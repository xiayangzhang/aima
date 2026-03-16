/**
 * Integration test: ClaudeAgentSDKAdapter provider fallback.
 *
 * Verifies that when the primary provider is unreachable, the adapter
 * transparently retries with the fallback provider, completes successfully,
 * and emits exactly one provider.fallback event to EventBus.
 *
 * Requires: AIMA_TEST_DATABASE_URL + ANTHROPIC_API_KEY
 *
 * Supports third-party Anthropic-compatible APIs via ANTHROPIC_BASE_URL.
 * Optionally add a second fallback via ANTHROPIC_BASE_URL_2 + ANTHROPIC_API_KEY_2:
 *   AIMA_E2E_ENABLED=1 \
 *     ANTHROPIC_API_KEY=k2a_... ANTHROPIC_BASE_URL=https://www.foxnio.com \
 *     ANTHROPIC_API_KEY_2=sk-... ANTHROPIC_BASE_URL_2=https://www.packyapi.com \
 *     npx vitest run tests/integration/adapters/claude-sdk/provider-fallback.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainEvent } from '../../../../src/adapters/index'
import { ClaudeAgentSDKAdapter } from '../../../../src/adapters/claude-sdk/index'
import { Amygdala } from '../../../../src/amygdala/index'
import { BrainEventBus } from '../../../../src/eventbus/index'
import { createTestDb, isTestDbAvailable, withTransaction } from '../../helpers/db'

// Skip unless AIMA_E2E_ENABLED is explicitly set to opt-in.
// Reason: claude-agent-sdk spawns the `claude` CLI subprocess, which fails
// when run from inside a Claude Code session (recursive spawn blocked).
// Run externally: AIMA_E2E_ENABLED=1 ANTHROPIC_API_KEY=sk-... npx vitest run tests/integration/adapters/claude-sdk/provider-fallback.test.ts
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
// Primary fallback provider (e.g. foxnio)
const FALLBACK_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
// Optional second fallback provider (e.g. packyapi) for extra stability
const FALLBACK_BASE_URL_2 = process.env.ANTHROPIC_BASE_URL_2
const FALLBACK_API_KEY_2 = process.env.ANTHROPIC_API_KEY_2
const SKIP = !isTestDbAvailable() || !ANTHROPIC_API_KEY || !process.env.AIMA_E2E_ENABLED

if (SKIP) {
  console.log(
    '⏭  Skipping provider-fallback E2E test (requires AIMA_E2E_ENABLED=1 + ANTHROPIC_API_KEY + AIMA_TEST_DATABASE_URL)',
  )
} else {
  console.log(`▶  provider-fallback E2E: fallback[0] = ${FALLBACK_BASE_URL}`)
  if (FALLBACK_BASE_URL_2) {
    console.log(`▶  provider-fallback E2E: fallback[1] = ${FALLBACK_BASE_URL_2}`)
  }
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
  }, 30_000)

  it('falls back to valid provider when primary is unreachable, emits provider.fallback event', { timeout: 60_000 }, async () => {
    await withTransaction(db, async (workspace) => {
      const eventBus = new BrainEventBus()
      const capturedEvents: BrainEvent[] = []
      eventBus.subscribe((event) => capturedEvents.push(event))

      const amygdala = new Amygdala({}, workspace, eventBus)

      // Build fallback chain: first fallback is always ANTHROPIC_BASE_URL,
      // second fallback (if configured) is ANTHROPIC_BASE_URL_2 for extra stability.
      const fallbackChain = [
        {
          model: 'claude-haiku-4-5-20251001' as const,
          provider: {
            baseUrl: FALLBACK_BASE_URL,
            apiKey: ANTHROPIC_API_KEY!,
          },
        },
        ...(FALLBACK_BASE_URL_2 && FALLBACK_API_KEY_2
          ? [
              {
                model: 'claude-haiku-4-5-20251001' as const,
                provider: {
                  baseUrl: FALLBACK_BASE_URL_2,
                  apiKey: FALLBACK_API_KEY_2,
                },
              },
            ]
          : []),
      ]

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
            fallback: fallbackChain,
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

      // Exactly one provider.fallback event emitted (primary → fallback[0])
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
      expect(payload.toBaseUrl).toBe(FALLBACK_BASE_URL)
      // ECONNREFUSED → classifyProviderError → 'timeout'
      expect(payload.reason).toBe('timeout')
      expect(payload.attempt).toBe(1)
      expect(payload.fromModel).toBe('claude-haiku-4-5-20251001')
      expect(payload.toModel).toBe('claude-haiku-4-5-20251001')
    })
  })

  it('propagates error when all providers are exhausted', { timeout: 30_000 }, async () => {
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
