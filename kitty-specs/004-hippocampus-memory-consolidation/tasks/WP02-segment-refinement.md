---
work_package_id: WP02
title: 步骤 1：段精修
lane: "doing"
dependencies: []
subtasks: [T008, T009, T010, T011, T012]
assignee: claude
agent: "claude-sonnet-4-6"
shell_pid: "47449"
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP02 — 步骤 1：段精修

## 目标

实现 `runSegmentRefine()`：读取近期 episodic 段，对相邻段对通过一次性 LLM 调用判断是否合并，执行合并更新（segment_id + segment_seq 重新编号）。单对失败不中断整体，幂等安全。

## 上下文

- **修改文件**：`src/hippocampus/index.ts`（将 stub `runSegmentRefine` 替换为完整实现）
- 依赖 WP01：`callLlm`、`parseLlmJson`（来自 `src/llm.ts`）；`getSegmentsByTimeRange`、`getSegmentSequence`、`updateMemorySegment`（来自 CognitiveWorkspace）
- 架构约束：只实现**合并**，不实现拆分（拆分需重新标注每条记录归属，超出本 Feature 范围）
- LLM 调用策略：每对发起 1 次 callLlm，最多 50 对/次（O(n) 上限），失败时保守策略（默认 merge: false）
- 架构参考：`docs/02-memory-architecture.md` §七 1. 段精修

## 实现指导

### T008 — runSegmentRefine：获取候选合并段对

在 `src/hippocampus/index.ts` 中将 `private async runSegmentRefine()` stub 替换为：

```typescript
private async runSegmentRefine(): Promise<void> {
  const now = new Date()
  const from = new Date(now.getTime() - this.config.lookbackDays * 24 * 60 * 60 * 1000)
  const segments = await this.workspace.getSegmentsByTimeRange({ from, to: now })

  // 按 maxCreatedAt 升序排列，形成相邻段对
  segments.sort((a, b) => a.maxCreatedAt.getTime() - b.maxCreatedAt.getTime())

  // 最多处理 50 对，避免大量 LLM 调用
  const pairs: [typeof segments[0], typeof segments[0]][] = []
  for (let i = 0; i < segments.length - 1 && pairs.length < 50; i++) {
    pairs.push([segments[i]!, segments[i + 1]!])
  }

  const mergedSegmentIds = new Set<string>()  // 幂等：本次已合并的段（被合并进其他段的）

  for (const [segA, segB] of pairs) {
    if (mergedSegmentIds.has(segA.segmentId) || mergedSegmentIds.has(segB.segmentId)) continue
    try {
      await this.tryMergeSegments(segA, segB, mergedSegmentIds)
    } catch (err) {
      console.warn(`[Hippocampus] Segment merge failed for ${segA.segmentId}+${segB.segmentId}:`, err)
    }
  }

  console.log(`[Hippocampus] Segment refine complete. Pairs checked: ${pairs.length}`)
}
```

---

### T009 — 段合并 LLM 调用

```typescript
private async tryMergeSegments(
  segA: { segmentId: string; eventCount: number; avgImportance: number },
  segB: { segmentId: string; eventCount: number; avgImportance: number },
  mergedSet: Set<string>,
): Promise<void> {
  // 获取两段各自前 3 条事件作为 context
  const seqA = (await this.workspace.getSegmentSequence(segA.segmentId)).slice(0, 3)
  const seqB = (await this.workspace.getSegmentSequence(segB.segmentId)).slice(0, 3)

  const contextA = seqA.map(e => `- ${e.content.slice(0, 200)}`).join('\n')
  const contextB = seqB.map(e => `- ${e.content.slice(0, 200)}`).join('\n')

  const prompt = `You are analyzing two event segments from an AI cognitive system to determine if they belong to the same continuous logical flow.

Segment A (${segA.eventCount} events, avg importance ${segA.avgImportance.toFixed(2)}):
${contextA}

Segment B (${segB.eventCount} events, avg importance ${segB.avgImportance.toFixed(2)}):
${contextB}

Do these two segments represent a single continuous logical episode that was incorrectly split?
Consider: same entities, continuous reasoning chain, same goal/task, directly related cause-and-effect.

Respond with JSON only:
{"merge": true/false, "reason": "one sentence explanation"}`

  const response = await callLlm(prompt, this.config.llm, { maxTokens: 256 })
  const result = parseLlmJson<{ merge: boolean; reason: string }>(
    response,
    { merge: false, reason: 'parse failed' }
  )

  if (result.merge) {
    console.log(`[Hippocampus] Merging segments ${segB.segmentId} → ${segA.segmentId}: ${result.reason}`)
    await this.executeMerge(segA.segmentId, segB.segmentId)
    mergedSet.add(segB.segmentId)
  }
}
```

---

### T010 — 执行合并更新

```typescript
private async executeMerge(targetSegmentId: string, sourceSegmentId: string): Promise<void> {
  // 获取 target 段当前最大 segment_seq
  const targetSeq = await this.workspace.getSegmentSequence(targetSegmentId)
  const maxSeq = targetSeq.length  // target 有 N 条，source 从 N 开始编号

  // 获取 source 段所有记录并重新编号
  const sourceSeq = await this.workspace.getSegmentSequence(sourceSegmentId)
  for (let i = 0; i < sourceSeq.length; i++) {
    const entry = sourceSeq[i]!
    await this.workspace.updateMemorySegment(entry.id, targetSegmentId, maxSeq + i)
  }
}
```

**注意**：`getSegmentSequence` 已按 segment_seq ASC 返回，重新编号从 target 段长度开始，确保连续性。

---

### T011 — 幂等保护

幂等已通过 `mergedSegmentIds` Set 在 T008 中实现：

- 每次 `executeMerge` 完成后，将 sourceSegmentId 加入 `mergedSet`
- 后续循环检查 `mergedSet.has(segA.segmentId) || mergedSet.has(segB.segmentId)` 时跳过
- **跨次运行幂等**：已被合并的 source 段的记录 segment_id 已更新为 target，`getSegmentsByTimeRange` 不再返回已消失的 source segment_id，自动跳过

---

### T012 — 错误处理 + 注册到 runConsolidation

- `tryMergeSegments` 内部抛出的错误被 `runSegmentRefine` 的 try/catch 捕获，`warn` 日志后继续下一对
- LLM 调用超时/网络错误：同上，捕获后继续
- JSON 解析失败：`parseLlmJson` 返回 fallback `{ merge: false }`，保守策略，不执行合并
- `runConsolidation` 中步骤 1 已是 `await this.runSegmentRefine()`，若整体 throw（非预期），步骤 2 不执行（顺序约束）

**验证**：
- `bun run typecheck` 无错误
- `biome check` 通过
- 手动测试：seed 两个相邻段，mock callLlm 返回 `{ merge: true, reason: "test" }`，验证 DB 中 segment_id 被更新

## Definition of Done

- [ ] T008: `runSegmentRefine` 获取相邻段对（最多 50），跳过已合并的段
- [ ] T009: `tryMergeSegments` 组装 prompt，callLlm，parseLlmJson（失败 merge=false）
- [ ] T010: `executeMerge` 获取 target 当前长度，将 source 记录重新编号并更新 segment_id
- [ ] T011: `mergedSegmentIds` Set 防止已合并段再次参与合并
- [ ] T012: 单对失败 warn + 继续，整体 runSegmentRefine 不因单对失败而抛出
- [ ] `bun run typecheck` 零错误，`biome check` 通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
spec-kitty agent tasks move-task WP02 --to for_review --note "Ready: <summary>"
```

## Activity Log

- 2026-03-11T02:29:18Z – claude-sonnet-4-6 – shell_pid=47449 – lane=doing – Started implementation via workflow command
