import { describe, expect, mock, test } from 'bun:test'
import { createAimaExtension } from '../../../../src/adapters/pi-coding-agent/extension'
import { BrainEventBus } from '../../../../src/eventbus/index'
import type { CognitiveBrainType } from '../../../../src/types/index'

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown

/** Capture handlers registered via pi.on() */
function capturePiHandlers(
  factory: ReturnType<typeof createAimaExtension>,
): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  const mockPi = {
    on: (event: string, handler: Handler) => {
      handlers[event] = handler
    },
  }
  factory(mockPi as Parameters<typeof factory>[0])
  return handlers
}

function makeAmygdala(decision: 'allow' | 'block' | 'escalate' = 'allow') {
  return {
    check: mock(async (_toolName: string, _input: unknown) => ({
      decision,
      reason: `${decision} reason`,
    })),
  }
}

function makeFixture(decision: 'allow' | 'block' | 'escalate' = 'allow') {
  const brain: CognitiveBrainType = 'limbic'
  const threadId = 'thread-1'
  const amygdala = makeAmygdala(decision)
  const eventBus = new BrainEventBus()
  const emitted: unknown[] = []
  eventBus.subscribe((e) => emitted.push(e))

  const factory = createAimaExtension(brain, threadId, amygdala as never, eventBus)
  const handlers = capturePiHandlers(factory)

  return { brain, threadId, amygdala, eventBus, emitted, handlers }
}

// ─── Default Blocked Tools ────────────────────────────────────────────────────

describe('createAimaExtension — default blocked tools', () => {
  test('bash is blocked by default policy', async () => {
    const { handlers } = makeFixture()
    const result = await (handlers.tool_call as Handler)({
      toolCallId: 'tc1',
      toolName: 'bash',
      input: { cmd: 'rm -rf /' },
    })
    expect((result as { block: boolean }).block).toBe(true)
  })

  test('edit is blocked by default policy', async () => {
    const { handlers } = makeFixture()
    const result = await (handlers.tool_call as Handler)({
      toolCallId: 'tc2',
      toolName: 'edit',
      input: {},
    })
    expect((result as { block: boolean }).block).toBe(true)
  })

  test('write is blocked by default policy', async () => {
    const { handlers } = makeFixture()
    const result = await (handlers.tool_call as Handler)({
      toolCallId: 'tc3',
      toolName: 'write',
      input: {},
    })
    expect((result as { block: boolean }).block).toBe(true)
  })

  test('bash block emits tool.pre_use AND tool.blocked events', async () => {
    const { handlers, emitted } = makeFixture()
    await (handlers.tool_call as Handler)({
      toolCallId: 'tc1',
      toolName: 'bash',
      input: { cmd: 'ls' },
    })
    const types = (emitted as Array<{ event_type: string }>).map((e) => e.event_type)
    expect(types).toContain('tool.pre_use')
    expect(types).toContain('tool.blocked')
  })

  test('default blocked tools do NOT call amygdala.check', async () => {
    const { handlers, amygdala } = makeFixture()
    await (handlers.tool_call as Handler)({ toolCallId: 'tc1', toolName: 'bash', input: {} })
    expect(amygdala.check).not.toHaveBeenCalled()
  })
})

// ─── Default Allowed Tools ────────────────────────────────────────────────────

describe('createAimaExtension — default allowed tools', () => {
  test('read returns undefined (allow)', async () => {
    const { handlers } = makeFixture()
    const result = await (handlers.tool_call as Handler)({
      toolCallId: 'tc4',
      toolName: 'read',
      input: { path: '/some/file' },
    })
    expect(result).toBeUndefined()
  })

  test('grep returns undefined (allow)', async () => {
    const { handlers } = makeFixture()
    const result = await (handlers.tool_call as Handler)({
      toolCallId: 'tc5',
      toolName: 'grep',
      input: {},
    })
    expect(result).toBeUndefined()
  })

  test('default allowed tools do NOT call amygdala.check', async () => {
    const { handlers, amygdala } = makeFixture()
    await (handlers.tool_call as Handler)({ toolCallId: 'tc4', toolName: 'read', input: {} })
    expect(amygdala.check).not.toHaveBeenCalled()
  })

  test('default allowed tools still emit tool.pre_use', async () => {
    const { handlers, emitted } = makeFixture()
    await (handlers.tool_call as Handler)({ toolCallId: 'tc4', toolName: 'read', input: {} })
    const types = (emitted as Array<{ event_type: string }>).map((e) => e.event_type)
    expect(types).toContain('tool.pre_use')
  })
})

// ─── Amygdala Dynamic Check ───────────────────────────────────────────────────

describe('createAimaExtension — amygdala dynamic check', () => {
  test('unknown tool calls amygdala.check', async () => {
    const { handlers, amygdala } = makeFixture('allow')
    await (handlers.tool_call as Handler)({
      toolCallId: 'tc9',
      toolName: 'my_custom_tool',
      input: { x: 1 },
    })
    expect(amygdala.check).toHaveBeenCalledWith('my_custom_tool', { x: 1 })
  })

  test('amygdala allow returns undefined', async () => {
    const { handlers } = makeFixture('allow')
    const result = await (handlers.tool_call as Handler)({
      toolCallId: 'tc9',
      toolName: 'custom_tool',
      input: {},
    })
    expect(result).toBeUndefined()
  })

  test('amygdala block returns { block: true, reason }', async () => {
    const { handlers } = makeFixture('block')
    const result = (await (handlers.tool_call as Handler)({
      toolCallId: 'tc10',
      toolName: 'dangerous_tool',
      input: {},
    })) as { block: boolean; reason: string }
    expect(result.block).toBe(true)
    expect(result.reason).toBe('block reason')
  })

  test('amygdala escalate returns { block: true, reason }', async () => {
    const { handlers } = makeFixture('escalate')
    const result = (await (handlers.tool_call as Handler)({
      toolCallId: 'tc11',
      toolName: 'risky_tool',
      input: {},
    })) as { block: boolean; reason: string }
    expect(result.block).toBe(true)
    expect(result.reason).toBe('escalate reason')
  })

  test('amygdala escalate emits amygdala.escalation event', async () => {
    const { handlers, emitted } = makeFixture('escalate')
    await (handlers.tool_call as Handler)({ toolCallId: 'tc11', toolName: 'risky', input: {} })
    const types = (emitted as Array<{ event_type: string }>).map((e) => e.event_type)
    expect(types).toContain('amygdala.escalation')
  })
})

// ─── allowedTools Override ────────────────────────────────────────────────────

describe('createAimaExtension — allowedTools override', () => {
  function makeAllowedFixture(
    allowedTools: string[],
    decision: 'allow' | 'block' | 'escalate' = 'allow',
  ) {
    const brain: CognitiveBrainType = 'brainstem'
    const threadId = 'thread-allowed'
    const amygdala = makeAmygdala(decision)
    const eventBus = new BrainEventBus()
    const emitted: unknown[] = []
    eventBus.subscribe((e) => emitted.push(e))

    const factory = createAimaExtension(brain, threadId, amygdala as never, eventBus, allowedTools)
    const handlers = capturePiHandlers(factory)

    return { brain, threadId, amygdala, eventBus, emitted, handlers }
  }

  test('bash in allowedTools is not blocked by Stage 1', async () => {
    const { handlers, emitted } = makeAllowedFixture(['bash'])
    const result = await (handlers.tool_call as Handler)({
      toolCallId: 'tc-a1',
      toolName: 'bash',
      input: { command: 'ls' },
    })
    // bash should pass Stage 1, then go to amygdala.check (mock returns allow → undefined)
    expect(result).toBeUndefined()
    const blockedEmits = (emitted as Array<{ event_type: string }>).filter(
      (e) => e.event_type === 'tool.blocked',
    )
    expect(blockedEmits).toHaveLength(0)
  })

  test('bash NOT in allowedTools is still blocked', async () => {
    const { handlers } = makeAllowedFixture([])
    const result = await (handlers.tool_call as Handler)({
      toolCallId: 'tc-a2',
      toolName: 'bash',
      input: { command: 'rm -rf' },
    })
    expect((result as { block: boolean }).block).toBe(true)
  })

  test('edit in allowedTools passes through to amygdala.check', async () => {
    const { handlers, amygdala } = makeAllowedFixture(['edit'])
    await (handlers.tool_call as Handler)({
      toolCallId: 'tc-a3',
      toolName: 'edit',
      input: {},
    })
    expect(amygdala.check).toHaveBeenCalledWith('edit', {})
  })

  test('tool not in DEFAULT_BLOCKED_TOOLS unaffected by allowedTools', async () => {
    const { handlers, amygdala } = makeAllowedFixture(['custom_tool'])
    await (handlers.tool_call as Handler)({
      toolCallId: 'tc-a4',
      toolName: 'custom_tool',
      input: {},
    })
    // custom_tool not in DEFAULT_BLOCKED_TOOLS — goes to amygdala.check regardless
    expect(amygdala.check).toHaveBeenCalledWith('custom_tool', {})
  })

  test('omitting allowedTools preserves original blocking behavior', async () => {
    // Same as makeFixture() with no allowedTools arg
    const { handlers } = makeFixture()
    const result = await (handlers.tool_call as Handler)({
      toolCallId: 'tc-a5',
      toolName: 'bash',
      input: {},
    })
    expect((result as { block: boolean }).block).toBe(true)
  })
})

// ─── Event Shape Assertions ───────────────────────────────────────────────────

describe('createAimaExtension — event shapes', () => {
  test('tool.pre_use event has correct shape', async () => {
    const { handlers, emitted, brain, threadId } = makeFixture('allow')
    await (handlers.tool_call as Handler)({
      toolCallId: 'tc20',
      toolName: 'read',
      input: { path: '/x' },
    })
    const evt = (emitted as Array<Record<string, unknown>>).find(
      (e) => e.event_type === 'tool.pre_use',
    )
    expect(evt).toBeDefined()
    expect(evt?.level).toBe('INFO')
    expect(evt?.brain).toBe(brain)
    expect(evt?.thread_id).toBe(threadId)
    const payload = evt?.payload as Record<string, unknown>
    expect(payload?.tool).toBe('read')
    expect(payload?.toolCallId).toBe('tc20')
  })

  test('tool.blocked event has reason field', async () => {
    const { handlers, emitted } = makeFixture()
    await (handlers.tool_call as Handler)({ toolCallId: 'tc21', toolName: 'bash', input: {} })
    const evt = (emitted as Array<Record<string, unknown>>).find(
      (e) => e.event_type === 'tool.blocked',
    )
    expect(evt).toBeDefined()
    const payload = evt?.payload as Record<string, unknown>
    expect(typeof payload?.reason).toBe('string')
  })

  test('tool.blocked level is COMPLIANCE', async () => {
    const { handlers, emitted } = makeFixture()
    await (handlers.tool_call as Handler)({ toolCallId: 'tc22', toolName: 'edit', input: {} })
    const evt = (emitted as Array<Record<string, unknown>>).find(
      (e) => e.event_type === 'tool.blocked',
    )
    expect(evt?.level).toBe('COMPLIANCE')
  })

  test('amygdala.escalation level is ALERT', async () => {
    const { handlers, emitted } = makeFixture('escalate')
    await (handlers.tool_call as Handler)({ toolCallId: 'tc23', toolName: 'risky', input: {} })
    const evt = (emitted as Array<Record<string, unknown>>).find(
      (e) => e.event_type === 'amygdala.escalation',
    )
    expect(evt?.level).toBe('ALERT')
  })

  test('tool_execution_end emits tool.post_use with correct fields', () => {
    const { handlers, emitted, brain, threadId } = makeFixture()
    ;(handlers.tool_execution_end as Handler)({
      toolCallId: 'tc30',
      toolName: 'read',
      isError: false,
    })
    const evt = (emitted as Array<Record<string, unknown>>).find(
      (e) => e.event_type === 'tool.post_use',
    )
    expect(evt).toBeDefined()
    expect(evt?.level).toBe('INFO')
    expect(evt?.brain).toBe(brain)
    expect(evt?.thread_id).toBe(threadId)
    const payload = evt?.payload as Record<string, unknown>
    expect(payload?.tool).toBe('read')
    expect(payload?.toolCallId).toBe('tc30')
    expect(payload?.isError).toBe(false)
  })

  test('agent_end emits brain.loop_end event', () => {
    const { handlers, emitted } = makeFixture()
    ;(handlers.agent_end as Handler)({})
    const evt = (emitted as Array<Record<string, unknown>>).find(
      (e) => e.event_type === 'brain.loop_end',
    )
    expect(evt).toBeDefined()
    expect(evt?.level).toBe('INFO')
  })
})
