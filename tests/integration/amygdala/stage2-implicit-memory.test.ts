/**
 * Integration tests for Amygdala Stage 2 implicit memory (Feature 018).
 * Verifies that real DB history is picked up and LLM is skipped.
 * Requires: AIMA_TEST_DATABASE_URL + ANTHROPIC_API_KEY
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { Amygdala } from '../../../src/amygdala/index'
import { BrainEventBus } from '../../../src/eventbus/index'
import { createTestDb, withTransaction } from '../helpers/db'
import * as llmModule from '../../../src/llm'

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

describeWithDbAndLlm('Amygdala Stage 2 — Implicit memory integration (F018)', () => {
  let testDb: ReturnType<typeof createTestDb>

  beforeAll(() => {
    testDb = createTestDb()
  })

  afterAll(async () => {
    await testDb.client.end()
  })

  test(
    'Stage 2 returns block from real DB history — LLM not called',
    async () => {
      const callLlmSpy = vi.spyOn(llmModule, 'callLlm')

      await withTransaction(testDb.db, async (workspace) => {
        const eventBus = new BrainEventBus()

        // Pre-seed implicit memory as Stage 3 would have written it
        await workspace.writeMemory({
          type: 'implicit',
          content: JSON.stringify({
            tool: 'stage2_test_tool',
            decision: 'block',
            reason: 'previously evaluated as dangerous',
          }),
          tags: ['amygdala_eval', 'stage2_test_tool', 'block'],
          baseImportance: 0.8,
          sourceBrain: 'amygdala',
        })

        const amygdala = new Amygdala(
          {
            haiku_enabled: true,
            riskLevels: { stage2_test_tool: 'high' },
            llm: { apiKey: process.env.ANTHROPIC_API_KEY },
          },
          workspace,
          eventBus,
        )

        const result = await amygdala.check('stage2_test_tool', { arg: 'test' })

        // Stage 2 should have returned from memory
        expect(result.decision).toBe('block')
        expect(result.reason).toBe('[memory] previously evaluated as dangerous')

        // LLM must NOT have been called
        expect(callLlmSpy).not.toHaveBeenCalled()
      })

      callLlmSpy.mockRestore()
    },
    15000,
  )

  test(
    'Stage 2 allow from DB history — LLM not called',
    async () => {
      const callLlmSpy = vi.spyOn(llmModule, 'callLlm')

      await withTransaction(testDb.db, async (workspace) => {
        const eventBus = new BrainEventBus()

        await workspace.writeMemory({
          type: 'implicit',
          content: JSON.stringify({
            tool: 'stage2_safe_tool',
            decision: 'allow',
            reason: 'safe read-only operation',
          }),
          tags: ['amygdala_eval', 'stage2_safe_tool', 'allow'],
          baseImportance: 0.4,
          sourceBrain: 'amygdala',
        })

        const amygdala = new Amygdala(
          {
            haiku_enabled: true,
            riskLevels: { stage2_safe_tool: 'high' },
            llm: { apiKey: process.env.ANTHROPIC_API_KEY },
          },
          workspace,
          eventBus,
        )

        const result = await amygdala.check('stage2_safe_tool', {})

        expect(result.decision).toBe('allow')
        expect(result.reason.startsWith('[memory]')).toBe(true)
        expect(callLlmSpy).not.toHaveBeenCalled()
      })

      callLlmSpy.mockRestore()
    },
    15000,
  )

  test(
    'Stage 2 escalate from DB history — LLM not called',
    async () => {
      const callLlmSpy = vi.spyOn(llmModule, 'callLlm')

      await withTransaction(testDb.db, async (workspace) => {
        const eventBus = new BrainEventBus()

        await workspace.writeMemory({
          type: 'implicit',
          content: JSON.stringify({
            tool: 'stage2_escalate_tool',
            decision: 'escalate',
            reason: 'requires human review',
          }),
          tags: ['amygdala_eval', 'stage2_escalate_tool', 'escalate'],
          baseImportance: 0.8,
          sourceBrain: 'amygdala',
        })

        const amygdala = new Amygdala(
          {
            haiku_enabled: true,
            riskLevels: { stage2_escalate_tool: 'high' },
            llm: { apiKey: process.env.ANTHROPIC_API_KEY },
          },
          workspace,
          eventBus,
        )

        const result = await amygdala.check('stage2_escalate_tool', {})

        expect(result.decision).toBe('escalate')
        expect(result.reason).toBe('[memory] requires human review')
        expect(callLlmSpy).not.toHaveBeenCalled()
      })

      callLlmSpy.mockRestore()
    },
    15000,
  )

  test(
    'No DB history → falls through to Stage 3 LLM',
    async () => {
      await withTransaction(testDb.db, async (workspace) => {
        const eventBus = new BrainEventBus()

        const amygdala = new Amygdala(
          {
            haiku_enabled: true,
            riskLevels: { stage2_nohistory_tool: 'high' },
            llm: { apiKey: process.env.ANTHROPIC_API_KEY },
          },
          workspace,
          eventBus,
        )

        const result = await amygdala.check('stage2_nohistory_tool', { action: 'test' })

        // LLM was invoked (Stage 3), so decision comes from LLM
        expect(['allow', 'block', 'escalate']).toContain(result.decision)
        // Reason must NOT have [memory] prefix — came from LLM, not Stage 2
        expect(result.reason.startsWith('[memory]')).toBe(false)
      })
    },
    20000,
  )
})
