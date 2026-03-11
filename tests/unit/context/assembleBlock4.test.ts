import { describe, expect, mock, test } from 'bun:test'
import { assembleBlock4 } from '../../../src/context/index'
import type { MemoryEntry } from '../../../src/types/index'
import type { CognitiveWorkspace } from '../../../src/workspace/index'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const T0 = new Date('2025-01-01T00:00:00Z')

function makeMemoryEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem-1',
    type: 'semantic',
    content: 'test',
    entityId: null,
    segmentId: null,
    segmentSeq: null,
    tags: [],
    baseImportance: 0.5,
    usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
    sourceBrain: null,
    threadId: null,
    sessionId: null,
    supersedesId: null,
    tInvalid: null,
    lastAccessedAt: null,
    pinned: false,
    forgotten: false,
    expiresAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

function makeWorkspaceSpy(overrides?: Partial<CognitiveWorkspace>) {
  return {
    getEntityContext: mock(async () => [makeMemoryEntry()]),
    findSimilarSituations: mock(async () => ({
      episodes: [makeMemoryEntry({ id: 'ep-1', type: 'episodic' })],
      procedures: [makeMemoryEntry({ id: 'pr-1', type: 'procedural' })],
      facts: [makeMemoryEntry({ id: 'fa-1', type: 'semantic' })],
    })),
    getProcedure: mock(async () => [makeMemoryEntry({ type: 'procedural' })]),
    searchMemory: mock(async () => [makeMemoryEntry()]),
    ...overrides,
  } as unknown as CognitiveWorkspace
}

// ─── Routing Tests ─────────────────────────────────────────────────────────────

describe('assembleBlock4 — routing with opts', () => {
  test('limbic + entityId → calls getEntityContext, not searchMemory', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('limbic', ws, 'thread-1', { entityId: 'entity-abc' })
    expect(ws.getEntityContext).toHaveBeenCalledWith('entity-abc', { limit: 10 })
    expect(ws.searchMemory).not.toHaveBeenCalled()
  })

  test('limbic without entityId → falls back to searchMemory (twice)', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('limbic', ws, 'thread-1')
    expect(ws.getEntityContext).not.toHaveBeenCalled()
    expect(ws.searchMemory).toHaveBeenCalledTimes(2)
  })

  test('cortex + situation → calls findSimilarSituations, not searchMemory', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('cortex', ws, 'thread-1', { situation: '客户投诉' })
    expect(ws.findSimilarSituations).toHaveBeenCalledWith('客户投诉', { limit: 5 })
    expect(ws.searchMemory).not.toHaveBeenCalled()
  })

  test('cortex without situation → falls back to searchMemory (twice)', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('cortex', ws, 'thread-1')
    expect(ws.findSimilarSituations).not.toHaveBeenCalled()
    expect(ws.searchMemory).toHaveBeenCalledTimes(2)
  })

  test('brainstem + taskType → calls getProcedure, not searchMemory', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('brainstem', ws, 'thread-1', { taskType: '报销审批' })
    expect(ws.getProcedure).toHaveBeenCalledWith('报销审批', { limit: 10 })
    expect(ws.searchMemory).not.toHaveBeenCalled()
  })

  test('brainstem without taskType → falls back to searchMemory (once)', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('brainstem', ws, 'thread-1')
    expect(ws.getProcedure).not.toHaveBeenCalled()
    expect(ws.searchMemory).toHaveBeenCalledTimes(1)
  })

  test('result text includes memory content when results are returned', async () => {
    const ws = makeWorkspaceSpy({
      getEntityContext: mock(async () => [makeMemoryEntry({ id: 'e1', content: 'entity fact' })]),
    })
    const { text, injectedMemoryIds } = await assembleBlock4('limbic', ws, 't', {
      entityId: 'entity-abc',
    })
    expect(text).toContain('## Relevant Memory')
    expect(text).toContain('entity fact')
    expect(injectedMemoryIds).toHaveLength(1)
    expect(injectedMemoryIds[0]).toBe('e1')
  })

  test('result is empty when no memories returned', async () => {
    const ws = makeWorkspaceSpy({
      getEntityContext: mock(async () => []),
    })
    const { text, injectedMemoryIds } = await assembleBlock4('limbic', ws, 't', {
      entityId: 'entity-abc',
    })
    expect(text).toBe('')
    expect(injectedMemoryIds).toHaveLength(0)
  })

  test('cortex situation path merges all three groups and deduplicates', async () => {
    const ws = makeWorkspaceSpy()
    const { injectedMemoryIds } = await assembleBlock4('cortex', ws, 't', { situation: 'test' })
    // 3 unique entries from the spy (ep-1, pr-1, fa-1)
    expect(injectedMemoryIds).toHaveLength(3)
  })
})
