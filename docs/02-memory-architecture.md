# AIMA 记忆架构

> **版本**: 2.0
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
| DMN Reactive | DMN | 读取会话锚点 + 最新增量事件 |
| DMN Consolidation | DMN | 批量扫描，调整权重，清理过期 |
| Amygdala 检测 | Amygdala | tag 过滤 + 时间窗口的风险模式匹配 |
| Skill 固化 | DMN + Cortex | 读写 procedural 记忆 |

每个场景的最优实现方式不同，不存在统一的"最好"检索策略。

### 对话历史只追加、不重写

这是保护 LLM prompt cache hit rate 的核心原则。压缩/重写对话历史会改变 context prefix，导致缓存失效，全量重新计费。AIMA 通过 Context Assembly 每轮重新组装 Block 3/4 来注入更新后的记忆摘要，对话历史本身始终是 append-only。

---

## 二、记忆类型

| 类型 | 功能角色 | 内容 | 主要写入方 | 主要读取场景 |
|---|---|---|---|---|
| `semantic` | 长期知识 | 实体、关系、事实（人、组织、系统、项目） | Limbic / Cortex | Context Assembly |
| `episodic` | 认知事件流 | DMN 从 Event Bus 派生的事件摘要，以及 Session 摘要锚点 | DMN | DMN Reactive |
| `procedural` | 技能库 | Skill 化的流程模式（reference / adapted / first-party） | Cortex | Context Assembly + Skill 固化 |
| `working` | 会话暂存 | 当前 Session 的临时状态，Session 结束清除 | 所有脑区 | 当前 Session |
| `implicit` | 风险模式 | Amygdala 规则的动态补充，泛化后的风险行为模式 | Amygdala / DMN | Amygdala 检测 |

**`episodic` 的审计边界**：`episodic` 记忆是认知衍生物，不是审计原始数据。它可以自由衰减和整理。审计完整性由 Event Bus → 外部不可变存储（WORM）保证，与 `episodic` 无关。

### 重要度字段

`importance` 被拆分为两个独立字段，分别承担不同语义：

| 字段 | 含义 | 由谁设置 | 是否衰减 |
|---|---|---|---|
| `base_importance` | 这条记忆的内在价值 | 写入时设定，DMN Consolidation 可显式调整 | 不自动衰减 |
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

**局限**：关键词匹配无法处理语义相近但词汇不同的情况。

**演进路径**：全文搜索 + 向量相似度搜索双路并行，RRF 融合重排。向量检索是独立工程项目（需要选型嵌入模型、向量索引、融合权重），不是"加一列"能解决的。

### 场景 B：DMN Reactive（事件流读取）

**目标**：获取当前 Session 的事件历史，判断是否有错误或需要预测的行为。

**设计约束：不压缩对话历史**

压缩/重写对话历史会使 LLM 的 prompt cache 失效，每次压缩等于全量重新计费。DMN Reactive 不做任何对话历史的重写或压缩。

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

### 场景 D：DMN Consolidation（记忆整理）

**目标**：批量处理历史记忆，调整权重，清理过期，固化 Skill。

**实现**：结构化查询，不走检索接口：
- `expires_at < now()` 且 `pinned = false` → 软删除（标记 `forgotten = true`）
- `last_accessed_at` 超过阈值且 `pinned = false` → 候选删除（不基于 importance 浮点数）
- `base_importance` 调整 → DMN 基于使用模式显式设置，不做线性自动衰减
- `procedural` 记忆的使用频率 → 触发 Skill 固化判断
- 定期对 `implicit` 记忆做语义相似度聚类，合并高度重叠的模式条目

---

## 四、子实例的记忆隔离

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
  session_id:       string
  base_importance:  float（内在价值，初始值见第二节）
  pinned:           boolean（true = 永不参与衰减/删除决策）
  source:           "brain" | "event_bus" | "dmn_consolidation"
  tags:             string[]（必填于 implicit；其他类型可选）
  t_valid:          timestamp | null（这条事实在现实中开始成立的时间）
  t_invalid:        timestamp | null（这条事实在现实中失效的时间，null = 仍然有效）
  expires_at:       timestamp | null（系统层面的过期时间）
  forgotten:        boolean（软删除标志）
  last_accessed_at: timestamp
  created_at:       timestamp
}
```

`t_valid` / `t_invalid` 区别于 `created_at` / `expires_at`：前者记录**事实在现实中的有效期**，后者记录**系统中的存储生命周期**。例如"客户 A 的联系人是张三"在 2025-01-01 更新为李四，旧记录 `t_invalid = 2025-01-01`，系统中保留历史，不删除。

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
→ Session 积累过多时，DMN Reactive 触发锚点写入（kind=session_anchor）
→ DMN Consolidation 定期归档（超过 N 天的旧 event 条目软删除，anchor 保留更长）

procedural 特殊路径：
Cortex 生成 → first-party Skill → 重复使用 → DMN Consolidation 固化 → 高 base_importance
```

---

## 七、MemoryService 接口抽象

记忆层应通过统一接口对上层脑区暴露能力，后端实现可替换。

```typescript
interface MemoryService {
  write(entry: MemoryEntry): Promise<void>
  search(query: string, filters: MemoryFilters): Promise<MemoryEntry[]>
  getRecent(type: MemoryType, n: number, since?: Date): Promise<MemoryEntry[]>
  getByTags(tags: string[], timeRange?: TimeRange, limit?: number): Promise<MemoryEntry[]>
  markAccessed(ids: string[]): Promise<void>
  forget(id: string): Promise<void>
}
```

原型阶段后端：PostgreSQL + 全文搜索。演进路径：加 pgvector 支持向量检索，必要时迁移至独立向量库（Qdrant）或图数据库（Graphiti，支持实体关系 + 双时态查询）。接口不变，后端替换对上层透明。

---

## 八、当前阶段局限与演进

| 局限 | 影响 | 演进方向 |
|---|---|---|
| `semantic` / `procedural` 只有全文搜索 | 语义相近但词汇不同的内容无法命中 | 向量嵌入 + BM25 双路 + RRF 融合（独立工程项目） |
| `episodic` 无结构化事件图 | 无法查询因果关系链 | 事件图谱（可选，高复杂度，Graphiti 模式） |
| `implicit` 写入无去重机制 | 语义重叠的模式会累积 | DMN Consolidation 周期聚类合并 |
| `session_anchor` 是 LLM 生成的摘要 | 有失真风险，细节不可还原 | 明确的能力边界，不是待修复的缺陷 |

当前阶段（原型）：接受全文搜索的局限，通过 MemoryService 接口抽象确保后端可替换，数据结构为向量检索演进预留字段位置。
