import { describe, expect, it, mock } from 'bun:test'
import type { BrainEvent } from '../../../src/adapters/index'
import type { DmnConfig } from '../../../src/dmn/index'
import { DmnReactive } from '../../../src/dmn/reactive/index'
import type { BrainEventBus } from '../../../src/eventbus/index'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<BrainEvent> = {}): BrainEvent {
  return {
    event_id: 'test-id',
    event_type: 'test.event',
    level: 'INFO',
    occurred_at: new Date(),
    brain: 'cortex',
    thread_id: 'thread-1',
    session_id: null,
    causation_id: null,
    schema_version: '1.0',
    payload: {},
    ...overrides,
  }
}

function makeConfig(overrides: Partial<DmnConfig> = {}): DmnConfig & {
  eventBus: NonNullable<DmnConfig['eventBus']>
} {
  const subscribers: Array<(e: BrainEvent) => void> = []
  const emitted: ReturnType<BrainEventBus['emit']>[] = []

  const mockEventBus: BrainEventBus = {
    subscribe: mock((handler: (e: BrainEvent) => void) => {
      subscribers.push(handler)
      return () => {
        const i = subscribers.indexOf(handler)
        if (i !== -1) subscribers.splice(i, 1)
      }
    }),
    emit: mock((params) => {
      const event = {
        ...params,
        event_id: 'emitted',
        occurred_at: new Date(),
        schema_version: '1.0',
      } as ReturnType<BrainEventBus['emit']>
      emitted.push(event)
      return event
    }),
    // expose for test inspection
    _subscribers: subscribers,
    _emitted: emitted,
    _dispatch: (e: BrainEvent) => {
      for (const h of subscribers) h(e)
    },
  } as unknown as BrainEventBus & {
    _subscribers: typeof subscribers
    _emitted: typeof emitted
    _dispatch: (e: BrainEvent) => void
  }

  return {
    workspace: {
      searchMemory: mock(async () => []),
      writeMemory: mock(async () => ({}) as never),
      writeSlot: mock(async () => ({}) as never),
      writePending: mock(async () => ({}) as never),
      updateThreadState: mock(async () => {}),
      getLatestSegmentStates: mock(async () => new Map()),
    } as unknown as DmnConfig['workspace'],
    eventBus: mockEventBus,
    llm: { apiKey: 'test-key' },
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DmnReactive', () => {
  describe('start / stop', () => {
    it('start() subscribes to eventBus', async () => {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      expect((config.eventBus as unknown as { _subscribers: unknown[] })._subscribers).toHaveLength(
        1,
      )
    })

    it('start() is idempotent', async () => {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      await reactive.start()
      expect((config.eventBus as unknown as { _subscribers: unknown[] })._subscribers).toHaveLength(
        1,
      )
    })

    it('stop() unsubscribes from eventBus', async () => {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      await reactive.stop()
      expect((config.eventBus as unknown as { _subscribers: unknown[] })._subscribers).toHaveLength(
        0,
      )
    })

    // Fix 3: restore segment tracking on start()
    it('start() restores segment tracking from workspace', async () => {
      const restoredState = new Map([
        ['thread-abc', { segmentId: 'seg-123', nextSeq: 5 }],
        ['thread-xyz', { segmentId: 'seg-456', nextSeq: 2 }],
      ])
      const config = makeConfig({
        workspace: {
          searchMemory: mock(async () => []),
          writeMemory: mock(async () => ({}) as never),
          writeSlot: mock(async () => ({}) as never),
          writePending: mock(async () => ({}) as never),
          updateThreadState: mock(async () => {}),
          getLatestSegmentStates: mock(async () => restoredState),
        } as unknown as typeof config.workspace,
      })
      const reactive = new DmnReactive(config)
      await reactive.start()
      // getLatestSegmentStates was called once on start
      // biome-ignore lint/suspicious/noExplicitAny: accessing private for test verification
      const segments = (reactive as unknown as Record<string, any>).threadSegments as Map<
        string,
        { segmentId: string; nextSeq: number }
      >
      expect(segments.get('thread-abc')).toEqual({ segmentId: 'seg-123', nextSeq: 5 })
      expect(segments.get('thread-xyz')).toEqual({ segmentId: 'seg-456', nextSeq: 2 })
      await reactive.stop()
    })
  })

  describe('Responsibility 1: error recovery', () => {
    it('ALERT with retryable=true and count < maxRetries → writes pending slot + retry memory', async () => {
      const config = makeConfig({ maxRetries: 3 })
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      const event = makeEvent({
        level: 'ALERT',
        event_type: 'brain.error',
        brain: 'brainstem',
        thread_id: 'thread-1',
        payload: { retryable: true, errorMessage: 'timeout' },
      })

      bus._dispatch(event)
      // Let async handler complete
      await new Promise((r) => setTimeout(r, 10))

      expect(config.workspace.writeSlot).toHaveBeenCalledWith(
        'thread-1',
        'brainstem',
        expect.objectContaining({ status: 'pending' }),
      )
      expect(config.workspace.writeMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'working',
          tags: expect.arrayContaining(['dmn_retry_count']),
        }),
      )
    })

    it('ALERT with retryable=false → interrupts thread', async () => {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      bus._dispatch(
        makeEvent({
          level: 'ALERT',
          brain: 'cortex',
          thread_id: 'thread-2',
          payload: { retryable: false },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      expect(config.workspace.updateThreadState).toHaveBeenCalledWith('thread-2', 'interrupted')
    })
  })

  describe('Responsibility 6: DEFER scheduling', () => {
    it('slot.done limbic with next=self → writes pending with correct triggerAt', async () => {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      const before = Date.now()
      bus._dispatch(
        makeEvent({
          event_type: 'slot.done',
          brain: 'limbic',
          thread_id: 'thread-3',
          payload: { output: { next: 'self', timeout_ms: 5000, defer_reason: 'waiting for user' } },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      expect(config.workspace.writePending).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBrain: 'limbic',
          triggerAt: expect.any(Date),
        }),
      )
      const call = (config.workspace.writePending as ReturnType<typeof mock>).mock.calls[0][0] as {
        triggerAt: Date
      }
      expect(call.triggerAt.getTime()).toBeGreaterThanOrEqual(before + 5000)
    })
  })

  describe('Amygdala interrupt: episodic write + significance mark', () => {
    it('writes episodic memory with boosted baseImportance on amygdala.interrupt ALERT', async () => {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      bus._dispatch(
        makeEvent({
          event_type: 'amygdala.interrupt',
          level: 'ALERT',
          brain: 'amygdala',
          thread_id: 'thread-amyg',
          payload: { tool: 'bash', decision: 'block', reason: 'blocked', significance_boost: 0.4 },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      expect(config.workspace.writeMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'episodic',
          sourceBrain: 'amygdala',
          baseImportance: 0.9,
          tags: expect.arrayContaining(['amygdala_interrupt']),
        }),
      )
    })

    it('writes significance_mark when boost > 0', async () => {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      bus._dispatch(
        makeEvent({
          event_type: 'amygdala.interrupt',
          level: 'ALERT',
          brain: 'amygdala',
          thread_id: 'thread-amyg',
          payload: { tool: 'bash', decision: 'block', reason: 'blocked', significance_boost: 0.4 },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      expect(config.workspace.writeMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(['significance_mark']),
        }),
      )
    })

    it('uses baseImportance=0.5 when significance_boost is absent', async () => {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      bus._dispatch(
        makeEvent({
          event_type: 'amygdala.interrupt',
          level: 'ALERT',
          brain: 'amygdala',
          thread_id: 'thread-amyg',
          payload: { tool: 'bash', decision: 'block', reason: 'blocked' },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      expect(config.workspace.writeMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'episodic',
          baseImportance: 0.5,
        }),
      )
      // No significance_mark when boost is 0
      const allCalls = (config.workspace.writeMemory as ReturnType<typeof mock>).mock.calls
      const hasSigMark = allCalls.some(
        (call) =>
          Array.isArray((call[0] as { tags?: string[] }).tags) &&
          (call[0] as { tags: string[] }).tags.includes('significance_mark'),
      )
      expect(hasSigMark).toBe(false)
    })

    it('does not write for non-ALERT amygdala.interrupt events', async () => {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      bus._dispatch(
        makeEvent({
          event_type: 'amygdala.interrupt',
          level: 'INFO',
          brain: 'amygdala',
          payload: { tool: 'bash', decision: 'block', reason: 'blocked', significance_boost: 0.4 },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      expect(config.workspace.writeMemory).not.toHaveBeenCalled()
    })
  })

  describe('buildEpisodicContent: cognitive summary format', () => {
    // Helper: dispatch a brain.complete event and capture the content written to episodic memory
    async function captureEpisodicContent(
      overrides: Partial<BrainEvent> = {},
    ): Promise<string | null> {
      const config = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      bus._dispatch(
        makeEvent({
          event_type: 'brain.complete',
          brain: 'limbic',
          thread_id: 'thread-test',
          payload: {},
          ...overrides,
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      const calls = (config.workspace.writeMemory as ReturnType<typeof mock>).mock.calls
      const episodicCall = calls.find((c) => (c[0] as { type?: string }).type === 'episodic')
      return episodicCall ? (episodicCall[0] as { content: string }).content : null
    }

    it('routing case: content contains brain, route decision, handoff excerpt, status, thread', async () => {
      const content = await captureEpisodicContent({
        brain: 'limbic',
        thread_id: 'thread-abc',
        payload: {
          outputSlot: {
            status: 'done',
            output: {
              next: 'cortex',
              handoff: 'Please continue with this task',
            },
          },
        },
      })

      expect(content).not.toBeNull()
      expect(content).toContain('[limbic]')
      expect(content).toContain('route → cortex')
      expect(content).toContain('handoff: "Please continue with this task"')
      expect(content).toContain('status: done')
      expect(content).toContain('thread: thread-abc')
    })

    it('complete case: content contains decided complete, no handoff', async () => {
      const content = await captureEpisodicContent({
        brain: 'cortex',
        thread_id: 'thread-done',
        payload: {
          outputSlot: {
            status: 'done',
            output: { next: null },
          },
        },
      })

      expect(content).not.toBeNull()
      expect(content).toContain('[cortex] decided: complete')
      expect(content).not.toContain('handoff')
    })

    it('defer case: content contains decided defer', async () => {
      const content = await captureEpisodicContent({
        brain: 'brainstem',
        thread_id: 'thread-defer',
        payload: {
          outputSlot: {
            status: 'done',
            output: { next: 'self' },
          },
        },
      })

      expect(content).not.toBeNull()
      expect(content).toContain('[brainstem] decided: defer')
    })

    it('error case: content contains decided error and stopReason', async () => {
      const content = await captureEpisodicContent({
        brain: 'limbic',
        thread_id: 'thread-err',
        payload: {
          outputSlot: { status: 'error' },
          stopReason: 'max_tokens',
        },
      })

      expect(content).not.toBeNull()
      expect(content).toContain('[limbic] decided: error')
      expect(content).toContain('stopReason: max_tokens')
    })

    it('reply present: content includes reply excerpt truncated to 100 chars', async () => {
      const longReply = 'A'.repeat(200)
      const content = await captureEpisodicContent({
        brain: 'cortex',
        thread_id: 'thread-reply',
        payload: {
          outputSlot: {
            status: 'done',
            output: {
              next: null,
              reply: longReply,
            },
          },
        },
      })

      expect(content).not.toBeNull()
      expect(content).toContain('reply: "')
      // The reply in content must not exceed 100 chars (plus surrounding quotes)
      const replyMatch = content?.match(/reply: "([^"]*)"/)
      expect(replyMatch).not.toBeNull()
      expect(replyMatch?.[1].length).toBeLessThanOrEqual(100)
    })

    it('no JSON: content must not contain { or }', async () => {
      const content = await captureEpisodicContent({
        brain: 'limbic',
        thread_id: 'thread-nojson',
        payload: {
          outputSlot: {
            status: 'done',
            output: { next: 'cortex', handoff: 'some task', reply: 'hello' },
          },
        },
      })

      expect(content).not.toBeNull()
      expect(content).not.toContain('{')
      expect(content).not.toContain('}')
    })
  })

  describe('handler error isolation', () => {
    it('handler error emits dmn.handler_error without throwing', async () => {
      const config = makeConfig()
      // Make writeSlot throw
      ;(config.workspace.writeSlot as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error('DB down')
      })

      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as {
        _dispatch: (e: BrainEvent) => void
        _emitted: BrainEvent[]
      }

      bus._dispatch(
        makeEvent({
          level: 'ALERT',
          brain: 'cortex',
          thread_id: 'thread-4',
          payload: { retryable: true },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      const errorEvent = bus._emitted.find((e) => e.event_type === 'dmn.handler_error')
      expect(errorEvent).toBeDefined()
    })
  })
})
