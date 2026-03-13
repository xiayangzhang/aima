import { afterAll, beforeAll, expect, test } from 'vitest'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import { createTestDb, withTransaction } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'

// ─── Feature 022: searchMemory query field — integration tests ────────────────
//
// I1: ILIKE fallback — no embedding config, pure text match against real DB
// I2: Vector search  — real OpenAI embedding + pgvector cosine distance

describeWithDb('searchMemory query field (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>

  beforeAll(() => {
    testDb = createTestDb()
  })

  afterAll(async () => {
    await testDb.client.end()
  })

  // ── I1: ILIKE fallback (no embedding config) ──────────────────────────────

  test('I1 — ILIKE: finds memory by partial text match without embedding', async () => {
    await withTransaction(testDb.db, async (ws) => {
      // CognitiveWorkspace inside withTransaction has no embedding config → ILIKE path
      await ws.writeMemory({
        type: 'semantic',
        content: 'AIMA_INTEG_ILIKE_MARKER cortex processed data routing decision for user',
        tags: ['integ-search-query-ilike'],
      })

      const results = await ws.searchMemory({ query: 'AIMA_INTEG_ILIKE_MARKER' })
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.some((m) => m.content.includes('AIMA_INTEG_ILIKE_MARKER'))).toBe(true)
    })
  })

  test('I1b — ILIKE: query + type filter both apply', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({
        type: 'semantic',
        content: 'AIMA_INTEG_TYPEFILTER_MARKER semantic content',
        tags: ['integ-search-typefilter'],
      })
      await ws.writeMemory({
        type: 'episodic',
        content: 'AIMA_INTEG_TYPEFILTER_MARKER episodic content',
        tags: ['integ-search-typefilter'],
      })

      // Only semantic type should be returned
      const results = await ws.searchMemory({
        query: 'AIMA_INTEG_TYPEFILTER_MARKER',
        type: 'semantic',
      })
      expect(results.every((m) => m.type === 'semantic')).toBe(true)
      expect(results.some((m) => m.content.includes('semantic content'))).toBe(true)
    })
  })

  test('I1c — no query: behavior unchanged, no ILIKE applied', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const mem = await ws.writeMemory({
        type: 'working',
        content: 'some working memory entry',
        tags: ['integ-no-query-test'],
      })

      // No query → existing filter behavior unchanged
      const results = await ws.searchMemory({ tags: ['integ-no-query-test'] })
      expect(results.some((m) => m.id === mem.id)).toBe(true)
    })
  })

  // ── I2: Vector search (real OpenAI embedding + pgvector) ─────────────────

  test('I2 — vector: finds semantically similar memory via cosine distance', async () => {
    const openAiKey = process.env.OPENAI_API_KEY
    if (!openAiKey) {
      console.log('⏭  Skipping vector search test: OPENAI_API_KEY not set')
      return
    }

    const ws = new CognitiveWorkspace(testDb.db, {
      embedding: { apiKey: openAiKey },
    })

    // Write with a distinctive semantic meaning
    const mem = await ws.writeMemory({
      type: 'semantic',
      content: 'The amygdala blocked a high-risk file deletion command from the brainstem',
      tags: ['integ-vector-search-022'],
      baseImportance: 0.8,
    })

    // Wait for fire-and-forget embedding generation to complete
    await new Promise((r) => setTimeout(r, 2000))

    try {
      // Query with semantically similar but lexically different text
      const results = await ws.searchMemory({
        query: 'security gate rejected dangerous tool execution',
        tags: ['integ-vector-search-022'],
      })

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.some((m) => m.id === mem.id)).toBe(true)
    } finally {
      // Soft-delete to keep test DB tidy
      await ws.invalidateMemory(mem.id)
    }
  })
})
