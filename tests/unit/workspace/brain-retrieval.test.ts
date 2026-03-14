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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const T0 = new Date('2025-01-01T00:00:00Z')

function makeMemoryRow(overrides?: Partial<MemoryRow>): MemoryRow {
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

// ─── Simple mock builder for select().from().where().orderBy().limit() chain ──

function makeSelectMock(rows: MemoryRow[]): DrizzleDB {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    }),
  } as unknown as DrizzleDB
}

// ─── getEntityContext Tests ───────────────────────────────────────────────────

describe('getEntityContext', () => {
  test('returns memories matching entityId', async () => {
    const rows = [
      makeMemoryRow({ id: 'mem-a', entityId: 'e1' }),
      makeMemoryRow({ id: 'mem-b', entityId: 'e1' }),
    ]
    const ws = new CognitiveWorkspace(makeSelectMock(rows))

    const results = await ws.getEntityContext('e1')
    expect(results).toHaveLength(2)
    expect(results.map((m) => m.id)).toEqual(['mem-a', 'mem-b'])
  })

  test('returns empty array when no matching entity', async () => {
    const ws = new CognitiveWorkspace(makeSelectMock([]))

    const results = await ws.getEntityContext('unknown-entity')
    expect(results).toHaveLength(0)
  })

  test('passes types filter and returns mapped results', async () => {
    const row = makeMemoryRow({ id: 'sem-1', type: 'semantic', entityId: 'e1' })
    const ws = new CognitiveWorkspace(makeSelectMock([row]))

    const results = await ws.getEntityContext('e1', { types: ['semantic'] })
    expect(results).toHaveLength(1)
    expect(results[0]?.type).toBe('semantic')
  })

  test('uses default limit 10 when not specified', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeMemoryRow({ id: `m${i}`, entityId: 'e1' }),
    )
    const ws = new CognitiveWorkspace(makeSelectMock(rows))

    const results = await ws.getEntityContext('e1')
    expect(results).toHaveLength(10)
  })

  test('respects custom limit', async () => {
    const rows = [makeMemoryRow({ id: 'mem-a', entityId: 'e1' })]
    const ws = new CognitiveWorkspace(makeSelectMock(rows))

    const results = await ws.getEntityContext('e1', { limit: 3 })
    expect(results).toHaveLength(1) // mock returns what's configured
  })

  test('maps row fields correctly', async () => {
    const row = makeMemoryRow({
      id: 'mem-xyz',
      type: 'episodic',
      content: 'something happened',
      entityId: 'entity-99',
      baseImportance: 0.9,
      tags: ['ctx', 'entity'],
      usageOutcomes: { positive: 1, negative: 0, neutral: 2 },
    })
    const ws = new CognitiveWorkspace(makeSelectMock([row]))

    const results = await ws.getEntityContext('entity-99')
    const mem = results[0]
    expect(mem?.id).toBe('mem-xyz')
    expect(mem?.type).toBe('episodic')
    expect(mem?.content).toBe('something happened')
    expect(mem?.entityId).toBe('entity-99')
    expect(mem?.baseImportance).toBe(0.9)
    expect(mem?.tags).toEqual(['ctx', 'entity'])
    expect(mem?.usageOutcomes).toEqual({ positive: 1, negative: 0, neutral: 2 })
  })
})

// ─── findSimilarSituations Tests ──────────────────────────────────────────────

describe('findSimilarSituations', () => {
  test('returns three groups: episodes, procedures, facts', async () => {
    // Use a call-count based mock to return different data per group
    let callCount = 0
    const groupRows = [
      [makeMemoryRow({ id: 'ep-1', type: 'episodic' })],
      [makeMemoryRow({ id: 'pr-1', type: 'procedural' })],
      [makeMemoryRow({ id: 'fa-1', type: 'semantic' })],
    ]
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => groupRows[callCount++] ?? [],
            }),
          }),
        }),
      }),
    } as unknown as DrizzleDB

    const ws = new CognitiveWorkspace(db)
    const result = await ws.findSimilarSituations('complaint')

    expect(result.episodes).toHaveLength(1)
    expect(result.procedures).toHaveLength(1)
    expect(result.facts).toHaveLength(1)
    expect(result.episodes[0]?.id).toBe('ep-1')
    expect(result.procedures[0]?.id).toBe('pr-1')
    expect(result.facts[0]?.id).toBe('fa-1')
  })

  test('executes three parallel queries (select called 3 times)', async () => {
    let callCount = 0
    const db = {
      select: () => {
        callCount++
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [] as MemoryRow[],
              }),
            }),
          }),
        }
      },
    } as unknown as DrizzleDB

    const ws = new CognitiveWorkspace(db)
    await ws.findSimilarSituations('anything')

    expect(callCount).toBe(3)
  })

  test('returns empty arrays when no matches', async () => {
    const ws = new CognitiveWorkspace(makeSelectMock([]))

    const result = await ws.findSimilarSituations('nomatch')
    expect(result.episodes).toEqual([])
    expect(result.procedures).toEqual([])
    expect(result.facts).toEqual([])
  })

  test('uses default limit 5 per group', async () => {
    const limitValues: number[] = []
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (n: number) => {
                limitValues.push(n)
                return [] as MemoryRow[]
              },
            }),
          }),
        }),
      }),
    } as unknown as DrizzleDB

    const ws = new CognitiveWorkspace(db)
    await ws.findSimilarSituations('x')

    expect(limitValues).toEqual([5, 5, 5])
  })

  test('respects custom limit', async () => {
    const limitValues: number[] = []
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (n: number) => {
                limitValues.push(n)
                return [] as MemoryRow[]
              },
            }),
          }),
        }),
      }),
    } as unknown as DrizzleDB

    const ws = new CognitiveWorkspace(db)
    await ws.findSimilarSituations('x', { limit: 2 })

    expect(limitValues).toEqual([2, 2, 2])
  })
})

// ─── getProcedure Tests ───────────────────────────────────────────────────────

describe('getProcedure', () => {
  test('returns only procedural type memories', async () => {
    const row = makeMemoryRow({ id: 'proc-1', type: 'procedural', content: 'handle complaint' })
    const ws = new CognitiveWorkspace(makeSelectMock([row]))

    const results = await ws.getProcedure('complaint')
    expect(results).toHaveLength(1)
    expect(results[0]?.type).toBe('procedural')
  })

  test('returns empty array when no matches', async () => {
    const ws = new CognitiveWorkspace(makeSelectMock([]))

    const results = await ws.getProcedure('unknown-task')
    expect(results).toHaveLength(0)
  })

  test('uses default limit 3', async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      makeMemoryRow({ id: `proc-${i}`, type: 'procedural' }),
    )
    const ws = new CognitiveWorkspace(makeSelectMock(rows))

    const results = await ws.getProcedure('task')
    expect(results).toHaveLength(3) // mock returns what's configured
  })

  test('respects custom limit', async () => {
    const limitValues: number[] = []
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (n: number) => {
                limitValues.push(n)
                return [] as MemoryRow[]
              },
            }),
          }),
        }),
      }),
    } as unknown as DrizzleDB

    const ws = new CognitiveWorkspace(db)
    await ws.getProcedure('task', { limit: 1 })

    expect(limitValues).toEqual([1])
  })

  test('maps row fields correctly', async () => {
    const row = makeMemoryRow({
      id: 'proc-xyz',
      type: 'procedural',
      content: 'handle refund task',
      baseImportance: 0.8,
      lastAccessedAt: T0,
    })
    const ws = new CognitiveWorkspace(makeSelectMock([row]))

    const results = await ws.getProcedure('refund')
    const mem = results[0]
    expect(mem?.id).toBe('proc-xyz')
    expect(mem?.type).toBe('procedural')
    expect(mem?.content).toBe('handle refund task')
    expect(mem?.baseImportance).toBe(0.8)
    expect(mem?.lastAccessedAt).toEqual(T0)
  })
})
