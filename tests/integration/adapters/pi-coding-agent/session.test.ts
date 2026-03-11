/**
 * Integration tests for the pi-coding-agent adapter.
 *
 * These tests verify the real integration between AIMA's Extension + EventBus
 * and the @mariozechner/pi-coding-agent module — without mocking pi-coding-agent
 * internals.
 *
 * Tests requiring actual LLM API calls are skipped when ANTHROPIC_API_KEY is unset.
 */
import { AuthStorage, DefaultResourceLoader, SessionManager } from '@mariozechner/pi-coding-agent'
import { describe, expect, test } from 'vitest'
import { createAimaExtension } from '../../../../src/adapters/pi-coding-agent/extension'
import { buildMcpTools } from '../../../../src/adapters/pi-coding-agent/mcp-tools'
import { Amygdala } from '../../../../src/amygdala/index'
import { BrainEventBus } from '../../../../src/eventbus/index'
import { CognitiveWorkspace } from '../../../../src/workspace/index'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

function makeEventCollector() {
  const bus = new BrainEventBus()
  const events: unknown[] = []
  bus.subscribe((e) => events.push(e))
  return { bus, events }
}

function makeAmygdala(_decision: 'allow' | 'block' = 'allow') {
  const workspace = new CognitiveWorkspace(mockDb)
  const bus = new BrainEventBus()
  return new Amygdala(
    {
      rules: [
        {
          match: { toolName: 'blocked_tool' },
          decision: 'block',
          reason: 'test block rule',
        },
      ],
    },
    workspace,
    bus,
  )
}

type ExtensionPiLike = {
  on: (event: string, handler: (...args: unknown[]) => unknown) => void
}

/** Capture extension handlers by passing a fake ExtensionAPI-compatible object */
function captureHandlers(factory: ReturnType<typeof createAimaExtension>) {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const pi: ExtensionPiLike = {
    on(event, handler) {
      handlers[event] = handler
    },
  }
  factory(pi as Parameters<typeof factory>[0])
  return handlers
}

// ─── T027: Infrastructure — SessionManager / AuthStorage ────────────────────

describe('pi-coding-agent infrastructure (no API key required)', () => {
  test('SessionManager.inMemory() can be created', () => {
    const sm = SessionManager.inMemory()
    expect(sm).toBeDefined()
  })

  test('AuthStorage.inMemory() can be created', () => {
    const auth = AuthStorage.inMemory()
    expect(auth).toBeDefined()
  })

  test('AuthStorage.inMemory().setRuntimeApiKey() does not throw', () => {
    const auth = AuthStorage.inMemory()
    expect(() => auth.setRuntimeApiKey('anthropic', 'test-key-abc')).not.toThrow()
  })

  test('DefaultResourceLoader accepts systemPromptOverride and extensionFactories', () => {
    const { bus } = makeEventCollector()
    const amygdala = makeAmygdala()
    const factory = createAimaExtension('limbic', 'thread-1', amygdala, bus)

    expect(() => {
      const _loader = new DefaultResourceLoader({
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPromptOverride: () => 'test system prompt',
        extensionFactories: [factory],
      })
    }).not.toThrow()
  })
})

// ─── T028: Extension factory wiring ──────────────────────────────────────────

describe('createAimaExtension — real integration wiring', () => {
  test('returns a function (ExtensionFactory)', () => {
    const { bus } = makeEventCollector()
    const amygdala = makeAmygdala()
    const factory = createAimaExtension('limbic', 'thread-1', amygdala, bus)
    expect(typeof factory).toBe('function')
  })

  test('factory registers tool_call, tool_execution_end, and agent_end handlers', () => {
    const { bus } = makeEventCollector()
    const amygdala = makeAmygdala()
    const factory = createAimaExtension('cortex', 'thread-2', amygdala, bus)
    const handlers = captureHandlers(factory)

    expect(typeof handlers.tool_call).toBe('function')
    expect(typeof handlers.tool_execution_end).toBe('function')
    expect(typeof handlers.agent_end).toBe('function')
  })
})

// ─── T029/T030: Block behavior ────────────────────────────────────────────────

describe('createAimaExtension — block behavior (real module, no API key)', () => {
  test('bash tool is blocked and emits tool.blocked event', async () => {
    const { bus, events } = makeEventCollector()
    const amygdala = makeAmygdala()
    const factory = createAimaExtension('limbic', 'thread-a', amygdala, bus)
    const handlers = captureHandlers(factory)

    const result = await handlers.tool_call({ toolCallId: 'tc1', toolName: 'bash', input: {} })

    expect((result as { block: boolean }).block).toBe(true)
    const blocked = (events as Array<{ event_type: string }>).find(
      (e) => e.event_type === 'tool.blocked',
    )
    expect(blocked).toBeDefined()
  })

  test('bash block does NOT emit tool.post_use (no execution)', async () => {
    const { bus, events } = makeEventCollector()
    const amygdala = makeAmygdala()
    const factory = createAimaExtension('limbic', 'thread-b', amygdala, bus)
    const handlers = captureHandlers(factory)

    await handlers.tool_call({ toolCallId: 'tc1', toolName: 'bash', input: {} })

    const postUse = (events as Array<{ event_type: string }>).find(
      (e) => e.event_type === 'tool.post_use',
    )
    expect(postUse).toBeUndefined()
  })
})

// ─── T031: Allow behavior ─────────────────────────────────────────────────────

describe('createAimaExtension — allow behavior (real module, no API key)', () => {
  test('read tool emits tool.pre_use and is allowed', async () => {
    const { bus, events } = makeEventCollector()
    const amygdala = makeAmygdala()
    const factory = createAimaExtension('brainstem', 'thread-c', amygdala, bus)
    const handlers = captureHandlers(factory)

    const result = await handlers.tool_call({
      toolCallId: 'tc2',
      toolName: 'read',
      input: { path: '/x' },
    })

    expect(result).toBeUndefined()
    const preUse = (events as Array<{ event_type: string }>).find(
      (e) => e.event_type === 'tool.pre_use',
    )
    expect(preUse).toBeDefined()
  })

  test('tool_execution_end emits tool.post_use', () => {
    const { bus, events } = makeEventCollector()
    const amygdala = makeAmygdala()
    const factory = createAimaExtension('limbic', 'thread-d', amygdala, bus)
    const handlers = captureHandlers(factory)

    handlers.tool_execution_end({ toolCallId: 'tc3', toolName: 'read', isError: false })

    const postUse = (events as Array<{ event_type: string }>).find(
      (e) => e.event_type === 'tool.post_use',
    )
    expect(postUse).toBeDefined()
  })
})

// ─── T032: agent_end handler ──────────────────────────────────────────────────

describe('createAimaExtension — agent_end wiring', () => {
  test('agent_end fires brain.loop_end on EventBus', () => {
    const { bus, events } = makeEventCollector()
    const amygdala = makeAmygdala()
    const factory = createAimaExtension('cortex', 'thread-e', amygdala, bus)
    const handlers = captureHandlers(factory)

    handlers.agent_end({})

    const loopEnd = (events as Array<{ event_type: string }>).find(
      (e) => e.event_type === 'brain.loop_end',
    )
    expect(loopEnd).toBeDefined()
  })

  test('brain.loop_end event has correct brain and thread_id', () => {
    const { bus, events } = makeEventCollector()
    const amygdala = makeAmygdala()
    const factory = createAimaExtension('brainstem', 'thread-x', amygdala, bus)
    const handlers = captureHandlers(factory)

    handlers.agent_end({})

    const evt = (events as Array<Record<string, unknown>>).find(
      (e) => e.event_type === 'brain.loop_end',
    )
    expect(evt?.brain).toBe('brainstem')
    expect(evt?.thread_id).toBe('thread-x')
  })
})

// ─── T033: MCP tools ──────────────────────────────────────────────────────────

describe('buildMcpTools — real tool list integration', () => {
  test('returns 6 tools', () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const tools = buildMcpTools(workspace)
    expect(tools).toHaveLength(6)
  })

  test('all tool names are strings and unique', () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const tools = buildMcpTools(workspace)
    const names = tools.map((t) => t.name)
    const uniqueNames = new Set(names)
    expect(uniqueNames.size).toBe(tools.length)
    for (const name of names) {
      expect(typeof name).toBe('string')
    }
  })
})

// ─── T034: Multi-session isolation ───────────────────────────────────────────

describe('multi-session isolation', () => {
  test('two Extension instances with different brains have isolated EventBuses', async () => {
    const { bus: bus1, events: events1 } = makeEventCollector()
    const { bus: bus2, events: events2 } = makeEventCollector()
    const amygdala1 = makeAmygdala()
    const amygdala2 = makeAmygdala()

    const factory1 = createAimaExtension('limbic', 'thread-A', amygdala1, bus1)
    const factory2 = createAimaExtension('cortex', 'thread-B', amygdala2, bus2)

    const handlers1 = captureHandlers(factory1)
    captureHandlers(factory2) // register factory2's handlers to simulate real usage

    // Fire tool_execution_end only on ext1
    handlers1.tool_execution_end({ toolCallId: 'tc-a', toolName: 'read', isError: false })

    expect(events1.length).toBe(1)
    expect(events2.length).toBe(0)
  })

  test('events from ext1 have brain=limbic, events from ext2 have brain=cortex', async () => {
    const { bus: bus1, events: events1 } = makeEventCollector()
    const { bus: bus2, events: events2 } = makeEventCollector()
    const amygdala1 = makeAmygdala()
    const amygdala2 = makeAmygdala()

    const factory1 = createAimaExtension('limbic', 'thread-A', amygdala1, bus1)
    const factory2 = createAimaExtension('cortex', 'thread-B', amygdala2, bus2)

    const handlers1 = captureHandlers(factory1)
    const handlers2 = captureHandlers(factory2)

    handlers1.tool_execution_end({ toolCallId: 'tc1', toolName: 'read', isError: false })
    handlers2.tool_execution_end({ toolCallId: 'tc2', toolName: 'grep', isError: false })

    const evt1 = events1[0] as Record<string, unknown>
    const evt2 = events2[0] as Record<string, unknown>
    expect(evt1.brain).toBe('limbic')
    expect(evt2.brain).toBe('cortex')
    expect(evt1.thread_id).toBe('thread-A')
    expect(evt2.thread_id).toBe('thread-B')
  })
})

// ─── API-key dependent: createAgentSession smoke test ────────────────────────

const hasApiKey = !!process.env.ANTHROPIC_API_KEY

describe('createAgentSession smoke (requires ANTHROPIC_API_KEY)', () => {
  test('DefaultResourceLoader.reload() succeeds with custom extension', async () => {
    if (!hasApiKey) return // skip gracefully when API key is not set

    const { bus } = makeEventCollector()
    const workspace = new CognitiveWorkspace(mockDb)
    const amygdala = new Amygdala({}, workspace, bus)
    const factory = createAimaExtension('limbic', 'thread-smoke', amygdala, bus)

    const loader = new DefaultResourceLoader({
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => 'test',
      extensionFactories: [factory],
    })

    await loader.reload()
  })
})
