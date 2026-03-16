import { describe, expect, test } from 'bun:test'
import { ClaudeAgentSDKAdapter } from '../../src/adapters/claude-sdk/index'
import { Amygdala } from '../../src/amygdala/index'
import { BrainEventBus } from '../../src/eventbus/index'
import { CognitiveWorkspace } from '../../src/workspace/index'

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

function makeAdapter() {
  const workspace = new CognitiveWorkspace(mockDb)
  const eventBus = new BrainEventBus()
  const amygdala = new Amygdala({}, workspace, eventBus)
  return new ClaudeAgentSDKAdapter({
    providers: {
      default: {
        primary: {
          model: 'claude-haiku-4-5-20251001',
          provider: { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-test-unit' },
        },
      },
    },
    workspace,
    eventBus,
    amygdala,
  })
}

describe('ClaudeAgentSDKAdapter', () => {
  test('can be instantiated without errors', () => {
    const adapter = makeAdapter()
    expect(adapter).toBeDefined()
  })

  test('implements BrainAdapter interface (abort is callable)', () => {
    const adapter = makeAdapter()
    expect(() => adapter.abort()).not.toThrow()
  })

  test('abortSession does not throw when session does not exist', () => {
    const adapter = makeAdapter()
    expect(() => adapter.abortSession('cortex', 'nonexistent-thread')).not.toThrow()
  })

  test('inject stores signal in workspace', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const amygdala = new Amygdala({}, workspace, eventBus)
    const adapter = new ClaudeAgentSDKAdapter({
      providers: {
        default: {
          primary: {
            model: 'claude-haiku-4-5-20251001',
            provider: { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-test-unit' },
          },
        },
      },
      workspace,
      eventBus,
      amygdala,
    })

    await adapter.inject({ type: 'amygdala_interrupt', threadId: 'thread-test', message: 'stop now' })

    expect(workspace.hasSignal('amygdala_interrupt', 'thread-test')).toBe(true)
    const sig = workspace.popSignal('amygdala_interrupt', 'thread-test')
    expect(sig?.message).toBe('stop now')
  })
})
