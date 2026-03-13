import { describe, expect, test } from 'bun:test'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import type { DrizzleDB } from '../../../src/workspace/index'

// ─── Mock Row Shape ───────────────────────────────────────────────────────────

type MemoryRow = {
  id: string
  type: 'semantic' | 'episodic' | 'procedural' | 'working' | 'implicit'
  content: string
  entityId: string | null
  segmentId: string | null
  segmentSeq: number | null
  tags: string[]
  baseImportance: number
  usageOutcomes: { positive: number; negative: number; neutral: number }
  sourceBrain: string | null
  threadId: string | null
  sessionId: string | null
  supersedesId: string | null
  tInvalid: Date | null
  lastAccessedAt: Date | null
  pinned: boolean
  forgotten: boolean
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const T0 = new Date('2025-01-01T00:00:00Z')

function makeRow(overrides?: Partial<MemoryRow>): MemoryRow {
  return {
    id: 'mem-1',
    type: 'semantic',
    content: 'test content',
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

// ─── Mock DB factory using call-count routing ─────────────────────────────────

function makeQueuedSelectDb(queue: MemoryRow[][]): DrizzleDB {
  let callIndex = 0
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => queue[callIndex++] ?? [],
          }),
        }),
      }),
    }),
  } as unknown as DrizzleDB
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getEntityContext — depth', () => {
  // V1: depth=1 (default) returns anchor memories only
  test('V1 — depth=1 returns anchor entity memories', async () => {
    const aliceRows = [
      makeRow({ id: 'a1', entityId: 'person:alice', type: 'semantic', baseImportance: 0.9 }),
      makeRow({ id: 'a2', entityId: 'person:alice', type: 'episodic', baseImportance: 0.7 }),
      makeRow({ id: 'a3', entityId: 'person:alice', type: 'semantic', baseImportance: 0.5 }),
    ]
    const ws = new CognitiveWorkspace(makeQueuedSelectDb([aliceRows]))

    const results = await ws.getEntityContext('person:alice')

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.entityId === 'person:alice')).toBe(true)
  })

  // V2: depth=2 expands related entities
  test('V2 — depth=2 appends related entity memories', async () => {
    const aliceRows = [
      makeRow({ id: 'a1', entityId: 'person:alice', type: 'semantic', baseImportance: 0.9 }),
      makeRow({
        id: 'a2',
        entityId: 'person:alice',
        type: 'semantic',
        baseImportance: 0.8,
        content: JSON.stringify({ related_to: { related_entity_id: 'project:aima' } }),
      }),
    ]
    const aimaRows = [
      makeRow({ id: 'p1', entityId: 'project:aima', type: 'semantic', baseImportance: 0.6 }),
      makeRow({ id: 'p2', entityId: 'project:aima', type: 'semantic', baseImportance: 0.5 }),
      makeRow({ id: 'p3', entityId: 'project:aima', type: 'episodic', baseImportance: 0.4 }),
    ]
    const ws = new CognitiveWorkspace(makeQueuedSelectDb([aliceRows, aimaRows]))

    const results = await ws.getEntityContext('person:alice', { depth: 2 })

    expect(results).toHaveLength(5) // 2 alice + 3 aima
    expect(results.slice(0, 2).every((r) => r.entityId === 'person:alice')).toBe(true)
    expect(results.slice(2).every((r) => r.entityId === 'project:aima')).toBe(true)
  })

  // V3: types filter works
  test('V3 — types filter returns only specified types', async () => {
    const rows = [
      makeRow({ id: 's1', entityId: 'project:aima', type: 'semantic' }),
      makeRow({ id: 'e1', entityId: 'project:aima', type: 'episodic' }),
      makeRow({ id: 'p1', entityId: 'project:aima', type: 'procedural' }),
    ]
    // Mock returns only the ones that would pass the filter (simulating DB-level filter)
    const filteredRows = [rows[0], rows[2]] as MemoryRow[]
    const ws = new CognitiveWorkspace(makeQueuedSelectDb([filteredRows]))

    const results = await ws.getEntityContext('project:aima', { types: ['semantic', 'procedural'] })

    expect(results).toHaveLength(2)
    expect(results.some((r) => r.type === 'episodic')).toBe(false)
  })

  // V4: depth > 2 is clamped to 2
  test('V4 — depth=3 is clamped to depth=2', async () => {
    const aliceRows = [
      makeRow({
        id: 'a1',
        entityId: 'person:alice',
        type: 'semantic',
        content: JSON.stringify({ related_to: { related_entity_id: 'project:aima' } }),
      }),
    ]
    const aimaRows = [makeRow({ id: 'p1', entityId: 'project:aima', type: 'semantic' })]
    let selectCallCount = 0
    const db = {
      select: () => {
        selectCallCount++
        const idx = selectCallCount - 1
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [aliceRows, aimaRows][idx] ?? [],
              }),
            }),
          }),
        }
      },
    } as unknown as DrizzleDB

    const ws = new CognitiveWorkspace(db)
    const results = await ws.getEntityContext('person:alice', { depth: 3 })

    // Should behave like depth=2: anchor + related
    expect(results.length).toBe(2) // 1 alice + 1 aima
    // select called exactly twice (anchor + 1 related entity) — same as depth=2
    expect(selectCallCount).toBe(2)
  })

  // V5: unknown entity returns empty array
  test('V5 — unknown entity returns empty array', async () => {
    const ws = new CognitiveWorkspace(makeQueuedSelectDb([[]]))

    const results = await ws.getEntityContext('person:nobody')

    expect(results).toEqual([])
  })
})
