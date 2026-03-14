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
      getSlotsByThread: mock(async () => []),
      getThread: mock(async () => null),
      markMemoryUsed: mock(async () => {}),
    } as unknown as DmnConfig['workspace'],
    eventBus: mockEventBus,
    llm: { apiKey: 'test-key' },
    ...overrides,
  }
}

// Build a workspace stub with custom slot + thread data for brain.complete tests
function makeWorkspaceWithSlots(
  slots: Array<{ brain: string; status: string; input?: unknown; output?: unknown }>,
  thread: { trigger?: string | null; goal?: string | null } | null = null,
): DmnConfig['workspace'] {
  return {
    searchMemory: mock(async () => []),
    writeMemory: mock(async () => ({}) as never),
    writeSlot: mock(async () => ({}) as never),
    writePending: mock(async () => ({}) as never),
    updateThreadState: mock(async () => {}),
    getLatestSegmentStates: mock(async () => new Map()),
    getSlotsByThread: mock(async () => slots as never),
    getThread: mock(async () => thread as never),
    markMemoryUsed: mock(async () => {}),
  } as unknown as DmnConfig['workspace']
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
    // Helper: dispatch a brain.complete event and capture the content written to episodic memory.
    // Slot + thread data come from the workspace mock (not the event payload), matching real runtime.
    async function captureEpisodicContent(
      eventOverrides: Partial<BrainEvent> = {},
      slots: Array<{ brain: string; status: string; input?: unknown; output?: unknown }> = [],
      thread: { trigger?: string | null; goal?: string | null } | null = null,
    ): Promise<string | null> {
      const config = makeConfig({
        workspace: makeWorkspaceWithSlots(slots, thread),
      })
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      bus._dispatch(
        makeEvent({
          event_type: 'brain.complete',
          brain: 'limbic',
          thread_id: 'thread-test',
          payload: {},
          ...eventOverrides,
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      const calls = (config.workspace.writeMemory as ReturnType<typeof mock>).mock.calls
      const episodicCall = calls.find((c) => (c[0] as { type?: string }).type === 'episodic')
      return episodicCall ? (episodicCall[0] as { content: string }).content : null
    }

    it('routing case: content contains brain, route decision, handoff excerpt, status, thread', async () => {
      const content = await captureEpisodicContent({ brain: 'limbic', thread_id: 'thread-abc' }, [
        {
          brain: 'limbic',
          status: 'done',
          output: { next: 'cortex', handoff: 'Please continue with this task' },
        },
      ])

      expect(content).not.toBeNull()
      expect(content).toContain('[limbic]')
      expect(content).toContain('decided: route → cortex')
      expect(content).toContain('handoff: "Please continue with this task"')
      expect(content).toContain('status: done')
      expect(content).toContain('thread: thread-abc')
    })

    it('complete case: content contains decided complete, no handoff', async () => {
      const content = await captureEpisodicContent({ brain: 'cortex', thread_id: 'thread-done' }, [
        { brain: 'cortex', status: 'done', output: { next: null } },
      ])

      expect(content).not.toBeNull()
      expect(content).toContain('[cortex]')
      expect(content).toContain('decided: complete')
      expect(content).not.toContain('handoff')
    })

    it('defer case: content contains decided defer', async () => {
      const content = await captureEpisodicContent(
        { brain: 'brainstem', thread_id: 'thread-defer' },
        [{ brain: 'brainstem', status: 'done', output: { next: 'self' } }],
      )

      expect(content).not.toBeNull()
      expect(content).toContain('[brainstem]')
      expect(content).toContain('decided: defer')
    })

    it('error case: content contains decided error and stopReason', async () => {
      const content = await captureEpisodicContent(
        { brain: 'limbic', thread_id: 'thread-err', payload: { stopReason: 'max_tokens' } },
        [{ brain: 'limbic', status: 'error' }],
      )

      expect(content).not.toBeNull()
      expect(content).toContain('[limbic]')
      expect(content).toContain('decided: error')
      expect(content).toContain('stopReason: max_tokens')
    })

    it('reply present: content includes reply excerpt truncated to 100 chars', async () => {
      const longReply = 'A'.repeat(200)
      const content = await captureEpisodicContent({ brain: 'cortex', thread_id: 'thread-reply' }, [
        { brain: 'cortex', status: 'done', output: { next: null, reply: longReply } },
      ])

      expect(content).not.toBeNull()
      expect(content).toContain('reply: "')
      const replyMatch = content?.match(/reply: "([^"]*)"/)
      expect(replyMatch).not.toBeNull()
      expect(replyMatch?.[1].length).toBeLessThanOrEqual(100)
    })

    it('no JSON: content must not contain { or }', async () => {
      const content = await captureEpisodicContent(
        { brain: 'limbic', thread_id: 'thread-nojson' },
        [
          {
            brain: 'limbic',
            status: 'done',
            output: { next: 'cortex', handoff: 'some task', reply: 'hello' },
          },
        ],
      )

      expect(content).not.toBeNull()
      expect(content).not.toContain('{')
      expect(content).not.toContain('}')
    })
  })

  describe('Feature 030: situation field + outputSlot enrichment', () => {
    // Helper: dispatch brain.complete and capture episodic content written
    async function dispatchAndCapture(
      brain: string,
      slots: Array<{ brain: string; status: string; input?: unknown; output?: unknown }>,
      thread: { trigger?: string | null; goal?: string | null } | null = null,
      extraPayload: Record<string, unknown> = {},
    ): Promise<{ content: string | null; workspace: DmnConfig['workspace'] }> {
      const workspace = makeWorkspaceWithSlots(slots, thread)
      const config = makeConfig({ workspace })
      const reactive = new DmnReactive(config)
      await reactive.start()
      const bus = config.eventBus as unknown as { _dispatch: (e: BrainEvent) => void }

      bus._dispatch(
        makeEvent({
          event_type: 'brain.complete',
          brain,
          thread_id: 'thread-1',
          payload: { injectedMemoryIds: [], ...extraPayload },
        }),
      )
      await new Promise((r) => setTimeout(r, 10))

      const calls = (workspace.writeMemory as ReturnType<typeof mock>).mock.calls
      const episodicCall = calls.find((c) => (c[0] as { type?: string }).type === 'episodic')
      const content = episodicCall ? (episodicCall[0] as { content: string }).content : null
      return { content, workspace }
    }

    it('T030-A: Cortex episodic includes situation from slot.input.handoff', async () => {
      const { content } = await dispatchAndCapture(
        'cortex',
        [
          {
            brain: 'cortex',
            status: 'done',
            input: { handoff: '需要分析：用户询问发票 X' },
            output: { next: 'brainstem', handoff: '任务：查找发票 X' },
          },
        ],
        { trigger: '用户询问发票' },
      )

      expect(content).not.toBeNull()
      expect(content).toContain('situation: "需要分析：用户询问发票 X"')
      expect(content).toContain('decided: route → brainstem')
      expect(content).toContain('handoff: "任务：查找发票 X"')
    })

    it('T030-B: Limbic episodic uses thread.trigger when slot.input has no handoff', async () => {
      const { content } = await dispatchAndCapture(
        'limbic',
        [
          {
            brain: 'limbic',
            status: 'done',
            input: null,
            output: { next: 'cortex', handoff: '需要分析：预算审批' },
          },
        ],
        { trigger: '批准预算' },
      )

      expect(content).not.toBeNull()
      expect(content).toContain('situation: "批准预算"')
      expect(content).toContain('decided: route → cortex')
    })

    it('T030-C: situation field omitted when no handoff and no trigger', async () => {
      const { content } = await dispatchAndCapture(
        'limbic',
        [{ brain: 'limbic', status: 'done', input: null, output: { next: 'cortex' } }],
        { trigger: null },
      )

      expect(content).not.toBeNull()
      expect(content).not.toContain('situation:')
      expect(content).toContain('[limbic]')
      expect(content).toContain('decided:')
    })

    it('T030-C2: situation truncated at 200 chars', async () => {
      const longSituation = 'X'.repeat(300)
      const { content } = await dispatchAndCapture('cortex', [
        {
          brain: 'cortex',
          status: 'done',
          input: { handoff: longSituation },
          output: { next: null },
        },
      ])

      expect(content).not.toBeNull()
      expect(content).toContain('situation: "')
      const situationMatch = content?.match(/situation: "([^"]*)"/)
      expect(situationMatch?.[1].length).toBeLessThanOrEqual(200)
    })

    it('T030-D1: feedbackMemoryUsage returns negative for error slot', async () => {
      const { workspace } = await dispatchAndCapture(
        'cortex',
        [{ brain: 'cortex', status: 'error', input: null, output: null }],
        { trigger: null },
        { injectedMemoryIds: ['mem-1'] },
      )

      expect(workspace.markMemoryUsed).toHaveBeenCalledWith(['mem-1'], 'negative')
    })

    it('T030-D2: feedbackMemoryUsage returns positive when output has reply', async () => {
      const { workspace } = await dispatchAndCapture(
        'limbic',
        [
          {
            brain: 'limbic',
            status: 'done',
            input: null,
            output: { reply: '已完成审批', next: null },
          },
        ],
        { trigger: '批准预算', goal: null },
        { injectedMemoryIds: ['mem-2'] },
      )

      expect(workspace.markMemoryUsed).toHaveBeenCalledWith(['mem-2'], 'positive')
    })

    it('T030-D3: feedbackMemoryUsage returns neutral for routing without reply (not to brainstem)', async () => {
      // evaluateOutcome: no error, no reply, no brainstem route → neutral
      const { workspace } = await dispatchAndCapture(
        'limbic',
        [
          {
            brain: 'limbic',
            status: 'done',
            input: null,
            output: { next: 'cortex', handoff: '分析请求' },
          },
        ],
        { trigger: null, goal: null },
        { injectedMemoryIds: ['mem-3'] },
      )

      expect(workspace.markMemoryUsed).toHaveBeenCalledWith(['mem-3'], 'neutral')
    })

    it('T030-E: retroactiveCorrection skips searchMemory (and LLM) for healthy brain.complete', async () => {
      // Healthy slot: status=done, output non-null → hasError=false, hasNoOutput=false → returns early
      const { workspace } = await dispatchAndCapture(
        'cortex',
        [
          {
            brain: 'cortex',
            status: 'done',
            input: null,
            output: { next: 'brainstem', handoff: '任务 X' },
          },
        ],
        { trigger: null },
        { injectedMemoryIds: [] },
      )

      // retroactiveCorrection returns early for healthy output — searchMemory for episodic+brain_complete
      // should NOT be called (the only searchMemory path in the healthy case would be isTopicSwitch,
      // which only fires after segState.nextSeq > 5 on a reply-and-no-next output)
      const searchCalls = (workspace.searchMemory as ReturnType<typeof mock>).mock.calls
      const retroactiveCalls = searchCalls.filter(
        (c) =>
          (c[0] as { type?: string }).type === 'episodic' &&
          Array.isArray((c[0] as { tags?: string[] }).tags) &&
          (c[0] as { tags: string[] }).tags.includes('brain_complete'),
      )
      expect(retroactiveCalls).toHaveLength(0)
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
