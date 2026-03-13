import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { DmnConsolidation } from '../../../src/dmn/consolidation/index'
import { DmnService, createDmnService } from '../../../src/dmn/index'
import { DmnReactive } from '../../../src/dmn/reactive/index'
import * as llmModule from '../../../src/llm'
import { makeAlertEvent, makeBrainCompleteEvent, makeDmnConfig, makeMockWorkspace } from './helpers'

// ─── T025: DmnService lifecycle ──────────────────────────────────────────────

describe('T025 — DmnService lifecycle', () => {
  it('createDmnService() returns DmnService instance', () => {
    const { config } = makeDmnConfig()
    const svc = createDmnService(config)
    expect(svc).toBeInstanceOf(DmnService)
  })

  it('start() is idempotent', async () => {
    const { config } = makeDmnConfig()
    const svc = new DmnService(config)
    await svc.start()
    await expect(svc.start()).resolves.toBeUndefined()
    await svc.stop()
  })

  it('stop() is idempotent', async () => {
    const { config } = makeDmnConfig()
    const svc = new DmnService(config)
    await svc.start()
    await svc.stop()
    await expect(svc.stop()).resolves.toBeUndefined()
  })

  it('stop() without prior start does not throw', async () => {
    const { config } = makeDmnConfig()
    const svc = new DmnService(config)
    await expect(svc.stop()).resolves.toBeUndefined()
  })

  it('runConsolidationNow() resolves without error', async () => {
    const { config } = makeDmnConfig()
    const svc = new DmnService(config)
    await expect(svc.runConsolidationNow()).resolves.toBeUndefined()
  })

  it('DmnService without eventBus still starts', async () => {
    const ws = makeMockWorkspace()
    const config = {
      workspace: ws as unknown as Parameters<typeof createDmnService>[0]['workspace'],
      llm: { apiKey: 'test-key' },
    }
    // No eventBus — DmnReactive is skipped, only consolidation runs
    const svc = createDmnService(config)
    await expect(svc.start()).resolves.toBeUndefined()
    await svc.stop()
  })
})

// ─── T026: DmnReactive error recovery ────────────────────────────────────────

describe('T026 — DmnReactive error recovery', () => {
  it('retryable error below maxRetries writes slot with pending status', async () => {
    const { config, ws, bus } = makeDmnConfig({ maxRetries: 3 })
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeAlertEvent('thread-1', 'cortex', true)
    await bus._trigger(event)

    expect(ws.writeSlot.mock.calls.length).toBe(1)
    const [threadId, brain, data] = ws.writeSlot.mock.calls[0] as [
      string,
      string,
      { status: string },
    ]
    expect(threadId).toBe('thread-1')
    expect(brain).toBe('cortex')
    expect(data.status).toBe('pending')

    await reactive.stop()
  })

  it('retryable error increments retry count in working memory', async () => {
    const { config, ws, bus } = makeDmnConfig({ maxRetries: 3 })
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeAlertEvent('thread-2', 'cortex', true)
    await bus._trigger(event)

    const writeCalls = ws.writeMemory.mock.calls
    const retryCalls = writeCalls.filter((c) => {
      const params = c[0] as { type: string; tags?: string[] }
      return params.type === 'working' && params.tags?.includes('dmn_retry_count')
    })
    expect(retryCalls.length).toBeGreaterThan(0)
    const params = retryCalls[0]?.[0] as { content: string }
    const data = JSON.parse(params.content) as { count: number }
    expect(data.count).toBe(1)

    await reactive.stop()
  })

  it('non-retryable error interrupts thread', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeAlertEvent('thread-3', 'cortex', false)
    await bus._trigger(event)

    expect(ws.updateThreadState.mock.calls.length).toBe(1)
    const [id, state] = ws.updateThreadState.mock.calls[0] as [string, string]
    expect(id).toBe('thread-3')
    expect(state).toBe('interrupted')

    await reactive.stop()
  })

  it('max retries exceeded interrupts thread on next error', async () => {
    const { config, ws, bus } = makeDmnConfig({ maxRetries: 1 })
    const reactive = new DmnReactive(config)
    await reactive.start()

    // Pre-seed working memory with retry count = 1 (already at max)
    await ws.writeMemory({
      type: 'working',
      threadId: 'thread-4',
      content: JSON.stringify({ count: 1, brain: 'cortex' }),
      tags: ['dmn_retry_count', 'thread:thread-4'],
      baseImportance: 1.0,
    })

    const event = makeAlertEvent('thread-4', 'cortex', true)
    await bus._trigger(event)

    expect(ws.updateThreadState.mock.calls.length).toBe(1)
    const [, state] = ws.updateThreadState.mock.calls[0] as [string, string]
    expect(state).toBe('interrupted')

    await reactive.stop()
  })

  it('emits dmn.retry_scheduled on successful retry', async () => {
    const { config, bus } = makeDmnConfig({ maxRetries: 3 })
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeAlertEvent('thread-5', 'limbic', true)
    await bus._trigger(event)

    const retryEmit = bus._emitted.find((e) => e.event_type === 'dmn.retry_scheduled')
    expect(retryEmit).toBeDefined()

    await reactive.stop()
  })

  it('error without thread_id is silently ignored', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    // Alert event with no thread_id
    await bus._trigger({
      event_type: 'brain.error',
      level: 'ALERT',
      brain: 'cortex',
      thread_id: null,
      payload: { retryable: true },
    })

    expect(ws.writeSlot.mock.calls.length).toBe(0)
    expect(ws.updateThreadState.mock.calls.length).toBe(0)

    await reactive.stop()
  })
})

// ─── T027: DmnReactive DEFER scheduling ──────────────────────────────────────

describe('T027 — DmnReactive DEFER scheduling', () => {
  it('slot.done with next=self writes pending observation', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    await bus._trigger({
      event_type: 'slot.done',
      level: 'INFO',
      brain: 'limbic',
      thread_id: 'thread-d1',
      payload: {
        output: {
          next: 'self',
          defer_reason: 'waiting for external event',
          timeout_ms: 60_000,
        },
      },
    })

    expect(ws.writePending.mock.calls.length).toBe(1)
    const [params] = ws.writePending.mock.calls[0] as [{ note: string; targetBrain: string }]
    expect(params.targetBrain).toBe('limbic')
    expect(params.note).toContain('waiting for external event')

    await reactive.stop()
  })

  it('DEFER uses default timeout when timeout_ms is absent', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const before = Date.now()
    await bus._trigger({
      event_type: 'slot.done',
      level: 'INFO',
      brain: 'limbic',
      thread_id: 'thread-d2',
      payload: { output: { next: 'self', defer_reason: 'test' } },
    })

    const [params] = ws.writePending.mock.calls[0] as [{ triggerAt: Date }]
    // Default timeout = 1 hour = 3_600_000ms
    expect(params.triggerAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000 - 100)

    await reactive.stop()
  })

  it('non-limbic slot.done with DEFER is not handled', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    await bus._trigger({
      event_type: 'slot.done',
      level: 'INFO',
      brain: 'cortex', // not limbic
      thread_id: 'thread-d3',
      payload: { output: { next: 'self', defer_reason: 'test' } },
    })

    expect(ws.writePending.mock.calls.length).toBe(0)

    await reactive.stop()
  })

  it('emits dmn.defer_scheduled event', async () => {
    const { config, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    await bus._trigger({
      event_type: 'slot.done',
      level: 'INFO',
      brain: 'limbic',
      thread_id: 'thread-d4',
      payload: { output: { next: 'self', defer_reason: 'pausing' } },
    })

    const deferEmit = bus._emitted.find((e) => e.event_type === 'dmn.defer_scheduled')
    expect(deferEmit).toBeDefined()
    expect((deferEmit?.payload as { reason: string }).reason).toBe('pausing')

    await reactive.stop()
  })
})

// ─── T028: DmnReactive brain.complete episodic writes ────────────────────────

describe('T028 — DmnReactive brain.complete episodic writes', () => {
  it('brain.complete writes episodic memory entry', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeBrainCompleteEvent('thread-bc1', 'cortex')
    await bus._trigger(event)

    const episodic = ws._memories.filter((m) => m.type === 'episodic')
    expect(episodic.length).toBeGreaterThan(0)

    await reactive.stop()
  })

  it('episodic entry has thread-scoped tags', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeBrainCompleteEvent('thread-bc2', 'cortex')
    await bus._trigger(event)

    const episodic = ws._memories.filter(
      (m) => m.type === 'episodic' && m.threadId === 'thread-bc2',
    )
    expect(episodic.length).toBeGreaterThan(0)
    expect(episodic[0]?.tags).toContain('brain_complete')
    expect(episodic[0]?.tags).toContain('thread:thread-bc2')

    await reactive.stop()
  })

  it('significance_boost creates additional significance_mark entry', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeBrainCompleteEvent('thread-bc3', 'cortex', {
      significance_boost: 0.3,
    })
    await bus._trigger(event)

    const sigMarks = ws._memories.filter(
      (m) => m.type === 'episodic' && m.tags.includes('significance_mark'),
    )
    expect(sigMarks.length).toBeGreaterThan(0)

    await reactive.stop()
  })

  it('no significance mark when significance_boost is 0', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeBrainCompleteEvent('thread-bc4', 'cortex', {
      significance_boost: 0,
    })
    await bus._trigger(event)

    const sigMarks = ws._memories.filter(
      (m) => m.type === 'episodic' && m.tags.includes('significance_mark'),
    )
    expect(sigMarks.length).toBe(0)

    await reactive.stop()
  })

  it('consecutive brain.complete events on same thread share segment', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const e1 = makeBrainCompleteEvent('thread-bc5', 'cortex')
    await bus._trigger(e1)

    const e2 = makeBrainCompleteEvent('thread-bc5', 'cortex')
    await bus._trigger(e2)

    const episodic = ws._memories.filter(
      (m) => m.type === 'episodic' && m.threadId === 'thread-bc5',
    )
    // Both should share the same segmentId
    const segIds = [...new Set(episodic.map((m) => m.segmentId))]
    expect(segIds.length).toBe(1)

    await reactive.stop()
  })

  it('injected memory IDs trigger markMemoryUsed', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeBrainCompleteEvent('thread-bc6', 'cortex', {
      injectedMemoryIds: ['mem-id-1', 'mem-id-2'],
    })
    await bus._trigger(event)

    expect(ws.markMemoryUsed.mock.calls.length).toBe(1)
    const [ids] = ws.markMemoryUsed.mock.calls[0] as [string[]]
    expect(ids).toContain('mem-id-1')
    expect(ids).toContain('mem-id-2')

    await reactive.stop()
  })

  it('empty injectedMemoryIds does not call markMemoryUsed', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeBrainCompleteEvent('thread-bc7', 'cortex', { injectedMemoryIds: [] })
    await bus._trigger(event)

    expect(ws.markMemoryUsed.mock.calls.length).toBe(0)

    await reactive.stop()
  })
})

// ─── T029: DmnReactive retroactive correction ────────────────────────────────

describe('T029 — DmnReactive retroactive correction', () => {
  let callLlmSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    callLlmSpy = spyOn(llmModule, 'callLlm')
  })

  afterEach(() => {
    callLlmSpy.mockRestore()
  })

  it('no correction when fewer than 2 episodic entries', async () => {
    const { config, ws, bus } = makeDmnConfig()
    callLlmSpy.mockResolvedValue('{"topic_switched": false}')
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeBrainCompleteEvent('thread-rc1', 'cortex')
    await bus._trigger(event)

    // With 0 prior episodic entries, retroactiveCorrection returns early
    expect(ws.pushSignal.mock.calls.length).toBe(0)

    await reactive.stop()
  })

  it('LLM decides correction needed — pushSignal called', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)

    // Pre-populate episodic memory so retroactive check has enough context
    for (let i = 0; i < 3; i++) {
      ws._memories.push({
        id: `prior-${i}`,
        type: 'episodic',
        content: `prior event ${i}`,
        entityId: null,
        segmentId: null,
        segmentSeq: null,
        tags: ['brain_complete', 'thread:thread-rc2'],
        baseImportance: 0.5,
        usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
        sourceBrain: 'cortex',
        threadId: 'thread-rc2',
        sessionId: null,
        supersedesId: null,
        tInvalid: null,
        lastAccessedAt: null,
        pinned: false,
        forgotten: false,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }

    callLlmSpy.mockResolvedValue(
      JSON.stringify({
        needs_correction: true,
        correction_type: 'reasoning_error',
        correction_message: 'Previous reasoning was flawed',
      }),
    )

    await reactive.start()
    // Use error status so rule pre-check allows the LLM correction call
    const event = makeBrainCompleteEvent('thread-rc2', 'cortex', {
      outputSlot: { status: 'error', output: {} },
    })
    await bus._trigger(event)

    expect(ws.pushSignal.mock.calls.length).toBeGreaterThan(0)
    const signal = ws.pushSignal.mock.calls[0]?.[0] as { type: string; message: string }
    expect(signal.type).toBe('dmn_correction')
    expect(signal.message).toBe('Previous reasoning was flawed')

    await reactive.stop()
  })

  it('LLM no correction needed — pushSignal not called', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)

    // Pre-populate episodic memory
    for (let i = 0; i < 3; i++) {
      ws._memories.push({
        id: `prior-nc-${i}`,
        type: 'episodic',
        content: `event ${i}`,
        entityId: null,
        segmentId: null,
        segmentSeq: null,
        tags: ['brain_complete', 'thread:thread-rc3'],
        baseImportance: 0.5,
        usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
        sourceBrain: 'cortex',
        threadId: 'thread-rc3',
        sessionId: null,
        supersedesId: null,
        tInvalid: null,
        lastAccessedAt: null,
        pinned: false,
        forgotten: false,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }

    callLlmSpy.mockResolvedValue(
      JSON.stringify({
        needs_correction: false,
        correction_type: null,
        correction_message: '',
      }),
    )

    await reactive.start()
    const event = makeBrainCompleteEvent('thread-rc3', 'cortex')
    await bus._trigger(event)

    expect(ws.pushSignal.mock.calls.length).toBe(0)

    await reactive.stop()
  })

  it('correction emits dmn.correction_issued event', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)

    // Pre-populate episodic memory
    for (let i = 0; i < 3; i++) {
      ws._memories.push({
        id: `prior-ci-${i}`,
        type: 'episodic',
        content: `event ${i}`,
        entityId: null,
        segmentId: null,
        segmentSeq: null,
        tags: ['brain_complete', 'thread:thread-rc4'],
        baseImportance: 0.5,
        usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
        sourceBrain: 'cortex',
        threadId: 'thread-rc4',
        sessionId: null,
        supersedesId: null,
        tInvalid: null,
        lastAccessedAt: null,
        pinned: false,
        forgotten: false,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }

    callLlmSpy.mockResolvedValue(
      JSON.stringify({
        needs_correction: true,
        correction_type: 'factual_error',
        correction_message: 'Wrong facts',
      }),
    )

    await reactive.start()
    // Use error status so rule pre-check allows the LLM correction call
    const event = makeBrainCompleteEvent('thread-rc4', 'cortex', {
      outputSlot: { status: 'error', output: {} },
    })
    await bus._trigger(event)

    const correctionEmit = bus._emitted.find((e) => e.event_type === 'dmn.correction_issued')
    expect(correctionEmit).toBeDefined()

    await reactive.stop()
  })
})

// ─── T030: DmnConsolidation predictive activation + pending maintenance ───────

describe('T030 — DmnConsolidation predictive activation', () => {
  let callLlmSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    callLlmSpy = spyOn(llmModule, 'callLlm')
  })

  afterEach(() => {
    callLlmSpy.mockRestore()
  })

  it('skips predictive activation when no episodic increment', async () => {
    const { config, ws } = makeDmnConfig()
    const c = new DmnConsolidation(config)
    await c.runOnce()

    const callTypes = ws.searchMemory.mock.calls.map((c) => (c[0] as { type?: string }).type)
    expect(callTypes).not.toContain('procedural')
    expect(callTypes).not.toContain('semantic')
  })

  it('predictive activation calls LLM when increment is non-empty', async () => {
    const { config, ws } = makeDmnConfig()
    const c = new DmnConsolidation(config)

    // Pre-populate episodic memory so increment is non-empty
    ws._memories.push({
      id: 'ep-1',
      type: 'episodic',
      content: 'some event',
      entityId: null,
      segmentId: null,
      segmentSeq: null,
      tags: [],
      baseImportance: 0.5,
      usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
      sourceBrain: 'cortex',
      threadId: null,
      sessionId: null,
      supersedesId: null,
      tInvalid: null,
      lastAccessedAt: null,
      pinned: false,
      forgotten: false,
      expiresAt: null,
      createdAt: new Date(), // after lastRunAt backtrack
      updatedAt: new Date(),
    })

    callLlmSpy.mockResolvedValue('[]')
    await c.runOnce()

    expect(callLlmSpy).toHaveBeenCalled()
  })

  it('writes high-confidence predictions to pending', async () => {
    const { config, ws } = makeDmnConfig()
    const c = new DmnConsolidation(config)

    ws._memories.push({
      id: 'ep-pred',
      type: 'episodic',
      content: 'activity event',
      entityId: null,
      segmentId: null,
      segmentSeq: null,
      tags: [],
      baseImportance: 0.5,
      usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
      sourceBrain: 'cortex',
      threadId: null,
      sessionId: null,
      supersedesId: null,
      tInvalid: null,
      lastAccessedAt: null,
      pinned: false,
      forgotten: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    callLlmSpy.mockResolvedValue(
      JSON.stringify([
        {
          target_brain: 'limbic',
          note: 'Schedule follow-up',
          trigger_at_hours: 1,
          confidence: 'high',
        },
      ]),
    )

    await c.runOnce()

    expect(ws.writePending.mock.calls.length).toBe(1)
    const [params] = ws.writePending.mock.calls[0] as [{ note: string; baseImportance: number }]
    expect(params.note).toContain('DMN Prediction')
    expect(params.baseImportance).toBe(0.7)
  })

  it('skips low-confidence predictions', async () => {
    const { config, ws } = makeDmnConfig()
    const c = new DmnConsolidation(config)

    ws._memories.push({
      id: 'ep-low',
      type: 'episodic',
      content: 'event',
      entityId: null,
      segmentId: null,
      segmentSeq: null,
      tags: [],
      baseImportance: 0.5,
      usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
      sourceBrain: 'cortex',
      threadId: null,
      sessionId: null,
      supersedesId: null,
      tInvalid: null,
      lastAccessedAt: null,
      pinned: false,
      forgotten: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    callLlmSpy.mockResolvedValue(
      JSON.stringify([
        { target_brain: 'limbic', note: 'Low confidence', trigger_at_hours: 2, confidence: 'low' },
      ]),
    )

    await c.runOnce()

    expect(ws.writePending.mock.calls.length).toBe(0)
  })

  it('pending maintenance removes stale items', async () => {
    const { config, ws } = makeDmnConfig()
    const c = new DmnConsolidation(config)

    // Add a pending item
    const pending = await ws.writePending({
      targetBrain: 'limbic',
      note: 'stale task',
      triggerAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      baseImportance: 0.5,
    })

    callLlmSpy.mockResolvedValue(JSON.stringify([{ action: 'remove', updated_note: null }]))

    await c.runOnce()

    expect(ws.removePending.mock.calls.length).toBe(1)
    const [removedId] = ws.removePending.mock.calls[0] as [string]
    expect(removedId).toBe(pending.id)
  })

  it('pending maintenance keeps items with keep action', async () => {
    const { config, ws } = makeDmnConfig()
    const c = new DmnConsolidation(config)

    await ws.writePending({
      targetBrain: 'limbic',
      note: 'valid task',
      triggerAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      baseImportance: 0.5,
    })

    callLlmSpy.mockResolvedValue(JSON.stringify([{ action: 'keep', updated_note: null }]))

    await c.runOnce()

    expect(ws.removePending.mock.calls.length).toBe(0)
    expect(ws._pending.length).toBe(1)
  })

  it('pending maintenance update replaces item note', async () => {
    const { config, ws } = makeDmnConfig()
    const c = new DmnConsolidation(config)

    await ws.writePending({
      targetBrain: 'limbic',
      note: 'old note',
      triggerAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      baseImportance: 0.5,
    })

    callLlmSpy.mockResolvedValue(
      JSON.stringify([{ action: 'update', updated_note: 'revised note' }]),
    )

    await c.runOnce()

    // remove old + write new
    expect(ws.removePending.mock.calls.length).toBe(1)
    const lastPending = ws._pending[ws._pending.length - 1]
    expect(lastPending?.note).toBe('revised note')
  })
})

// ─── T031: Signal capture rule engine ────────────────────────────────────────

describe('T031 — Signal capture rule engine', () => {
  it('custom rule matching event fires handler', async () => {
    const handled: string[] = []
    const { config, bus } = makeDmnConfig({
      signalRules: [
        {
          match: (e) => e.event_type === 'custom.signal',
          handle: async (_e, _ws) => {
            handled.push('fired')
          },
        },
      ],
    })
    const reactive = new DmnReactive(config)
    await reactive.start()

    await bus._trigger({
      event_type: 'custom.signal',
      level: 'INFO',
      brain: 'cortex',
      thread_id: null,
      payload: {},
    })

    expect(handled).toContain('fired')
    await reactive.stop()
  })

  it('first matching rule wins — second rule not called', async () => {
    const calls: number[] = []
    const { config, bus } = makeDmnConfig({
      signalRules: [
        {
          match: (e) => e.event_type === 'custom.signal',
          handle: async () => {
            calls.push(1)
          },
        },
        {
          match: (e) => e.event_type === 'custom.signal',
          handle: async () => {
            calls.push(2)
          },
        },
      ],
    })
    const reactive = new DmnReactive(config)
    await reactive.start()

    await bus._trigger({
      event_type: 'custom.signal',
      level: 'INFO',
      brain: 'cortex',
      thread_id: null,
      payload: {},
    })

    expect(calls).toEqual([1])
    await reactive.stop()
  })

  it('default rule fires creates_followup pending', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    await bus._trigger({
      event_type: 'brain.complete',
      level: 'INFO',
      brain: 'cortex',
      thread_id: 'thread-sc1',
      payload: {
        outputSlot: { status: 'done', output: {} },
        output: { creates_followup: true, followup_brain: 'limbic', followup_note: 'Do follow-up' },
        injectedMemoryIds: [],
      },
    })

    // The default rule matches brain.complete with creates_followup in payload.output
    // But the reactive uses payload.output not outputSlot.output — check what actually gets called
    // The default rule checks event.payload.output.creates_followup
    const pendingCalls = ws.writePending.mock.calls
    const followupCalls = pendingCalls.filter((c) => {
      const p = c[0] as { note?: string }
      return p.note?.includes('Follow-up') || p.note?.includes('Do follow-up')
    })
    expect(followupCalls.length).toBeGreaterThan(0)

    await reactive.stop()
  })
})

// ─── T032: Handler isolation ──────────────────────────────────────────────────

describe('T032 — Handler isolation', () => {
  it('handler error is caught and emits dmn.handler_error', async () => {
    const { config, bus } = makeDmnConfig({
      signalRules: [
        {
          match: () => true,
          handle: async () => {
            throw new Error('handler exploded')
          },
        },
      ],
    })
    const reactive = new DmnReactive(config)
    await reactive.start()

    await bus._trigger({
      event_type: 'custom.fail',
      level: 'INFO',
      brain: 'cortex',
      thread_id: 't1',
      payload: {},
    })

    const errEmit = bus._emitted.find((e) => e.event_type === 'dmn.handler_error')
    expect(errEmit).toBeDefined()
    expect(String((errEmit?.payload as { error: string }).error)).toContain('handler exploded')

    await reactive.stop()
  })

  it('second event still processed after first handler fails', async () => {
    let secondCalled = false
    const { config, bus } = makeDmnConfig({
      signalRules: [
        {
          match: (e) => e.event_type === 'fail.event',
          handle: async () => {
            throw new Error('boom')
          },
        },
        {
          match: (e) => e.event_type === 'ok.event',
          handle: async () => {
            secondCalled = true
          },
        },
      ],
    })
    const reactive = new DmnReactive(config)
    await reactive.start()

    await bus._trigger({
      event_type: 'fail.event',
      level: 'INFO',
      brain: 'cortex',
      thread_id: null,
      payload: {},
    })
    await bus._trigger({
      event_type: 'ok.event',
      level: 'INFO',
      brain: 'cortex',
      thread_id: null,
      payload: {},
    })

    expect(secondCalled).toBe(true)

    await reactive.stop()
  })
})

// ─── T033: Retroactive correction pre-check ───────────────────────────────────

describe('T033 — Retroactive correction pre-check', () => {
  let callLlmSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    callLlmSpy = spyOn(llmModule, 'callLlm')
  })

  afterEach(() => {
    callLlmSpy.mockRestore()
  })

  it('V1: skips correction LLM for healthy brain.complete (status=done, output present, no error stopReason)', async () => {
    const { config, bus } = makeDmnConfig()
    callLlmSpy.mockResolvedValue('{}')
    const reactive = new DmnReactive(config)
    await reactive.start()

    // output.next is non-null → topic switch won't trigger either
    const event = makeBrainCompleteEvent('thread-t033-v1', 'cortex', {
      outputSlot: { status: 'done', output: { next: 'brainstem', reply: null } },
      stopReason: 'done',
    })
    await bus._trigger(event)

    expect(callLlmSpy).not.toHaveBeenCalled()

    await reactive.stop()
  })

  it('V2: runs correction LLM when slot status is error', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)

    for (let i = 0; i < 3; i++) {
      ws._memories.push({
        id: `pre-v2-${i}`,
        type: 'episodic',
        content: `prior event ${i}`,
        entityId: null,
        segmentId: null,
        segmentSeq: null,
        tags: ['brain_complete', 'thread:thread-t033-v2'],
        baseImportance: 0.5,
        usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
        sourceBrain: 'cortex',
        threadId: 'thread-t033-v2',
        sessionId: null,
        supersedesId: null,
        tInvalid: null,
        lastAccessedAt: null,
        pinned: false,
        forgotten: false,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }

    callLlmSpy.mockResolvedValue(
      JSON.stringify({ needs_correction: false, correction_type: null, correction_message: '' }),
    )

    await reactive.start()
    const event = makeBrainCompleteEvent('thread-t033-v2', 'cortex', {
      outputSlot: { status: 'error', output: { next: 'cortex' } },
      stopReason: 'done',
    })
    await bus._trigger(event)

    expect(callLlmSpy).toHaveBeenCalled()

    await reactive.stop()
  })

  it('V3: runs correction LLM when stopReason is error', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)

    for (let i = 0; i < 3; i++) {
      ws._memories.push({
        id: `pre-v3-${i}`,
        type: 'episodic',
        content: `prior event ${i}`,
        entityId: null,
        segmentId: null,
        segmentSeq: null,
        tags: ['brain_complete', 'thread:thread-t033-v3'],
        baseImportance: 0.5,
        usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
        sourceBrain: 'cortex',
        threadId: 'thread-t033-v3',
        sessionId: null,
        supersedesId: null,
        tInvalid: null,
        lastAccessedAt: null,
        pinned: false,
        forgotten: false,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }

    callLlmSpy.mockResolvedValue(
      JSON.stringify({ needs_correction: false, correction_type: null, correction_message: '' }),
    )

    await reactive.start()
    const event = makeBrainCompleteEvent('thread-t033-v3', 'cortex', {
      outputSlot: { status: 'done', output: { next: 'cortex' } },
      stopReason: 'error',
    })
    await bus._trigger(event)

    expect(callLlmSpy).toHaveBeenCalled()

    await reactive.stop()
  })

  it('V4: runs correction LLM when output is null', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)

    for (let i = 0; i < 3; i++) {
      ws._memories.push({
        id: `pre-v4-${i}`,
        type: 'episodic',
        content: `prior event ${i}`,
        entityId: null,
        segmentId: null,
        segmentSeq: null,
        tags: ['brain_complete', 'thread:thread-t033-v4'],
        baseImportance: 0.5,
        usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
        sourceBrain: 'cortex',
        threadId: 'thread-t033-v4',
        sessionId: null,
        supersedesId: null,
        tInvalid: null,
        lastAccessedAt: null,
        pinned: false,
        forgotten: false,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }

    callLlmSpy.mockResolvedValue(
      JSON.stringify({ needs_correction: false, correction_type: null, correction_message: '' }),
    )

    await reactive.start()
    const event = makeBrainCompleteEvent('thread-t033-v4', 'cortex', {
      outputSlot: { status: 'done', output: null },
      stopReason: 'done',
    })
    await bus._trigger(event)

    expect(callLlmSpy).toHaveBeenCalled()

    await reactive.stop()
  })
})

// ─── T034: Episodic handoff content ───────────────────────────────────────────

describe('T034 — Episodic handoff content', () => {
  it('V5: includes handoff content in episodic record', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const handoffText = 'User asked about billing; routing to execution layer'
    const event = makeBrainCompleteEvent('thread-t034-v5', 'cortex', {
      outputSlot: {
        status: 'done',
        output: { next: 'brainstem', reply: null, handoff: handoffText },
      },
      stopReason: 'done',
    })
    await bus._trigger(event)

    const episodic = ws._memories.filter((m) => m.type === 'episodic')
    expect(episodic.length).toBeGreaterThan(0)
    const content = episodic[0]?.content ?? ''
    // stopReason='done' (not 'end_turn') triggers 'error' decision path
    expect(content).toContain('[cortex]')
    expect(content).toContain(`handoff: "${handoffText.slice(0, 200)}"`)
    expect(content).not.toContain('reply:')

    await reactive.stop()
  })

  it('V6: writes null for handoff when output has no handoff field', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeBrainCompleteEvent('thread-t034-v6', 'cortex', {
      outputSlot: { status: 'done', output: { next: null, reply: 'Done' } },
      stopReason: 'done',
    })
    await bus._trigger(event)

    const episodic = ws._memories.filter((m) => m.type === 'episodic')
    const content = episodic[0]?.content ?? ''
    expect(content).not.toContain('handoff:')
    expect(content).toContain('reply: "Done"')

    await reactive.stop()
  })

  it('V7: treats empty string handoff as null', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    const event = makeBrainCompleteEvent('thread-t034-v7', 'cortex', {
      outputSlot: { status: 'done', output: { next: 'brainstem', handoff: '' } },
      stopReason: 'done',
    })
    await bus._trigger(event)

    const episodic = ws._memories.filter((m) => m.type === 'episodic')
    const content = episodic[0]?.content ?? ''
    // Empty string handoff is falsy — no handoff part in the output
    expect(content).not.toContain('handoff:')
    expect(content).toContain('[cortex]')

    await reactive.stop()
  })

  it('V8: episodic write succeeds even when correction is skipped (parallel independence)', async () => {
    const { config, ws, bus } = makeDmnConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    // Healthy event — correction will be skipped by pre-check
    const event = makeBrainCompleteEvent('thread-t034-v8', 'cortex', {
      outputSlot: { status: 'done', output: { next: 'brainstem', reply: null } },
      stopReason: 'done',
      injectedMemoryIds: [],
    })
    await bus._trigger(event)

    // Episodic write happened despite correction being skipped
    const episodic = ws._memories.filter((m) => m.type === 'episodic')
    expect(episodic.length).toBeGreaterThan(0)

    await reactive.stop()
  })
})
