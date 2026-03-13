import { beforeEach, describe, expect, it, mock } from 'bun:test'

// Mock callLlm BEFORE the DmnReactive module is loaded
const mockCallLlm = mock(() => Promise.resolve('{"achieved": true, "reason": "default"}'))

mock.module('../../../src/llm', () => ({
  callLlm: mockCallLlm,
  parseLlmJson: <T>(text: string, fallback: T): T => {
    try {
      const m = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
      if (!m?.[1] && !m?.[0]) return fallback
      return JSON.parse((m[1] ?? m[0]) as string) as T
    } catch {
      return fallback
    }
  },
}))

// Dynamic import ensures the mock is in place first
const { DmnReactive } = await import('../../../src/dmn/reactive/index')

import type { BrainEvent } from '../../../src/adapters/index'
import type { DmnConfig } from '../../../src/dmn/index'
import type { Thread } from '../../../src/types/index'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeThread(opts: { id: string; goal: string | null }): Thread {
  return {
    id: opts.id,
    state: 'complete',
    sourceChannel: null,
    initiatedBy: 'external:teams',
    trigger: null,
    goal: opts.goal,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeBrainCompleteEvent(opts: {
  threadId: string
  injectedMemoryIds: string[]
  reply?: string
  outputStatus?: string
}): BrainEvent {
  return {
    event_id: 'test-id',
    event_type: 'brain.complete',
    level: 'INFO',
    occurred_at: new Date(),
    brain: 'limbic',
    thread_id: opts.threadId,
    session_id: null,
    causation_id: null,
    schema_version: '1.0',
    payload: {
      injectedMemoryIds: opts.injectedMemoryIds,
      outputSlot: {
        status: opts.outputStatus ?? 'done',
        output: opts.reply !== undefined ? { reply: opts.reply } : {},
      },
      stopReason: 'end_turn',
    },
  }
}

function makeConfig() {
  const subscribers: Array<(e: BrainEvent) => void> = []
  const mockEventBus = {
    subscribe: mock((h: (e: BrainEvent) => void) => {
      subscribers.push(h)
      return () => { subscribers.splice(subscribers.indexOf(h), 1) }
    }),
    emit: mock(() => ({} as ReturnType<typeof mockEventBus.emit>)),
    _dispatch: (e: BrainEvent) => subscribers.forEach((h) => h(e)),
  }

  const mockWorkspace = {
    searchMemory: mock(async () => []),
    writeMemory: mock(async () => ({} as never)),
    markMemoryUsed: mock(async () => {}),
    getThread: mock(async () => null as Thread | null),
    writePending: mock(async () => ({} as never)),
    updateThreadState: mock(async () => {}),
    writeSlot: mock(async () => ({} as never)),
    getLatestSegmentStates: mock(async () => new Map()),
  }

  return {
    config: {
      workspace: mockWorkspace as unknown as DmnConfig['workspace'],
      eventBus: mockEventBus as unknown as NonNullable<DmnConfig['eventBus']>,
      llm: { apiKey: 'test-key' },
    } as DmnConfig & { eventBus: NonNullable<DmnConfig['eventBus']> },
    bus: mockEventBus,
    ws: mockWorkspace,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('feedbackMemoryUsage — goal-based evaluation', () => {
  beforeEach(() => {
    mockCallLlm.mockReset()
    mockCallLlm.mockResolvedValue('{"achieved": true, "reason": "default"}')
  })

  // V1: goal + reply + achieved=true → positive
  it('calls markMemoryUsed with positive when LLM evaluates goal as achieved', async () => {
    const { config, bus, ws } = makeConfig()
    ws.getThread.mockResolvedValue(makeThread({ id: 'thread-goal-1', goal: 'Send a confirmation email reply' }))
    mockCallLlm.mockResolvedValue('{"achieved": true, "reason": "reply confirms email sent"}')

    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(
      makeBrainCompleteEvent({
        threadId: 'thread-goal-1',
        injectedMemoryIds: ['mem-001', 'mem-002'],
        reply: 'I have sent the confirmation email.',
      }),
    )
    await new Promise((r) => setTimeout(r, 20))

    expect(ws.markMemoryUsed).toHaveBeenCalledWith(['mem-001', 'mem-002'], 'positive')
    expect(mockCallLlm).toHaveBeenCalledTimes(1)
    await reactive.stop()
  })

  // V2: goal + reply + achieved=false → negative
  it('calls markMemoryUsed with negative when LLM evaluates goal as not achieved', async () => {
    const { config, bus, ws } = makeConfig()
    ws.getThread.mockResolvedValue(makeThread({ id: 'thread-goal-2', goal: 'Book the flight' }))
    mockCallLlm.mockResolvedValue('{"achieved": false, "reason": "no booking confirmation"}')

    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(
      makeBrainCompleteEvent({
        threadId: 'thread-goal-2',
        injectedMemoryIds: ['mem-003'],
        reply: 'I need more information about your travel dates.',
      }),
    )
    await new Promise((r) => setTimeout(r, 20))

    expect(ws.markMemoryUsed).toHaveBeenCalledWith(['mem-003'], 'negative')
    await reactive.stop()
  })

  // V3: goal = null → heuristic, no LLM
  it('falls back to heuristic when thread.goal is null', async () => {
    const { config, bus, ws } = makeConfig()
    ws.getThread.mockResolvedValue(makeThread({ id: 'thread-no-goal', goal: null }))

    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(
      makeBrainCompleteEvent({
        threadId: 'thread-no-goal',
        injectedMemoryIds: ['mem-004'],
        reply: 'Hello, how can I help?',
      }),
    )
    await new Promise((r) => setTimeout(r, 20))

    expect(mockCallLlm).not.toHaveBeenCalled()
    // heuristic: has reply → positive
    expect(ws.markMemoryUsed).toHaveBeenCalledWith(['mem-004'], 'positive')
    await reactive.stop()
  })

  // V4: getThread returns null → heuristic, no LLM
  it('falls back to heuristic when getThread returns null', async () => {
    const { config, bus, ws } = makeConfig()
    ws.getThread.mockResolvedValue(null)

    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(
      makeBrainCompleteEvent({
        threadId: 'missing-thread',
        injectedMemoryIds: ['mem-005'],
        reply: 'some reply',
      }),
    )
    await new Promise((r) => setTimeout(r, 20))

    expect(mockCallLlm).not.toHaveBeenCalled()
    expect(ws.markMemoryUsed).toHaveBeenCalledTimes(1)
    await reactive.stop()
  })

  // V5: callLlm throws → markMemoryUsed with heuristic, no throw
  it('silently falls back to heuristic when callLlm throws', async () => {
    const { config, bus, ws } = makeConfig()
    ws.getThread.mockResolvedValue(makeThread({ id: 'thread-llm-fail', goal: 'some goal' }))
    mockCallLlm.mockRejectedValue(new Error('llm timeout'))

    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(
      makeBrainCompleteEvent({
        threadId: 'thread-llm-fail',
        injectedMemoryIds: ['mem-006'],
        reply: 'some reply',
      }),
    )
    await new Promise((r) => setTimeout(r, 20))

    // Must not throw; markMemoryUsed must still be called (fallback)
    expect(ws.markMemoryUsed).toHaveBeenCalledTimes(1)
    await reactive.stop()
  })

  // V6: injectedMemoryIds empty → no calls at all
  it('returns early when injectedMemoryIds is empty', async () => {
    const { config, bus, ws } = makeConfig()

    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(
      makeBrainCompleteEvent({
        threadId: 'thread-abc',
        injectedMemoryIds: [],
        reply: 'some reply',
      }),
    )
    await new Promise((r) => setTimeout(r, 20))

    expect(ws.getThread).not.toHaveBeenCalled()
    expect(mockCallLlm).not.toHaveBeenCalled()
    expect(ws.markMemoryUsed).not.toHaveBeenCalled()
    await reactive.stop()
  })

  // V7: goal exists but reply is null → heuristic (no LLM)
  it('falls back to heuristic when goal exists but reply is null', async () => {
    const { config, bus, ws } = makeConfig()
    ws.getThread.mockResolvedValue(makeThread({ id: 'thread-no-reply', goal: 'some goal' }))

    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(
      makeBrainCompleteEvent({
        threadId: 'thread-no-reply',
        injectedMemoryIds: ['mem-007'],
        // no reply (routing turn)
      }),
    )
    await new Promise((r) => setTimeout(r, 20))

    expect(mockCallLlm).not.toHaveBeenCalled()
    // heuristic: no reply, no error → neutral
    expect(ws.markMemoryUsed).toHaveBeenCalledWith(['mem-007'], 'neutral')
    await reactive.stop()
  })
})
