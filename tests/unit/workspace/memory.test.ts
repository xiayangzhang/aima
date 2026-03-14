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

interface MockDbConfig {
  memoryInsertResult?: MemoryRow
  memorySelectResult?: MemoryRow[]
  memorySelectFieldsResult?: Array<{
    id: string
    usageOutcomes: { positive: number; negative: number; neutral: number }
  }>
}

interface CallRecord {
  updates: Array<{ setFields: Record<string, unknown> }>
  deletes: number
  transactionCount: number
}

function makeMockDb(config: MockDbConfig = {}): { db: DrizzleDB; calls: CallRecord } {
  const calls: CallRecord = { updates: [], deletes: 0, transactionCount: 0 }

  const dbMock = {
    insert: () => ({
      values: () => ({
        returning: async () =>
          config.memoryInsertResult !== undefined ? [config.memoryInsertResult] : [],
      }),
    }),
    update: () => ({
      set: (fields: Record<string, unknown>) => ({
        where: async () => {
          calls.updates.push({ setFields: fields })
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        calls.deletes++
      },
    }),
    select: (cols?: unknown) => ({
      from: () => ({
        where: (_cond?: unknown) => {
          if (cols !== undefined) {
            // markMemoryUsed path: select({ id, usageOutcomes }).from().where() — directly awaitable
            return Promise.resolve(config.memorySelectFieldsResult ?? [])
          }
          // searchMemory path: select().from().where().orderBy().limit()
          const fullRows = config.memorySelectResult ?? []
          return {
            orderBy: () => ({
              limit: async () => fullRows,
            }),
          }
        },
      }),
    }),
    transaction: async (fn: (tx: DrizzleDB) => Promise<unknown>) => {
      calls.transactionCount++
      return fn(dbMock as unknown as DrizzleDB)
    },
    query: {},
  }

  return { db: dbMock as unknown as DrizzleDB, calls }
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

// ─── writeMemory Tests ────────────────────────────────────────────────────────

describe('writeMemory', () => {
  test('writes memory with correct fields', async () => {
    const row = makeMemoryRow({ id: 'mem-abc', type: 'episodic', content: 'event happened' })
    const { db } = makeMockDb({ memoryInsertResult: row })
    const ws = new CognitiveWorkspace(db)

    const mem = await ws.writeMemory({ type: 'episodic', content: 'event happened' })

    expect(mem.id).toBe('mem-abc')
    expect(mem.type).toBe('episodic')
    expect(mem.content).toBe('event happened')
    expect(mem.createdAt).toEqual(T0)
  })

  test('uses default baseImportance 0.5 when not provided', async () => {
    const row = makeMemoryRow({ baseImportance: 0.5 })
    const { db } = makeMockDb({ memoryInsertResult: row })
    const ws = new CognitiveWorkspace(db)

    const mem = await ws.writeMemory({ type: 'semantic', content: 'x' })
    expect(mem.baseImportance).toBe(0.5)
  })

  test('uses default tags [] when not provided', async () => {
    const row = makeMemoryRow({ tags: [] })
    const { db } = makeMockDb({ memoryInsertResult: row })
    const ws = new CognitiveWorkspace(db)

    const mem = await ws.writeMemory({ type: 'semantic', content: 'x' })
    expect(mem.tags).toEqual([])
  })

  test('uses default pinned false when not provided', async () => {
    const row = makeMemoryRow({ pinned: false })
    const { db } = makeMockDb({ memoryInsertResult: row })
    const ws = new CognitiveWorkspace(db)

    const mem = await ws.writeMemory({ type: 'semantic', content: 'x' })
    expect(mem.pinned).toBe(false)
  })

  test('maps all optional fields when provided', async () => {
    const row = makeMemoryRow({
      entityId: 'entity-1',
      segmentId: 'seg-1',
      segmentSeq: 3,
      tags: ['foo', 'bar'],
      baseImportance: 0.9,
      sourceBrain: 'cortex',
      threadId: 'thread-1',
      sessionId: 'session-1',
      pinned: true,
    })
    const { db } = makeMockDb({ memoryInsertResult: row })
    const ws = new CognitiveWorkspace(db)

    const mem = await ws.writeMemory({ type: 'semantic', content: 'x' })
    expect(mem.entityId).toBe('entity-1')
    expect(mem.tags).toEqual(['foo', 'bar'])
    expect(mem.sourceBrain).toBe('cortex')
    expect(mem.pinned).toBe(true)
  })

  describe('with supersedesId', () => {
    test('atomically inserts new and invalidates old (uses transaction)', async () => {
      const newRow = makeMemoryRow({ id: 'mem-new', supersedesId: 'mem-old' })
      const { db, calls } = makeMockDb({ memoryInsertResult: newRow })
      const ws = new CognitiveWorkspace(db)

      await ws.writeMemory({ type: 'semantic', content: 'updated', supersedesId: 'mem-old' })

      expect(calls.transactionCount).toBe(1)
      // update was called to invalidate the old record
      expect(calls.updates.length).toBe(1)
      expect(calls.updates[0]?.setFields).toMatchObject({ tInvalid: expect.any(Date) })
    })

    test('new record has supersedesId pointing to old record', async () => {
      const newRow = makeMemoryRow({ id: 'mem-new', supersedesId: 'mem-old' })
      const { db } = makeMockDb({ memoryInsertResult: newRow })
      const ws = new CognitiveWorkspace(db)

      const mem = await ws.writeMemory({
        type: 'semantic',
        content: 'updated',
        supersedesId: 'mem-old',
      })

      expect(mem.supersedesId).toBe('mem-old')
    })

    test('non-supersedes path does not use transaction', async () => {
      const row = makeMemoryRow()
      const { db, calls } = makeMockDb({ memoryInsertResult: row })
      const ws = new CognitiveWorkspace(db)

      await ws.writeMemory({ type: 'semantic', content: 'x' })

      expect(calls.transactionCount).toBe(0)
      expect(calls.updates.length).toBe(0)
    })
  })
})

// ─── searchMemory Tests ───────────────────────────────────────────────────────

describe('searchMemory', () => {
  test('returns all valid memories when no filters', async () => {
    const rows = [makeMemoryRow({ id: 'a' }), makeMemoryRow({ id: 'b' })]
    const { db } = makeMockDb({ memorySelectResult: rows })
    const ws = new CognitiveWorkspace(db)

    const results = await ws.searchMemory({})
    expect(results).toHaveLength(2)
    expect(results.map((m) => m.id)).toEqual(['a', 'b'])
  })

  test('returns empty array when no memories found', async () => {
    const { db } = makeMockDb({ memorySelectResult: [] })
    const ws = new CognitiveWorkspace(db)

    const results = await ws.searchMemory({})
    expect(results).toHaveLength(0)
  })

  test('maps row fields correctly in search results', async () => {
    const row = makeMemoryRow({
      type: 'episodic',
      tags: ['tag1'],
      baseImportance: 0.8,
      tInvalid: null,
      usageOutcomes: { positive: 2, negative: 1, neutral: 0 },
    })
    const { db } = makeMockDb({ memorySelectResult: [row] })
    const ws = new CognitiveWorkspace(db)

    const results = await ws.searchMemory({})
    expect(results[0]?.type).toBe('episodic')
    expect(results[0]?.tags).toEqual(['tag1'])
    expect(results[0]?.usageOutcomes).toEqual({ positive: 2, negative: 1, neutral: 0 })
  })

  test('excludeInvalid: false includes t_invalid records in mock', async () => {
    const invalidRow = makeMemoryRow({ id: 'invalid', tInvalid: new Date() })
    const { db } = makeMockDb({ memorySelectResult: [invalidRow] })
    const ws = new CognitiveWorkspace(db)

    // Mock always returns configured rows regardless of WHERE — just verify call succeeds
    const results = await ws.searchMemory({ excludeInvalid: false })
    expect(results).toHaveLength(1)
    expect(results[0]?.tInvalid).toBeInstanceOf(Date)
  })

  test('filters by type (mock returns configured result)', async () => {
    const rows = [makeMemoryRow({ type: 'working' })]
    const { db } = makeMockDb({ memorySelectResult: rows })
    const ws = new CognitiveWorkspace(db)

    const results = await ws.searchMemory({ type: 'working' })
    expect(results[0]?.type).toBe('working')
  })

  test('filters by entityId (mock returns configured result)', async () => {
    const rows = [makeMemoryRow({ entityId: 'entity-42' })]
    const { db } = makeMockDb({ memorySelectResult: rows })
    const ws = new CognitiveWorkspace(db)

    const results = await ws.searchMemory({ entityId: 'entity-42' })
    expect(results[0]?.entityId).toBe('entity-42')
  })

  test('filters by segmentId (mock returns configured result)', async () => {
    const rows = [makeMemoryRow({ segmentId: 'seg-5' })]
    const { db } = makeMockDb({ memorySelectResult: rows })
    const ws = new CognitiveWorkspace(db)

    const results = await ws.searchMemory({ segmentId: 'seg-5' })
    expect(results[0]?.segmentId).toBe('seg-5')
  })

  test('respects limit via mock (default 20)', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeMemoryRow({ id: `m${i}` }))
    const { db } = makeMockDb({ memorySelectResult: rows })
    const ws = new CognitiveWorkspace(db)

    const results = await ws.searchMemory({})
    expect(results).toHaveLength(5) // mock returns what's configured
  })
})

// ─── markMemoryUsed Tests ─────────────────────────────────────────────────────

describe('markMemoryUsed', () => {
  test('handles empty ids array (no-op)', async () => {
    const { db, calls } = makeMockDb()
    const ws = new CognitiveWorkspace(db)

    await ws.markMemoryUsed([], 'positive')

    expect(calls.transactionCount).toBe(0)
    expect(calls.updates).toHaveLength(0)
  })

  test('increments positive counter for outcome: positive', async () => {
    const fieldRows = [{ id: 'mem-1', usageOutcomes: { positive: 3, negative: 1, neutral: 0 } }]
    const { db, calls } = makeMockDb({ memorySelectFieldsResult: fieldRows })
    const ws = new CognitiveWorkspace(db)

    await ws.markMemoryUsed(['mem-1'], 'positive')

    expect(calls.updates).toHaveLength(1)
    expect(calls.updates[0]?.setFields.usageOutcomes).toEqual({
      positive: 4,
      negative: 1,
      neutral: 0,
    })
  })

  test('increments negative counter for outcome: negative', async () => {
    const fieldRows = [{ id: 'mem-1', usageOutcomes: { positive: 0, negative: 0, neutral: 2 } }]
    const { db, calls } = makeMockDb({ memorySelectFieldsResult: fieldRows })
    const ws = new CognitiveWorkspace(db)

    await ws.markMemoryUsed(['mem-1'], 'negative')

    expect(calls.updates[0]?.setFields.usageOutcomes).toEqual({
      positive: 0,
      negative: 1,
      neutral: 2,
    })
  })

  test('increments neutral counter for outcome: neutral', async () => {
    const fieldRows = [{ id: 'mem-1', usageOutcomes: { positive: 1, negative: 1, neutral: 0 } }]
    const { db, calls } = makeMockDb({ memorySelectFieldsResult: fieldRows })
    const ws = new CognitiveWorkspace(db)

    await ws.markMemoryUsed(['mem-1'], 'neutral')

    expect(calls.updates[0]?.setFields.usageOutcomes).toEqual({
      positive: 1,
      negative: 1,
      neutral: 1,
    })
  })

  test('updates multiple memories in one call', async () => {
    const fieldRows = [
      { id: 'mem-1', usageOutcomes: { positive: 0, negative: 0, neutral: 0 } },
      { id: 'mem-2', usageOutcomes: { positive: 5, negative: 0, neutral: 0 } },
    ]
    const { db, calls } = makeMockDb({ memorySelectFieldsResult: fieldRows })
    const ws = new CognitiveWorkspace(db)

    await ws.markMemoryUsed(['mem-1', 'mem-2'], 'positive')

    expect(calls.updates).toHaveLength(2)
    expect(calls.updates[0]?.setFields.usageOutcomes).toEqual({
      positive: 1,
      negative: 0,
      neutral: 0,
    })
    expect(calls.updates[1]?.setFields.usageOutcomes).toEqual({
      positive: 6,
      negative: 0,
      neutral: 0,
    })
  })

  test('wraps updates in a transaction', async () => {
    const fieldRows = [{ id: 'mem-1', usageOutcomes: { positive: 0, negative: 0, neutral: 0 } }]
    const { db, calls } = makeMockDb({ memorySelectFieldsResult: fieldRows })
    const ws = new CognitiveWorkspace(db)

    await ws.markMemoryUsed(['mem-1'], 'positive')

    expect(calls.transactionCount).toBe(1)
  })

  // GAP-3: lastAccessedAt must be set on every markMemoryUsed call
  test('sets lastAccessedAt to a recent Date', async () => {
    const fieldRows = [{ id: 'mem-1', usageOutcomes: { positive: 0, negative: 0, neutral: 0 } }]
    const { db, calls } = makeMockDb({ memorySelectFieldsResult: fieldRows })
    const ws = new CognitiveWorkspace(db)

    const before = Date.now()
    await ws.markMemoryUsed(['mem-1'], 'positive')
    const after = Date.now()

    const lastAccessedAt = calls.updates[0]?.setFields.lastAccessedAt as Date | undefined
    expect(lastAccessedAt).toBeInstanceOf(Date)
    expect(lastAccessedAt!.getTime()).toBeGreaterThanOrEqual(before)
    expect(lastAccessedAt!.getTime()).toBeLessThanOrEqual(after)
  })
})

// ─── clearWorkingMemory Tests ─────────────────────────────────────────────────

describe('clearWorkingMemory', () => {
  test('calls delete on the memories table', async () => {
    const { db, calls } = makeMockDb()
    const ws = new CognitiveWorkspace(db)

    await ws.clearWorkingMemory('thread-1')

    expect(calls.deletes).toBe(1)
  })

  test('resolves without error for any threadId', async () => {
    const { db } = makeMockDb()
    const ws = new CognitiveWorkspace(db)

    await expect(ws.clearWorkingMemory('thread-99')).resolves.toBeUndefined()
  })

  test('does not use insert or transaction', async () => {
    const { db, calls } = makeMockDb()
    const ws = new CognitiveWorkspace(db)

    await ws.clearWorkingMemory('thread-1')

    expect(calls.transactionCount).toBe(0)
    expect(calls.updates).toHaveLength(0)
  })
})
