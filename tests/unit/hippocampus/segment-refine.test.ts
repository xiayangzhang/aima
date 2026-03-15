import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock the llm module BEFORE the hippocampus module is loaded
const mockCallLlm = mock(() => Promise.resolve({ text: '{"merge": false, "reason": "default"}', usage: { inputTokens: 0, outputTokens: 0 } }))

mock.module('../../../src/llm', () => ({
  callLlm: mockCallLlm,
  parseLlmJson: <T>(text: string, fallback: T): T => {
    try {
      const m = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
      if (!m?.[1] && !m?.[0]) return fallback
      return JSON.parse((m[1] ?? m[0]) as string) as T
    } catch {
      return fallback
    }
  },
}))

// Dynamic import ensures the mock is in place first
const { HippocampusConsolidation } = await import('../../../src/hippocampus/index')

const makeWorkspace = (overrides: Record<string, unknown>) => ({
  getSegmentsByTimeRange: mock(() => Promise.resolve([])),
  getSegmentSequence: mock(() => Promise.resolve([])),
  updateMemorySegment: mock(() => Promise.resolve()),
  ...overrides,
})

const segA = {
  segmentId: 'seg-a',
  eventCount: 2,
  avgImportance: 0.7,
  maxCreatedAt: new Date('2026-01-01'),
}
const segB = {
  segmentId: 'seg-b',
  eventCount: 2,
  avgImportance: 0.6,
  maxCreatedAt: new Date('2026-01-02'),
}
const seqA = [
  { id: 'a1', content: 'event A1', segmentSeq: 0 },
  { id: 'a2', content: 'event A2', segmentSeq: 1 },
]
const seqB = [
  { id: 'b1', content: 'event B1', segmentSeq: 0 },
  { id: 'b2', content: 'event B2', segmentSeq: 1 },
]

describe('runSegmentRefine', () => {
  beforeEach(() => {
    mockCallLlm.mockReset()
    mockCallLlm.mockResolvedValue({ text: '{"merge": false, "reason": "default"}', usage: { inputTokens: 0, outputTokens: 0 } })
  })

  test('merge=true → updateMemorySegment called for source entries with correct seq', async () => {
    const updateSpy = mock(() => Promise.resolve())
    const workspace = makeWorkspace({
      getSegmentsByTimeRange: mock(() => Promise.resolve([segA, segB])),
      getSegmentSequence: mock((id: string) => Promise.resolve(id === 'seg-a' ? seqA : seqB)),
      updateMemorySegment: updateSpy,
    })
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    mockCallLlm.mockResolvedValue({ text: '{"merge": true, "reason": "same topic"}', usage: { inputTokens: 0, outputTokens: 0 } })
    await (c as never as { runSegmentRefine: () => Promise<void> }).runSegmentRefine()

    // seqA has 2 entries → offset=2; seqB[0]→seq 2, seqB[1]→seq 3
    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect(updateSpy.mock.calls[0]).toEqual(['b1', 'seg-a', 2])
    expect(updateSpy.mock.calls[1]).toEqual(['b2', 'seg-a', 3])
  })

  test('merge=false → updateMemorySegment is NOT called', async () => {
    const updateSpy = mock(() => Promise.resolve())
    const workspace = makeWorkspace({
      getSegmentsByTimeRange: mock(() => Promise.resolve([segA, segB])),
      getSegmentSequence: mock(() => Promise.resolve([{ id: 'x', content: 'e', segmentSeq: 0 }])),
      updateMemorySegment: updateSpy,
    })
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    mockCallLlm.mockResolvedValue({ text: '{"merge": false, "reason": "different topics"}', usage: { inputTokens: 0, outputTokens: 0 } })
    await (c as never as { runSegmentRefine: () => Promise<void> }).runSegmentRefine()

    expect(updateSpy).not.toHaveBeenCalled()
  })

  test('LLM failure → single pair fails with warn, refinement does not throw', async () => {
    const workspace = makeWorkspace({
      getSegmentsByTimeRange: mock(() => Promise.resolve([segA, segB])),
      getSegmentSequence: mock(() => Promise.resolve([{ id: 'x', content: 'e', segmentSeq: 0 }])),
    })
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    mockCallLlm.mockRejectedValue(new Error('LLM timeout'))
    await expect(
      (c as never as { runSegmentRefine: () => Promise<void> }).runSegmentRefine(),
    ).resolves.toBeUndefined()
  })

  test('invalid JSON from LLM → defaults to merge=false, no update', async () => {
    const updateSpy = mock(() => Promise.resolve())
    const workspace = makeWorkspace({
      getSegmentsByTimeRange: mock(() => Promise.resolve([segA, segB])),
      getSegmentSequence: mock(() => Promise.resolve([{ id: 'x', content: 'e', segmentSeq: 0 }])),
      updateMemorySegment: updateSpy,
    })
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    mockCallLlm.mockResolvedValue({ text: 'not valid json at all !!!', usage: { inputTokens: 0, outputTokens: 0 } })
    await (c as never as { runSegmentRefine: () => Promise<void> }).runSegmentRefine()

    expect(updateSpy).not.toHaveBeenCalled()
  })

  test('already-merged segment is skipped (within-run idempotency)', async () => {
    // Three segments: A→B merge, then B→C should be skipped since B is already merged
    const segC = {
      segmentId: 'seg-c',
      eventCount: 2,
      avgImportance: 0.5,
      maxCreatedAt: new Date('2026-01-03'),
    }
    const updateSpy = mock(() => Promise.resolve())
    const workspace = makeWorkspace({
      getSegmentsByTimeRange: mock(() => Promise.resolve([segA, segB, segC])),
      getSegmentSequence: mock((id: string) => {
        if (id === 'seg-a') return Promise.resolve(seqA)
        if (id === 'seg-b') return Promise.resolve(seqB)
        return Promise.resolve([{ id: 'c1', content: 'c', segmentSeq: 0 }])
      }),
      updateMemorySegment: updateSpy,
    })
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    // Both pairs return merge=true, but B is merged in pair A-B,
    // so pair B-C should be skipped
    mockCallLlm.mockResolvedValue({ text: '{"merge": true, "reason": "same"}', usage: { inputTokens: 0, outputTokens: 0 } })
    await (c as never as { runSegmentRefine: () => Promise<void> }).runSegmentRefine()

    // Only seqB entries should be updated (B merged into A), not seqC (B-C skipped)
    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect(updateSpy.mock.calls[0]?.[0]).toBe('b1')
    expect(updateSpy.mock.calls[1]?.[0]).toBe('b2')
  })
})
