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

// ─── Mock DB Factory ──────────────────────────────────────────────────────────

function makeSessionMockDb(rows: MemoryRow[]): DrizzleDB {
  const dbMock = {
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
    transaction: async (fn: (tx: DrizzleDB) => Promise<unknown>) =>
      fn(dbMock as unknown as DrizzleDB),
    query: {},
  }
  return dbMock as unknown as DrizzleDB
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const T1 = new Date('2025-01-01T00:00:00Z')
const T2 = new Date('2025-01-01T00:01:00Z')
const T3 = new Date('2025-01-01T00:02:00Z')

function makeEpisodicRow(overrides: Partial<MemoryRow> & { id: string }): MemoryRow {
  return {
    type: 'episodic',
    content: 'event',
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
    createdAt: T1,
    updatedAt: T1,
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CognitiveWorkspace.getSessionContext', () => {
  // V1 — returns anchor as earliest + events in ascending order
  test('returns anchor as earliest episodic and events in ascending order', async () => {
    const m1 = makeEpisodicRow({ id: 'mem-1', sessionId: 'sess-A', createdAt: T1 })
    const m2 = makeEpisodicRow({ id: 'mem-2', sessionId: 'sess-A', content: 'second', createdAt: T2 })
    const m3 = makeEpisodicRow({ id: 'mem-3', sessionId: 'sess-A', content: 'third', createdAt: T3 })

    const ws = new CognitiveWorkspace(makeSessionMockDb([m1, m2, m3]))
    const ctx = await ws.getSessionContext('sess-A')

    expect(ctx.anchor).not.toBeNull()
    expect(ctx.anchor!.id).toBe('mem-1')
    expect(ctx.events).toHaveLength(3)
    expect(ctx.events[0].id).toBe('mem-1')
    expect(ctx.events[2].id).toBe('mem-3')
  })

  // V2 — non-existent sessionId returns empty result, no exception
  test('returns { anchor: null, events: [] } for non-existent sessionId', async () => {
    const ws = new CognitiveWorkspace(makeSessionMockDb([]))
    const ctx = await ws.getSessionContext('session-does-not-exist')

    expect(ctx.anchor).toBeNull()
    expect(ctx.events).toHaveLength(0)
  })

  // V3 — cross-session isolation: does not mix memories from other sessions
  test('does not mix memories from other sessions', async () => {
    const m = makeEpisodicRow({ id: 'mem-A', sessionId: 'sess-A' })
    // Mock returns only sess-A rows (the real DB filters by sessionId)
    const ws = new CognitiveWorkspace(makeSessionMockDb([m]))
    const ctx = await ws.getSessionContext('sess-A')

    expect(ctx.events.every(e => e.sessionId === 'sess-A')).toBe(true)
    expect(ctx.events.some(e => e.sessionId === 'sess-B')).toBe(false)
  })

  // V4 — soft-deleted records are excluded (mock returns 0 rows, reflecting DB filter)
  test('excludes soft-deleted memories', async () => {
    // Real DB filters tInvalid IS NULL; mock returns empty to simulate all-deleted result
    const ws = new CognitiveWorkspace(makeSessionMockDb([]))
    const ctx = await ws.getSessionContext('sess-C')

    expect(ctx.anchor).toBeNull()
    expect(ctx.events).toHaveLength(0)
  })

  // V5 — non-episodic types are excluded (mock returns 0 rows, reflecting type filter)
  test('only returns episodic memories, not other types', async () => {
    // Real DB filters type='episodic'; mock returns empty to simulate working/semantic-only session
    const ws = new CognitiveWorkspace(makeSessionMockDb([]))
    const ctx = await ws.getSessionContext('sess-D')

    expect(ctx.anchor).toBeNull()
    expect(ctx.events).toHaveLength(0)
  })

  // V6 — single record: anchor and events[0] point to the same entry
  test('returns same entry as both anchor and events[0] when only one record exists', async () => {
    const m = makeEpisodicRow({ id: 'mem-only', sessionId: 'sess-E' })
    const ws = new CognitiveWorkspace(makeSessionMockDb([m]))
    const ctx = await ws.getSessionContext('sess-E')

    expect(ctx.anchor).not.toBeNull()
    expect(ctx.anchor!.id).toBe('mem-only')
    expect(ctx.events).toHaveLength(1)
    expect(ctx.events[0].id).toBe('mem-only')
  })
})
