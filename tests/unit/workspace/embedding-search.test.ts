import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Mock embedding module BEFORE workspace is loaded ────────────────────────

const mockGenerateEmbedding = mock((_text: string) =>
  Promise.resolve(new Array(1536).fill(0.1) as number[]),
)

mock.module('../../../src/embedding', () => ({
  generateEmbedding: mockGenerateEmbedding,
}))

// Dynamic import so the mock is in place when workspace loads
const { CognitiveWorkspace } = await import('../../../src/workspace/index')
import type { DrizzleDB } from '../../../src/workspace/index'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const T0 = new Date('2025-01-01T00:00:00Z')

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
  embedding: number[] | null
  createdAt: Date
  updatedAt: Date
}

function makeMemoryRow(overrides?: Partial<MemoryRow>): MemoryRow {
  return {
    id: 'mem-1',
    type: 'episodic',
    content: 'rejected request to delete customer records',
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
    embedding: new Array(1536).fill(0.1),
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

// ─── DB Mock Helpers ─────────────────────────────────────────────────────────

/**
 * Build a mock DB where select queries return rows in round-robin order
 * from the provided groups array. Each call to select().from()... exhausts one group.
 */
function makeSelectRoundRobin(groups: MemoryRow[][]): DrizzleDB {
  let callIndex = 0
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => groups[callIndex++ % groups.length] ?? [],
          }),
        }),
      }),
    }),
  } as unknown as DrizzleDB
}

/** DB that also supports insert + update (for writeMemory tests). */
function makeFullMockDb(opts: {
  insertRow?: MemoryRow
  selectGroups?: MemoryRow[][]
  trackUpdates?: boolean
}): { db: DrizzleDB; updates: Array<Record<string, unknown>> } {
  const updates: Array<Record<string, unknown>> = []
  let selectCallIndex = 0
  const groups = opts.selectGroups ?? []

  const db = {
    insert: () => ({
      values: () => ({
        returning: async () => (opts.insertRow ? [opts.insertRow] : []),
      }),
    }),
    update: () => ({
      set: (fields: Record<string, unknown>) => ({
        where: async () => {
          updates.push(fields)
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => groups[selectCallIndex++ % Math.max(groups.length, 1)] ?? [],
          }),
        }),
      }),
    }),
    transaction: async (fn: (tx: DrizzleDB) => Promise<unknown>) => fn(db as unknown as DrizzleDB),
  } as unknown as DrizzleDB

  return { db, updates }
}

// ─── V1: Vector search recalls semantically similar memory ───────────────────

describe('V1 — vector search recalls semantically similar memory', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('findSimilarSituations uses vector path and returns episodic result', async () => {
    const row = makeMemoryRow({ id: 'ep-vector', type: 'episodic' })
    const db = makeSelectRoundRobin([[row], [], []])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.findSimilarSituations('prevent destructive action')

    expect(result.episodes).toHaveLength(1)
    expect(result.episodes[0]?.id).toBe('ep-vector')
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1)
    expect(mockGenerateEmbedding).toHaveBeenCalledWith('prevent destructive action', {
      apiKey: 'test-key',
    })
  })
})

// ─── V2: Falls back to ILIKE for memories without embedding ──────────────────

describe('V2 — falls back to ILIKE when vector query returns no results', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('findSimilarSituations returns ILIKE result after empty vector query', async () => {
    // Calls 0-2: vector path → empty (no embeddings in DB)
    // Calls 3-5: ILIKE fallback → one matching row
    const iLikeRow = makeMemoryRow({
      id: 'ep-ilike',
      type: 'episodic',
      embedding: null,
      content: 'rejected request to delete customer records',
    })
    const db = makeSelectRoundRobin([[], [], [], [iLikeRow], [], []])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.findSimilarSituations('delete customer')

    expect(result.episodes).toHaveLength(1)
    expect(result.episodes[0]?.id).toBe('ep-ilike')
  })
})

// ─── V3: Embedding generation failure does not block writeMemory ─────────────

describe('V3 — embedding generation failure does not block writeMemory', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('writeMemory does not throw when generateEmbedding rejects', async () => {
    mockGenerateEmbedding.mockImplementationOnce(() =>
      Promise.reject(new Error('rate limit exceeded')),
    )

    const row = makeMemoryRow({ id: 'mem-write', content: 'new memory content' })
    const { db } = makeFullMockDb({ insertRow: row })
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    // writeMemory must not throw even when embedding generation fails
    const result = await ws.writeMemory({ type: 'episodic', content: 'new memory content' })
    expect(result.id).toBe('mem-write')

    // Give the fire-and-forget microtask time to settle
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})

// ─── V4: getProcedure uses vector search when embedding configured ────────────

describe('V4 — getProcedure uses vector search', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('getProcedure returns vector result when embedding is configured', async () => {
    const row = makeMemoryRow({ id: 'proc-vector', type: 'procedural' })
    const db = makeSelectRoundRobin([[row]])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.getProcedure('deploy to kubernetes')

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('proc-vector')
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1)
    expect(mockGenerateEmbedding).toHaveBeenCalledWith('deploy to kubernetes', {
      apiKey: 'test-key',
    })
  })
})

// ─── V5: No embedding calls when config.embedding is undefined ───────────────

describe('V5 — no embedding calls when config.embedding is undefined', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('writeMemory does not call generateEmbedding without embedding config', async () => {
    const row = makeMemoryRow({ id: 'mem-no-embed' })
    const { db } = makeFullMockDb({ insertRow: row })
    const ws = new CognitiveWorkspace(db) // no embedding option

    await ws.writeMemory({ type: 'episodic', content: 'some event' })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
  })

  test('findSimilarSituations does not call generateEmbedding without embedding config', async () => {
    const db = makeSelectRoundRobin([[], [], []])
    const ws = new CognitiveWorkspace(db) // no embedding option

    await ws.findSimilarSituations('any query')

    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
  })
})

// ─── V6: Vector path exception falls back silently to ILIKE ─────────────────

describe('V6 — vector path exception falls back silently to ILIKE', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('findSimilarSituations returns ILIKE result when generateEmbedding throws', async () => {
    mockGenerateEmbedding.mockImplementationOnce(() =>
      Promise.reject(new Error('embedding service unavailable')),
    )

    const iLikeRow = makeMemoryRow({ id: 'ep-fallback', type: 'episodic' })
    // Vector path will throw; ILIKE path returns iLikeRow
    const db = makeSelectRoundRobin([[iLikeRow], [], []])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.findSimilarSituations('some query')

    // Should not throw, and should return via ILIKE
    expect(result.episodes).toHaveLength(1)
    expect(result.episodes[0]?.id).toBe('ep-fallback')
  })

  test('getProcedure returns ILIKE result when generateEmbedding throws', async () => {
    mockGenerateEmbedding.mockImplementationOnce(() =>
      Promise.reject(new Error('embedding service unavailable')),
    )

    const row = makeMemoryRow({ id: 'proc-fallback', type: 'procedural' })
    const db = makeSelectRoundRobin([[row]])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.getProcedure('some task')

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('proc-fallback')
  })
})

// ─── V7: Zero regression — run via bun test tests/unit/ ──────────────────────
// This test just confirms the new test file itself passes.
// Full V7 regression is verified by running: bun test tests/unit/
