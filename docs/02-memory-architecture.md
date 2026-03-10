# AIMA 记忆系统 — Hippocampus

> **版本**: 4.0
> **状态**: 当前权威文档
> **关联**: `01-agent-architecture.md` 第九节为概览，本文为完整规范

---

## 一、设计哲学

### Hippocampus 是完整记忆实体

Hippocampus 不是"记忆数据库 + 外挂的批处理进程"。它是 AIMA 中负责记忆的完整实体，内含三个子模块，统一拥有数据、读写接口和巩固逻辑。五脑通过 Hippocampus 的接口与记忆交互，不直接操作底层存储。

生物学上海马体本来就是这样——它不是"存储旁边的一个结构"，它就是记忆系统的核心。

### 存储扁平完整，检索按脑区分层

底层存储永远保持**扁平完整**：每条记忆是独立的完整记录，任何时候都可以通过 `SELECT * FROM memories ORDER BY created_at` 拿到全量记录。审计系统直接读扁平表，不需要理解认知层抽象。

脑区专属检索是**读取视图**：利用现有字段（`entity_id`、`segment_id`、`tags`）提供语义更强的检索入口，不改变底层数据结构。

### 三轴组织

记忆通过三种轴组织，靠检索策略实现，不靠数据模型膨胀：

| 轴 | 概念 | 实现方式 |
|---|---|---|
| **因果链** | 段内事件因果序列 | `segment_id` + `segment_seq` 字段 |
| **时间容器** | Thread → Segment 两层时间层级 | `thread_id`（已有）+ `segment_id`（新增），见第四节 |
| **实体驱动** | 以实体为中心的星形拓扑 | `entity_id`（已有）+ `getEntityContext()` 深度展开 |

### 持久化历史只追加、不重写

**持久化的对话历史记录不允许重写或删除**。这是保护 LLM prompt cache hit rate 的核心原则——重写会改变 context prefix，导致缓存失效。

**超长 Session 的处理**：写 `session_anchor` 后开启新 Session，旧 Session 的 cache prefix 自然终止，无需重写。

**豁免：认知标注字段可更新**。`segment_id`、`entity_id` 等字段不进入 prompt，修改不影响 cache。Consolidation 精修段边界时可更新 `segment_id`，不违反本原则。

---

## 二、子模块结构

```
Hippocampus
├── Encoding      — 编码层：实时写入路径
├── Recall        — 检索层：实时读取路径，脑区专属入口
└── Consolidation — 巩固层：批量后台，每日低负载时段运行
```

| 子模块 | 性质 | 对外暴露 | 生物类比 |
|---|---|---|---|
| **Encoding** | 实时同步 | 写入接口（五脑调用） | 齿状回——新经历的初始编码 |
| **Recall** | 实时同步 | 检索接口（五脑调用） | CA3——模式补全，联想召回 |
| **Consolidation** | 批量异步 | 不对外暴露，内部调度 | 睡眠期 Sharp-Wave Ripples |

Skill Review 不属于 Hippocampus——评估 Skill 质量需要认知判断，由 **Cortex** 负责（DMN 心跳整合检测到模式后触发 Cortex 评估）。Hippocampus 只维护 Skill 的索引元数据，不做价值判断。

---

## 三、记忆类型

| 类型 | 功能角色 | 内容 | 主要写入方 | 主要读取场景 |
|---|---|---|---|---|
| `semantic` | 长期知识 | 实体、关系、事实；含事件段元数据 | Limbic / Cortex / Consolidation | Recall（场景 A/D/E） |
| `episodic` | 认知事件流 | DMN 从 Event Bus 派生的事件摘要；Session 摘要锚点 | DMN（经 Encoding） | Recall（场景 B/E/G） |
| `procedural` | 技能库 | Skill 化的流程模式（reference / adapted / first-party） | Cortex（经 Encoding） | Recall（场景 A/E/F） |
| `working` | 会话暂存 | 当前 Thread 的临时状态 | 所有脑区（经 Encoding） | 当前 Thread；Thread 完成时 Encoding 批量清除 |
| `implicit` | 风险模式 | Amygdala 规则的动态补充，泛化后的风险行为模式 | Amygdala / DMN（经 Encoding） | Recall（场景 C） |

**`working` 的生命周期**：持久化到 PostgreSQL，但绑定 Thread——Thread Runner 在 Thread 状态变为 `complete` 时调用 Encoding 的 `clearWorkingMemory(thread_id)` 批量清除。`session_id` 字段保留写入时的脑区 session ID 供调试追溯，清除逻辑依赖 `tags` 中的 `thread_id` 标签。

**`episodic` 的审计边界**：`episodic` 是认知衍生物，可以自由衰减和整理。审计完整性由 Event Bus → WORM 保证，与 `episodic` 无关。

**`episodic` 记录脑区行为，不是原始输入**：`content` 描述脑区的决策和动作（"Limbic 判断 intent=both，ROUTE 给 Cortex"；"Brainstem 执行工具 X，结果 Y"），不复制原始输入文本。原始输入如需参考可放 `context` 字段，但 `content` 必须是行为层描述。DMN 读 Event Bus 或读 episodic 时，读到的都是同一层：认知系统的**行为历史**，不是外部刺激的内容历史。

### 重要度字段

| 字段 | 含义 | 由谁设置 |
|---|---|---|
| `base_importance` | 记忆的内在价值 | 写入时设定，Consolidation 批量收敛（基于 `usage_outcomes`） |
| `pinned` | 永不参与衰减/删除 | 写入时或人工标记 |

检索排序：`base_importance + recency_boost`（`recency_boost` 基于 `last_accessed_at` 动态计算，不持久化）。

| 类型 | 初始 base_importance |
|---|---|
| `episodic` | 0.3 |
| `procedural` | 0.8 |
| `semantic` | 0.6 |
| `implicit` | 0.7 |
| `working` | — |

---

## 四、事件分段（Episodic Segment）

### 概念

**Segment** 是 episodic 记忆中一组认知上连贯的事件序列——对应一个完整"情节"：一次问题从提出到解决、一个错误的发生与恢复、一次目标转换。

### 两层分段

**Encoding 粗分（准实时）**：写 episodic 事件时，根据触发条件分配 `segment_id`：
- Thread 边界（新 Thread → 新 Segment）
- 目标变更（工作空间主任务描述变化）
- 错误恢复（`ALERT` 事件后重新激活）
- 话题切换（Limbic 判断输入显著偏离当前上下文）

**Consolidation 精修（批量）**：每日回放时对已有段做深层因果分析，必要时拆分或合并，更新 `segment_id`。精修必须在序列回放前完成（见第七节）。

### Segment 元数据

Segment 元数据写入 `semantic` 记忆，不建独立表：

```
entity_id:  "segment:{uuid}"
attribute:  "metadata"
content:    "## Segment {uuid}\n- 起止时间: ...\n- 事件数: N\n- 主要实体: ...\n- 摘要: ..."
type:       "semantic"
tags:       ["segment", "thread:{thread_id}"]
```

---

## 五、Encoding — 写入接口

Encoding 是所有记忆写入的唯一入口，五脑不直接操作 PostgreSQL。

**核心职责：**
- 接收写入请求，验证，持久化
- episodic 写入时持久化 DMN 传入的 `segment_id` / `segment_seq`，**不自行决定段边界**（段边界由 DMN 事件响应决定，见第四节）
- 携带 `significance_boost` 的事件：`base_importance = 初始值 + significance_boost`
- `supersedes_id` 非空时在事务内同时失效旧记录（设置 `t_invalid`）
- Thread 完成时执行 `clearWorkingMemory(thread_id)`

**写入接口：**

```typescript
// Encoding 暴露的写入方法
write(entry: MemoryEntry): Promise<void>
markUsed(ids: string[], outcome: 'positive' | 'negative' | 'neutral'): Promise<void>
markAccessed(ids: string[]): Promise<void>  // 等价于 markUsed(ids, 'neutral')
forget(id: string): Promise<void>
clearWorkingMemory(threadId: string): Promise<void>
```

`markAccessed` 是语义更清晰的纯访问记录方法，适用于只读查询（Shadow Mode 审计、Consolidation 内部扫描）。

---

## 六、Recall — 检索接口

Recall 是所有记忆读取的唯一入口，根据调用脑区路由到对应的检索策略。

### 检索性质分类

| 脑区 | 方法 | 检索性质 | 返回类型 |
|---|---|---|---|
| **Limbic** | `getEntityContext()` | 复合 | semantic + episodic + procedural |
| **Cortex** | `findSimilarSituations()` | 复合 | episodes + procedures + facts（三项分组） |
| **Brainstem** | `getProcedure()` | 单项 | procedural |
| **Amygdala** | `getByTags()` | 单项 | implicit |
| **DMN** | `getSessionContext()` | 单项 | episodic |
| **Consolidation**（内部） | `getSegmentSequence()` | 单项 | episodic |
| 所有脑区（兜底） | `search()` | 任意 | 混合 |

**复合检索 vs 单项检索**：Limbic 和 Cortex 做理解和推理，需要多类型证据同时在场；Brainstem、Amygdala、DMN 做执行/检测/监控，目标明确，单类型足够。原型阶段复合检索是并行的多次单类型查询后合并；向量检索上线后升级为跨类型 RRF 融合，接口不变。

---

### 场景 A：通用语义检索（所有脑区兜底）

**目标**：找到与当前消息/任务语义相关的历史知识，作为脑区专属检索无结果时的兜底。

**实现**：ILIKE 全文搜索，按 `base_importance DESC, last_accessed_at DESC` 排序，返回 top-N。

**冷启动**：记忆库为空时 Block 4 省略，脑区直接基于 Block 1/2/3 运行。

---

### 场景 B：DMN 事件响应专用

**目标**：获取当前脑区 session 的事件历史。

**Session 锚点模式**：

```
[最近一条 session_anchor 摘要]   ← created_at 最新的 kind=session_anchor
+ [anchor 之后的增量事件]         ← created_at > anchor.created_at
```

`sessionId` 是被监控的脑区 session ID（非 DMN 自身，DMN Reactive 无 LLM session）。来源：Thread Runner 在 `activateBrain()` 后从 `BrainRunResult.session_id` 取到，经 `brain.complete` 事件 payload 传给 DMN。

**回溯能力边界**：锚点以前的历史以摘要形式存在，细节不可还原。这是明确的能力边界。

---

### 场景 C：Amygdala 风险模式匹配

**目标**：工具执行前快速判断是否触发风险规则（两层：静态规则 + 动态 `implicit`）。

**分级降级策略**：
```
1. 精确 tag 命中 + 最近 30 天  → 结果 <= K 条，直接用
2. 结果过多                   → 缩短为最近 7 天
3. 结果过少                   → 放宽为最近 90 天
4. 兜底                       → 取最近 K 条（不限 tag）
```

`implicit` 写入时必须打高质量 tag（风险类别、涉及工具、关联脑区）。

---

### 场景 D：Limbic 实体中心检索（复合）

**目标**：以特定实体为中心，检索围绕该实体的全部知识。

**实现**：
1. 以 `entity_id = entityId` 为锚点，取 semantic + episodic + procedural
2. 若 `depth >= 1`：扫描 `attribute = "related_to"` 的条目，展开关联实体（上限 depth=2）

生物类比：语义网络扩散激活。

---

### 场景 E：Cortex 情境匹配（复合）

**目标**：给定当前任务描述，找出历史上相似的情境、处理方式和相关事实。

**返回三项**：
```typescript
{
  episodes:   MemoryEntry[]   // 相似历史情节（episodic）
  procedures: MemoryEntry[]   // 相关 Skill（procedural）
  facts:      MemoryEntry[]   // 相关 semantic 事实（当前任务涉及的实体知识）
}
```

**原型阶段与 `search()` 的区别**：原型阶段行为接近（本质是对三类分别做 ILIKE，分组返回）。向量检索上线后，三类分别使用针对各自语义优化的向量空间，匹配能力显著分化。

生物类比：前额叶经验检索。

---

### 场景 F：Brainstem 任务过程检索（单项）

**目标**：给定任务类型，直接取出执行步骤。

**实现**：tag 匹配优先，全文搜索兜底；仅返回 `procedural`，按 `base_importance DESC` 排序。

与场景 E 的区别：E 返回"上次是这么处理的"，F 返回"应该这么执行"。Brainstem 不需要 `implicit`——风险检测由 Amygdala 在每次工具调用前处理，不需要在 Context Assembly 时预加载。

生物类比：程序性记忆直接调取。

---

### 场景 G：Consolidation 段回放（单项，内部）

**目标**：批量读取事件序列，供 Consolidation 提取跨段模式（内部使用，不对五脑暴露）。

---

## 七、Consolidation — 巩固引擎

Consolidation 是 Hippocampus 的内部批量进程，每日低负载时段自动运行，不对外暴露接口，不参与实时决策。

**执行顺序严格约束：1 → 2 → 3 → 4**（步骤 1 产生的 `segment_id` 是步骤 2 的输入，必须先完成）

### 1. 段精修

对 Encoding 粗分的段做深层因果分析，必要时拆分或合并——更新 `segment_id` 字段（不新增记录，见§一豁免说明）。

### 2. 段序列回放

```
getSegmentsByTimeRange(过去 N 天)
→ 按 avg(base_importance) / recency / significance_boost 排序
→ 对 top-K 段（K 为上层配置项）：
   getSegmentSequence(segmentId)
   → LLM 分析事件序列（低温度）：
     - 提取跨事件因果模式
     - 识别可泛化流程步骤
     - 检测行为偏差
→ 模式写入：
   事实规律 → semantic
   流程步骤 → procedural（Skill Index 更新；价值判断交给 Cortex）
   风险模式 → implicit
```

**LLM 泛化即微扰**：LLM 每次分析同一序列都可能产生略有不同的表达，保持记忆动态，防止固化——这是设计，不是噪音。

**系统巩固**：回放写入的 semantic 通过 `entity_id` 关联已有实体，通过 `supersedes_ids` 替代旧版本。episodic 随时间自然衰减，知识内核通过回放提炼进 semantic/procedural，实现跨时间积累。

### 3. usage_outcomes 收敛

批量读取 `usage_outcomes` 计数器，根据正负比例小幅调整 `base_importance`（具体阈值和步长为上层配置项，框架不锁定）。单次反馈不直接修改权重，Consolidation 批量收敛。

### 4. 过期清理

`expires_at < now()` 且 `pinned = false` → 软删除（`forgotten = true`）；`last_accessed_at` 超过阈值且 `pinned = false` → 候选删除。

---

## 八、检索即再巩固（Reconsolidation）

### 生物学来源

记忆每次被检索都会进入不稳定状态，经历一次"再巩固"——成功使用的记忆更容易被召回，被证伪的记忆可以被修正。

### 机制

`markUsed(ids, outcome)`：Recall 检索 + 脑区执行后，反馈流转：

```
Context Assembly（Block 4）
  → Recall 记录本次注入的记忆 IDs → injected_memory_ids 存入 BrainRunResult
Thread Runner 调用 activateBrain()
  → 存入当前 Thread 状态
脑区完成后（brain.complete 事件）
  → DMN Reactive 评估执行结果
  → 调用 Encoding.markUsed(injected_memory_ids, outcome)
  → usage_outcomes 计数器递增
Consolidation 每日批量收敛
  → 根据累积比例调整 base_importance
```

| outcome | 触发条件（示例） |
|---|---|
| `positive` | 工具调用成功；用户确认满意；推理被采纳 |
| `negative` | 工具执行出错；推理被 DMN 标记为偏差；用户要求重做 |
| `neutral` | 其他 |

---

## 九、Amygdala 显著性标记

Amygdala 在 `tool.pre_use` 评估后，若触发规则匹配，向 Event Bus 发射的事件中携带 `significance_boost: float`（无匹配时不携带）。

分级概念：
- 无匹配 → 不携带
- 动态规则命中 → 较低正值
- 静态规则命中 → 中等正值
- 硬底线触发 → 较高正值

具体数值为 Amygdala 实现策略，属于上层应用配置。

Encoding 写入 episodic 时应用：`base_importance = 初始值 + significance_boost`。

**效果链**：风险经历编码更深 → 检索更容易召回 → Consolidation 回放优先处理 → 风险模式更容易浮现 → 写入更高质量的 implicit。

---

## 十、子实例记忆隔离

> **暂缓**：子实例（Instance 级并行）已在 `01-agent-architecture.md` 中推迟。本节保留作为未来设计参考。

子实例不直接写持久记忆：

| 类型 | 读权限 | 写权限 |
|---|---|---|
| `semantic` / `episodic` / `procedural` / `implicit` | ✅ | ❌ |
| `working` | ✅ | ✅（隔离命名空间，`parent_session_id` 标签） |

子实例结果通过 `working` 返回父实例 Slot，由父实例的 DMN 决定是否提升为持久记忆。

---

## 十一、记忆写入规范

每条记忆记录（完整字段）：

```
{
  id:               UUID
  type:             semantic | episodic | procedural | working | implicit
  content:          string（Markdown 格式）
  partition_id:     string（写入方脑区）
  session_id:       string | null
  entity_id:        string | null（如 "colleague:alice" / "skill:procurement" / "segment:{uuid}"）
  attribute:        string | null（如 "reliability" / "owner" / "metadata" / "related_to"）
  base_importance:  float
  pinned:           boolean
  source:           "brain" | "event_bus" | "dmn_consolidation" | "hippocampus"
  tags:             string[]
  supersedes_ids:   UUID[]
  t_valid:          timestamp | null
  t_invalid:        timestamp | null
  expires_at:       timestamp | null
  forgotten:        boolean
  last_accessed_at: timestamp
  created_at:       timestamp

  // episodic 专用（新增，nullable，向后兼容）
  segment_id:       string | null
  segment_seq:      number | null

  // 反馈计数（新增，nullable，不暴露到公共 SDK）
  usage_outcomes:   { positive: number, negative: number, neutral: number } | null
}
```

`episodic` 额外字段：
```
{
  kind:        "event" | "session_anchor"
  event_type:  string | null
  brain:       string
  thread_id:   string | null
}
```

**双时态字段**：`t_valid`/`t_invalid` 记录事实在现实中的有效期；`created_at`/`expires_at` 记录系统存储生命周期。两组独立。

**事实更新**：写入新记录时提供 `supersedes_id`，Encoding 在同一事务内 INSERT 新记录 + 设置旧记录 `t_invalid`。`t_invalid` 只能通过此机制设置。

---

## 十二、生命周期

```
写入（Encoding）
→ 活跃（Recall 命中 → last_accessed_at 更新；markUsed 递增 usage_outcomes）
→ 沉默（长时间未命中）
→ Consolidation 过期清理（软删除）

episodic 特殊路径：
Event Bus → DMN 消费 → Encoding.write()（分配 segment_id，应用 significance_boost）
→ Recall 命中 → markUsed 反馈
→ Consolidation：段精修 → 段序列回放（模式提炼）→ usage_outcomes 收敛 → 过期清理

procedural 特殊路径：
Cortex 生成 → Encoding.write() → 重复使用 → markUsed(positive) 积累
→ DMN 心跳整合检测到固化模式 → pending 给 Cortex
→ Cortex Skill Review → 写入 first-party Skill 文件 + 更新 Skill Index
```

---

## 十三、Hippocampus 完整接口

```typescript
// ── Encoding ────────────────────────────────────────────────────────────────

interface HippocampusEncoding {
  write(entry: MemoryEntry): Promise<void>
  markUsed(ids: string[], outcome: 'positive' | 'negative' | 'neutral'): Promise<void>
  markAccessed(ids: string[]): Promise<void>   // 等价于 markUsed(ids, 'neutral')
  forget(id: string): Promise<void>
  clearWorkingMemory(threadId: string): Promise<void>
  getSupersededBy(oldRecordId: string): Promise<MemoryEntry[]>  // TODO: 待有具体场景时实现
}

// ── Recall ──────────────────────────────────────────────────────────────────

interface HippocampusRecall {
  // 场景 A：通用语义检索（兜底）
  search(query: string, filters: MemoryFilters): Promise<MemoryEntry[]>

  // 场景 B：DMN 专用——最近 session_anchor + 其后增量 event
  getSessionContext(sessionId: string): Promise<{
    anchor: MemoryEntry | null
    events: MemoryEntry[]
  }>

  // 场景 C：Amygdala 专用——implicit 记忆分级检索
  getByTags(tags: string[], timeRange?: TimeRange, limit?: number): Promise<MemoryEntry[]>

  // 场景 D：Limbic 专用——实体中心复合检索
  getEntityContext(entityId: string, opts?: {
    depth?: number        // 关联展开深度，默认 1，上限 2
    types?: MemoryType[]
    limit?: number
  }): Promise<MemoryEntry[]>

  // 场景 E：Cortex 专用——情境匹配复合检索
  findSimilarSituations(situation: string, opts?: {
    limit?: number
  }): Promise<{
    episodes:   MemoryEntry[]   // 相似历史情节
    procedures: MemoryEntry[]   // 相关 Skill
    facts:      MemoryEntry[]   // 相关 semantic 事实
  }>

  // 场景 F：Brainstem 专用——任务过程单项检索
  getProcedure(taskType: string, opts?: { limit?: number }): Promise<MemoryEntry[]>

  // 场景 G：Consolidation 内部——段回放（不对五脑直接暴露）
  getSegmentSequence(segmentId: string): Promise<MemoryEntry[]>
  getSegmentsByTimeRange(range: TimeRange): Promise<{
    segmentId:       string
    summary:         string
    eventCount:      number
    avgImportance:   number
    hasRiskEvents:   boolean
  }[]>
}

// ── 共用类型 ─────────────────────────────────────────────────────────────────

interface MemoryFilters {
  types?:      MemoryType[]
  entity_id?:  string
  segment_id?: string
  tags?:       string[]
  limit?:      number
  timeRange?:  TimeRange
}

interface TimeRange {
  from: Date
  to?:  Date
}
```

Encoding 和 Recall 共享同一 PostgreSQL 连接池，底层实现在同一进程内。对五脑暴露时，可以作为 `hippocampus.encoding` 和 `hippocampus.recall` 两个命名空间，也可以平铺为单一接口对象——取决于适配器实现。

---

## 十四、当前阶段局限与演进

| 局限 | 影响 | 演进方向 |
|---|---|---|
| 所有 Recall 方法底层是 ILIKE 全文搜索 | 语义相近但词汇不同无法命中 | pgvector 向量检索 + BM25 双路 + RRF 融合（独立工程项目） |
| 复合检索（场景 D/E）是多次单类型查询合并 | 跨类型相关性排序不准 | 向量检索上线后升级为跨类型 RRF，接口不变 |
| DMN 段分配是粗分 | 段边界可能不精确（DMN 实时响应只做 Thread/目标/错误/话题等粗粒度切割） | Consolidation 每日精修补偿，精度随积累提高 |
| usage_outcomes 收敛需 Consolidation 批量运行 | 单次反馈不立即影响检索排序 | 有意设计，防止单次噪音；批量收敛每日执行 |
| `session_anchor` 是 LLM 生成的摘要 | anchor 后对话历史仅有摘要，隐含约束/偏好有丢失风险；在长对话的合规敏感场景下尤为显著 | 缓解策略：Limbic 在对话中检测到重要约束/偏好时主动写入 `semantic`（`entity_id` = 对方实体，`attribute = "preference"` 等）——结构化记忆比摘要更可靠。Event Bus `COMPLIANCE` 轨迹保存所有有效外部动作的完整记录（独立于 anchor）。剩余风险（纯对话细节无 COMPLIANCE 动作）是已知能力边界。 |
