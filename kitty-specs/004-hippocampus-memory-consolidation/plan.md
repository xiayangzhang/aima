# Implementation Plan: Hippocampus Memory Consolidation (Feature 004)

**Branch**: `main` | **Date**: 2026-03-11 | **Spec**: [spec.md](./spec.md)
**Depends on**: Feature 001 (workspace schema), Feature 002 (Brain Runtime), Feature 003 (DMN + callLlm)

---

## Summary

实现 Hippocampus Consolidation——每日批量记忆巩固进程。四步顺序执行：段精修（LLM 因果分析 + segment_id 更新）→ 段序列回放（LLM 模式提取 + semantic/procedural/implicit 写入）→ usage_outcomes 收敛（批量调整 base_importance）→ 过期清理（软删除 forgotten=true）。不走 BrainAdapter，不持有持久 session，LLM 调用使用共享 callLlm 工具。

---

## Technical Context

**Language/Version**: TypeScript strict, ESM-only, Bun v1.x（与 Feature 001-003 一致）
**Primary Dependencies**: Drizzle ORM, @anthropic-ai/sdk（通过 callLlm）
**Storage**: PostgreSQL（CognitiveWorkspace，Feature 001 schema — 无新表，只扩展现有 memories 表查询）
**Testing**: Bun test（单元）+ Vitest（集成，需 DB）
**Target Platform**: Node/Bun 服务端
**LLM**: Haiku（低成本批处理），通过共享 callLlm 工具，不走 BrainAdapter
**Constraints**: 顺序约束（步骤 1 完成后步骤 2 才启动）；每步幂等；stop() 后最多等 60s 优雅退出

---

## Constitution Check

*无 constitution.md，跳过。*

---

## 一、架构决策

### callLlm 共享工具

Feature 003 将 `callLlm` 放在 `src/dmn/llm.ts`，但 Hippocampus 同样需要一次性 LLM 调用。作为 Feature 004 的第一步，将 `callLlm` 和 `parseLlmJson` 提取到 `src/llm.ts`（共享工具层），同时更新 DMN 的 import。避免跨模块 import（`hippocampus` 不应 import from `dmn`）。

```
src/
├── llm.ts                    # 提取：callLlm + parseLlmJson（原 src/dmn/llm.ts）
├── dmn/
│   ├── llm.ts               # 删除，内容移至 src/llm.ts
│   ├── index.ts             # 更新：from './llm' → from '../llm'
│   ├── reactive/index.ts    # 更新：from '../llm' → from '../../llm'
│   └── consolidation/index.ts # 更新同上
└── hippocampus/
    └── index.ts             # import from '../llm'
```

### HippocampusConsolidation 类结构

```typescript
export interface HippocampusConfig {
  llm: LlmConfig                  // model, apiKey, maxTokens
  lookbackDays?: number           // 段精修/回放窗口（默认 7）
  replayTopK?: number             // 回放 top-K 段（默认 5）
  convergencePositiveThreshold?: number  // positive 比例阈值（默认 0.6）
  convergenceNegativeThreshold?: number  // negative 比例阈值（默认 0.6）
  convergenceStep?: number        // base_importance 调整步长（默认 0.05）
  staleAccessDays?: number        // last_accessed_at 超过 N 天标记候选删除（默认 180）
  runAt?: string                  // 每日触发时间，"HH:MM" 格式（默认 "03:00"）
}

export class HippocampusConsolidation {
  constructor(workspace: CognitiveWorkspace, config: HippocampusConfig)
  async runConsolidation(): Promise<void>   // 顺序执行四步
  start(): void                             // 启动每日调度器
  stop(): Promise<void>                     // 优雅停止（等待当前任务完成，60s 超时）
}
```

### 调度器实现

不引入 cron 库。与 DMN Consolidation 相同的模式：计算距离下次 runAt 的毫秒数，用 setTimeout 单次触发，完成后重新调度。

```typescript
private scheduleNext(): void {
  const now = new Date()
  const [h, m] = this.config.runAt!.split(':').map(Number)
  const next = new Date(now)
  next.setHours(h!, m!, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  const delay = next.getTime() - now.getTime()
  this.timer = setTimeout(() => {
    if (!this.running) return
    void this.runConsolidation().finally(() => this.scheduleNext())
  }, delay)
}
```

### CognitiveWorkspace 扩展

Hippocampus 需要以下新方法（追加到 `src/workspace/index.ts`，不改动已有方法）：

```typescript
// 按时间范围查询 episodic 段摘要（段精修和回放的数据源）
getSegmentsByTimeRange(range: { from: Date; to: Date }): Promise<{
  segmentId: string
  eventCount: number
  avgImportance: number
  maxCreatedAt: Date
}[]>

// 获取某段的完整事件序列（按 segment_seq 排序）
getSegmentSequence(segmentId: string): Promise<MemoryEntry[]>

// 更新记忆条目的 segmentId/segmentSeq（段精修使用）
updateMemorySegment(memoryId: string, newSegmentId: string, newSegmentSeq: number): Promise<void>

// 软删除：设置 forgotten=true，条件：expiresAt < now AND NOT pinned
forgetExpiredMemories(now: Date): Promise<number>  // 返回清理数量

// 批量读取 usage_outcomes 非零的记忆（收敛步骤）
getMemoriesWithNonZeroOutcomes(): Promise<MemoryEntry[]>

// 批量更新：base_importance + 重置 usage_outcomes 为 {0,0,0}
updateMemoryImportanceAndResetOutcomes(id: string, newBaseImportance: number): Promise<void>
```

### 段精修的 LLM 策略

段精修对每对相邻段发起 LLM 调用，判断是否应该合并。为控制 LLM 调用次数（O(n_segments)），只处理 `lookbackDays` 内的段，段数量有上限（如 100 段/次）。

**合并判断 prompt 要点**：
- 提供两段的摘要（segment_id、事件数、前几条 content 摘录）
- 问：这两段在逻辑上是否属于同一连续事件流？
- 返回 `{ merge: boolean, reason: string }`
- 合并时：将第二段所有 episodic 记录的 segment_id 更新为第一段的 segment_id，重新编号 segment_seq

**拆分策略**：拆分较复杂（需要重新标注每条记录的归属），Feature 004 范围内只实现"合并"，拆分留作未来演进（spec 中提到但工程上推后）。

### 段序列回放的 LLM 策略

每个段独立一次 LLM 调用，发送完整 episodic 序列，要求以 JSON 返回提取结果：

```json
{
  "semantic": [{ "content": "...", "entityId": "...", "tags": [...] }],
  "procedural": [{ "content": "...", "tags": [...] }],
  "implicit": [{ "content": "...", "tags": [...] }]
}
```

写入时通过 `supersedesId` 关联旧版本（先搜索相同 entityId + type 的现有记录，存在则设 supersedesId）。

### usage_outcomes 收敛算法

```typescript
function computeNewImportance(
  current: number,
  outcomes: { positive: number; negative: number; neutral: number },
  config: Required<HippocampusConfig>
): number {
  const total = outcomes.positive + outcomes.negative + outcomes.neutral
  if (total === 0) return current

  const posRatio = outcomes.positive / total
  const negRatio = outcomes.negative / total

  let delta = 0
  if (posRatio > config.convergencePositiveThreshold) delta = config.convergenceStep
  else if (negRatio > config.convergenceNegativeThreshold) delta = -config.convergenceStep

  return Math.max(0.0, Math.min(1.0, current + delta))
}
```

### AIMAInstance 集成

在 `src/instance.ts` 中，与 `enableDmn` 相同的模式：

```typescript
export interface AIMAInstanceConfig {
  // ... 已有字段 ...
  enableHippocampus?: boolean
  hippocampus?: HippocampusConfig
}
```

start() 和 stop() 调用 `hippocampusConsolidation.start()` 和 `hippocampusConsolidation.stop()`。

---

## 二、模块结构

```
src/
├── llm.ts                                    # 新建：callLlm + parseLlmJson（从 src/dmn/llm.ts 迁移）
├── hippocampus/
│   └── index.ts                              # 新建：HippocampusConsolidation 类
├── dmn/
│   ├── index.ts                              # 修改：更新 callLlm import 路径
│   ├── llm.ts                                # 删除（迁移到 src/llm.ts）
│   ├── reactive/index.ts                     # 修改：更新 import 路径
│   └── consolidation/index.ts               # 修改：更新 import 路径
├── workspace/index.ts                        # 修改：追加 6 个新方法
├── instance.ts                               # 修改：enableHippocampus + 生命周期
└── index.ts                                  # 修改：导出 HippocampusConsolidation + HippocampusConfig

tests/
├── unit/
│   └── hippocampus/
│       ├── lifecycle.test.ts                 # 调度器 start/stop
│       ├── segment-refine.test.ts            # 段精修逻辑（mock workspace + mock callLlm）
│       ├── sequence-replay.test.ts           # 序列回放（mock）
│       └── converge-cleanup.test.ts          # 收敛算法 + 过期清理（mock）
└── integration/
    └── hippocampus/
        └── consolidation.test.ts             # 真实 DB 全流程验证
```

---

## 三、工作包规划

| WP | 标题 | 子任务 | 依赖 | 优先级 |
|---|---|---|---|---|
| WP01 | callLlm 迁移 + 基础设施 + CognitiveWorkspace 扩展 | T001-T007 | — | P0 |
| WP02 | 步骤 1：段精修 | T008-T012 | WP01 | P0 |
| WP03 | 步骤 2：段序列回放 | T013-T017 | WP01 | P0 |
| WP04 | 步骤 3+4：收敛 + 清理 | T018-T021 | WP01 | P0 |
| WP05 | 单元测试 | T022-T027 | WP01-WP04 | P1 |
| WP06 | 集成测试 | T028-T033 | WP01-WP04 | P1 |

---

## 四、子任务清单

### WP01 — callLlm 迁移 + 基础设施 + CognitiveWorkspace 扩展

**T001** — 将 `callLlm` + `parseLlmJson` 从 `src/dmn/llm.ts` 迁移到 `src/llm.ts`
- 创建 `src/llm.ts`，内容与原 `src/dmn/llm.ts` 相同，类型名从 `DmnLlmConfig` 改为 `LlmConfig`
- 更新 `src/dmn/index.ts`、`src/dmn/reactive/index.ts`、`src/dmn/consolidation/index.ts` 的 import 路径
- 删除 `src/dmn/llm.ts`
- 验证：`bun run typecheck` 通过

**T002** — `HippocampusConfig` 类型 + `HippocampusConsolidation` 类骨架
- 新建 `src/hippocampus/index.ts`
- 定义 `HippocampusConfig` 接口（含所有配置项和默认值说明）
- 实现 `HippocampusConsolidation` 类的构造函数和四个步骤的 stub
- 四步顺序调用：`runSegmentRefine → runSequenceReplay → runOutcomesConverge → runExpiryCleanup`

**T003** — 调度器：`start()` + `stop()`
- 基于 setTimeout 的每日调度器（计算到 `runAt` 的延迟）
- `stop()` 发送停止信号，等待当前任务完成（60s 超时后强制退出）
- `running` flag 防重入（任意时刻最多一个 Consolidation 在执行）

**T004** — CognitiveWorkspace 扩展：`getSegmentsByTimeRange` + `getSegmentSequence`
- `getSegmentsByTimeRange(range)`: 查询 episodic 记录（`type='episodic'`, `createdAt >= from`, `createdAt < to`, `segmentId IS NOT NULL`, `forgotten=false`），按 segment_id GROUP BY，返回 segmentId、eventCount、avgImportance、maxCreatedAt
- `getSegmentSequence(segmentId)`: 查询该 segment_id 的所有 episodic 记录，按 segment_seq ASC 排序

**T005** — CognitiveWorkspace 扩展：`updateMemorySegment`
- `updateMemorySegment(memoryId, newSegmentId, newSegmentSeq)`: 更新单条记忆的 segmentId 和 segmentSeq 字段

**T006** — CognitiveWorkspace 扩展：`getMemoriesWithNonZeroOutcomes` + `updateMemoryImportanceAndResetOutcomes`
- `getMemoriesWithNonZeroOutcomes()`: 查询 `(usageOutcomes->>'positive')::int + (usageOutcomes->>'negative')::int > 0` 的记忆
- `updateMemoryImportanceAndResetOutcomes(id, newBaseImportance)`: 批量更新，重置 usageOutcomes 为 `{0,0,0}`

**T007** — CognitiveWorkspace 扩展：`forgetExpiredMemories` + AIMAInstance 集成
- `forgetExpiredMemories(now: Date)`: 设 forgotten=true，条件：expiresAt < now AND pinned=false AND forgotten=false
- AIMAInstance: 添加 `enableHippocampus` flag，start/stop 生命周期集成
- src/index.ts 导出 `HippocampusConsolidation`、`HippocampusConfig`

---

### WP02 — 步骤 1：段精修

**T008** — 获取候选合并段对
- `runSegmentRefine(workspace, config, llmConfig)` 函数
- 调用 `getSegmentsByTimeRange({ from: now-lookbackDays, to: now })`
- 按 maxCreatedAt 排序，形成相邻段对列表（(seg[i], seg[i+1]) 对）
- 限制最多处理 min(pairs.length, 50) 对，防止 O(n²) LLM 爆炸

**T009** — 段合并 LLM 调用
- 对每个候选对，提取各自前 3 条事件 content 作为 context
- 调用 `callLlm(prompt, llmConfig, { maxTokens: 256 })`
- prompt 包含两段摘要，要求返回 `{ merge: boolean, reason: string }`
- `parseLlmJson` 解析，失败时默认 `merge: false`（保守策略）

**T010** — 执行合并更新
- `merge: true` 时：将第二段的所有 episodic 记录 segment_id 改为第一段的 segment_id
- 重新分配 segment_seq（第一段 N 条 + 第二段 M 条，统一从 0 编号）
- 使用 `updateMemorySegment` 逐条更新

**T011** — 幂等保证
- 精修后的段不再参与下次运行的合并候选（通过检查 segment_id 是否已在本次精修中被更新过的 set 排除）
- 或：标记已精修的段（在内存中维护 Set，本次运行内有效）

**T012** — 错误处理
- 单对合并失败（LLM 错误/超时）不中断整体精修，记录 warn 日志并继续下一对
- 捕获所有 per-pair 错误，精修步骤整体成功（不因单个 LLM 失败而 fail-fast）

---

### WP03 — 步骤 2：段序列回放

**T013** — 选取 top-K 段
- `runSequenceReplay(workspace, config, llmConfig)` 函数
- 调用 `getSegmentsByTimeRange({ from: now-lookbackDays, to: now })`
- 排序：按 `avgImportance DESC, maxCreatedAt DESC`（高重要度且近期优先）
- 取 top K（`config.replayTopK ?? 5`）

**T014** — 获取段序列并发起 LLM 分析
- 对每个选中段：调用 `getSegmentSequence(segmentId)`
- 组装 prompt：发送完整事件序列的 content 摘录
- 要求 LLM 提取三类结论（semantic 事实 / procedural 步骤 / implicit 风险模式）
- 返回 JSON 格式（见§一 LLM 策略）

**T015** — 写入 semantic 和 procedural 记忆
- 对每条 semantic 结论：检查 `entityId` 是否已存在同类记忆（searchMemory 精确匹配）
- 存在时：新记录设置 `supersedesId` 指向旧记录，旧记录 `invalidateMemory`（设 tInvalid）
- 写入记忆，sourceBrain='hippocampus'，tags 包含 `['replay', segmentId]`

**T016** — 写入 implicit 记忆
- implicit 记忆：tag 匹配 + content 相似性检测（ILIKE 兜底）
- 存在相似记录时通过 `supersedesId` 替代
- base_importance 初始值：段平均 importance 的 0.8 倍（回放提炼出的模式略低于原始风险事件）

**T017** — 错误处理
- 单个段的回放失败（LLM 报错/JSON 解析失败）不中断整体，记录 warn + 继续下一段
- 空段（序列长度 < 2）跳过不回放

---

### WP04 — 步骤 3+4：收敛 + 清理

**T018** — usage_outcomes 收敛
- `runOutcomesConverge(workspace, config)` 函数
- 调用 `getMemoriesWithNonZeroOutcomes()`
- 对每条：计算 `computeNewImportance(current, outcomes, config)`
- 调用 `updateMemoryImportanceAndResetOutcomes(id, newValue)`
- 记录调整数量到日志

**T019** — `computeNewImportance` 纯函数实现
- 输入：当前 base_importance，usage_outcomes，HippocampusConfig
- 计算 posRatio, negRatio
- posRatio > positiveThreshold → +step；negRatio > negativeThreshold → -step；否则不变
- 结果 clamp 到 [0.0, 1.0]
- 此函数必须可单独单元测试（无 I/O）

**T020** — 过期清理
- `runExpiryCleanup(workspace, config)` 函数
- 调用 `forgetExpiredMemories(now)` — 软删除过期记忆
- 记录清理数量到日志

**T021** — 收敛和清理的幂等性
- 收敛：读取 outcomes 时若所有计数为 0，跳过（reset 后下次不处理）
- 清理：`forgotten=true` 的记录不再被 `forgetExpiredMemories` 匹配（查询条件已有 `forgotten=false` 过滤）

---

### WP05 — 单元测试

**T022** — 调度器生命周期测试（lifecycle.test.ts）
- start() 后 running flag 为 true
- stop() 后 running flag 为 false，timer 清除
- 重复 stop() 不报错
- 重入保护：runConsolidation 执行中再次 start() 不产生第二个并发任务

**T023** — 段精修单元测试（segment-refine.test.ts）
- mock workspace：getSegmentsByTimeRange 返回 2 个相邻段
- mock callLlm：第一次返回 `{ merge: true }`，第二次 `{ merge: false }`
- 验证：merge=true 时 updateMemorySegment 被调用，merge=false 时不调用
- LLM 失败时段精修继续（容错性测试）

**T024** — 序列回放单元测试（sequence-replay.test.ts）
- mock workspace：getSegmentsByTimeRange 返回 3 段，getSegmentSequence 返回 3 条 episodic
- mock callLlm：返回含 semantic/procedural/implicit 各 1 条的 JSON
- 验证：writeMemory 被调用 3 次（类型正确）
- JSON 解析失败时跳过该段，继续下一段

**T025** — computeNewImportance 单元测试（converge-cleanup.test.ts）
- positive 比例 0.8 → 上升
- negative 比例 0.8 → 下降
- 均低于阈值 → 不变
- base_importance=0.0 + 下降 → 保持 0.0（不溢出）
- base_importance=1.0 + 上升 → 保持 1.0

**T026** — 收敛批量更新测试
- mock workspace：getMemoriesWithNonZeroOutcomes 返回 2 条记忆
- 验证 updateMemoryImportanceAndResetOutcomes 被正确调用 2 次
- 全零 outcomes 的记忆不调用 update

**T027** — 过期清理测试
- mock workspace：forgetExpiredMemories 返回 3
- 验证日志包含 "3 memories forgotten"

---

### WP06 — 集成测试

**T028** — 集成测试 helper
- 创建 `tests/integration/hippocampus/consolidation.test.ts`
- Helper：seeded workspace（写入已知 episodic 记录，含 segment_id + usage_outcomes）
- MockLlm：可配置返回值的 callLlm mock（用于控制 LLM 输出）

**T029** — 集成测试：段精修（真实 DB）
- 写入两个相邻段（各 2 条 episodic），mock callLlm 返回 merge=true
- 运行 runSegmentRefine
- 验证：DB 中第二段的记录 segment_id 已更新为第一段的 segment_id

**T030** — 集成测试：序列回放写入（真实 DB）
- 写入 1 个段（3 条 episodic），mock callLlm 返回 semantic+procedural 各 1 条
- 运行 runSequenceReplay
- 验证：DB 中新增 2 条记忆（type 分别为 semantic/procedural）

**T031** — 集成测试：usage_outcomes 收敛（真实 DB）
- 写入 1 条记忆，base_importance=0.5，usage_outcomes={positive:4, negative:1, neutral:0}
- 运行 runOutcomesConverge
- 验证：DB 中 base_importance 升至 0.55，usage_outcomes 重置为 {0,0,0}

**T032** — 集成测试：过期清理（真实 DB）
- 写入 2 条 expired 记忆（expiresAt < now，pinned=false）+ 1 条 pinned=true
- 运行 runExpiryCleanup
- 验证：2 条 forgotten=true，1 条（pinned）forgotten=false 不变

**T033** — 集成测试：全流程顺序约束
- 写入混合测试数据（含段、usage_outcomes、过期记忆）
- mock callLlm
- 运行 runConsolidation（完整四步）
- 验证四步均被调用（通过 spy 或检查 DB 最终状态）

---

## 五、Definition of Done

- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] `bun test tests/unit/hippocampus/` 全通过
- [ ] `AIMA_TEST_DATABASE_URL=... npx vitest run tests/integration/hippocampus/` 全通过
- [ ] callLlm 已迁移到 `src/llm.ts`，DMN 相关 import 路径更新
- [ ] CognitiveWorkspace 6 个新方法已实现
- [ ] AIMAInstance 支持 `enableHippocampus` flag
- [ ] `src/index.ts` 导出 HippocampusConsolidation + HippocampusConfig

---

## 六、风险

| 风险 | 缓解 |
|---|---|
| 段精修 LLM 调用数 O(n_segments) | 限制最多处理 50 对/次，lookbackDays 控制范围 |
| 序列回放写入重复记忆 | supersedesId + invalidateMemory 确保幂等 |
| callLlm 迁移破坏 DMN | T001 第一步 typecheck 验证，集成测试覆盖 DMN |
| 过期清理误删 | 软删除（forgotten flag），pinned=true 保护，审计可恢复 |
| 收敛步长过大导致震荡 | convergenceStep 默认 0.05（小步长），上层可配置 |
