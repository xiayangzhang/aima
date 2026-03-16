/**
 * Integration test: ClaudeAgentSDKAdapter provider fallback.
 *
 * Verifies that when the primary provider is unreachable, the adapter
 * transparently retries with the fallback provider, completes successfully,
 * and emits exactly one provider.fallback event to EventBus.
 *
 * Requires: AIMA_TEST_DATABASE_URL + ANTHROPIC_API_KEY
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeAgentSDKAdapter } from '../../../../src/adapters/claude-sdk/index'
import { Amygdala } from '../../../../src/amygdala/index'
import { BrainEventBus } from '../../../../src/eventbus/index'
import type { BrainEvent } from '../../../../src/adapters/index'
import { isTestDbAvailable, createTestDb, withTransaction } from '../../helpers/db'

// Skip unless AIMA_E2E_ENABLED is explicitly set to opt-in.
// Reason: claude-agent-sdk spawns the `claude` CLI subprocess, which fails
// when run from inside a Claude Code session (recursive spawn blocked).
// Run externally: AIMA_E2E_ENABLED=1 ANTHROPIC_API_KEY=sk-... npx vitest run tests/integration/adapters/claude-sdk/provider-fallback.test.ts
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SKIP = !isTestDbAvailable() || !ANTHROPIC_API_KEY || !process.env.AIMA_E2E_ENABLED

if (SKIP) {
  console.log(
    '⏭  Skipping provider-fallback E2E test (requires AIMA_E2E_ENABLED=1 + ANTHROPIC_API_KEY + AIMA_TEST_DATABASE_URL)',
  )
}

describe.skipIf(SKIP)('ClaudeAgentSDKAdapter — provider fallback (real API)', () => {
  let client: ReturnType<typeof createTestDb>['client']
  let db: ReturnType<typeof createTestDb>['db']

  beforeEach(() => {
    const setup = createTestDb()
    client = setup.client
    db = setup.db
  })

  afterEach(async () => {
    await client.end()
  })

  it('falls back to valid provider when primary is unreachable, emits provider.fallback event', async () => {
    await withTransaction(db, async (workspace) => {
      const eventBus = new BrainEventBus()
      const capturedEvents: BrainEvent[] = []
      eventBus.subscribe((event) => capturedEvents.push(event))

      const amygdala = new Amygdala({}, workspace, eventBus)

      const adapter = new ClaudeAgentSDKAdapter({
        providers: {
          default: {
            primary: {
              model: 'claude-haiku-4-5-20251001',
              provider: {
                // Invalid endpoint — connection refused immediately
                baseUrl: 'http://localhost:1',
                apiKey: 'sk-invalid-primary',
              },
            },
            fallback: [
              {
                model: 'claude-haiku-4-5-20251001',
                provider: {
                  baseUrl: 'https://api.anthropic.com',
                  apiKey: ANTHROPIC_API_KEY!,
                },
              },
            ],
          },
        },
        workspace,
        eventBus,
        amygdala,
      })

      // Create a thread in the workspace
      const thread = await workspace.createThread({ initiatedBy: 'test' })
      await workspace.writeSlot(thread.id, 'limbic', {
        status: 'running',
        input: { trigger: 'Say hello' },
      })

      // Run the adapter — primary fails (ECONNREFUSED), fallback succeeds
      const result = await adapter.run({
        brain: 'limbic',
        threadId: thread.id,
        systemPrompt: 'You are a concise assistant. Respond in one word.',
        initialPrompt: 'Say hello in exactly one word.',
      })

      // Activation completed successfully via fallback
      expect(result.stopReason).toBe('done')

      // Exactly one provider.fallback event emitted
      const fallbackEvents = capturedEvents.filter((e) => e.event_type === 'provider.fallback')
      expect(fallbackEvents).toHaveLength(1)

      const evt = fallbackEvents[0]
      expect(evt.brain).toBe('limbic')
      expect(evt.level).toBe('INFO')

      const payload = evt.payload as {
        brain: string
        fromModel: string
        fromBaseUrl: string
        toModel: string
        toBaseUrl: string
        reason: string
        attempt: number
      }
      expect(payload.fromBaseUrl).toBe('http://localhost:1')
      expect(payload.toBaseUrl).toBe('https://api.anthropic.com')
      // ECONNREFUSED → classifyProviderError → 'timeout'
      expect(payload.reason).toBe('timeout')
      expect(payload.attempt).toBe(1)
      expect(payload.fromModel).toBe('claude-haiku-4-5-20251001')
      expect(payload.toModel).toBe('claude-haiku-4-5-20251001')
    })
  })

  it('propagates error when all providers are exhausted', async () => {
    await withTransaction(db, async (workspace) => {
      const eventBus = new BrainEventBus()
      const amygdala = new Amygdala({}, workspace, eventBus)

      const adapter = new ClaudeAgentSDKAdapter({
        providers: {
          default: {
            primary: {
              model: 'claude-haiku-4-5-20251001',
              provider: {
                baseUrl: 'http://localhost:1',
                apiKey: 'sk-invalid',
              },
            },
            // No fallback — maxAttempts=1 by default
          },
        },
        workspace,
        eventBus,
        amygdala,
      })

      const thread = await workspace.createThread({ initiatedBy: 'test' })

      await expect(
        adapter.run({
          brain: 'limbic',
          threadId: thread.id,
          systemPrompt: 'You are a concise assistant.',
          initialPrompt: 'Hello.',
        }),
      ).rejects.toThrow()
    })
  })
})
