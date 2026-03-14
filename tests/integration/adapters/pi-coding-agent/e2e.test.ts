/**
 * E2E smoke test for PiCodingAgentAdapter.
 *
 * Requires:
 *   ANTHROPIC_API_KEY=<key>
 *   AIMA_TEST_DATABASE_URL=<postgres url>  (optional — workspace uses in-memory mock)
 *
 * Runs a real AgentSession with a real model to verify the full adapter stack:
 *   PiCodingAgentAdapter.run() → createAgentSession() → real LLM → EventBus events
 */
import { describe, expect, test } from 'vitest'
import type { BrainEvent } from '../../../../src/adapters/index'
import { PiCodingAgentAdapter } from '../../../../src/adapters/pi-coding-agent/index'
import { Amygdala } from '../../../../src/amygdala/index'
import { BrainEventBus } from '../../../../src/eventbus/index'
import { CognitiveWorkspace } from '../../../../src/workspace/index'

const hasApiKey = !!process.env.ANTHROPIC_API_KEY

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

function makeAdapter() {
  const workspace = new CognitiveWorkspace(mockDb)
  const eventBus = new BrainEventBus()
  const amygdala = new Amygdala({}, workspace, eventBus)
  const events: BrainEvent[] = []
  eventBus.subscribe((e) => events.push(e))

  const adapter = new PiCodingAgentAdapter({
    modelId: 'claude-haiku-4-5-20251001',
    workspace,
    eventBus,
    amygdala,
    getApiKey: () => process.env.ANTHROPIC_API_KEY,
  })

  return { adapter, workspace, eventBus, events }
}

describe('PiCodingAgentAdapter E2E (requires ANTHROPIC_API_KEY)', () => {
  test.skipIf(!hasApiKey)(
    'run() with real session completes and returns BrainRunResult',
    async () => {
      const { adapter } = makeAdapter()

      const result = await adapter.run({
        brain: 'brainstem',
        threadId: 'e2e-thread-1',
        systemPrompt: 'You are a helpful assistant. Answer concisely.',
        initialPrompt: 'Reply with exactly the word PONG and nothing else.',
      })

      expect(result.sessionId).toBe('brainstem:e2e-thread-1')
      expect(result.stopReason).toBe('done')
      expect(result.output).toEqual({})
      expect(result.injectedMemoryIds).toEqual([])
    },
    30_000,
  )

  test.skipIf(!hasApiKey)(
    'run() emits brain.loop_end event via EventBus',
    async () => {
      const { adapter, events } = makeAdapter()

      await adapter.run({
        brain: 'limbic',
        threadId: 'e2e-thread-2',
        systemPrompt: 'You are a helpful assistant.',
        initialPrompt: 'Say only: OK',
      })

      const loopEnd = events.find((e) => e.event_type === 'brain.loop_end')
      expect(loopEnd).toBeDefined()
      expect(loopEnd?.brain).toBe('limbic')
      expect(loopEnd?.thread_id).toBe('e2e-thread-2')
    },
    30_000,
  )

  test.skipIf(!hasApiKey)(
    'second run() reuses existing session (no new session factory call)',
    async () => {
      let sessionCreateCount = 0
      const workspace = new CognitiveWorkspace(mockDb)
      const eventBus = new BrainEventBus()
      const amygdala = new Amygdala({}, workspace, eventBus)

      // Use a counting wrapper around the real session creation
      const adapter = new PiCodingAgentAdapter({
        modelId: 'claude-haiku-4-5-20251001',
        workspace,
        eventBus,
        amygdala,
        getApiKey: () => process.env.ANTHROPIC_API_KEY,
        _createSession: async () => {
          sessionCreateCount++
          // Fall back to real session — but count calls
          const {
            createAgentSession,
            AuthStorage,
            DefaultResourceLoader,
            ModelRegistry,
            SessionManager,
          } = await import('@mariozechner/pi-coding-agent')
          const { getModel } = await import('@mariozechner/pi-ai')
          const auth = AuthStorage.inMemory()
          const key = process.env.ANTHROPIC_API_KEY
          if (key) auth.setRuntimeApiKey('anthropic', key)
          const modelRegistry = new ModelRegistry(auth)
          const model = getModel('anthropic', 'claude-haiku-4-5-20251001' as never)
          const loader = new DefaultResourceLoader({
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            systemPromptOverride: () => 'test',
          })
          await loader.reload()
          const sm = SessionManager.inMemory()
          const { session } = await createAgentSession({
            model,
            authStorage: auth,
            modelRegistry,
            sessionManager: sm,
            resourceLoader: loader,
          })
          return session
        },
      })

      await adapter.run({
        brain: 'cortex',
        threadId: 'e2e-thread-3',
        systemPrompt: 'You are helpful.',
        initialPrompt: 'Say: FIRST',
      })
      await adapter.run({
        brain: 'cortex',
        threadId: 'e2e-thread-3',
        systemPrompt: 'You are helpful.',
        initialPrompt: 'Say: SECOND',
      })

      expect(sessionCreateCount).toBe(1)
    },
    60_000,
  )
})
