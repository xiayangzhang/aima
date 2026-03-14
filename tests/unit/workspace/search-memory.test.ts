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
    type: 'semantic',
    content: 'policy violation detected in access control',
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
 * Build a mock DB where the first select call returns firstCallRows,
 * subsequent calls return secondCallRows.
 */
function makeSearchMockDb(firstCallRows: MemoryRow[], secondCallRows: MemoryRow[]): DrizzleDB {
  let callCount = 0
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              const rows = callCount === 0 ? firstCallRows : secondCallRows
              callCount++
              return rows
            },
          }),
        }),
      }),
    }),
  } as unknown as DrizzleDB
}

// ─── V1: Vector path used when embedding configured ──────────────────────────

describe('V1 — vector path used when embedding is configured', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('searchMemory calls generateEmbedding and returns vector result', async () => {
    const row = makeMemoryRow({ id: 'mem-vector' })
    const db = makeSearchMockDb([row], [])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.searchMemory({ query: 'policy violation' })

    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1)
    expect(mockGenerateEmbedding).toHaveBeenCalledWith('policy violation', { apiKey: 'test-key' })
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('mem-vector')
  })
})

// ─── V2: Vector returns empty → ILIKE fallback ───────────────────────────────

describe('V2 — vector returns empty → ILIKE fallback', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('searchMemory falls through to ILIKE when vector returns no results', async () => {
    const iLikeRow = makeMemoryRow({ id: 'mem-ilike', embedding: null })
    const db = makeSearchMockDb([], [iLikeRow])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.searchMemory({ query: 'policy violation' })

    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('mem-ilike')
  })
})

// ─── V3: No embedding config → direct ILIKE ──────────────────────────────────

describe('V3 — no embedding config → direct ILIKE, no generateEmbedding call', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('searchMemory does not call generateEmbedding when no embedding config', async () => {
    const row = makeMemoryRow({ id: 'mem-ilike-only' })
    const db = makeSearchMockDb([row], [])
    const ws = new CognitiveWorkspace(db) // no embedding option

    const result = await ws.searchMemory({ query: 'policy violation' })

    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(0)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('mem-ilike-only')
  })
})

// ─── V4: No query → existing behavior unchanged ──────────────────────────────

describe('V4 — no query → existing behavior, generateEmbedding not called', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('searchMemory without query does not call generateEmbedding', async () => {
    const row = makeMemoryRow({ id: 'mem-no-query', type: 'semantic' })
    const db = makeSearchMockDb([row], [])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.searchMemory({ type: 'semantic' })

    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('mem-no-query')
  })
})

// ─── V5: Vector throws → ILIKE fallback, no error propagation ────────────────

describe('V5 — generateEmbedding throws → ILIKE fallback, no error thrown', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('searchMemory returns ILIKE result when generateEmbedding throws', async () => {
    mockGenerateEmbedding.mockImplementationOnce(() => Promise.reject(new Error('API timeout')))

    const row = makeMemoryRow({ id: 'mem-fallback' })
    // Vector path throws; ILIKE path is the only DB call
    const db = makeSearchMockDb([row], [])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.searchMemory({ query: 'policy violation' })

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('mem-fallback')
  })
})

// ─── V6: query + type + tags all applied in vector path ──────────────────────

describe('V6 — query + type + tags filters all active in vector path', () => {
  beforeEach(() => mockGenerateEmbedding.mockClear())

  test('searchMemory with query, type, and tags calls generateEmbedding and returns result', async () => {
    const row = makeMemoryRow({ id: 'mem-filtered', type: 'semantic', tags: ['policy'] })
    const db = makeSearchMockDb([row], [])
    const ws = new CognitiveWorkspace(db, { embedding: { apiKey: 'test-key' } })

    const result = await ws.searchMemory({
      query: 'access control',
      type: 'semantic',
      tags: ['policy'],
    })

    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1)
    expect(mockGenerateEmbedding).toHaveBeenCalledWith('access control', { apiKey: 'test-key' })
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('mem-filtered')
  })
})
