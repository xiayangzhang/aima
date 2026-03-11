# Tasks: Hippocampus Memory Consolidation (Feature 004)

## 工作包总览

| WP | 标题 | 子任务 | 依赖 | 优先级 | 估计行数 |
|---|---|---|---|---|---|
| WP01 | callLlm 迁移 + 基础设施 + CognitiveWorkspace 扩展 | T001-T007 | — | P0 | ~420 |
| WP02 | 步骤 1：段精修 | T008-T012 | WP01 | P0 | ~300 |
| WP03 | 步骤 2：段序列回放 | T013-T017 | WP01 | P0 | ~320 |
| WP04 | 步骤 3+4：usage_outcomes 收敛 + 过期清理 | T018-T021 | WP01 | P0 | ~250 |
| WP05 | 单元测试 | T022-T027 | WP01-WP04 | P1 | ~350 |
| WP06 | 集成测试 | T028-T033 | WP01-WP04 | P1 | ~360 |

---

## WP01 — callLlm 迁移 + 基础设施 + CognitiveWorkspace 扩展

**目标**：将 callLlm 提取到共享工具层；建立 HippocampusConsolidation 类骨架、调度器、生命周期；扩展 CognitiveWorkspace 6 个新方法；更新 AIMAInstance。

子任务：
- [x] T001: 将 callLlm + parseLlmJson 从 src/dmn/llm.ts 迁移至 src/llm.ts（LlmConfig 类型），更新 DMN 所有 import 路径，删除 src/dmn/llm.ts
- [ ] T002: HippocampusConfig 类型 + HippocampusConsolidation 类骨架（构造函数 + runConsolidation() 顺序调用四步 stub）
- [ ] T003: 调度器实现：start()（setTimeout 计算距 runAt 的延迟）+ stop()（60s 超时优雅退出 + running flag 防重入）
- [ ] T004: CognitiveWorkspace 扩展：getSegmentsByTimeRange + getSegmentSequence
- [ ] T005: CognitiveWorkspace 扩展：updateMemorySegment
- [ ] T006: CognitiveWorkspace 扩展：getMemoriesWithNonZeroOutcomes + updateMemoryImportanceAndResetOutcomes
- [ ] T007: CognitiveWorkspace 扩展：forgetExpiredMemories；AIMAInstance 集成（enableHippocampus）；src/index.ts 导出

**Prompt**: WP01-infra-llm-migration-workspace-extensions.md
**并行机会**: T004/T005/T006/T007 的 workspace 扩展可并行实现（独立方法），合并前类型检查即可
**依赖**: 无

---

## WP02 — 步骤 1：段精修

**目标**：实现 runSegmentRefine()，调用 getSegmentsByTimeRange 获取候选合并段对，通过 LLM 判断是否合并，执行合并更新。

子任务：
- [ ] T008: runSegmentRefine(workspace, config, llmConfig)：获取 lookbackDays 内的段列表，形成相邻段对（限制 50 对）
- [ ] T009: 段合并 LLM 调用：prompt 组装（两段 context 摘录）+ callLlm + parseLlmJson（失败默认 merge: false）
- [ ] T010: 执行合并更新：merge=true 时将第二段所有 episodic 记录 segment_id 改为第一段，重新编号 segment_seq
- [ ] T011: 幂等保护：in-memory Set 跟踪本次已更新的段，防止重复合并
- [ ] T012: 错误处理：单对合并失败不中断整体，warn 日志继续下一对；在 runConsolidation 中注册为步骤 1

**Prompt**: WP02-segment-refinement.md
**依赖**: WP01

---

## WP03 — 步骤 2：段序列回放

**目标**：实现 runSequenceReplay()，选取 top-K 高重要度段，对每段发起一次性 LLM 分析，将提炼结果写入 semantic/procedural/implicit 记忆。

子任务：
- [ ] T013: runSequenceReplay(workspace, config, llmConfig)：getSegmentsByTimeRange → 按 avgImportance DESC + maxCreatedAt DESC 排序 → 取 top-K
- [ ] T014: 获取段序列并组装 LLM prompt：getSegmentSequence + content 摘录 + 要求返回三类 JSON
- [ ] T015: LLM 调用 + parseLlmJson：解析 semantic/procedural/implicit 数组；解析失败跳过该段
- [ ] T016: 写入 semantic + procedural 记忆：supersedesId 去重（searchMemory 先查，存在时设 supersedesId + invalidateMemory 旧记录）
- [ ] T017: 写入 implicit 记忆 + 错误处理：base_importance = 段 avgImportance × 0.8；单段失败不中断；在 runConsolidation 注册为步骤 2

**Prompt**: WP03-sequence-replay.md
**依赖**: WP01

---

## WP04 — 步骤 3+4：usage_outcomes 收敛 + 过期清理

**目标**：实现 runOutcomesConverge() 和 runExpiryCleanup()，分别完成 base_importance 批量收敛和过期记忆软删除。

子任务：
- [ ] T018: computeNewImportance 纯函数（posRatio/negRatio 阈值比对 → delta → clamp 0.0-1.0）
- [ ] T019: runOutcomesConverge(workspace, config)：getMemoriesWithNonZeroOutcomes → computeNewImportance → updateMemoryImportanceAndResetOutcomes；日志记录调整数量
- [ ] T020: runExpiryCleanup(workspace, config)：forgetExpiredMemories(now) → 日志记录数量；在 runConsolidation 注册为步骤 3 + 步骤 4
- [ ] T021: 顺序约束验证：runConsolidation 中步骤 1-4 按顺序 await，步骤 N 抛出时后续不执行；幂等文档注释

**Prompt**: WP04-converge-cleanup.md
**依赖**: WP01

---

## WP05 — 单元测试

**目标**：Bun test 单元测试，覆盖调度器生命周期、段精修逻辑、序列回放、收敛算法、清理逻辑（全 mock，无真实 DB/LLM）。

子任务：
- [ ] T022: lifecycle.test.ts：start/stop flag、timer 清除、重复 stop 不报错、running 重入保护
- [ ] T023: segment-refine.test.ts：mock workspace + mock callLlm；merge=true 时 updateMemorySegment 被调用；LLM 失败时精修继续
- [ ] T024: sequence-replay.test.ts：mock workspace + mock callLlm；writeMemory 被调用 3 次（类型正确）；JSON 解析失败时跳过该段
- [ ] T025: converge-cleanup.test.ts Part A：computeNewImportance 纯函数——5 个边界值测试（上升/下降/不变/下溢/上溢）
- [ ] T026: converge-cleanup.test.ts Part B：runOutcomesConverge mock 验证（getMemoriesWithNonZeroOutcomes 结果 → 正确 update 调用次数）
- [ ] T027: converge-cleanup.test.ts Part C：runExpiryCleanup mock 验证 + 顺序约束（步骤 1 抛出 → 步骤 2 未执行，通过 spy 验证）

**Prompt**: WP05-unit-tests.md
**依赖**: WP01, WP02, WP03, WP04

---

## WP06 — 集成测试

**目标**：Vitest 集成测试，真实 DB（AIMA_TEST_DATABASE_URL），验证四步完整流程和各步骤的 DB 状态变更。

子任务：
- [ ] T028: 集成测试 helper + seeder：写入已知 episodic 段数据、usage_outcomes 数据、过期数据；MockLlm（可配置返回值）
- [ ] T029: 集成测试：段精修（mock callLlm merge=true → DB 中 segment_id 被更新）
- [ ] T030: 集成测试：序列回放（mock callLlm 返回 semantic+procedural → DB 中新记忆写入）
- [ ] T031: 集成测试：usage_outcomes 收敛（seeded 正向反馈 → DB base_importance 上升，outcomes 重置）
- [ ] T032: 集成测试：过期清理（2 条 expired + 1 条 pinned → 只有 2 条 forgotten=true）
- [ ] T033: 集成测试：全流程顺序约束（runConsolidation 完整运行，验证四步均执行且 DB 最终状态正确）

**Prompt**: WP06-integration-tests.md
**依赖**: WP01, WP02, WP03, WP04
