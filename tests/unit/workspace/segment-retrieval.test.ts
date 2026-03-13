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

type AggRow = {
  segmentId: string | null
  eventCount: string | number
  avgImportance: string | number | null
  maxCreatedAt: Date | null
}

const T0 = new Date('2025-01-01T00:00:00Z')

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
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

// ─── Mock DB builders ─────────────────────────────────────────────────────────

// For getSegmentSequence: select().from().where().orderBy() → rows
function makeSequenceMockDb(rows: MemoryRow[]): DrizzleDB {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  } as unknown as DrizzleDB
}

// For getSegmentsByTimeRange: select({fields}).from().where().groupBy() → aggRows
function makeRangeMockDb(aggRows: AggRow[]): DrizzleDB {
  return {
    select: (_cols?: unknown) => ({
      from: () => ({
        where: () => ({
          groupBy: async () => aggRows,
        }),
      }),
    }),
  } as unknown as DrizzleDB
}

// ─── Tests: getSegmentSequence ────────────────────────────────────────────────

describe('getSegmentSequence', () => {
  // V1: returns entries in ascending segmentSeq order (order is from DB / mock)
  test('V1 — returns segment events in segmentSeq order', async () => {
    // Mock simulates that DB already returned them in correct order (ORDER BY segmentSeq ASC)
    const rows = [
      makeEpisodicRow({ id: 'e0', segmentId: 'seg-abc', segmentSeq: 0 }),
      makeEpisodicRow({ id: 'e1', segmentId: 'seg-abc', segmentSeq: 1 }),
      makeEpisodicRow({ id: 'e2', segmentId: 'seg-abc', segmentSeq: 2 }),
    ]
    const ws = new CognitiveWorkspace(makeSequenceMockDb(rows))

    const results = await ws.getSegmentSequence('seg-abc')

    expect(results).toHaveLength(3)
    expect(results[0]?.segmentSeq).toBe(0)
    expect(results[1]?.segmentSeq).toBe(1)
    expect(results[2]?.segmentSeq).toBe(2)
  })

  // V2: excludes soft-deleted entries (mock returns only active rows)
  test('V2 — excludes soft-deleted entries', async () => {
    // DB filters tInvalid IS NULL; mock returns only the 2 active rows
    const rows = [
      makeEpisodicRow({ id: 'e0', segmentId: 'seg-def', segmentSeq: 0 }),
      makeEpisodicRow({ id: 'e1', segmentId: 'seg-def', segmentSeq: 1 }),
      // third row (segmentSeq: 2) was soft-deleted, DB excludes it
    ]
    const ws = new CognitiveWorkspace(makeSequenceMockDb(rows))

    const results = await ws.getSegmentSequence('seg-def')

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.tInvalid === null)).toBe(true)
  })

  // V3: returns empty array for unknown segment
  test('V3 — returns empty array for unknown segment', async () => {
    const ws = new CognitiveWorkspace(makeSequenceMockDb([]))

    const results = await ws.getSegmentSequence('seg-unknown')

    expect(results).toEqual([])
  })
})

// ─── Tests: getSegmentsByTimeRange ────────────────────────────────────────────

describe('getSegmentsByTimeRange', () => {
  // V4: returns segments with correct aggregated fields; higher importance first
  test('V4 — returns segments with correct eventCount, avgImportance, maxCreatedAt', async () => {
    const T_HIGH = new Date('2025-01-02T00:00:00Z')
    const T_LOW = new Date('2025-01-01T00:00:00Z')
    const aggRows: AggRow[] = [
      { segmentId: 'seg-high', eventCount: 3, avgImportance: 0.9, maxCreatedAt: T_HIGH },
      { segmentId: 'seg-low', eventCount: 3, avgImportance: 0.3, maxCreatedAt: T_LOW },
    ]
    const ws = new CognitiveWorkspace(makeRangeMockDb(aggRows))
    const from = new Date('2024-12-31T00:00:00Z')
    const to = new Date('2025-01-03T00:00:00Z')

    const results = await ws.getSegmentsByTimeRange({ from, to })

    expect(results).toHaveLength(2)
    expect(results[0]?.segmentId).toBe('seg-high')
    expect(results[0]?.eventCount).toBe(3)
    expect(results[0]?.avgImportance).toBeCloseTo(0.9)
    expect(results[0]?.maxCreatedAt).toEqual(T_HIGH)
    expect(results[1]?.segmentId).toBe('seg-low')
  })

  // V5: excludes segments outside time range (mock returns only within-range rows)
  test('V5 — excludes segments outside the time range', async () => {
    const T_INSIDE = new Date('2025-01-02T00:00:00Z')
    const aggRows: AggRow[] = [
      { segmentId: 'seg-inside', eventCount: 2, avgImportance: 0.7, maxCreatedAt: T_INSIDE },
      // seg-outside not returned — DB filters it out by created_at range
    ]
    const ws = new CognitiveWorkspace(makeRangeMockDb(aggRows))
    const from = new Date('2025-01-01T00:00:00Z')
    const to = new Date('2025-01-03T00:00:00Z')

    const results = await ws.getSegmentsByTimeRange({ from, to })

    expect(results).toHaveLength(1)
    expect(results[0]?.segmentId).toBe('seg-inside')
    expect(results.some((r) => r.segmentId === 'seg-outside')).toBe(false)
  })
})
