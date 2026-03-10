# AIMA 记忆架构

> **版本**: 2.2
> **状态**: 当前权威文档
> **关联**: `01-agent-architecture.md` 第九节为概览，本文为详细设计

---

## 一、设计原则

### 记忆是有访问约束的数据库

记忆的底层实现是 PostgreSQL 数据库。重要的不是否认这一点，而是强调约束：**每种记忆类型有规定的访问模式，禁止绕过这些模式直接读写底层表**。不同记忆类型的读取方式、检索策略和生命周期完全不同——用同一套通用 CRUD 接口服务所有场景是错误的。

### 读写场景决定设计

不同脑区在不同时机对记忆有不同需求：

| 场景 | 使用方 | 需要什么 |
|---|---|---|
| Context Assembly | 所有脑区 | 检索与当前任务相关的历史知识 |
| DMN 事件响应 | DMN | 读取会话锚点 + 最新增量事件 |
| DMN 心跳整合 | DMN | 批量扫描 episodic，维护 pending_observations，归并 implicit |
| Hippocampus | Hippocampus | 清理低权重条目，调整权重，提炼 semantic；定期 Skill Review |
| Amygdala 检测 | Amygdala | tag 过滤 + 时间窗口的风险模式匹配 |
| Skill 固化 | Hippocampus + Cortex | 读写 procedural 记忆 |

每个场景的最优实现方式不同，不存在统一的"最好"检索策略。

### 持久化历史只追加、不重写

**持久化的对话历史记录不允许重写或删除**。这是保护 LLM prompt cache hit rate 的核心原则——重写持久化历史会改变 context prefix，导致缓存失效，全量重新计费。

这个原则不禁止 in-context 表示的裁剪：单次请求前可以对大型工具结果做内存中的软裁（保留头尾），这类操作不修改持久化记录，不影响 cache。

**超长 Session 的处理**：当 Session 极长（跨天、跨任务），不在同一 Session 内做压缩，而是写 `session_anchor` 后开启新 Session。新 Session 继承锚点作为起始上下文，旧 Session 的 cache prefix 自然终止，无需重写。

---

## 二、记忆类型

| 类型 | 功能角色 | 内容 | 主要写入方 | 主要读取场景 |
|---|---|---|---|---|
| `semantic` | 长期知识 | 实体、关系、事实（人、组织、系统、项目） | Limbic / Cortex | Context Assembly |
| `episodic` | 认知事件流 | DMN 从 Event Bus 派生的事件摘要，以及 Session 摘要锚点 | DMN | DMN Reactive |
| `procedural` | 技能库 | Skill 化的流程模式（reference / adapted / first-party） | Cortex | Context Assembly + Skill 固化 |
| `working` | 会话暂存 | 当前 Thread 的临时状态，Thread 完成时清除 | 所有脑区 | 当前 Thread |
| `implicit` | 风险模式 | Amygdala 规则的动态补充，泛化后的风险行为模式 | Amygdala / DMN | Amygdala 检测 |

**`working` 的清除粒度**：`working` 记忆的生命周期绑定到 **Thread**，而非单个脑区的 LLM session。同一 Thread 中 Limbic session 已结束而 Cortex 仍在运行时，Limbic 写入的 `working` 记录对 Cortex 仍然可见。Thread Runner 在 Thread 状态变为 `complete` 时调用 `clearWorkingMemory(thread_id)` 批量清除。`working` 记录的 `session_id` 字段保留写入时的脑区 session ID（供调试追溯），但清除逻辑不依赖此字段——依赖 `tags` 中的 `thread_id` 标签。

**`episodic` 的审计边界**：`episodic` 记忆是认知衍生物，不是审计原始数据。它可以自由衰减和整理。审计完整性由 Event Bus → 外部不可变存储（WORM）保证，与 `episodic` 无关。

### 重要度字段

`importance` 被拆分为两个独立字段，分别承担不同语义：

| 字段 | 含义 | 由谁设置 | 是否衰减 |
|---|---|---|---|
| `base_importance` | 这条记忆的内在价值 | 写入时设定，Hippocampus 可显式调整 | 不自动衰减 |
| `pinned` | 受保护，永不衰减 | 写入时或人工标记 | 永不参与删除决策 |

检索排序使用 `base_importance + recency_boost`，其中 `recency_boost` 基于 `last_accessed_at` 动态计算，不持久化。删除决策基于 `last_accessed_at` 超过阈值 + `expires_at`，**不基于 base_importance 浮点数**。

| 类型 | 初始 base_importance | 理由 |
|---|---|---|
| `episodic` | 0.3 | 高频写入，单条价值低，靠时序读取而非权重检索 |
| `procedural` | 0.8 | Skill 是核心知识，高优先注入 |
| `semantic` | 0.6 | 中等稳定性 |
| `implicit` | 0.7 | 风险模式应被优先检索 |
| `working` | — | 不持久化，不参与检索排序 |

---

## 三、检索策略（按场景）

### 场景 A：Context Assembly（Block 4 记忆注入）

**目标**：找到与当前消息/任务语义相关的历史知识，注入系统提示词。

**当前实现（原型阶段）**：
- 全文搜索（ILIKE `%query%`）
- 按 `base_importance DESC, last_accessed_at DESC` 排序
- 返回 top-N 条，渲染为 Markdown 段落
- Query = 原始消息/任务描述（不做实体提取）

**冷启动行为**：系统初始阶段记忆库为空，Block 4 返回空字符串或省略该 Block。这是正常路径——脑区在没有历史记忆的情况下直接基于系统提示词（Block 1/2）和当前上下文（Block 3）运行。随着使用积累，Block 4 内容自然增长，无需特殊处理。

**局限**：关键词匹配无法处理语义相近但词汇不同的情况。

**演进路径**：全文搜索 + 向量相似度搜索双路并行，RRF 融合重排。向量检索是独立工程项目（需要选型嵌入模型、向量索引、融合权重），不是"加一列"能解决的。

### 场景 B：DMN 事件响应（事件流读取）

**目标**：获取当前 Session 的事件历史，判断是否有错误或需要预测的行为。

**Session 锚点模式**：

长 Session 中，早期事件会随时间被挤出 LLM context window。DMN 的解法是定期写入 `episodic` 摘要锚点（`kind: session_anchor`），将之前的事件压缩成一条摘要记录追加到数据库。

DMN Reactive 每次看到的内容结构：
```
[最近一条 session_anchor 摘要]  ← 从 DB 取，Block 4 注入
+ [anchor 之后的增量事件]        ← created_at > anchor.created_at
```

对话历史本身始终是 append-only，不重写。Cache prefix（Block 1 + Block 2）保持稳定，cache hit rate 得到保护。

**回溯能力边界**：DMN Reactive 只对锚点以后的原始事件有精确感知能力；锚点以前的历史以摘要形式存在，细节不可还原。这是明确的能力边界，不是 bug。

### 场景 C：Amygdala 风险模式匹配

**目标**：在工具执行前快速判断是否触发风险规则。

**实现**：两层，按顺序执行：
1. **静态规则**（代码层）：正则、金额阈值、关键词黑名单，零延迟，零 LLM 成本
2. **动态规则**（`implicit` 记忆）：tag 过滤 + 时间窗口分级检索

`implicit` 记忆检索的分级降级策略：
```
1. 精确 tag 命中 + 最近 30 天  → 结果 <= K 条，直接用
2. 结果过多                   → 缩短为最近 7 天
3. 结果过少                   → 放宽为最近 90 天
4. 兜底                       → 取最近 K 条（不限 tag）
```

`implicit` 记忆写入时必须打高质量 tag（风险类别、涉及工具、关联脑区），这是检索精度的保证，也是控制匹配面的手段。

**冷启动行为**：系统初始阶段 `implicit` 记忆库为空，分级检索四级均无命中。这时 Amygdala 仅运行静态规则层（正则、金额阈值、关键词黑名单）。这是**预期行为，不是 bug**——静态规则是完整的第一道防线，动态 `implicit` 记忆是运行积累后的增强层。随着系统运行，Amygdala 会逐步写入观察到的风险模式，`implicit` 层的覆盖面自然增长。此退化仅影响 medium 和 high 级工具；low 级工具的 Amygdala 行为始终只使用静态规则，不受 `implicit` 记忆库状态影响。

### 场景 D：Hippocampus（记忆整理）

**目标**：每日批量处理历史记忆，调整权重，清理过期，提炼 semantic。定期（可配置间隔）执行 Skill Review。

**实现**：结构化查询，不走检索接口：
- `expires_at < now()` 且 `pinned = false` → 软删除（标记 `forgotten = true`）
- `last_accessed_at` 超过阈值且 `pinned = false` → 候选删除（不基于 importance 浮点数）
- `base_importance` 调整 → Hippocampus 基于使用模式显式设置，不做线性自动衰减
- 重要 `episodic` 模式提炼 → 写入 `semantic` 记忆（跨 Thread 的长期知识）
- 定期对 `implicit` 记忆做语义相似度聚类，合并高度重叠的模式条目（见下方聚类策略）
- Skill Review：分析 `procedural` 使用频率和成功率 → 生成固化候选 Skill Draft

**聚类策略**：原型阶段采用 LLM 驱动的小批量聚类——每次取最近 20-50 条 `implicit` 记忆，请 LLM 判断哪些条目语义高度重叠并建议合并。合并后的新记录继承最高 `base_importance`，旧记录通过 `supersedes_ids` 软删除。此策略无需向量索引，代价是每次运行消耗一次 LLM 调用。演进路径：引入嵌入模型后，改为向量聚类（DBSCAN 或 k-means），LLM 仅做最终合并摘要生成，不参与相似度计算。

---

## 四、子实例的记忆隔离

> **暂缓**：子实例（Instance 级并行）已在 `01-agent-architecture.md` 中推迟。本节保留作为未来设计参考，当前不实现。

### 问题

子实例（临时计算分支）与父实例共享同一记忆池。如果子实例写入错误的 `semantic` 记忆，父实例会被污染，且子实例销毁后这些写入无法撤回。

### 设计决策：子实例不直接写持久记忆

子实例的记忆权限：

| 类型 | 读权限 | 写权限 |
|---|---|---|
| `semantic` | ✅ | ❌ |
| `episodic` | ✅ | ❌ |
| `procedural` | ✅ | ❌ |
| `working` | ✅ | ✅（隔离命名空间，`parent_session_id` 标签） |
| `implicit` | ✅ | ❌ |

**子实例的输出路径**：
1. 结果写入子实例自己的 `working` 记忆（带 `parent_session_id` 标签）
2. 父实例的工作空间 Slot 接收子实例的输出
3. 父实例的 DMN 决定哪些内容值得提升为持久记忆（`semantic` / `procedural` / `implicit`）

这使子实例成为纯粹的计算分支：输入来自父实例的共享记忆（只读），输出通过工作空间 Slot 返回，写持久记忆的权力归父实例。

### 实现方式

子实例在创建时接收一个 `read_only_memory: true` 标志。记忆服务在写入前检查此标志，拒绝非 `working` 类型的写入并返回错误（非异常，由子实例的 DMN 处理）。

---

## 五、记忆写入规范

每条记忆记录：

```
{
  id:               UUID
  type:             semantic | episodic | procedural | working | implicit
  content:          string（Markdown 格式）
  partition_id:     string（写入方脑区）
  session_id:       string | null（`episodic` 记录通常为 null——DMN 从 Event Bus 消费写入，不关联特定脑区 session；`working` 记录填写写入时的脑区 session ID 供调试追溯）
  entity_id:        string | null（这条记录描述的实体，如 "brain:cortex" / "skill:procurement" / "colleague:alice"）
  attribute:        string | null（实体的哪个属性，如 "reliability" / "owner" / "status"）
  base_importance:  float（内在价值，初始值见第二节）
  pinned:           boolean（true = 永不参与衰减/删除决策）
  source:           "brain" | "event_bus" | "dmn_consolidation"
  tags:             string[]（必填于 implicit；其他类型可选）
  supersedes_ids:   UUID[]（写入时指定被替换的旧记录 ID，支持 1:N 和 N:1 场景）
  t_valid:          timestamp | null（这条事实在现实中开始成立的时间）
  t_invalid:        timestamp | null（这条事实在现实中失效的时间，null = 仍然有效）
  expires_at:       timestamp | null（系统层面的过期时间）
  forgotten:        boolean（软删除标志）
  last_accessed_at: timestamp
  created_at:       timestamp
}
```

**`entity_id` 和 `attribute` 是可选的轻量锚点**，不强制唯一约束。写入方尽力填写——尤其是 `semantic` 类型记录。当同一 `entity_id + attribute` 组合存在多条 `t_invalid=null` 记录时（如"当前项目 owner"有两个版本），检索方（LLM）基于 `created_at` 推断更新者，Hippocampus 定期清理矛盾记录并设置 `supersedes_ids`。这遵循"治理而非强约束"的原则：不要求写入时必须正确，但提供足够的结构信息让系统能在事后修复。

**双时态字段说明**：`t_valid` / `t_invalid` 记录**事实在现实中的有效期**；`created_at` / `expires_at` 记录**系统中的存储生命周期**。两组字段独立，不互相推导。

**事实更新的写入方式**：当某条 `semantic` 事实发生变化（如联系人从张三改为李四），调用方在写入新记录时提供 `supersedes_id` 指向旧记录。MemoryService 在同一事务内执行：INSERT 新记录 + 将旧记录的 `t_invalid` 设为当前时间。`t_invalid` 只能由 MemoryService 通过 `supersedes_id` 机制设置，调用方不得直接修改。

Context Assembly 检索默认只返回 `t_invalid IS NULL` 的记录（当前有效事实）。历史版本通过专用的 `getHistory()` 接口访问，不出现在通用检索路径上。

`episodic` 额外字段：
```
{
  kind:        "event" | "session_anchor"（普通事件 vs 会话摘要锚点）
  event_type:  string | null（来自 Event Bus 的事件类型，session_anchor 为 null）
  brain:       string（发射事件的脑区）
  thread_id:   string | null
}
```

---

## 六、生命周期

```
写入 → 活跃（被检索命中 last_accessed_at 更新）→ 沉默（长时间未命中）→ 到期/超时 → 软删除

episodic 特殊路径：
Event Bus → DMN 消费 → 写入（kind=event）
→ Context 接近上限时，DMN 事件响应触发 anchor 写入（kind=session_anchor）
→ Hippocampus 每日归档（超过 N 天的旧 event 条目软删除，anchor 保留更长）

procedural 特殊路径：
Cortex 生成 → first-party Skill → 重复使用 → Hippocampus Skill Review 固化 → 高 base_importance
```

---

## 七、MemoryService 接口抽象

记忆层应通过统一接口对上层脑区暴露能力，后端实现可替换。

```typescript
interface MemoryService {
  // 通用写入；supersedes_id 非空时在事务内同时失效旧记录
  write(entry: MemoryEntry): Promise<void>

  // 场景 A：Context Assembly 语义检索（默认只返回 t_invalid IS NULL）
  search(query: string, filters: MemoryFilters): Promise<MemoryEntry[]>

  // 场景 B：DMN Reactive 专用——返回最近 session_anchor + 其后的增量 event
  getSessionContext(sessionId: string): Promise<{
    anchor: MemoryEntry | null
    events: MemoryEntry[]
  }>

  // 场景 C：Amygdala implicit 记忆分级检索
  getByTags(tags: string[], timeRange?: TimeRange, limit?: number): Promise<MemoryEntry[]>

  // 反向查询：给定一条旧记录的 ID，返回所有取代它的新记录
  // TODO: 待定——当前无明确使用场景。Hippocampus 直接读 supersedes_ids 字段即可完成清理，
  //        无需反向索引。保留接口定义，等有具体需求时实现。
  getSupersededBy(oldRecordId: string): Promise<MemoryEntry[]>

  markAccessed(ids: string[]): Promise<void>
  forget(id: string): Promise<void>
}
```

每个方法对应一个规定的访问场景，调用方不应跨场景混用接口。

原型阶段后端：PostgreSQL + 全文搜索。演进路径：加 pgvector 支持向量检索，必要时迁移至 Qdrant 或 Graphiti（支持实体关系图 + 双时态查询）。接口不变，后端替换对上层透明。

**失败处理**：记忆读写失败不中断认知主流程——记忆是辅助系统，不在控制流关键路径上。`write()` 返回的 Promise 可以 reject，调用方必须 catch 并自行决定是否重试；不得让 reject 变为未捕获的异常传播到认知主流程。具体的重试策略属于实现层决策，不在本文范围内。

---

## 八、当前阶段局限与演进

| 局限 | 影响 | 演进方向 |
|---|---|---|
| `semantic` / `procedural` 只有全文搜索 | 语义相近但词汇不同的内容无法命中 | 向量嵌入 + BM25 双路 + RRF 融合（独立工程项目） |
| `episodic` 无结构化事件图 | 无法查询因果关系链 | 事件图谱（可选，高复杂度，Graphiti 模式） |
| `implicit` 写入无去重机制 | 语义重叠的模式会累积 | Hippocampus 每日聚类合并 |
| `session_anchor` 是 LLM 生成的摘要 | 有失真风险，细节不可还原 | 明确的能力边界，不是待修复的缺陷 |

当前阶段（原型）：接受全文搜索的局限，通过 MemoryService 接口抽象确保后端可替换，数据结构为向量检索演进预留字段位置。
