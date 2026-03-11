import { describe, expect, test } from 'bun:test'
import { PiAgentAdapter } from '../../src/adapters/pi-agent/index'
import { Amygdala } from '../../src/amygdala/index'
import { BrainEventBus } from '../../src/eventbus/index'
import { CognitiveWorkspace } from '../../src/workspace/index'

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

function makeAdapter() {
  const workspace = new CognitiveWorkspace(mockDb)
  const eventBus = new BrainEventBus()
  const amygdala = new Amygdala({}, workspace, eventBus)
  return new PiAgentAdapter({
    modelId: 'claude-haiku-4-5-20251001',
    workspace,
    eventBus,
    amygdala,
    getApiKey: () => undefined,
  })
}

describe('PiAgentAdapter', () => {
  test('can be instantiated without errors', () => {
    const adapter = makeAdapter()
    expect(adapter).toBeDefined()
  })

  test('implements BrainAdapter interface (abort is callable)', () => {
    const adapter = makeAdapter()
    // Should not throw even with no live sessions
    expect(() => adapter.abort()).not.toThrow()
  })

  test('abortSession does not throw when session does not exist', () => {
    const adapter = makeAdapter()
    expect(() => adapter.abortSession('cortex', 'nonexistent-thread')).not.toThrow()
  })

  test('inject does not throw with no live sessions', async () => {
    const adapter = makeAdapter()
    await expect(
      adapter.inject({ type: 'amygdala_interrupt', message: 'test interrupt' }),
    ).resolves.toBeUndefined()
  })
})
