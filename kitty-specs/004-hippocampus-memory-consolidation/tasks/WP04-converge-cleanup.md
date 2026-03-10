---
work_package_id: WP04
title: 步骤 3+4：usage_outcomes 收敛 + 过期清理
lane: planned
dependencies: []
subtasks: [T018, T019, T020, T021]
assignee: claude
agent: claude
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP04 — 步骤 3+4：usage_outcomes 收敛 + 过期清理

## 目标

实现 `runOutcomesConverge()` 和 `runExpiryCleanup()`：前者根据使用反馈批量调整 `base_importance`，后者软删除过期记忆。两步均无 LLM 调用，纯数据库操作，逻辑简单清晰。

## 上下文

- **修改文件**：`src/hippocampus/index.ts`（替换步骤 3/4 stub，追加 `computeNewImportance` 纯函数）
- 依赖 WP01：`getMemoriesWithNonZeroOutcomes`、`updateMemoryImportanceAndResetOutcomes`、`forgetExpiredMemories`（CognitiveWorkspace）
- 收敛是**批量操作**：单次 `markUsed` 不立即影响排序，Consolidation 每日收敛一次，防止单次噪音
- 步骤 3 完成后步骤 4 执行；步骤 3 throw 时步骤 4 不执行（顺序约束由 `runConsolidation` 的 await 链保证）
- 架构参考：`docs/02-memory-architecture.md` §七 3. usage_outcomes 收敛；§七 4. 过期清理

## 实现指导

### T018 — computeNewImportance 纯函数

在 `src/hippocampus/index.ts` 文件内（类外，或作为私有方法）定义：

```typescript
/**
 * 根据 usage_outcomes 计数器小幅调整 base_importance。
 * 纯函数：无 I/O，无副作用，便于单元测试。
 *
 * 逻辑：
 * - positive 比例 > positiveThreshold → +step
 * - negative 比例 > negativeThreshold → -step
 * - 否则不变
 * - 结果 clamp 到 [0.0, 1.0]
 */
export function computeNewImportance(
  current: number,
  outcomes: { positive: number; negative: number; neutral: number },
  config: {
    convergencePositiveThreshold: number
    convergenceNegativeThreshold: number
    convergenceStep: number
  }
): number {
  const total = outcomes.positive + outcomes.negative + outcomes.neutral
  if (total === 0) return current

  const posRatio = outcomes.positive / total
  const negRatio = outcomes.negative / total

  let delta = 0
  if (posRatio > config.convergencePositiveThreshold) {
    delta = config.convergenceStep
  } else if (negRatio > config.convergenceNegativeThreshold) {
    delta = -config.convergenceStep
  }

  return Math.max(0.0, Math.min(1.0, current + delta))
}
```

**导出**：`computeNewImportance` 从 `src/hippocampus/index.ts` 导出（供单元测试直接 import）。

---

### T019 — runOutcomesConverge

在 `HippocampusConsolidation` 类中替换步骤 3 stub：

```typescript
private async runOutcomesConverge(): Promise<void> {
  const entries = await this.workspace.getMemoriesWithNonZeroOutcomes()
  let updatedCount = 0

  for (const entry of entries) {
    if (!entry.usageOutcomes) continue

    const newImportance = computeNewImportance(
      entry.baseImportance,
      entry.usageOutcomes,
      this.config
    )

    // 即使 newImportance === current（无变化），仍重置计数器
    await this.workspace.updateMemoryImportanceAndResetOutcomes(entry.id, newImportance)
    updatedCount++
  }

  console.log(`[Hippocampus] Outcomes converge complete. Updated: ${updatedCount} entries`)
}
```

**幂等**：`updateMemoryImportanceAndResetOutcomes` 将 usageOutcomes 重置为 `{0,0,0}`，下次 `getMemoriesWithNonZeroOutcomes` 不再返回该条目，自动跳过。

---

### T020 — runExpiryCleanup

在 `HippocampusConsolidation` 类中替换步骤 4 stub：

```typescript
private async runExpiryCleanup(): Promise<void> {
  const now = new Date()
  const forgotten = await this.workspace.forgetExpiredMemories(now)
  console.log(`[Hippocampus] Expiry cleanup complete. Forgotten: ${forgotten} entries`)
}
```

**幂等**：`forgetExpiredMemories` 的查询条件包含 `forgotten=false`，已 forgotten 的记录不会被重复处理。

---

### T021 — 顺序约束验证 + runConsolidation 完整实现

`runConsolidation` 中步骤 1-4 的顺序 await 已由 WP01 T002 建立：

```typescript
async runConsolidation(): Promise<void> {
  console.log('[Hippocampus] Starting consolidation run')
  await this.runSegmentRefine()    // 步骤 1（WP02）—— 失败时步骤 2 不执行
  await this.runSequenceReplay()   // 步骤 2（WP03）—— 失败时步骤 3 不执行
  await this.runOutcomesConverge() // 步骤 3（WP04 T019）—— 失败时步骤 4 不执行
  await this.runExpiryCleanup()    // 步骤 4（WP04 T020）
  console.log('[Hippocampus] Consolidation run complete')
}
```

顺序约束自动成立：JavaScript 的 `await` 在 Promise reject 时抛出，后续 await 不执行。不需要额外的 try/catch 包裹——步骤内部已处理单项失败（warn + 继续），整体步骤 throw 代表不可恢复错误，此时中断是正确行为。

**注意**：步骤 1 中单对合并失败被内部 catch 处理，不影响整体步骤成功；步骤 2 中单段回放失败同理。只有步骤整体级别的错误（如 DB 连接失败）才会中断后续步骤。

**步骤文档注释**（在代码中标注）：

```typescript
// 顺序约束：步骤 1 精修 segment_id → 步骤 2 依赖精修后的正确段边界
// 步骤 3/4 独立但顺序执行，保证同一 Consolidation 运行内一致性
```

## Definition of Done

- [ ] T018: `computeNewImportance` 纯函数已导出，逻辑正确（posRatio/negRatio 分支，clamp 0-1）
- [ ] T019: `runOutcomesConverge` 读取非零 outcomes 记忆，调用 `computeNewImportance`，更新并重置计数器，记录日志
- [ ] T020: `runExpiryCleanup` 调用 `forgetExpiredMemories(now)`，记录清理数量
- [ ] T021: `runConsolidation` 四步顺序 await，代码注释说明顺序约束，幂等保证已文档化
- [ ] `bun run typecheck` 零错误，`biome check` 通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
spec-kitty agent tasks move-task WP04 --to for_review --note "Ready: <summary>"
```
