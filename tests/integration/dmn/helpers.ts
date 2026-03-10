import type { DmnConfig } from '../../../src/dmn/index'
import { DmnService } from '../../../src/dmn/index'
import { BrainEventBus } from '../../../src/eventbus/index'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import { createTestDb } from '../helpers/db'

export type IntegrationDmnContext = {
  workspace: CognitiveWorkspace
  eventBus: BrainEventBus
  dmnService: DmnService
  pgClient: { end: () => Promise<void> }
  waitForHandlers: () => Promise<void>
}

/**
 * Creates a DMN integration test context with real DB + real workspace.
 * LLM calls are NOT mocked — tests should avoid triggering LLM paths,
 * or provide ANTHROPIC_API_KEY for smoke tests.
 */
export async function createDmnContext(
  opts: {
    dmnConfig?: Partial<DmnConfig>
  } = {},
): Promise<IntegrationDmnContext> {
  const { db, client } = createTestDb()
  const workspace = new CognitiveWorkspace(db)
  const eventBus = new BrainEventBus()

  const dmnService = new DmnService({
    workspace,
    eventBus,
    llm: { apiKey: process.env.ANTHROPIC_API_KEY ?? 'test-key-not-used' },
    consolidationIntervalMs: 999_999, // disable auto-trigger
    ...opts.dmnConfig,
  })

  await dmnService.start()

  // Helper: yield event loop several times to let fire-and-forget handlers settle
  const waitForHandlers = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => setTimeout(r, 50))
    }
  }

  return {
    workspace,
    eventBus,
    dmnService,
    pgClient: client as { end: () => Promise<void> },
    waitForHandlers,
  }
}

export async function teardownDmnContext(ctx: IntegrationDmnContext): Promise<void> {
  await ctx.dmnService.stop()
  await ctx.pgClient.end()
}
