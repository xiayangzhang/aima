# Hippocampus — 记忆系统

> **版本**: v2.0
> **状态**: 草稿

---

## 一、角色定位

Hippocampus 是 AIMA 的**完整记忆实体**，不是"记忆数据库旁边的批处理进程"。它统一拥有数据、读写接口和巩固逻辑，五脑通过 Hippocampus 的接口与记忆交互，不直接操作底层存储。

### AIMA 是器官，不是灵魂

Hippocampus 提供记忆的物理基础：写入路径、检索策略、巩固机制——这是器官层面的工作。

**Hippocampus 不判断对错**。它巩固的是被观察到的模式，不是客观真理。什么是"好的"决策，由 soul.md 和角色文件的价值观定义；Hippocampus 按此学习，不按 AIMA 内置的评判标准。

### 三个子模块

```
Hippocampus
├── Encoding      — 编码层：实时写入路径（唯一写入入口）
├── Recall        — 检索层：实时读取路径（唯一读取入口）
└── Consolidation — 巩固层：批量后台，每日低负载时段运行
```

| 子模块 | 性质 | 职责 |
|---|---|---|
| **Encoding** | 实时同步 | 所有记忆写入的唯一入口 |
| **Recall** | 实时同步 | 所有记忆读取的唯一入口 |
| **Consolidation** | 批量异步（每日） | 段精修 → 段序列回放 → 使用反馈收敛 → 过期清理 |

Consolidation 不对外暴露接口，不参与实时决策，不走 BrainAdapter，不持有持久 LLM session。每次回放任务发起一次性 LLM 调用（Haiku，无对话历史，独立请求）——与 DMN Reactive 的偶发 LLM 调用性质相同。

---

## 二、五种记忆类型

**划分依据是访问模式，不是内容类型**。四种不同的读写频率和检索策略，若合并进同一接口会互相干扰。

| 类型 | 功能角色 | 主要写入方 | 主要读取场景 | 初始 base_importance |
|---|---|---|---|---|
| `semantic` | 长期知识（实体、关系、事实） | Limbic / Cortex / Consolidation | 所有脑区 | 0.6 |
| `episodic` | 认知事件流（DMN 从 Event Bus 派生的压缩摘要） | DMN（经 Encoding） | DMN 回溯 / Consolidation 回放 | 0.3 |
| `procedural` | 技能库（Skill 化的流程模式） | Cortex（经 Encoding） | Brainstem 执行前 / Context Assembly | 0.8 |
| `working` | 会话暂存（当前 Thread 的临时状态） | 所有脑区（经 Encoding） | 当前 Thread 内 | — |
| `implicit` | 风险模式（Amygdala 规则的动态补充） | Amygdala / DMN（经 Encoding） | Amygdala 每次工具调用前 | 0.7 |

### 关键说明

**`working` 的生命周期**：持久化到 PostgreSQL，但绑定 Thread。Thread Runner 在 Thread 状态变为 `complete` 时调用 `Encoding.clearWorkingMemory(thread_id)` 批量清除。

**`episodic` 的审计边界**：`episodic` 是认知衍生物，可以自由衰减和整理。审计完整性由 Event Bus → WORM 保证，与 `episodic` 数据库记录无关。

**`episodic` 记录行为，不记录原始输入**：`content` 描述脑区的决策和动作（"Limbic 判断需要 Cortex 参与，路由给 Cortex"），不复制外部消息文本。

---

## 三、两种记忆访问模式

记忆系统对脑区提供两种互补的访问模式，分别服务于不同的认知需求。

### 模式一：Block 4 冷启动推送（被动）

Thread Runner 在激活脑区前，根据 Thread trigger 内容组装冷启动上下文，注入 Block 4。这是轻量的起点——给脑区"进屋前自然想起的背景知识"，不追求完整，只做引导。

- Block 4 无结果时直接省略，脑区基于 Block 1/2/3 运行
- 检索 query 来自 Thread trigger（外部输入的摘要）
- 适合：领域背景、相关实体历史、常用流程步骤

### 模式二：MCP 工具主动拉取（主动）

脑区在推理过程中，可通过 MCP 工具主动向 Hippocampus 查询。脑区推理到一半才知道需要什么——这个时机和查询内容，Block 4 预测不了。

各脑区的专属工具：

| 脑区 | 工具 | 典型使用场景 |
|---|---|---|
| **Limbic** | `memory_get_entity(entityId)` | 推理中发现实体名，立即展开关系网络 |
| **Cortex** | `memory_find_similar(situation)` | 分析到一半，主动查"上次类似情况怎么处理的" |
| **Brainstem** | `memory_get_procedure(taskType)` | 执行前确认操作步骤 |
| **Amygdala** | `memory_get_by_tags(tags)` | 工具调用前查询历史风险模式 |
| **所有脑区** | `memory_search(query)` | 通用兜底 |

> ⚠️ **P2-D 已知限制（语义搜索天花板）**：当前所有 Recall 方法底层是 ILIKE 全文搜索，语义相近但词汇不同无法命中。`memory_find_similar` 实质是关键词匹配，Cortex"见过类似情境"的能力基本失效。
>
> **设计目标**：pgvector + embedding on write，双路检索（向量 + BM25）+ RRF 融合重排；接口不变，实现升级。Stage 2 Amygdala implicit 检索同样依赖此基础设施。

**两种模式的职责边界**：Block 4 是框架的预判，工具调用是脑区自己的认知决策。不需要 hint 机制——脑区知道自己需要什么时，直接调工具。

---

## 四、Consolidation 四步（严格顺序）

**执行顺序约束**：步骤 1 产生的 `segment_id` 是步骤 2 的输入，必须严格按顺序执行：

### 步骤 1：段精修

对 DMN Encoding 粗分的段做深层因果分析，必要时拆分或合并——更新 episodic 记录的 `segment_id` 字段（不新增记录，豁免"持久化历史不重写"原则，因为 `segment_id` 不进入 LLM prompt，修改不影响 cache）。

### 步骤 2：段序列回放

```
getSegmentsByTimeRange(过去 N 天)
→ 按 avg(base_importance) / recency / significance_boost 排序
→ 对 top-K 段（K 为上层配置项）：
   getSegmentSequence(segmentId)
   → LLM 分析事件序列（低温度，一次性调用）：
     - 提取跨事件因果模式
     - 识别可泛化流程步骤
     - 检测行为偏差
→ 模式写入：
   事实规律 → semantic
   流程步骤 → procedural（更新 Skill Index；价值判断交给 Cortex）
   风险模式 → implicit
```

回放写入的 semantic 通过 `entity_id` 关联已有实体，通过 `supersedes_ids` 替代旧版本。episodic 随时间自然衰减，知识内核通过回放提炼进 semantic/procedural，实现跨时间积累。

### 步骤 3：使用反馈收敛

批量读取 `usage_outcomes` 计数器，根据正负比例小幅调整 `base_importance`（具体阈值和步长为上层配置项，框架不锁定默认值）。

单次反馈不直接修改权重——这是有意设计，防止单次噪音驱动权重剧烈波动；Consolidation 批量收敛每日执行。

> ⚠️ **P2-C 已知限制**：当前反馈信号质量较低（`mode === 'RESPOND'` 直接 → `positive`），会影响 `base_importance` 收敛的准确性。随 DMN 反馈信号改进后自然收益。

### 步骤 4：过期清理

- `expires_at < now()` 且 `pinned = false` → 软删除（`forgotten = true`）
- `last_accessed_at` 超过阈值且 `pinned = false` → 候选删除

---

## 五、实体模型

AIMA 的 `semantic` 记忆以**实体**（entity）为基本单位对世界建模。

### AIMA 内部实体（框架保留）

| entity_type | 示例 entity_id | 说明 |
|---|---|---|
| `brain` | `brain:cortex`、`brain:limbic` | 五个脑区各有实体记录，支持元认知 |
| `skill` | `skill:procurement-approval` | Skill 实体（认知层）与 Skill 文件（操作层）分离 |
| `instance` | `instance:self` | 实例整体自我描述（能力边界、当前工作状态、已知局限） |

**大脑是实体**：DMN 将观察到的脑区行为模式写入 `implicit` 记忆（如"Cortex 在多步数学任务上的可靠性较低"），使路由和风险评估能从自身历史中学习——这是 AIMA 元认知能力的底层机制。

**Skill 是实体**：Skill 文件是 Agent 运行时读取的可执行知识；Skill 实体记录是 AIMA 对这个 Skill 的认知积累（使用历史、版本关系、适用场景模式）。Hippocampus 维护 Skill Index；Cortex 基于实体记录评估 Skill 的健康度和固化时机（DMN 心跳整合检测到固化模式后触发）。

### 应用层实体（自由扩展）

应用层在框架保留的三个 `entity_type` 之外自由扩展（同事、供应商、内部系统、组织部门、其他 AIMA 实例等），与内部实体共存于同一记忆池，互不冲突。

框架只提供 `entity_id` 和 `attribute` 两个索引字段；具体属性模型由应用层定义。

---

## 六、Skill Review 归属说明

**评估 Skill 质量是认知判断，由 Cortex 执行，不由 Hippocampus 执行**。

Hippocampus 的职责：

- 维护 Skill 实体（`entity_id = "skill:*"`）的索引元数据
- 追踪 Skill 使用统计（`usage_outcomes`、`last_accessed_at`）
- 向 Cortex 提供查询接口

Hippocampus 不判断"这个 Skill 是好是坏"——那是认知判断，超出物理基础的职责范围。

Skill Review 触发链：

```
DMN 心跳整合检测到某 Skill 固化模式
→ 写 pending_observations（target_brain = 'cortex'）
→ Thread Runner 路由给 Cortex
→ Cortex Skill Review：评估、固化或废弃
→ 写入 first-party Skill 文件 + 更新 Skill Index（通过 Encoding）
```

---

## 七、检索排序与重巩固（Reconsolidation）

检索排序：`base_importance + recency_boost`（`recency_boost` 基于 `last_accessed_at` 动态计算，不持久化）。

`markUsed(ids, outcome)` 机制实现反馈闭环：

```
Context Assembly（Block 4）→ Recall 记录注入的记忆 IDs
                           → injected_memory_ids 存入 BrainRunResult
Thread Runner 存入当前 Thread 状态
脑区完成后（brain.complete 事件）
  → DMN Reactive 评估执行结果
  → Encoding.markUsed(injected_memory_ids, outcome)
  → usage_outcomes 计数器递增
Consolidation 每日批量收敛
  → 根据累积比例调整 base_importance
```

| outcome | 触发条件示例 |
|---|---|
| `positive` | 工具调用成功；用户确认满意；推理被采纳 |
| `negative` | 工具执行出错；推理被 DMN 标记为偏差；用户要求重做 |
| `neutral` | 纯读取访问（`markAccessed` 的语义等价） |

---

## 八、三轴组织

记忆通过三种轴组织，靠检索策略实现，不靠数据模型膨胀：

| 轴 | 概念 | 实现方式 |
|---|---|---|
| **因果链** | 段内事件因果序列 | `segment_id` + `segment_seq` 字段 |
| **时间容器** | Thread → Segment 两层时间层级 | `thread_id` + `segment_id` |
| **实体驱动** | 以实体为中心的星形拓扑 | `entity_id` + `getEntityContext()` 深度展开 |

底层存储永远保持**扁平完整**——审计系统直接读扁平表，不需要理解认知层抽象。认知层抽象（三轴）是读取视图，不改变底层结构。

---

## 九、存储原则

**持久化历史只追加、不重写**：持久化的对话历史记录不允许重写或删除，这是保护 LLM prompt cache hit rate 的核心原则。重写会改变 context prefix，导致缓存失效。

**豁免：认知标注字段可更新**。`segment_id`、`entity_id` 等字段不进入 LLM prompt，修改不影响 cache。Consolidation 段精修时可更新 `segment_id`，不违反本原则。

---

## 十、当前阶段局限

| 局限 | 影响 | 演进方向 |
|---|---|---|
| 所有 Recall 方法底层是 ILIKE 全文搜索 | 语义相近但词汇不同无法命中 | pgvector + BM25 双路 + RRF 融合（独立工程项目） |
| 复合检索（Limbic/Cortex）是多次单类型查询合并 | 跨类型相关性排序不准 | 向量检索上线后升级，接口不变 |
| DMN 段分配是粗分 | 段边界可能不精确 | Consolidation 每日精修补偿 |
| usage_outcomes 收敛需 Consolidation 批量运行 | 单次反馈不立即影响检索排序 | 有意设计，防止单次噪音；批量收敛每日执行 |
| session_anchor 是 LLM 生成摘要 | anchor 后对话历史仅有摘要，细节有丢失风险 | Limbic 在对话中检测到重要约束/偏好时主动写入 structured semantic 记忆作为补偿 |
