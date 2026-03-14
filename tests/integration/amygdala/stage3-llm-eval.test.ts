/**
 * Integration tests for Amygdala Stage 3 LLM evaluation (Feature 016).
 * Requires: AIMA_TEST_DATABASE_URL + ANTHROPIC_API_KEY
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Amygdala } from '../../../src/amygdala/index'
import { BrainEventBus } from '../../../src/eventbus/index'
import { createTestDb, withTransaction } from '../helpers/db'

const hasDb = !!process.env.AIMA_TEST_DATABASE_URL
const hasApiKey = !!process.env.ANTHROPIC_API_KEY

function describeWithDbAndLlm(name: string, fn: () => void): void {
  if (!hasDb || !hasApiKey) {
    console.log(
      `⏭  Skipping integration suite: "${name}" (AIMA_TEST_DATABASE_URL or ANTHROPIC_API_KEY not set)`,
    )
    return
  }
  describe(name, fn)
}

describeWithDbAndLlm('Amygdala Stage 3 — LLM evaluation integration (T016)', () => {
  let testDb: ReturnType<typeof createTestDb>

  beforeAll(() => {
    testDb = createTestDb()
  })

  afterAll(async () => {
    await testDb.client.end()
  })

  test('check() with real LLM returns valid decision for high-risk tool', async () => {
    await withTransaction(testDb.db, async (workspace) => {
      const eventBus = new BrainEventBus()
      const amygdala = new Amygdala(
        {
          haiku_enabled: true,
          // Register a tool not in DEFAULT_BLOCK_TOOLS so Stage 1 doesn't intercept
          riskLevels: { list_files: 'high' },
          llm: { apiKey: process.env.ANTHROPIC_API_KEY },
        },
        workspace,
        eventBus,
      )

      const result = await amygdala.check('list_files', { path: '/tmp' })

      // LLM must return one of the three valid decisions
      expect(['allow', 'block', 'escalate']).toContain(result.decision)
      expect(typeof result.reason).toBe('string')
      expect(result.reason.length).toBeGreaterThan(0)
      // Must NOT be the stub message (stub was removed)
      expect(result.reason).not.toContain('not yet implemented')

      // Wait for fire-and-forget writeMemory to complete
      await new Promise((r) => setTimeout(r, 500))

      // Verify implicit memory was written to DB within this transaction
      const memories = await workspace.searchMemory({
        type: 'implicit',
        tags: ['amygdala_eval', 'list_files'],
      })
      expect(memories.length).toBeGreaterThanOrEqual(1)
      const mem = memories[0]
      expect(mem.sourceBrain).toBe('amygdala')
      const content = JSON.parse(mem.content) as { tool: string; decision: string; reason: string }
      expect(content.tool).toBe('list_files')
      expect(['allow', 'block', 'escalate']).toContain(content.decision)
      expect(content.decision).toBe(result.decision)
    })
  }, 15000) // 15s timeout for real LLM call

  test('check() LLM block decision is passed through correctly', async () => {
    await withTransaction(testDb.db, async (workspace) => {
      const eventBus = new BrainEventBus()
      const amygdala = new Amygdala(
        {
          haiku_enabled: true,
          riskLevels: { drop_database: 'high' },
          llm: { apiKey: process.env.ANTHROPIC_API_KEY },
        },
        workspace,
        eventBus,
      )

      // Ask LLM to evaluate a clearly dangerous operation
      const result = await amygdala.check('drop_database', {
        database: 'production',
        confirm: true,
      })

      // LLM should block or escalate a destructive DB operation
      expect(['block', 'escalate']).toContain(result.decision)
      expect(result.reason.length).toBeGreaterThan(0)

      // Memory written regardless of decision
      await new Promise((r) => setTimeout(r, 500))
      const memories = await workspace.searchMemory({
        type: 'implicit',
        tags: ['amygdala_eval', 'drop_database'],
      })
      expect(memories.length).toBeGreaterThanOrEqual(1)
      // Dangerous decision → high importance
      expect(memories[0].baseImportance).toBe(0.8)
    })
  }, 15000)

  test('haiku_enabled=false skips LLM — no memory written', async () => {
    await withTransaction(testDb.db, async (workspace) => {
      const eventBus = new BrainEventBus()
      const amygdala = new Amygdala(
        {
          haiku_enabled: false,
          riskLevels: { list_files: 'high' },
        },
        workspace,
        eventBus,
      )

      const result = await amygdala.check('list_files', { path: '/tmp' })

      // No LLM → falls through to allow
      expect(result.decision).toBe('allow')

      await new Promise((r) => setTimeout(r, 100))

      // No memory should have been written
      const memories = await workspace.searchMemory({
        type: 'implicit',
        tags: ['amygdala_eval', 'list_files'],
      })
      expect(memories.length).toBe(0)
    })
  })
})
