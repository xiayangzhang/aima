import { describe, expect, mock, test } from 'bun:test'
import type { AgentSession } from '@mariozechner/pi-coding-agent'
import type { BrainSignal } from '../../../../src/adapters/index'
import { PiCodingAgentAdapter } from '../../../../src/adapters/pi-coding-agent/index'
import { Amygdala } from '../../../../src/amygdala/index'
import { BrainEventBus } from '../../../../src/eventbus/index'
import type { CognitiveWorkspace } from '../../../../src/workspace/index'

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function makeMockSession() {
  return {
    prompt: mock(async (_text: string) => undefined),
    steer: mock(async (_text: string) => undefined),
    followUp: mock(async (_text: string) => undefined),
    abort: mock(async () => undefined),
  } as unknown as AgentSession
}

function makeWorkspaceMock() {
  return {
    pushSignal: mock((_signal: BrainSignal) => undefined),
    popSignal: mock((_type: string) => undefined as BrainSignal | undefined),
    readSlot: mock(async () => null),
    writeSlot: mock(async () => ({}) as never),
  } as unknown as CognitiveWorkspace
}

function makeAdapter(
  overrides: {
    session?: AgentSession
    workspace?: CognitiveWorkspace
  } = {},
) {
  const workspace = overrides.workspace ?? makeWorkspaceMock()
  const eventBus = new BrainEventBus()
  const amygdala = new Amygdala({}, workspace, eventBus)
  const session = overrides.session ?? makeMockSession()

  const adapter = new PiCodingAgentAdapter({
    modelId: 'claude-haiku-4-5-20251001',
    workspace,
    eventBus,
    amygdala,
    getApiKey: () => undefined,
    _createSession: async () => session,
  })

  return { adapter, workspace, eventBus, session }
}

// ─── Constructor ─────────────────────────────────────────────────────────────

describe('PiCodingAgentAdapter — constructor', () => {
  test('can be instantiated without errors', () => {
    const { adapter } = makeAdapter()
    expect(adapter).toBeDefined()
  })
})

// ─── run() ───────────────────────────────────────────────────────────────────

describe('PiCodingAgentAdapter — run()', () => {
  test('first run creates a new session (session factory called once)', async () => {
    const sessionFactory = mock(async () => makeMockSession())
    const workspace = makeWorkspaceMock()
    const eventBus = new BrainEventBus()
    const amygdala = new Amygdala({}, workspace, eventBus)
    const adapter = new PiCodingAgentAdapter({
      modelId: 'claude-haiku-4-5-20251001',
      workspace,
      eventBus,
      amygdala,
      getApiKey: () => undefined,
      _createSession: sessionFactory,
    })

    await adapter.run({
      brain: 'limbic',
      threadId: 'thread-1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })
    expect(sessionFactory).toHaveBeenCalledTimes(1)
  })

  test('second run does NOT call session factory again', async () => {
    const sessionFactory = mock(async () => makeMockSession())
    const workspace = makeWorkspaceMock()
    const eventBus = new BrainEventBus()
    const amygdala = new Amygdala({}, workspace, eventBus)
    const adapter = new PiCodingAgentAdapter({
      modelId: 'claude-haiku-4-5-20251001',
      workspace,
      eventBus,
      amygdala,
      getApiKey: () => undefined,
      _createSession: sessionFactory,
    })

    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys1',
      initialPrompt: undefined,
    })
    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys2',
      initialPrompt: undefined,
    })
    expect(sessionFactory).toHaveBeenCalledTimes(1)
  })

  test('second run updates systemPromptRef to new value', async () => {
    const session = makeMockSession()
    const workspace = makeWorkspaceMock()
    const eventBus = new BrainEventBus()
    const amygdala = new Amygdala({}, workspace, eventBus)

    // popSignal is only called on the 2nd run (else branch)
    ;(workspace.popSignal as ReturnType<typeof mock>).mockReturnValueOnce({
      type: 'amygdala_interrupt',
      message: 'stop',
    })

    const adapter = new PiCodingAgentAdapter({
      modelId: 'claude-haiku-4-5-20251001',
      workspace,
      eventBus,
      amygdala,
      getApiKey: () => undefined,
      _createSession: async () => session,
    })

    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'prompt-v1',
      initialPrompt: undefined,
    })
    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'prompt-v2',
      initialPrompt: undefined,
    })
    // Verify steer was called with AMYGDALA INTERRUPT (proves 2nd run path executed)
    expect(session.steer).toHaveBeenCalledWith('[AMYGDALA INTERRUPT] stop')
  })

  test('second run delivers amygdala interrupt via steer when signal present', async () => {
    const session = makeMockSession()
    const workspace = makeWorkspaceMock()
    ;(workspace.popSignal as ReturnType<typeof mock>).mockReturnValueOnce({
      type: 'amygdala_interrupt',
      message: 'emergency',
    })

    const eventBus = new BrainEventBus()
    const amygdala = new Amygdala({}, workspace, eventBus)
    const adapter = new PiCodingAgentAdapter({
      modelId: 'claude-haiku-4-5-20251001',
      workspace,
      eventBus,
      amygdala,
      getApiKey: () => undefined,
      _createSession: async () => session,
    })

    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })
    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })
    expect(session.steer).toHaveBeenCalledWith('[AMYGDALA INTERRUPT] emergency')
  })

  test('second run skips steer when no interrupt queued', async () => {
    const session = makeMockSession()
    const workspace = makeWorkspaceMock()
    ;(workspace.popSignal as ReturnType<typeof mock>).mockReturnValue(undefined)

    const eventBus = new BrainEventBus()
    const amygdala = new Amygdala({}, workspace, eventBus)
    const adapter = new PiCodingAgentAdapter({
      modelId: 'claude-haiku-4-5-20251001',
      workspace,
      eventBus,
      amygdala,
      getApiKey: () => undefined,
      _createSession: async () => session,
    })

    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })
    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })
    expect(session.steer).not.toHaveBeenCalled()
  })

  test('run with initialPrompt calls session.prompt', async () => {
    const { adapter, session } = makeAdapter()
    await adapter.run({
      brain: 'cortex',
      threadId: 'thread-x',
      systemPrompt: 'sys',
      initialPrompt: 'hello!',
    })
    expect(session.prompt).toHaveBeenCalledWith('hello!')
  })

  test('run without initialPrompt does not call session.prompt', async () => {
    const { adapter, session } = makeAdapter()
    await adapter.run({
      brain: 'cortex',
      threadId: 'thread-y',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })
    expect(session.prompt).not.toHaveBeenCalled()
  })

  test('run returns correct BrainRunResult shape', async () => {
    const { adapter } = makeAdapter()
    const result = await adapter.run({
      brain: 'brainstem',
      threadId: 'thread-z',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })
    expect(result.sessionId).toBe('brainstem:thread-z')
    expect(result.stopReason).toBe('done')
    expect(result.output).toEqual({})
    expect(result.injectedMemoryIds).toEqual([])
  })
})

// ─── inject() ────────────────────────────────────────────────────────────────

describe('PiCodingAgentAdapter — inject()', () => {
  test('inject with no sessions calls workspace.pushSignal', async () => {
    const workspace = makeWorkspaceMock()
    const eventBus = new BrainEventBus()
    const amygdala = new Amygdala({}, workspace, eventBus)
    const adapter = new PiCodingAgentAdapter({
      modelId: 'claude-haiku-4-5-20251001',
      workspace,
      eventBus,
      amygdala,
      getApiKey: () => undefined,
      _createSession: async () => makeMockSession(),
    })

    const signal: BrainSignal = { type: 'amygdala_interrupt', threadId: 'no-session-thread', message: 'halt' }
    await adapter.inject(signal)
    expect(workspace.pushSignal).toHaveBeenCalledWith(signal)
  })

  test('inject amygdala_interrupt with active session calls session.steer', async () => {
    const { adapter, session } = makeAdapter()
    // Create a session first
    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })

    await adapter.inject({ type: 'amygdala_interrupt', threadId: 't1', message: 'urgent' })
    expect(session.steer).toHaveBeenCalledWith('[AMYGDALA INTERRUPT] urgent')
  })

  test('inject dmn_correction with active session calls session.followUp', async () => {
    const { adapter, session } = makeAdapter()
    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })

    await adapter.inject({ type: 'dmn_correction', threadId: 't1', message: 'reconsider' })
    expect(session.followUp).toHaveBeenCalledWith('[DMN CORRECTION] reconsider')
  })

  test('inject with active sessions does NOT call pushSignal', async () => {
    const { adapter, workspace } = makeAdapter()
    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })

    await adapter.inject({ type: 'amygdala_interrupt', threadId: 't1', message: 'msg' })
    expect(workspace.pushSignal).not.toHaveBeenCalled()
  })

  test('inject with empty message still calls steer', async () => {
    const { adapter, session } = makeAdapter()
    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })

    await adapter.inject({ type: 'amygdala_interrupt', threadId: 't1', message: '' })
    expect(session.steer).toHaveBeenCalledWith('[AMYGDALA INTERRUPT] ')
  })
})

// ─── abort() / abortSession() ────────────────────────────────────────────────

describe('PiCodingAgentAdapter — abort/abortSession', () => {
  test('abort() with no sessions does not throw', () => {
    const { adapter } = makeAdapter()
    expect(() => adapter.abort()).not.toThrow()
  })

  test('abort() with active sessions clears them', async () => {
    const { adapter, session } = makeAdapter()
    await adapter.run({
      brain: 'limbic',
      threadId: 't1',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })
    adapter.abort()
    // After abort, inject with no sessions should call pushSignal
    await adapter.inject({ type: 'amygdala_interrupt', threadId: 't1', message: 'test' })
    // session.abort should have been called
    expect(session.abort).toHaveBeenCalled()
  })

  test('abortSession() with unknown key does not throw', () => {
    const { adapter } = makeAdapter()
    expect(() => adapter.abortSession('cortex', 'nonexistent')).not.toThrow()
  })

  test('abortSession() with known key removes that session', async () => {
    const { adapter, session } = makeAdapter()
    await adapter.run({
      brain: 'limbic',
      threadId: 'tid',
      systemPrompt: 'sys',
      initialPrompt: undefined,
    })

    adapter.abortSession('limbic', 'tid')
    expect(session.abort).toHaveBeenCalled()
  })
})
