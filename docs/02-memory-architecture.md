# AIMA 记忆架构

> **版本**: 3.0
> **状态**: 当前权威文档
> **关联**: `01-agent-architecture.md` 第九节为概览，本文为详细设计

---

## 一、设计原则

### 记忆是有访问约束的数据库

记忆的底层实现是 PostgreSQL 数据库。重要的不是否认这一点，而是强调约束：**每种记忆类型有规定的访问模式，禁止绕过这些模式直接读写底层表**。不同记忆类型的读取方式、检索策略和生命周期完全不同——用同一套通用 CRUD 接口服务所有场景是错误的。

### 存储扁平完整，检索按脑区分层

底层存储结构永远保持**扁平完整**：每条 MemoryEntry 是独立的完整记录，任何时候都可以通过 `SELECT * FROM memories ORDER BY created_at` 拿到全量记录。这是审计需求的硬约束——合规系统直接读扁平表，不需要理解认知层抽象。

脑区专属检索（场景 D-G）是**读取视图**：利用现有字段（`entity_id`、`segment_id`、`tags`）提供语义更强的检索入口，不改变底层数据结构，不新增独立的 segment 表或图边表。`segment_id`、`entity_id` 是字段标注而非数据拆分。

### 三轴组织

记忆通过三种不同的轴进行组织，三个轴靠**检索策略**实现，不靠数据模型膨胀：

| 轴 | 概念 | 实现方式 |
|---|---|---|
| **因果链** | 段内事件因果序列 | `segment_id` + `segment_seq` 字段 |
| **时间容器** | Thread → Segment 两层时间层级 | `thread_id`（已有）+ `segment_id`（新增），见第三节 |
| **实体驱动** | 以实体为中心的星形拓扑 | `entity_id`（已有）+ `getEntityContext()` 深度展开 |

### 读写场景决定设计

不同脑区在不同时机对记忆有不同需求：

| 场景 | 使用方 | 需要什么 |
|---|---|---|
| Context Assembly | Limbic / Cortex / Brainstem | 脑区专属检索（场景 D/E/F）+ 通用兜底（场景 A） |
| DMN 事件响应 | DMN | 读取会话锚点 + 最新增量事件（场景 B）；段分配；使用反馈写入 |
| DMN 心跳整合 | DMN | 批量扫描 episodic，维护 pending_observations，归并 implicit |
| Hippocampus | Hippocampus | 清理低权重条目，调整权重，提炼 semantic；段序列回放（场景 G）；Skill Review |
| Amygdala 检测 | Amygdala | tag 过滤 + 时间窗口的风险模式匹配（场景 C）；significance_boost 写入 |
| Skill 固化 | Hippocampus + Cortex | 读写 procedural 记忆 |

每个场景的最优实现方式不同，不存在统一的"最好"检索策略。

### 持久化历史只追加、不重写

**持久化的对话历史记录不允许重写或删除**。这是保护 LLM prompt cache hit rate 的核心原则——重写持久化历史会改变 context prefix，导致缓存失效，全量重新计费。

**超长 Session 的处理**：当 Session 极长（跨天、跨任务），不在同一 Session 内做压缩，而是写 `session_anchor` 后开启新 Session。新 Session 继承锚点作为起始上下文，旧 Session 的 cache prefix 自然终止，无需重写。

**豁免：认知标注字段可更新**。"不重写"约束保护的是**对话历史记录**——这些内容构成 LLM prompt cache 的 prefix，重写会导致 cache miss。`segment_id`、`entity_id` 等认知标注字段不进入 prompt，修改它们不影响 cache。因此 Hippocampus 在精修段边界时，可以更新 episodic 记录的 `segment_id` 字段，这不违反本原则。

---

## 二、记忆类型

| 类型 | 功能角色 | 内容 | 主要写入方 | 主要读取场景 |
|---|---|---|---|---|
| `semantic` | 长期知识 | 实体、关系、事实（人、组织、系统、项目）；含事件段元数据 | Limbic / Cortex / Hippocampus | Context Assembly |
| `episodic` | 认知事件流 | DMN 从 Event Bus 派生的事件摘要，以及 Session 摘要锚点 | DMN | DMN Reactive；Hippocampus 段回放 |
| `procedural` | 技能库 | Skill 化的流程模式（reference / adapted / first-party） | Cortex | Context Assembly + Skill 固化 |
| `working` | 会话暂存 | 当前 Thread 的临时状态，Thread 完成时清除 | 所有脑区 | 当前 Thread |
| `implicit` | 风险模式 | Amygdala 规则的动态补充，泛化后的风险行为模式 | Amygdala / DMN | Amygdala 检测（主）/ Brainstem Block 4（辅） |

**`working` 的清除粒度**：`working` 记忆的生命周期绑定到 **Thread**，而非单个脑区的 LLM session。Thread Runner 在 Thread 状态变为 `complete` 时调用 `clearWorkingMemory(thread_id)` 批量清除。`working` 记录的 `session_id` 字段保留写入时的脑区 session ID（供调试追溯），但清除逻辑不依赖此字段——依赖 `tags` 中的 `thread_id` 标签。

**`episodic` 的审计边界**：`episodic` 记忆是认知衍生物，不是审计原始数据。它可以自由衰减和整理。审计完整性由 Event Bus → 外部不可变存储（WORM）保证，与 `episodic` 无关。

### 重要度字段

`importance` 被拆分为两个独立字段，分别承担不同语义：

| 字段 | 含义 | 由谁设置 | 是否衰减 |
|---|---|---|---|
| `base_importance` | 这条记忆的内在价值 | 写入时设定，Hippocampus 批量调整（基于 `usage_outcomes`） | 不自动衰减 |
| `pinned` | 受保护，永不衰减 | 写入时或人工标记 | 永不参与删除决策 |

检索排序使用 `base_importance + recency_boost`，其中 `recency_boost` 基于 `last_accessed_at` 动态计算，不持久化。删除决策基于 `last_accessed_at` 超过阈值 + `expires_at`，**不基于 base_importance 浮点数**。

| 类型 | 初始 base_importance | 理由 |
|---|---|---|
| `episodic` | 0.3 | 高频写入，单条价值低，靠时序读取而非权重检索 |
| `procedural` | 0.8 | Skill 是核心知识，高优先注入 |
| `semantic` | 0.6 | 中等稳定性 |
| `implicit` | 0.7 | 风险模式应被优先检索 |
| `working` | — | 持久化到 PG，但有限生命周期（Thread 完成时批量清除），不参与检索排序 |

`usage_outcomes`（新增字段）影响 `base_importance` 的方式：不实时修改——只累积计数器，由 Hippocampus 每日批量收敛（见第五节）。

---

## 三、事件分段（Episodic Segment）

### 概念

**Segment（事件段）** 是 episodic 记忆中一组具有内在连贯性的事件序列——对应一个认知上完整的"情节"：一次问题的从提出到解决、一个错误的发生与恢复、一次目标转换。

Segment 不是 Thread 的简单映射。一个 Thread 内可能包含多个 Segment（目标转换、错误恢复），一个 Segment 内的事件通常隶属同一 Thread。

### 两层分段

分段由两个运行单元协作完成，互不阻塞：

**DMN Reactive（粗分，准实时）**：在写 episodic 事件时，根据以下触发条件分配 `segment_id`：
- Thread 边界（新 Thread 开始 → 新 Segment）
- 目标变更（工作空间 Slot 的主任务描述发生变化）
- 错误恢复（`ALERT` 事件后重新激活）
- 话题切换（Limbic 判断输入显著偏离当前上下文）

当触发分段条件时：生成新 `segment_id`（UUID），后续同条件内的事件延续该 `segment_id`，`segment_seq` 从 0 递增。

**Hippocampus（精修，批量）**：在每日回放时，对已有段序列进行更深层的因果分析——根据事件内容语义拆分粒度过粗的段、合并相关性极强的相邻段。精修结果更新现有记录的 `segment_id`，不新增记录。

### Segment 元数据

Segment 自身的元数据写入 `semantic` 记忆，不建独立表：

```
entity_id:  "segment:{uuid}"
attribute:  "metadata"
content:    "## Segment {uuid}\n- 起止时间: ...\n- 事件数: N\n- 主要实体: ...\n- 摘要: ..."
type:       "semantic"
tags:       ["segment", "thread:{thread_id}"]
```

这样可以通过 `getEntityContext("segment:{uuid}")` 取到段元数据，通过 `getSegmentsByTimeRange()` 批量查询段列表（扫描 semantic 表中 tag 包含 "segment" 的记录），无需独立表。

### 段间关系

段之间的时间顺序由 `created_at` 推断，不存图边。需要"哪些段属于同一 Thread"时，通过 `thread_id` tag 过滤。需要"某个实体经历了哪些段"时，通过 `entity_id` 过滤 episodic 记录，再按 `segment_id` 聚合。

---

## 四、检索策略（按场景）

### 场景 A：通用语义检索（Block 4 兜底）

**使用方**：所有脑区（Context Assembly 兜底路径）
**生物学类比**：非特异性联想激活

**目标**：找到与当前消息/任务语义相关的历史知识。当脑区专属检索（场景 D/E/F）无结果时作为兜底。

**实现**：
- 全文搜索（ILIKE `%query%`）
- 按 `base_importance DESC, last_accessed_at DESC` 排序
- 返回 top-N 条，渲染为 Markdown 段落

**冷启动行为**：系统初始阶段记忆库为空，Block 4 返回空字符串或省略该 Block。随着使用积累，Block 4 内容自然增长。

**演进路径**：全文搜索 + 向量相似度搜索双路并行，RRF 融合重排（独立工程项目）。

---

### 场景 B：DMN 事件响应专用（事件流读取）

**使用方**：DMN Reactive
**生物学类比**：海马体短时工作记忆激活

**目标**：获取当前 Session 的事件历史，判断是否有错误或需要预测的行为。

**Session 锚点模式**：

长 Session 中，早期事件会随时间被挤出 LLM context window。DMN 的解法是定期写入 `episodic` 摘要锚点（`kind: session_anchor`），将之前的事件压缩成一条摘要记录追加到数据库。

DMN Reactive 每次看到的内容结构：
```
[最近一条 session_anchor 摘要]  ← 从 DB 取，Block 4 注入
+ [anchor 之后的增量事件]        ← created_at > anchor.created_at
```

对话历史始终是 append-only，不重写。

**回溯能力边界**：DMN Reactive 只对锚点以后的原始事件有精确感知能力；锚点以前的历史以摘要形式存在，细节不可还原。这是明确的能力边界，不是 bug。

---

### 场景 C：Amygdala 风险模式匹配

**使用方**：Amygdala
**生物学类比**：杏仁核快速危险识别

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

**冷启动行为**：系统初始阶段 `implicit` 记忆库为空，仅运行静态规则层。这是**预期行为，不是 bug**——静态规则是完整的第一道防线，动态 `implicit` 记忆是运行积累后的增强层。

---

### 场景 D：Limbic 实体中心检索（新增）

**使用方**：Limbic
**生物学类比**：语义网络扩散激活（以实体为锚点的知识网络激活）

**目标**：以特定实体（人/组织/项目/系统）为中心，检索围绕该实体的所有已知知识。

**方法**：`getEntityContext(entityId, opts?)`

**实现**：
1. 以 `entity_id = entityId` 为锚点，取所有相关记忆（`semantic` + 指定 `types`）
2. 若 `depth >= 1`：扫描这批记录中 `attribute = "related_to"` 的条目，提取关联实体的 `entity_id`，再次查询（关联展开）
3. 上限 `depth = 2`，防止过度展开

**示例**：Limbic 处理"Alice 发来的采购申请"时，`getEntityContext("colleague:alice")` 返回：
- Alice 的联系方式、工作风格、历史合作记录（semantic）
- Alice 所在部门（semantic，`attribute: "department"`）
- 与 Alice 关联的项目（semantic，`attribute: "related_to"`，depth=1 展开）

---

### 场景 E：Cortex 情境匹配（新增）

**使用方**：Cortex
**生物学类比**：前额叶皮层经验检索（"我处理过类似情况吗？"）

**目标**：给定当前任务描述，找出历史上处理过的相似情境和处理方式。

**方法**：`findSimilarSituations(situation, opts?)`

**实现**：
1. 以 `situation` 为 query，对 `episodic` 进行全文搜索（演进后：向量相似度）
2. 同时对 `procedural` 进行匹配（"这类任务有已知 Skill 吗？"）
3. 返回两类结果：历史情节（`episodes`）+ 相关流程（`procedures`）

**原型阶段与 `search()` 的区别**：原型阶段两者行为接近——`findSimilarSituations` 本质上等价于 `search(situation, {types: ['episodic', 'procedural']})` 再拆分返回。专属方法的价值在向量检索上线后才显著分化：`findSimilarSituations` 对 episodic 和 procedural 分别使用针对各自语义优化的向量空间，语义匹配能力远超通用 `search`。原型阶段接受这个局限。

---

### 场景 F：Brainstem 任务过程检索（新增）

**使用方**：Brainstem
**生物学类比**：程序性记忆直接调取（"我怎么做这类操作？"）

**目标**：给定任务类型，直接取出执行步骤（不经过情境推理）。

**方法**：`getProcedure(taskType, opts?)`

**实现**：
1. 以 `taskType` 为 query，对 `procedural` 记忆进行精确匹配（tag 匹配优先，全文搜索兜底）
2. 按 `base_importance DESC` 排序，高权重 Skill 优先
3. 返回可直接使用的执行指引

**与场景 E 的区别**：场景 E 返回历史情节（"上次是这么处理的"），场景 F 返回操作规程（"应该这么执行"）——前者是记忆，后者是方法论。

---

### 场景 G：Hippocampus 段回放（新增）

**使用方**：Hippocampus
**生物学类比**：海马体睡眠记忆重放（Sharp-Wave Ripples）

**目标**：批量读取一段时间内的事件序列，供 Hippocampus 提取跨段模式。

**方法**：
- `getSegmentsByTimeRange(range)`：获取指定时间范围内所有段的元数据列表
- `getSegmentSequence(segmentId)`：获取某个段内所有事件的完整序列（按 `segment_seq` 排序）

**实现**：
- `getSegmentsByTimeRange`：扫描 `semantic` 表中 `tags` 含 "segment" 且 `created_at` 在范围内的记录，返回 `{ segmentId, summary, eventCount }` 列表
- `getSegmentSequence`：查询 `episodic` 表中 `segment_id = segmentId` 的所有记录，按 `segment_seq ASC` 排序

详见第七节（Hippocampus 序列回放）。

---

## 五、检索即再巩固（Reconsolidation）

### 生物学来源

哺乳动物神经学中，记忆每次被检索都会进入不稳定状态，经历一次"再巩固"——成功使用的记忆变得更容易被检索，被证伪或不再适用的记忆可以被更新。

### 机制

**markUsed(ids, outcome)**：替代原有的 `markAccessed(ids)`。调用方不仅标记"被访问"，还提供执行结果作为反馈。

反馈来源（injected_memory_ids 的流转）：

```
Context Assembly（Block 4 组装）
  → 记录本次注入的记忆 IDs → injected_memory_ids 存入 BrainRunResult
Thread Runner 调用 activateBrain()
  → 收到 BrainRunResult（含 injected_memory_ids）
  → 存入当前 Thread 状态
脑区完成后（Brainstem 执行结束 / Limbic 响应发出）
  → DMN Reactive 订阅 brain.complete 事件
  → 评估执行结果（工具是否成功、用户是否满意、错误是否发生）
  → 调用 markUsed(injected_memory_ids, outcome)
```

### usage_outcomes 计数器

每条记忆新增 `usage_outcomes: { positive, negative, neutral }` 计数器（详见第九节数据模型）。

| outcome | 触发条件（示例） |
|---|---|
| `positive` | Brainstem 工具调用成功；用户确认回复满意；Cortex 推理最终被采纳 |
| `negative` | 工具执行出错；Cortex 推理被 DMN 标记为偏差；用户要求重做 |
| `neutral` | 其他情况 |

**不实时修改 base_importance**——只递增计数器，由 Hippocampus 批量收敛：

```
Hippocampus 每日批量：
  → 取 usage_outcomes 累积足够次数的记录
  → 计算 positive_ratio = positive / (positive + negative + neutral)
  → 正向比例高 → base_importance 小幅上调
  → 负向比例高 → base_importance 小幅下调
  → 其余不变
```

具体阈值（最小样本数、调整幅度）是上层应用的配置项，AIMA 框架只保证机制（计数器递增 + Hippocampus 批量收敛），不锁定策略参数。

---

## 六、Amygdala 显著性标记

### 机制

Amygdala 在 `tool.pre_use` 评估后，如果触发了规则匹配（无论最终放行还是拦截），向 Event Bus 发射的事件中携带 `significance_boost: float`。

`significance_boost` 的取值由 Amygdala 根据触发规则的严重程度决定：
- 无规则匹配 → 不携带此字段（或为 0）
- 动态规则命中（implicit 记忆匹配） → 较低正值
- 静态规则命中（正则/阈值） → 中等正值
- 硬底线触发（PII、不可逆操作、金额超限） → 较高正值

具体的分级数值是 Amygdala 的实现策略，属于上层应用配置，不在框架层锁定。

### 编码流程

DMN Reactive 订阅 Event Bus，在写 episodic 事件时：
- 若事件携带 `significance_boost > 0`：`base_importance = 初始值 + significance_boost`
- 这条 episodic 记录权重更高，Hippocampus 回放时优先处理

**效果**：风险相关的经历编码更深 → 检索时更容易被召回 → Hippocampus 回放优先处理 → 跨段模式提取时风险模式更容易浮现 → 沉淀为更高质量的 implicit 记忆。这复现了杏仁核对情绪/危险事件的增强编码机制。

---

## 七、Hippocampus 序列回放

### 生物学来源

海马体在睡眠中的 Sharp-Wave Ripples 会将白天的事件序列高速重放，用于：记忆巩固（将工作记忆转移到新皮层长期存储）、模式抽象（泛化经验为规律）、系统整合（将情节记忆整合进语义网络）。

AIMA 的 Hippocampus 每日批量执行，模拟这个过程。

### 回放流程

```
1. getSegmentsByTimeRange(过去 N 天)
   → 获取 M 个段的元数据列表（segmentId, summary, eventCount）

2. 优先级排序（按以下权重组合）：
   - 段内事件的平均 base_importance（高优先）
   - 段的最近访问时间（近期优先）
   - 段内是否含 significance_boost > 0 的事件（风险段优先）

3. 对 top-K 段（K 为可配置项，由上层应用决定）：
   getSegmentSequence(segmentId)
   → 获取该段内全部事件（含 significance_boost 信息、entity_id 等）

4. LLM 分析段序列（Haiku，低温度）：
   → 提取跨事件的因果模式："每次 X 发生后 Y 紧跟"
   → 识别可泛化的流程步骤："这类任务的标准处理路径是..."
   → 检测行为偏差："这个段内有错误恢复，原因是..."

5. 模式写入：
   → 可描述的事实规律 → semantic 记忆
   → 可操作的流程步骤 → procedural 记忆（待 Skill Review 固化）
   → 风险行为模式 → implicit 记忆（supplement/canonical）
```

### LLM 泛化即微扰

LLM 分析段序列时，同一个事件序列每次被分析都可能产生略有不同的语言表达——这正是生物系统中记忆再巩固时的"微扰"（perturbation）。与神经学类似，这种微扰使记忆保持动态，不固化为不可更新的"岩化"状态。

不需要额外的工程机制来实现微扰——LLM 的随机性（温度参数）自然提供这个效果。

### 巩固与系统整合

回放后写入的 semantic 记录通过 `entity_id` 与已有实体关联，通过 `supersedes_ids` 替代旧版本的事实——这实现了"系统巩固"（System Consolidation）：情节记忆（episodic）随着时间自然衰减，而其中的知识内核通过 Hippocampus 回放被提炼进 semantic/procedural，实现跨时间的知识积累。

---

## 八、子实例记忆隔离

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
3. 父实例的 DMN 决定哪些内容值得提升为持久记忆

### 实现方式

子实例在创建时接收一个 `read_only_memory: true` 标志。记忆服务在写入前检查此标志，拒绝非 `working` 类型的写入并返回错误（非异常，由子实例的 DMN 处理）。

---

## 九、记忆写入规范

每条记忆记录：

```
{
  id:               UUID
  type:             semantic | episodic | procedural | working | implicit
  content:          string（Markdown 格式）
  partition_id:     string（写入方脑区）
  session_id:       string | null（episodic 记录通常为 null——DMN 从 Event Bus 消费写入，
                                   不关联特定脑区 session；working 记录填写写入时的脑区 session ID 供调试追溯）
  entity_id:        string | null（这条记录描述的实体，如 "brain:cortex" / "skill:procurement" /
                                   "colleague:alice" / "segment:{uuid}"）
  attribute:        string | null（实体的哪个属性，如 "reliability" / "owner" / "status" /
                                   "metadata"（segment 元数据）/ "related_to"（实体关联）)
  base_importance:  float（内在价值，初始值见第二节）
  pinned:           boolean（true = 永不参与衰减/删除决策）
  source:           "brain" | "event_bus" | "dmn_consolidation" | "hippocampus"
  tags:             string[]（必填于 implicit；episodic segment 标签；其他类型可选）
  supersedes_ids:   UUID[]（写入时指定被替换的旧记录 ID，支持 1:N 和 N:1 场景）
  t_valid:          timestamp | null（这条事实在现实中开始成立的时间）
  t_invalid:        timestamp | null（这条事实在现实中失效的时间，null = 仍然有效）
  expires_at:       timestamp | null（系统层面的过期时间）
  forgotten:        boolean（软删除标志）
  last_accessed_at: timestamp
  created_at:       timestamp

  // 新增字段（全部 nullable，向后兼容）
  segment_id:       string | null（episodic 专用；所属事件段；DMN Reactive 写 episodic 时分配）
  segment_seq:      number | null（episodic 专用；段内序号，从 0 递增）
  usage_outcomes:   { positive: number, negative: number, neutral: number } | null
                    （累计使用反馈；默认 { positive: 0, negative: 0, neutral: 0 }；
                     仅由 markUsed() 递增，Hippocampus 批量收敛为 base_importance 调整；
                     不暴露到公共 SDK API）
}
```

**`entity_id` 和 `attribute` 是可选的轻量锚点**，不强制唯一约束。写入方尽力填写——尤其是 `semantic` 类型记录。当同一 `entity_id + attribute` 组合存在多条 `t_invalid=null` 记录时，检索方（LLM）基于 `created_at` 推断更新者，Hippocampus 定期清理矛盾记录并设置 `supersedes_ids`。

**双时态字段说明**：`t_valid` / `t_invalid` 记录**事实在现实中的有效期**；`created_at` / `expires_at` 记录**系统中的存储生命周期**。两组字段独立，不互相推导。

**事实更新的写入方式**：当某条 `semantic` 事实发生变化，调用方在写入新记录时提供 `supersedes_id` 指向旧记录。MemoryService 在同一事务内执行：INSERT 新记录 + 将旧记录的 `t_invalid` 设为当前时间。`t_invalid` 只能由 MemoryService 通过 `supersedes_id` 机制设置，调用方不得直接修改。

Context Assembly 检索默认只返回 `t_invalid IS NULL` 的记录（当前有效事实）。历史版本通过专用的 `getHistory()` 接口访问，不出现在通用检索路径上。

`episodic` 额外字段：
```
{
  kind:        "event" | "session_anchor"（普通事件 vs 会话摘要锚点）
  event_type:  string | null（来自 Event Bus 的事件类型，session_anchor 为 null）
  brain:       string（发射事件的脑区）
  thread_id:   string | null
  // segment_id / segment_seq 在公共字段中，episodic 专用
}
```

---

## 十、生命周期

```
写入 → 活跃（被检索命中 last_accessed_at 更新）→ 沉默（长时间未命中）→ 到期/超时 → 软删除

episodic 特殊路径：
Event Bus → DMN 消费 → 写入（kind=event，分配 segment_id/segment_seq）
→ Context 接近上限时，DMN 事件响应触发 anchor 写入（kind=session_anchor）
→ Amygdala 检测时 significance_boost > 0 → base_importance 增强
→ markUsed() 递增 usage_outcomes 计数器
→ Hippocampus 每日段回放 → 提炼模式至 semantic/procedural/implicit
→ Hippocampus 批量调整 base_importance（基于 usage_outcomes 正负比例）
→ Hippocampus 每日归档（超过 N 天的旧 event 条目软删除，anchor 保留更长）

procedural 特殊路径：
Cortex 生成 → first-party Skill → 重复使用 → markUsed(positive) 计数累积
→ Hippocampus Skill Review 固化 → 高 base_importance
```

---

## 十一、MemoryService 接口抽象

记忆层应通过统一接口对上层脑区暴露能力，后端实现可替换。

```typescript
interface MemoryService {
  // 通用写入；supersedes_id 非空时在事务内同时失效旧记录
  write(entry: MemoryEntry): Promise<void>

  // 场景 A：通用语义检索（Block 4 兜底，默认只返回 t_invalid IS NULL）
  search(query: string, filters: MemoryFilters): Promise<MemoryEntry[]>

  // 场景 B：DMN Reactive 专用——返回最近 session_anchor + 其后的增量 event
  // sessionId 是被监控的脑区 session ID（如 Limbic 或 Brainstem 的 session），
  // 不是 DMN 自己的 session（DMN Reactive 不使用 LLM session）。
  // 来源：Thread Runner 在 activateBrain() 后将 BrainRunResult.session_id 存入 Thread 状态，
  // DMN 订阅 brain.complete 事件时从事件 payload 取到此 ID。
  getSessionContext(sessionId: string): Promise<{
    anchor: MemoryEntry | null
    events: MemoryEntry[]
  }>

  // 场景 C：Amygdala implicit 记忆分级检索
  getByTags(tags: string[], timeRange?: TimeRange, limit?: number): Promise<MemoryEntry[]>

  // 场景 D：Limbic 实体中心检索（新增）
  // 以 entityId 为锚点，沿 "related_to" attribute 展开 depth 层关联实体
  getEntityContext(entityId: string, opts?: {
    depth?: number        // 关联展开深度，默认 1，上限 2
    types?: MemoryType[]  // 过滤类型，默认 ['semantic', 'episodic', 'procedural']
    limit?: number        // 每层结果上限，默认 20
  }): Promise<MemoryEntry[]>

  // 场景 E：Cortex 情境匹配（新增）
  // 返回历史上相似的情节（episodic）和相关流程（procedural）
  findSimilarSituations(situation: string, opts?: {
    limit?: number  // 每类结果上限，默认 10
  }): Promise<{ episodes: MemoryEntry[]; procedures: MemoryEntry[] }>

  // 场景 F：Brainstem 任务过程检索（新增）
  // tag 匹配优先，全文搜索兜底，仅返回 procedural 类型
  getProcedure(taskType: string, opts?: { limit?: number }): Promise<MemoryEntry[]>

  // 场景 G：Hippocampus 段回放（新增）
  getSegmentSequence(segmentId: string): Promise<MemoryEntry[]>
  getSegmentsByTimeRange(range: TimeRange): Promise<{
    segmentId: string
    summary: string
    eventCount: number
    avgImportance: number
    hasRiskEvents: boolean
  }[]>

  // 使用反馈（升级自 markAccessed）
  // 脑区完成后由 DMN Reactive 调用；ids 来自 BrainRunResult.injected_memory_ids
  markUsed(ids: string[], outcome: 'positive' | 'negative' | 'neutral'): Promise<void>

  // 纯访问记录（不带 outcome 语义），等价于 markUsed(ids, 'neutral')
  // 适用于只读查询场景（Shadow Mode 审计、Hippocampus 内部扫描），语义更清晰
  markAccessed(ids: string[]): Promise<void>

  // 反向查询：给定一条旧记录的 ID，返回所有取代它的新记录
  // TODO: 待定——当前无明确使用场景。Hippocampus 直接读 supersedes_ids 字段即可完成清理。
  getSupersededBy(oldRecordId: string): Promise<MemoryEntry[]>

  forget(id: string): Promise<void>
}

interface MemoryFilters {
  types?: MemoryType[]
  entity_id?: string
  segment_id?: string
  tags?: string[]
  limit?: number
  timeRange?: TimeRange
}

interface TimeRange {
  from: Date
  to?: Date  // null 表示至今
}
```

每个方法对应一个规定的访问场景，调用方不应跨场景混用接口。

**失败处理**：记忆读写失败不中断认知主流程——记忆是辅助系统，不在控制流关键路径上。`write()` 返回的 Promise 可以 reject，调用方必须 catch 并自行决定是否重试；不得让 reject 变为未捕获的异常传播到认知主流程。

原型阶段后端：PostgreSQL + 全文搜索。演进路径：加 pgvector 支持向量检索，必要时迁移至 Qdrant 或 Graphiti（支持实体关系图 + 双时态查询）。接口不变，后端替换对上层透明。

---

## 十二、当前阶段局限与演进

| 局限 | 影响 | 演进方向 |
|---|---|---|
| 场景 A/D/E/F 只有全文搜索 | 语义相近但词汇不同的内容无法命中 | 向量嵌入 + BM25 双路 + RRF 融合（独立工程项目） |
| `episodic` 段分配是 DMN Reactive 粗分 | 段边界可能与认知边界不完全一致 | Hippocampus 精修补偿；精度随积累提高 |
| `usage_outcomes` 调整需 Hippocampus 批量收敛 | 单次使用反馈不立即影响检索排序 | 这是有意设计——防止单次噪音干扰；批量收敛足够快（每日） |
| `implicit` 写入无去重机制 | 语义重叠的模式会累积 | Hippocampus 每日聚类合并（已有设计，见第七节）|
| Hippocampus 段回放消耗 LLM 调用 | 每日一次，但批量处理是较重的操作 | 控制 K（回放段数上限），低负载时段调度 |
| `session_anchor` 是 LLM 生成的摘要 | 有失真风险，细节不可还原 | 明确的能力边界，不是待修复的缺陷 |

当前阶段（原型）：接受全文搜索的局限，通过 MemoryService 接口抽象确保后端可替换，数据结构为向量检索演进预留字段位置。
