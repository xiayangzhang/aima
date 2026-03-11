---
work_package_id: WP05
title: 单元测试
lane: "doing"
dependencies: []
subtasks: [T022, T023, T024, T025, T026, T027]
assignee: claude
agent: "claude"
shell_pid: "70094"
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP05 — 单元测试

## 目标

Bun test 单元测试，全 mock（无真实 DB/LLM），覆盖：调度器生命周期、段精修逻辑、序列回放逻辑、`computeNewImportance` 纯函数、收敛批量调用、清理调用、顺序约束。

## 上下文

- **新建目录**：`tests/unit/hippocampus/`
- **新建文件**：`lifecycle.test.ts`、`segment-refine.test.ts`、`sequence-replay.test.ts`、`converge-cleanup.test.ts`
- 测试框架：`bun test`（与 Feature 001-003 一致）
- Mock 策略：使用 `mock.module` 或手动构造 mock workspace + mock callLlm（注入到类）
- `computeNewImportance` 是纯函数，直接 import 测试，无需 mock

## 实现指导

### T022 — lifecycle.test.ts：调度器生命周期

```typescript
// tests/unit/hippocampus/lifecycle.test.ts
import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { HippocampusConsolidation } from '../../../src/hippocampus/index'

describe('HippocampusConsolidation lifecycle', () => {
  let mockWorkspace: any
  let consolidation: HippocampusConsolidation

  beforeEach(() => {
    mockWorkspace = {}
    consolidation = new HippocampusConsolidation(mockWorkspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      runAt: '23:59',  // 明天才触发，不影响测试
    })
  })

  test('running flag is false before start()', () => {
    expect((consolidation as any).running).toBe(false)
  })

  test('start() sets running=true', () => {
    consolidation.start()
    expect((consolidation as any).running).toBe(true)
    consolidation.stop()  // cleanup
  })

  test('stop() sets running=false and clears timer', async () => {
    consolidation.start()
    await consolidation.stop()
    expect((consolidation as any).running).toBe(false)
    expect((consolidation as any).timer).toBeNull()
  })

  test('stop() is idempotent (no error on double stop)', async () => {
    consolidation.start()
    await consolidation.stop()
    await expect(consolidation.stop()).resolves.toBeUndefined()
  })

  test('start() is idempotent (no double scheduling)', () => {
    consolidation.start()
    const timer1 = (consolidation as any).timer
    consolidation.start()  // second call
    const timer2 = (consolidation as any).timer
    expect(timer1).toBe(timer2)  // same timer, not replaced
    consolidation.stop()
  })

  test('stop() waits for currentRun to complete (within timeout)', async () => {
    let resolveRun!: () => void
    const slowRun = new Promise<void>((resolve) => { resolveRun = resolve })
    ;(consolidation as any).currentRun = slowRun
    ;(consolidation as any).running = true

    const stopPromise = consolidation.stop()
    resolveRun()  // resolve before timeout
    await stopPromise
    expect((consolidation as any).running).toBe(false)
  })
})
```

---

### T023 — segment-refine.test.ts：段精修逻辑

```typescript
// tests/unit/hippocampus/segment-refine.test.ts
import { describe, test, expect, mock, spyOn } from 'bun:test'
import { HippocampusConsolidation } from '../../../src/hippocampus/index'
import * as llmModule from '../../../src/llm'

describe('runSegmentRefine', () => {
  function makeConsolidation(workspaceMethods: Record<string, any>) {
    const workspace = { ...workspaceMethods }
    return new HippocampusConsolidation(workspace as any, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })
  }

  test('merge=true → updateMemorySegment is called for source entries', async () => {
    const segA = { segmentId: 'seg-a', eventCount: 2, avgImportance: 0.7, maxCreatedAt: new Date('2026-01-01') }
    const segB = { segmentId: 'seg-b', eventCount: 2, avgImportance: 0.6, maxCreatedAt: new Date('2026-01-02') }
    const seqA = [{ id: 'a1', content: 'event A1', segmentSeq: 0 }, { id: 'a2', content: 'event A2', segmentSeq: 1 }]
    const seqB = [{ id: 'b1', content: 'event B1', segmentSeq: 0 }, { id: 'b2', content: 'event B2', segmentSeq: 1 }]

    const updateSpy = mock(() => Promise.resolve())
    const c = makeConsolidation({
      getSegmentsByTimeRange: mock(() => Promise.resolve([segA, segB])),
      getSegmentSequence: mock((id: string) =>
        Promise.resolve(id === 'seg-a' ? seqA : seqB)
      ),
      updateMemorySegment: updateSpy,
    })

    // mock callLlm to return merge=true
    spyOn(llmModule, 'callLlm').mockResolvedValue('{"merge": true, "reason": "same topic"}')

    await (c as any).runSegmentRefine()

    // b1, b2 should be updated to seg-a
    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect(updateSpy).toHaveBeenCalledWith('b1', 'seg-a', 2)  // maxSeq(segA)=2, index 0
    expect(updateSpy).toHaveBeenCalledWith('b2', 'seg-a', 3)  // index 1
  })

  test('merge=false → updateMemorySegment is NOT called', async () => {
    const segA = { segmentId: 'seg-a', eventCount: 2, avgImportance: 0.7, maxCreatedAt: new Date('2026-01-01') }
    const segB = { segmentId: 'seg-b', eventCount: 2, avgImportance: 0.6, maxCreatedAt: new Date('2026-01-02') }
    const updateSpy = mock(() => Promise.resolve())
    const c = makeConsolidation({
      getSegmentsByTimeRange: mock(() => Promise.resolve([segA, segB])),
      getSegmentSequence: mock(() => Promise.resolve([{ id: 'x', content: 'e', segmentSeq: 0 }])),
      updateMemorySegment: updateSpy,
    })
    spyOn(llmModule, 'callLlm').mockResolvedValue('{"merge": false, "reason": "different topics"}')
    await (c as any).runSegmentRefine()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  test('LLM failure → single pair fails, refinement continues (no throw)', async () => {
    const segments = [
      { segmentId: 'seg-a', eventCount: 2, avgImportance: 0.7, maxCreatedAt: new Date('2026-01-01') },
      { segmentId: 'seg-b', eventCount: 2, avgImportance: 0.6, maxCreatedAt: new Date('2026-01-02') },
    ]
    const c = makeConsolidation({
      getSegmentsByTimeRange: mock(() => Promise.resolve(segments)),
      getSegmentSequence: mock(() => Promise.resolve([{ id: 'x', content: 'e', segmentSeq: 0 }])),
      updateMemorySegment: mock(() => Promise.resolve()),
    })
    spyOn(llmModule, 'callLlm').mockRejectedValue(new Error('LLM timeout'))
    // Should NOT throw
    await expect((c as any).runSegmentRefine()).resolves.toBeUndefined()
  })

  test('parseLlmJson failure → defaults to merge=false', async () => {
    const updateSpy = mock(() => Promise.resolve())
    const segments = [
      { segmentId: 'seg-a', eventCount: 2, avgImportance: 0.7, maxCreatedAt: new Date('2026-01-01') },
      { segmentId: 'seg-b', eventCount: 2, avgImportance: 0.6, maxCreatedAt: new Date('2026-01-02') },
    ]
    const c = makeConsolidation({
      getSegmentsByTimeRange: mock(() => Promise.resolve(segments)),
      getSegmentSequence: mock(() => Promise.resolve([{ id: 'x', content: 'e', segmentSeq: 0 }])),
      updateMemorySegment: updateSpy,
    })
    spyOn(llmModule, 'callLlm').mockResolvedValue('invalid json here')
    await (c as any).runSegmentRefine()
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
```

---

### T024 — sequence-replay.test.ts：序列回放逻辑

```typescript
// tests/unit/hippocampus/sequence-replay.test.ts
import { describe, test, expect, mock, spyOn } from 'bun:test'
import { HippocampusConsolidation } from '../../../src/hippocampus/index'
import * as llmModule from '../../../src/llm'

const sampleLlmResponse = JSON.stringify({
  semantic: [{ content: 'Fact about procurement', entityId: 'procurement', tags: ['workflow'] }],
  procedural: [{ content: 'Step 1: Check approval. Step 2: Submit.', tags: ['approval'] }],
  implicit: [],
})

describe('runSequenceReplay', () => {
  function makeConsolidation(workspaceMethods: Record<string, any>) {
    return new HippocampusConsolidation(workspaceMethods as any, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      replayTopK: 2,
    })
  }

  test('writeMemory called twice for semantic + procedural results', async () => {
    const writeMemorySpy = mock(() => Promise.resolve({ id: 'new-id' }))
    const c = makeConsolidation({
      getSegmentsByTimeRange: mock(() => Promise.resolve([
        { segmentId: 'seg-1', eventCount: 3, avgImportance: 0.8, maxCreatedAt: new Date() },
      ])),
      getSegmentSequence: mock(() => Promise.resolve([
        { id: 'e1', content: 'Event 1', segmentSeq: 0 },
        { id: 'e2', content: 'Event 2', segmentSeq: 1 },
        { id: 'e3', content: 'Event 3', segmentSeq: 2 },
      ])),
      searchMemory: mock(() => Promise.resolve([])),  // no existing
      writeMemory: writeMemorySpy,
      invalidateMemory: mock(() => Promise.resolve()),
    })
    spyOn(llmModule, 'callLlm').mockResolvedValue(sampleLlmResponse)
    await (c as any).runSequenceReplay()
    // semantic(1) + procedural(1) = 2 writes
    expect(writeMemorySpy).toHaveBeenCalledTimes(2)
    const calls = writeMemorySpy.mock.calls
    expect(calls[0]?.[0]?.type).toBe('semantic')
    expect(calls[1]?.[0]?.type).toBe('procedural')
  })

  test('segment with < 2 events is skipped', async () => {
    const writeMemorySpy = mock(() => Promise.resolve({ id: 'x' }))
    const c = makeConsolidation({
      getSegmentsByTimeRange: mock(() => Promise.resolve([
        { segmentId: 'seg-tiny', eventCount: 1, avgImportance: 0.9, maxCreatedAt: new Date() },
      ])),
      getSegmentSequence: mock(() => Promise.resolve([{ id: 'e1', content: 'Single', segmentSeq: 0 }])),
      searchMemory: mock(() => Promise.resolve([])),
      writeMemory: writeMemorySpy,
      invalidateMemory: mock(() => Promise.resolve()),
    })
    spyOn(llmModule, 'callLlm').mockResolvedValue(sampleLlmResponse)
    await (c as any).runSequenceReplay()
    expect(writeMemorySpy).not.toHaveBeenCalled()
  })

  test('JSON parse failure → segment skipped, no throw', async () => {
    const writeMemorySpy = mock(() => Promise.resolve({ id: 'x' }))
    const c = makeConsolidation({
      getSegmentsByTimeRange: mock(() => Promise.resolve([
        { segmentId: 'seg-1', eventCount: 3, avgImportance: 0.8, maxCreatedAt: new Date() },
      ])),
      getSegmentSequence: mock(() => Promise.resolve([
        { id: 'e1', content: 'A', segmentSeq: 0 },
        { id: 'e2', content: 'B', segmentSeq: 1 },
      ])),
      searchMemory: mock(() => Promise.resolve([])),
      writeMemory: writeMemorySpy,
      invalidateMemory: mock(() => Promise.resolve()),
    })
    spyOn(llmModule, 'callLlm').mockResolvedValue('not valid json at all')
    await expect((c as any).runSequenceReplay()).resolves.toBeUndefined()
    expect(writeMemorySpy).not.toHaveBeenCalled()
  })

  test('existing memory → invalidateMemory + supersedesId set', async () => {
    const invalidateSpy = mock(() => Promise.resolve())
    const writeMemorySpy = mock(() => Promise.resolve({ id: 'new' }))
    const c = makeConsolidation({
      getSegmentsByTimeRange: mock(() => Promise.resolve([
        { segmentId: 'seg-1', eventCount: 3, avgImportance: 0.8, maxCreatedAt: new Date() },
      ])),
      getSegmentSequence: mock(() => Promise.resolve([
        { id: 'e1', content: 'A', segmentSeq: 0 },
        { id: 'e2', content: 'B', segmentSeq: 1 },
        { id: 'e3', content: 'C', segmentSeq: 2 },
      ])),
      searchMemory: mock(() => Promise.resolve([{ id: 'existing-id', content: 'old fact' }])),
      writeMemory: writeMemorySpy,
      invalidateMemory: invalidateSpy,
    })
    spyOn(llmModule, 'callLlm').mockResolvedValue(JSON.stringify({
      semantic: [{ content: 'Updated fact', entityId: null, tags: [] }],
      procedural: [],
      implicit: [],
    }))
    await (c as any).runSequenceReplay()
    expect(invalidateSpy).toHaveBeenCalledWith('existing-id')
    expect(writeMemorySpy.mock.calls[0]?.[0]?.supersedesId).toBe('existing-id')
  })
})
```

---

### T025 — converge-cleanup.test.ts Part A：computeNewImportance 纯函数

```typescript
// tests/unit/hippocampus/converge-cleanup.test.ts
import { describe, test, expect } from 'bun:test'
import { computeNewImportance } from '../../../src/hippocampus/index'

const config = {
  convergencePositiveThreshold: 0.6,
  convergenceNegativeThreshold: 0.6,
  convergenceStep: 0.05,
}

describe('computeNewImportance', () => {
  test('high positive ratio → importance increases', () => {
    const result = computeNewImportance(0.5, { positive: 4, negative: 1, neutral: 0 }, config)
    expect(result).toBeCloseTo(0.55, 5)
  })

  test('high negative ratio → importance decreases', () => {
    const result = computeNewImportance(0.5, { positive: 1, negative: 4, neutral: 0 }, config)
    expect(result).toBeCloseTo(0.45, 5)
  })

  test('neither threshold met → no change', () => {
    const result = computeNewImportance(0.5, { positive: 3, negative: 3, neutral: 4 }, config)
    expect(result).toBeCloseTo(0.5, 5)
  })

  test('at floor (0.0) + negative → stays at 0.0 (no underflow)', () => {
    const result = computeNewImportance(0.0, { positive: 0, negative: 5, neutral: 0 }, config)
    expect(result).toBe(0.0)
  })

  test('at ceiling (1.0) + positive → stays at 1.0 (no overflow)', () => {
    const result = computeNewImportance(1.0, { positive: 5, negative: 0, neutral: 0 }, config)
    expect(result).toBe(1.0)
  })

  test('all zero outcomes → returns current unchanged', () => {
    const result = computeNewImportance(0.7, { positive: 0, negative: 0, neutral: 0 }, config)
    expect(result).toBe(0.7)
  })
})
```

---

### T026 — converge-cleanup.test.ts Part B：runOutcomesConverge mock 验证

```typescript
describe('runOutcomesConverge', () => {
  test('calls updateMemoryImportanceAndResetOutcomes for each non-zero entry', async () => {
    const updateSpy = mock(() => Promise.resolve())
    const workspace = {
      getMemoriesWithNonZeroOutcomes: mock(() => Promise.resolve([
        { id: 'mem-1', baseImportance: 0.5, usageOutcomes: { positive: 4, negative: 1, neutral: 0 } },
        { id: 'mem-2', baseImportance: 0.6, usageOutcomes: { positive: 1, negative: 4, neutral: 0 } },
      ])),
      updateMemoryImportanceAndResetOutcomes: updateSpy,
    }
    const c = new HippocampusConsolidation(workspace as any, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })
    await (c as any).runOutcomesConverge()
    expect(updateSpy).toHaveBeenCalledTimes(2)
    // mem-1: positive ratio 0.8 > 0.6 → +0.05 → 0.55
    expect(updateSpy.mock.calls[0]?.[0]).toBe('mem-1')
    expect(updateSpy.mock.calls[0]?.[1]).toBeCloseTo(0.55, 5)
    // mem-2: negative ratio 0.8 > 0.6 → -0.05 → 0.55
    expect(updateSpy.mock.calls[1]?.[0]).toBe('mem-2')
    expect(updateSpy.mock.calls[1]?.[1]).toBeCloseTo(0.55, 5)
  })
})
```

---

### T027 — converge-cleanup.test.ts Part C：runExpiryCleanup + 顺序约束

```typescript
describe('runExpiryCleanup', () => {
  test('calls forgetExpiredMemories with current time', async () => {
    const forgetSpy = mock(() => Promise.resolve(3))
    const c = new HippocampusConsolidation({
      forgetExpiredMemories: forgetSpy,
    } as any, { llm: { model: 'claude-haiku-4-5-20251001' } })
    await (c as any).runExpiryCleanup()
    expect(forgetSpy).toHaveBeenCalledTimes(1)
    // called with a Date close to now
    const calledWith = forgetSpy.mock.calls[0]?.[0]
    expect(calledWith).toBeInstanceOf(Date)
  })
})

describe('runConsolidation ordering', () => {
  test('step 2 is NOT called if step 1 throws', async () => {
    const replaySpy = mock(() => Promise.resolve())
    const c = new HippocampusConsolidation({} as any, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })
    // override private methods
    ;(c as any).runSegmentRefine = mock(() => Promise.reject(new Error('step 1 failed')))
    ;(c as any).runSequenceReplay = replaySpy
    ;(c as any).runOutcomesConverge = mock(() => Promise.resolve())
    ;(c as any).runExpiryCleanup = mock(() => Promise.resolve())

    await expect(c.runConsolidation()).rejects.toThrow('step 1 failed')
    expect(replaySpy).not.toHaveBeenCalled()
  })
})
```

## Definition of Done

- [ ] T022: lifecycle.test.ts — 6 tests covering start/stop/idempotency/wait 均通过
- [ ] T023: segment-refine.test.ts — merge=true 调用 updateMemorySegment，merge=false 不调用，LLM 失败不 throw，JSON 无效 → merge=false
- [ ] T024: sequence-replay.test.ts — 写入 semantic+procedural，小段跳过，解析失败跳过，supersedesId 正确设置
- [ ] T025: computeNewImportance — 6 边界值测试全通过
- [ ] T026: runOutcomesConverge — mock 2 条记忆，updateSpy 调用 2 次，importance 方向正确
- [ ] T027: runExpiryCleanup + 顺序约束——step 1 throw 时 step 2 未调用
- [ ] `bun test tests/unit/hippocampus/` 全通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
spec-kitty agent tasks move-task WP05 --to for_review --note "Ready: <summary>"
```

## Activity Log

- 2026-03-11T02:36:28Z – claude-sonnet-4-6 – shell_pid=57258 – lane=doing – Started implementation via workflow command
- 2026-03-11T02:43:48Z – claude-sonnet-4-6 – shell_pid=57258 – lane=for_review – Ready for review: 30 unit tests passing across 4 files (lifecycle, segment-refine, sequence-replay, converge-cleanup). Uses mock.module() + dynamic import pattern for ESM mocking. All typecheck and biome checks pass.
- 2026-03-11T02:48:16Z – claude – shell_pid=70094 – lane=doing – Started review via workflow command
