import { describe, expect, test } from 'bun:test'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import type { DrizzleDB } from '../../../src/workspace/index'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const T0 = new Date('2025-01-01T00:00:00Z')
const T1 = new Date('2025-01-02T00:00:00Z')
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z')

type PendingRow = {
  id: string
  targetBrain: string
  note: string
  triggerAt: Date | null
  expiresAt: Date
  baseImportance: number
  addedAt: Date
}

function makePendingRow(overrides?: Partial<PendingRow>): PendingRow {
  return {
    id: 'pending-1',
    targetBrain: 'dmn',
    note: 'test observation',
    triggerAt: null,
    expiresAt: FAR_FUTURE,
    baseImportance: 0.5,
    addedAt: T0,
    ...overrides,
  }
}

// ─── Transaction Mock Factory ─────────────────────────────────────────────────

interface TransactionMockConfig {
  currentCount: number
  evictCandidates?: Array<{ id: string }>
  insertRow?: PendingRow
}

interface TransactionMockResult {
  db: DrizzleDB
  calls: { execute: number; delete: number }
}

function makeTransactionMockDb(config: TransactionMockConfig): TransactionMockResult {
  const calls = { execute: 0, delete: 0 }

  const makeTx = () => {
    let selectCallNum = 0

    return {
      execute: async (_query: unknown) => {
        calls.execute++
        return []
      },
      select: (_fields?: unknown) => {
        selectCallNum++
        const callNum = selectCallNum
        return {
          from: (_table: unknown) => ({
            where: (_condition: unknown) => {
              if (callNum === 1) {
                // First select: count query
                return Promise.resolve([{ count: config.currentCount }])
              }
              // Second select: eviction candidates (has orderBy + limit)
              return {
                orderBy: (..._args: unknown[]) => ({
                  limit: (_n: number) => Promise.resolve(config.evictCandidates ?? []),
                }),
              }
            },
          }),
        }
      },
      delete: (_table: unknown) => ({
        where: async (_condition: unknown) => {
          calls.delete++
          return undefined
        },
      }),
      insert: (_table: unknown) => ({
        values: (_vals: unknown) => ({
          returning: async () => (config.insertRow ? [config.insertRow] : []),
        }),
      }),
    }
  }

  const db = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      return await cb(makeTx())
    },
  }

  return { db: db as unknown as DrizzleDB, calls }
}

// ─── Simple Mock Factory (for non-transaction methods) ───────────────────────

interface SimpleMockConfig {
  pendingRows?: PendingRow[]
}

interface SimpleMockResult {
  db: DrizzleDB
  calls: { delete: number }
}

function makeSimpleMockDb(config: SimpleMockConfig = {}): SimpleMockResult {
  const calls = { delete: 0 }

  const db = {
    select: () => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({
          orderBy: async (_expr: unknown) => config.pendingRows ?? [],
        }),
      }),
    }),
    delete: (_table: unknown) => ({
      where: async (_condition: unknown) => {
        calls.delete++
        return undefined
      },
    }),
  }

  return { db: db as unknown as DrizzleDB, calls }
}

// ─── writePending Tests ───────────────────────────────────────────────────────

describe('writePending', () => {
  test('acquires advisory lock (execute called once)', async () => {
    const row = makePendingRow()
    const { db, calls } = makeTransactionMockDb({ currentCount: 0, insertRow: row })
    const ws = new CognitiveWorkspace(db)

    await ws.writePending({ targetBrain: 'dmn', note: 'test', expiresAt: FAR_FUTURE })

    expect(calls.execute).toBe(1)
  })

  test('writes observation when under capacity without eviction', async () => {
    const row = makePendingRow({ targetBrain: 'limbic', note: 'hello', baseImportance: 0.7 })
    const { db, calls } = makeTransactionMockDb({ currentCount: 5, insertRow: row })
    const ws = new CognitiveWorkspace(db, { pendingCapacity: 100 })

    const result = await ws.writePending({
      targetBrain: 'limbic',
      note: 'hello',
      expiresAt: FAR_FUTURE,
      baseImportance: 0.7,
    })

    expect(calls.delete).toBe(0) // no eviction
    expect(result.targetBrain).toBe('limbic')
    expect(result.note).toBe('hello')
    expect(result.baseImportance).toBe(0.7)
  })

  test('evicts one record when exactly at capacity', async () => {
    const row = makePendingRow()
    const { db, calls } = makeTransactionMockDb({
      currentCount: 10,
      evictCandidates: [{ id: 'old-1' }],
      insertRow: row,
    })
    const ws = new CognitiveWorkspace(db, { pendingCapacity: 10 })

    await ws.writePending({ targetBrain: 'dmn', note: 'new', expiresAt: FAR_FUTURE })

    expect(calls.delete).toBe(1)
  })

  test('evicts multiple records when over capacity', async () => {
    const row = makePendingRow()
    const { db, calls } = makeTransactionMockDb({
      currentCount: 12,
      evictCandidates: [{ id: 'old-1' }, { id: 'old-2' }, { id: 'old-3' }],
      insertRow: row,
    })
    const ws = new CognitiveWorkspace(db, { pendingCapacity: 10 })

    await ws.writePending({ targetBrain: 'dmn', note: 'new', expiresAt: FAR_FUTURE })

    expect(calls.delete).toBe(1) // single inArray delete call
  })

  test('does not evict when one below capacity', async () => {
    const row = makePendingRow()
    const { db, calls } = makeTransactionMockDb({ currentCount: 9, insertRow: row })
    const ws = new CognitiveWorkspace(db, { pendingCapacity: 10 })

    await ws.writePending({ targetBrain: 'dmn', note: 'new', expiresAt: FAR_FUTURE })

    expect(calls.delete).toBe(0)
  })

  test('returns PendingObservation with all correct fields', async () => {
    const triggerAt = new Date('2025-06-01T00:00:00Z')
    const row = makePendingRow({
      id: 'obs-42',
      targetBrain: 'cortex',
      note: 'check this',
      triggerAt,
      expiresAt: FAR_FUTURE,
      baseImportance: 0.9,
      addedAt: T0,
    })
    const { db } = makeTransactionMockDb({ currentCount: 0, insertRow: row })
    const ws = new CognitiveWorkspace(db)

    const result = await ws.writePending({
      targetBrain: 'cortex',
      note: 'check this',
      expiresAt: FAR_FUTURE,
      triggerAt,
      baseImportance: 0.9,
    })

    expect(result.id).toBe('obs-42')
    expect(result.targetBrain).toBe('cortex')
    expect(result.note).toBe('check this')
    expect(result.triggerAt).toEqual(triggerAt)
    expect(result.expiresAt).toEqual(FAR_FUTURE)
    expect(result.baseImportance).toBe(0.9)
    expect(result.addedAt).toEqual(T0)
  })

  test('uses default baseImportance of 0.5 when not provided', async () => {
    const row = makePendingRow({ baseImportance: 0.5 })
    const { db } = makeTransactionMockDb({ currentCount: 0, insertRow: row })
    const ws = new CognitiveWorkspace(db)

    const result = await ws.writePending({
      targetBrain: 'dmn',
      note: 'default importance',
      expiresAt: FAR_FUTURE,
    })

    expect(result.baseImportance).toBe(0.5)
  })

  test('throws when insert returns no rows', async () => {
    const { db } = makeTransactionMockDb({ currentCount: 0, insertRow: undefined })
    const ws = new CognitiveWorkspace(db)

    await expect(
      ws.writePending({ targetBrain: 'dmn', note: 'test', expiresAt: FAR_FUTURE }),
    ).rejects.toThrow('Insert returned no rows')
  })

  test('skips eviction delete when no candidates returned', async () => {
    const row = makePendingRow()
    const { db, calls } = makeTransactionMockDb({
      currentCount: 10,
      evictCandidates: [], // empty — all might have expired already
      insertRow: row,
    })
    const ws = new CognitiveWorkspace(db, { pendingCapacity: 10 })

    await ws.writePending({ targetBrain: 'dmn', note: 'new', expiresAt: FAR_FUTURE })

    expect(calls.delete).toBe(0) // skip when nothing to evict
  })
})

// ─── getPendingObservations Tests ─────────────────────────────────────────────

describe('getPendingObservations', () => {
  test('returns mapped PendingObservation array', async () => {
    const rows = [
      makePendingRow({ id: 'p1', targetBrain: 'limbic', triggerAt: null }),
      makePendingRow({ id: 'p2', targetBrain: 'cortex', triggerAt: T1 }),
    ]
    const { db } = makeSimpleMockDb({ pendingRows: rows })
    const ws = new CognitiveWorkspace(db)

    const result = await ws.getPendingObservations()

    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('p1')
    expect(result[0]?.targetBrain).toBe('limbic')
    expect(result[0]?.triggerAt).toBeNull()
    expect(result[1]?.id).toBe('p2')
    expect(result[1]?.triggerAt).toEqual(T1)
  })

  test('returns empty array when no pending observations', async () => {
    const { db } = makeSimpleMockDb({ pendingRows: [] })
    const ws = new CognitiveWorkspace(db)

    const result = await ws.getPendingObservations()

    expect(result).toHaveLength(0)
  })
})

// ─── removeExpiredPending Tests ───────────────────────────────────────────────

describe('removeExpiredPending', () => {
  test('resolves without error', async () => {
    const { db } = makeSimpleMockDb()
    const ws = new CognitiveWorkspace(db)

    await expect(ws.removeExpiredPending(new Date())).resolves.toBeUndefined()
  })

  test('calls delete exactly once', async () => {
    const { db, calls } = makeSimpleMockDb()
    const ws = new CognitiveWorkspace(db)

    await ws.removeExpiredPending(new Date())

    expect(calls.delete).toBe(1)
  })
})

// ─── removePending Tests ──────────────────────────────────────────────────────

describe('removePending', () => {
  test('resolves without error', async () => {
    const { db } = makeSimpleMockDb()
    const ws = new CognitiveWorkspace(db)

    await expect(ws.removePending('some-id')).resolves.toBeUndefined()
  })

  test('calls delete exactly once', async () => {
    const { db, calls } = makeSimpleMockDb()
    const ws = new CognitiveWorkspace(db)

    await ws.removePending('obs-1')

    expect(calls.delete).toBe(1)
  })
})
