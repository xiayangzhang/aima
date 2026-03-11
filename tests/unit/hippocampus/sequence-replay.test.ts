import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock the llm module BEFORE the hippocampus module is loaded
const mockCallLlm = mock(() => Promise.resolve('{}'))

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

const { HippocampusConsolidation } = await import('../../../src/hippocampus/index')

const sampleLlmResponse = JSON.stringify({
  semantic: [{ content: 'Fact about procurement', entityId: 'procurement', tags: ['workflow'] }],
  procedural: [{ content: 'Step 1: Check approval. Step 2: Submit.', tags: ['approval'] }],
  implicit: [],
})

const twoEvents = [
  { id: 'e1', content: 'Event 1', segmentSeq: 0 },
  { id: 'e2', content: 'Event 2', segmentSeq: 1 },
]

const threeEvents = [
  { id: 'e1', content: 'Event 1', segmentSeq: 0 },
  { id: 'e2', content: 'Event 2', segmentSeq: 1 },
  { id: 'e3', content: 'Event 3', segmentSeq: 2 },
]

const makeSeg = (segmentId = 'seg-1') => ({
  segmentId,
  eventCount: 3,
  avgImportance: 0.8,
  maxCreatedAt: new Date(),
})

describe('runSequenceReplay', () => {
  beforeEach(() => {
    mockCallLlm.mockReset()
    mockCallLlm.mockResolvedValue(sampleLlmResponse)
  })

  test('writeMemory called for each extracted semantic and procedural item', async () => {
    const writeMemorySpy = mock(() => Promise.resolve({ id: 'new-id' }))
    const workspace = {
      getSegmentsByTimeRange: mock(() => Promise.resolve([makeSeg()])),
      getSegmentSequence: mock(() => Promise.resolve(threeEvents)),
      searchMemory: mock(() => Promise.resolve([])),
      writeMemory: writeMemorySpy,
    }
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      replayTopK: 2,
    })

    await (c as never as { runSequenceReplay: () => Promise<void> }).runSequenceReplay()

    // 1 semantic + 1 procedural = 2 writeMemory calls
    expect(writeMemorySpy).toHaveBeenCalledTimes(2)
    expect(writeMemorySpy.mock.calls[0]?.[0]?.type).toBe('semantic')
    expect(writeMemorySpy.mock.calls[1]?.[0]?.type).toBe('procedural')
  })

  test('segment with fewer than 2 events is skipped', async () => {
    const writeMemorySpy = mock(() => Promise.resolve({ id: 'x' }))
    const workspace = {
      getSegmentsByTimeRange: mock(() => Promise.resolve([makeSeg('seg-tiny')])),
      getSegmentSequence: mock(() =>
        Promise.resolve([{ id: 'e1', content: 'Single event', segmentSeq: 0 }]),
      ),
      searchMemory: mock(() => Promise.resolve([])),
      writeMemory: writeMemorySpy,
    }
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    await (c as never as { runSequenceReplay: () => Promise<void> }).runSequenceReplay()

    expect(writeMemorySpy).not.toHaveBeenCalled()
  })

  test('JSON parse failure → segment produces no writes, no throw', async () => {
    const writeMemorySpy = mock(() => Promise.resolve({ id: 'x' }))
    const workspace = {
      getSegmentsByTimeRange: mock(() => Promise.resolve([makeSeg()])),
      getSegmentSequence: mock(() => Promise.resolve(twoEvents)),
      searchMemory: mock(() => Promise.resolve([])),
      writeMemory: writeMemorySpy,
    }
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    mockCallLlm.mockResolvedValue('not valid json at all !!!')

    await expect(
      (c as never as { runSequenceReplay: () => Promise<void> }).runSequenceReplay(),
    ).resolves.toBeUndefined()
    expect(writeMemorySpy).not.toHaveBeenCalled()
  })

  test('existing memory found → supersedesId passed to writeMemory', async () => {
    const writeMemorySpy = mock(() => Promise.resolve({ id: 'new' }))
    const workspace = {
      getSegmentsByTimeRange: mock(() => Promise.resolve([makeSeg()])),
      getSegmentSequence: mock(() => Promise.resolve(threeEvents)),
      searchMemory: mock(() => Promise.resolve([{ id: 'existing-id', content: 'old fact' }])),
      writeMemory: writeMemorySpy,
    }
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    mockCallLlm.mockResolvedValue(
      JSON.stringify({
        semantic: [{ content: 'Updated fact', entityId: null, tags: [] }],
        procedural: [],
        implicit: [],
      }),
    )

    await (c as never as { runSequenceReplay: () => Promise<void> }).runSequenceReplay()

    expect(writeMemorySpy).toHaveBeenCalledTimes(1)
    expect(writeMemorySpy.mock.calls[0]?.[0]?.supersedesId).toBe('existing-id')
  })

  test('top-K selection limits number of segments replayed', async () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({
      segmentId: `seg-${i}`,
      eventCount: 3,
      avgImportance: (10 - i) / 10, // descending importance
      maxCreatedAt: new Date(Date.now() - i * 1000),
    }))
    const getSequenceSpy = mock(() => Promise.resolve(threeEvents))
    const workspace = {
      getSegmentsByTimeRange: mock(() => Promise.resolve(segments)),
      getSegmentSequence: getSequenceSpy,
      searchMemory: mock(() => Promise.resolve([])),
      writeMemory: mock(() => Promise.resolve({ id: 'x' })),
    }
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      replayTopK: 3,
    })

    mockCallLlm.mockResolvedValue(JSON.stringify({ semantic: [], procedural: [], implicit: [] }))

    await (c as never as { runSequenceReplay: () => Promise<void> }).runSequenceReplay()

    // Only top 3 segments should have getSegmentSequence called
    // Each call to replaySegment calls getSegmentSequence once
    expect(getSequenceSpy.mock.calls.length).toBe(3)
  })
})
