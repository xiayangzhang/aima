import { describe, expect, it, mock } from 'bun:test'
import type { BrainEvent } from '../../../src/adapters/index'
import type { DmnConfig } from '../../../src/dmn/index'
import { DmnReactive } from '../../../src/dmn/reactive/index'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBrainCompleteEvent(overrides: Partial<BrainEvent> = {}): BrainEvent {
  return {
    event_id: 'test-id',
    event_type: 'brain.complete',
    level: 'INFO',
    occurred_at: new Date(),
    brain: 'limbic',
    thread_id: 'thread-1',
    session_id: null,
    causation_id: null,
    schema_version: '1.0',
    payload: {
      injectedMemoryIds: [],
      outputSlot: { status: 'done', output: { mode: 'RESPOND' } },
      stopReason: 'end_turn',
    },
    ...overrides,
  }
}

function makeConfig(overrides: Partial<DmnConfig> = {}) {
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
    pushSignal: mock(() => {}),
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
      ...overrides,
    } as DmnConfig & { eventBus: NonNullable<DmnConfig['eventBus']> },
    bus: mockEventBus,
    ws: mockWorkspace,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DmnReactive — brain.complete handler', () => {
  describe('Responsibility 3+4: segment assignment + episodic write', () => {
    it('writes episodic memory on brain.complete', async () => {
      const { config, bus, ws } = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()

      bus._dispatch(makeBrainCompleteEvent())
      await new Promise((r) => setTimeout(r, 20))

      expect(ws.writeMemory).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'episodic', segmentSeq: 0 }),
      )
    })

    it('increments segmentSeq on same thread same segment', async () => {
      const { config, bus, ws } = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()

      bus._dispatch(makeBrainCompleteEvent({ thread_id: 'thread-A' }))
      await new Promise((r) => setTimeout(r, 20))
      bus._dispatch(makeBrainCompleteEvent({ thread_id: 'thread-A' }))
      await new Promise((r) => setTimeout(r, 20))

      const calls = (ws.writeMemory as ReturnType<typeof mock>).mock.calls
        .map((c) => c[0] as { type: string; segmentSeq: number; segmentId: string })
        .filter((c) => c.type === 'episodic')
      expect(calls[0].segmentId).toBe(calls[1].segmentId)
      expect(calls[1].segmentSeq).toBe(1)
    })

    it('starts new segment on error slot status', async () => {
      const { config, bus, ws } = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()

      bus._dispatch(makeBrainCompleteEvent({ thread_id: 'thread-B' }))
      await new Promise((r) => setTimeout(r, 20))

      bus._dispatch(
        makeBrainCompleteEvent({
          thread_id: 'thread-B',
          payload: { outputSlot: { status: 'error', output: {} }, injectedMemoryIds: [] },
        }),
      )
      await new Promise((r) => setTimeout(r, 20))

      const calls = (ws.writeMemory as ReturnType<typeof mock>).mock.calls
        .map((c) => c[0] as { type: string; segmentSeq: number; segmentId: string })
        .filter((c) => c.type === 'episodic')
      expect(calls[0].segmentId).not.toBe(calls[1].segmentId)
      expect(calls[1].segmentSeq).toBe(0) // reset
    })

    it('writes significance_mark when significance_boost > 0', async () => {
      const { config, bus, ws } = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()

      bus._dispatch(
        makeBrainCompleteEvent({
          payload: {
            injectedMemoryIds: [],
            outputSlot: { status: 'done', output: { mode: 'RESPOND' } },
            significance_boost: 0.3,
          },
        }),
      )
      await new Promise((r) => setTimeout(r, 20))

      const calls = (ws.writeMemory as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as { tags: string[] },
      )
      const hasSigMark = calls.some((c) => c.tags.includes('significance_mark'))
      expect(hasSigMark).toBe(true)
    })

    it('base_importance capped at 1.0 with large boost', async () => {
      const { config, bus, ws } = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()

      bus._dispatch(
        makeBrainCompleteEvent({
          payload: {
            injectedMemoryIds: [],
            outputSlot: { status: 'done', output: {} },
            significance_boost: 1.0,
          },
        }),
      )
      await new Promise((r) => setTimeout(r, 20))

      const calls = (ws.writeMemory as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as { baseImportance: number },
      )
      for (const c of calls) {
        expect(c.baseImportance).toBeLessThanOrEqual(1.0)
      }
    })
  })

  describe('Responsibility 5: memory usage feedback', () => {
    it('calls markMemoryUsed with injected IDs and positive outcome on RESPOND', async () => {
      const { config, bus, ws } = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()

      bus._dispatch(
        makeBrainCompleteEvent({
          payload: {
            injectedMemoryIds: ['mem-1', 'mem-2'],
            outputSlot: { status: 'done', output: { mode: 'RESPOND' } },
          },
        }),
      )
      await new Promise((r) => setTimeout(r, 20))

      expect(ws.markMemoryUsed).toHaveBeenCalledWith(['mem-1', 'mem-2'], 'positive')
    })

    it('negative outcome on error slot', async () => {
      const { config, bus, ws } = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()

      bus._dispatch(
        makeBrainCompleteEvent({
          payload: {
            injectedMemoryIds: ['mem-3'],
            outputSlot: { status: 'error', output: {} },
          },
        }),
      )
      await new Promise((r) => setTimeout(r, 20))

      expect(ws.markMemoryUsed).toHaveBeenCalledWith(['mem-3'], 'negative')
    })

    it('skips markMemoryUsed when no injected IDs', async () => {
      const { config, bus, ws } = makeConfig()
      const reactive = new DmnReactive(config)
      await reactive.start()

      bus._dispatch(makeBrainCompleteEvent())
      await new Promise((r) => setTimeout(r, 20))

      expect(ws.markMemoryUsed).not.toHaveBeenCalled()
    })
  })
})
