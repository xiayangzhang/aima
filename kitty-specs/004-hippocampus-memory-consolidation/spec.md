# Feature Specification: Hippocampus Memory Consolidation

**Feature**: 004-hippocampus-memory-consolidation
**Status**: Draft
**Created**: 2026-03-11
**Depends on**: Feature 001 (Workspace Schema), Feature 002 (Brain Runtime), Feature 003 (DMN)

---

## Overview

AIMA 的记忆系统在日常运行中不断积累 episodic 记录、usage 反馈和事件段标注，但这些数据不会自动变成可复用的知识。Hippocampus Consolidation（海马体巩固）是每日低负载时段运行的批量后台进程，负责将原始积累转化为高质量记忆：

- 将 DMN Reactive 粗分的事件段精修为语义边界清晰的段
- 对高价值段做序列回放，提炼跨事件的因果模式和可操作流程
- 根据各条记忆的使用反馈批量收敛重要度权重
- 清理过期记忆，维持存储健康

Hippocampus Consolidation 是纯后台基础设施，不参与实时决策，不改变用户可见行为，但持续提升 AIMA 实例的长期知识质量。

---

## Actors

- **AIMA 实例**（系统）：Hippocampus Consolidation 的唯一执行主体，不需要人类触发或干预
- **运维人员**：配置运行时间窗口、回放 top-K、usage_outcomes 收敛阈值等参数
- **上层应用**：通过 AIMAInstance 配置项控制 Hippocampus 是否启用及运行参数

---

## Problem Statement

AIMA 在实时运行中积累的原始数据存在以下问题：

1. **段边界不精确**：DMN Reactive 按 Thread 边界/错误/话题切换粗分事件段，无法做深层因果分析——同一场景下的不同对话轮次可能被错误地切分或合并
2. **知识未提炼**：高价值 episodic 序列中隐含的可泛化规律（事实、流程、风险模式）停留在原始记录中，无法被高效检索和复用
3. **重要度权重滞后**：记忆使用反馈（markUsed）只递增计数器，实际重要度未调整，导致高质量记忆和低质量记忆被同等对待
4. **存储自然膨胀**：过期记忆占用存储，影响检索排序和系统性能

---

## Functional Requirements

### FR-01：段精修

系统每日批量读取近 N 天（可配置）内的 episodic 记录，对 DMN Reactive 粗分的事件段做深层因果分析，识别需要拆分或合并的段，更新 `segment_id` 字段。精修必须在段序列回放前完成，不新增记录，只更新字段。

**验收条件**：
- 运行后，同一 Thread 内因果断裂的粗分段被拆分为两个逻辑独立的段
- 运行后，相邻 Thread 中属于同一连续推理的段被合并（segment_id 统一）
- 原始 episodic 记录数量不变，只有 segment_id/segment_seq 字段更新

### FR-02：段序列回放

对最近 N 天内按重要度/recency/显著性排序的 top-K 段（K 可配置），依次获取完整事件序列，发起一次性 LLM 调用进行因果模式分析，将提炼结果写入记忆：

- 事实规律 → semantic 记忆（关联已有实体，通过 supersedes_ids 替代旧版本）
- 可操作流程步骤 → procedural 记忆（更新 Skill Index）
- 风险行为模式 → implicit 记忆

**验收条件**：
- 每个被回放的段至少触发一次 LLM 调用
- 回放结果写入对应类型的记忆条目，entity_id/segment_id 字段正确关联
- 回放失败（LLM 报错/超时）时单个段回放失败不中断整体流程，记录错误日志并继续
- 每日最多回放 K 个段（不超限）

### FR-03：usage_outcomes 收敛

批量读取所有 `usage_outcomes` 非零的记忆条目，根据正负比例小幅调整 `base_importance`（阈值和步长由上层配置，框架不锁定默认值），重置计数器。收敛是批量操作，单次 markUsed 不立即影响检索排序。

**验收条件**：
- 高正向反馈（positive 比例超过阈值）的记忆 base_importance 上升
- 高负向反馈（negative 比例超过阈值）的记忆 base_importance 下降（但不低于最小值 0）
- 收敛后 usage_outcomes 计数器清零（等待下一个 Consolidation 周期重新积累）
- base_importance 调整有上下界（0.0 ~ 1.0），不溢出

### FR-04：过期清理

将 `expires_at < now()` 且 `pinned = false` 的记忆条目软删除（`forgotten = true`）；将 `last_accessed_at` 超过阈值（可配置）且 `pinned = false` 的记忆条目标记为候选删除，候选删除条目在下一周期清理前可人工干预恢复。

**验收条件**：
- `expires_at < now()` 且 `pinned = false` 的条目 forgotten 字段设为 true
- `pinned = true` 的条目不被清理，无论是否过期
- 清理操作是软删除（forgotten 标记），不物理删除记录（支持审计和恢复）

### FR-05：顺序约束与幂等性

Consolidation 四个步骤按固定顺序执行：段精修 → 段序列回放 → usage_outcomes 收敛 → 过期清理。每个步骤幂等：重复运行不产生重复副作用（段精修不重复更新已精修的段；段序列回放通过 supersedes_ids 避免重复写入；收敛检查计数器非零再执行；清理只处理未 forgotten 的条目）。

**验收条件**：
- 同一天内运行两次，第二次运行结果与第一次一致（无额外变更）
- 前一步骤失败时后续步骤不执行（fail-fast 但保证当前步骤原子性）

### FR-06：生命周期控制

Hippocampus Consolidation 作为 AIMAInstance 的可选组件：
- `enableHippocampus: true`（默认 false）时随 `instance.start()` 启动调度器
- `instance.stop()` 时优雅停止调度器（当前运行的 Consolidation 完成后退出，不强制中断）
- 支持配置每日运行时间窗口（`hippocampus.runAt`，如 `"03:00"`）

**验收条件**：
- start() 后调度器按配置时间触发，stop() 后不再触发
- stop() 调用时若 Consolidation 正在运行，等待当前任务完成后退出（超时 60s 后强制退出）

---

## User Scenarios

### 场景 1：首次 Consolidation — 知识从 episodic 中浮现

**背景**：AIMA 实例运行了一周，积累了大量 episodic 事件记录，但 semantic/procedural 记忆相对稀疏。

**流程**：
1. 夜间 Consolidation 运行，读取最近 7 天内的 episodic 事件段
2. 段精修：发现同一会议记录跨两个 Thread 被粗分为两个段，合并为一个完整的"会议段"
3. 序列回放：对高重要度的"会议段"做 LLM 分析，提取"该类会议通常需要起草会议记录后发送给与会者"这一流程步骤，写入 procedural 记忆
4. 下次 Brainstem 处理同类场景时，Block 4 检索到该 procedural 记忆，减少 LLM 推理步骤

**期望结果**：
- 会议处理流程从 episodic 中提炼进 procedural，可直接复用
- Brainstem 处理同类场景时 getProcedure() 命中率提升

### 场景 2：负面反馈导致低质量记忆边缘化

**背景**：某条 procedural 记忆描述了一个已失效的审批流程，DMN Reactive 多次将其标记为 negative（执行后被用户否定）。

**流程**：
1. Consolidation 读取该记忆的 usage_outcomes：positive=1, negative=5, neutral=2
2. negative 比例超过阈值，base_importance 下降（如从 0.7 → 0.5）
3. 下次检索时该记忆排名下降，不再轻易进入 Block 4 注入窗口
4. 新的正确流程通过新的 episodic + 回放写入，逐步替代旧记忆

**期望结果**：
- 旧流程记忆不被立即删除（保持审计链完整），但检索优先级降低
- 新流程通过自然积累写入，系统自愈

### 场景 3：段精修修正粗分边界

**背景**：一次复杂问题处理横跨了两个 Thread（中途系统重启），DMN Reactive 将其分为两个独立的段。

**流程**：
1. 段精修读取两个相邻段，通过 LLM 因果分析识别到两段属于同一逻辑流程（相同实体、连续推理链）
2. 将第二段的事件更新 segment_id 指向第一段，统一为一个连续的"问题处理段"
3. 序列回放时以完整的连续段为单位进行模式提取，避免碎片化分析

**期望结果**：
- 段边界从 Thread 边界修正为语义边界
- 后续回放基于语义完整的段，提炼质量更高

### 场景 4：过期清理维护存储健康

**背景**：AIMA 实例运行一年后，早期的 episodic 记忆大量过期（expires_at 已过，未设置 pinned）。

**流程**：
1. 过期清理步骤读取 expires_at < now() 且 pinned=false 的记录
2. 批量将其 forgotten 字段设为 true
3. 后续检索默认过滤 forgotten=true 的记录，存储占用统计降低

**期望结果**：
- 过期记忆从检索视图中退出，但原始记录保留（支持合规审计）
- 重要的、高频使用的记忆通过 pinned=true 或高 base_importance 免于清理

### 场景 5：Consolidation 优雅停止

**背景**：运维人员在 Consolidation 进行到段序列回放时调用 instance.stop()。

**流程**：
1. stop() 发送停止信号给调度器
2. 调度器等待当前 Consolidation 任务完成（最长 60 秒超时）
3. 当前任务在当前步骤完成后，优雅退出
4. 下次 start() 时，Consolidation 在配置的时间窗口重新启动

**期望结果**：
- 已完成的步骤结果被保留
- 不会产生半完成的段精修或部分回放的不一致状态

---

## Success Criteria

1. **知识提炼有效**：集成测试验证：给定已知 episodic 序列，Consolidation 运行后 semantic/procedural 记忆中有新条目写入，内容与序列相关
2. **段精修改善段边界**：集成测试验证：人为制造跨 Thread 连续场景，精修后相关 episodic 的 segment_id 被统一
3. **重要度收敛方向正确**：单元测试验证：正向反馈占多数时 base_importance 上升，负向反馈占多数时下降，边界值不溢出
4. **过期清理不丢数据**：清理后 forgotten=true 的记录仍可通过数据库直接查询（物理记录保留）
5. **顺序约束可观测**：段精修步骤失败时，后续步骤不执行（集成测试通过 mock 注入错误验证）
6. **生命周期无泄漏**：stop() 后调度器不再触发，不产生悬挂后台任务（单元测试验证）

---

## Key Entities

| 实体 | 描述 |
|---|---|
| `MemoryEntry` | 所有记忆的基础实体，含 segment_id、usage_outcomes、base_importance、expires_at、pinned、forgotten 字段 |
| `segment_id` | 事件段标识符，多条 episodic 记录共享同一 segment_id 表示属于同一逻辑事件段 |
| `segment_seq` | 段内序号，标记事件在段内的顺序位置 |
| `usage_outcomes` | 使用反馈计数器 { positive, negative, neutral }，由 markUsed 写入，Consolidation 读取并重置 |
| `base_importance` | 记忆内在价值权重（0.0-1.0），影响检索排序 |
| `HippocampusConsolidation` | 批量巩固进程，内含四个顺序执行的步骤 |

---

## Assumptions

1. **运行时间窗口**：默认每日 03:00 运行（上层可配置），以当前实例的本地时区为准
2. **回放窗口**：默认查询近 7 天的段；top-K 默认 K=5（上层配置，框架不锁定）
3. **收敛步长**：positive 比例 > 60% 时 base_importance +0.05；negative 比例 > 60% 时 -0.05（框架提供合理默认值，上层可覆盖）
4. **LLM 调用模型**：Haiku（低成本），与 DMN callLlm 复用同一封装
5. **段精修范围**：只精修近 N 天内的段，不全库扫描
6. **幂等窗口**：每个 Consolidation 周期（24 小时）内调度器只触发一次，防止重叠

---

## Out of Scope

- **Skill 质量评估**：Skill Review 由 Cortex 负责（DMN 触发），Hippocampus 只维护 Skill Index 元数据
- **即时重要度调整**：markUsed 写入反馈后不立即调整排序（批量收敛设计，防止单次噪音）
- **向量检索**：当前 Recall 使用 ILIKE，向量检索为未来演进
- **管理 UI**：参数通过配置文件调整，不提供可视化界面

---

## Dependencies

- **Feature 001**：CognitiveWorkspace、MemoryService 基础接口、memories 表 schema（含 segment_id、usage_outcomes、base_importance、forgotten、pinned 字段）
- **Feature 002**：AIMAInstance（生命周期集成点）
- **Feature 003**：DMN Reactive 写入的 segment_id/usage_outcomes 是 Consolidation 的输入数据；callLlm 封装复用
