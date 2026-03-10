import { afterAll, beforeAll, expect, test } from 'vitest'
import { DmnService } from '../../../src/dmn/index'
import { BrainEventBus } from '../../../src/eventbus/index'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import { createTestDb } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'
import { createDmnContext, teardownDmnContext } from './helpers'
import type { IntegrationDmnContext } from './helpers'

// ─── T032: Error Recovery ─────────────────────────────────────────────────────

describeWithDb('DMN integration — error recovery (T032)', () => {
  let ctx: IntegrationDmnContext

  beforeAll(async () => {
    ctx = await createDmnContext()
  })

  afterAll(async () => {
    await teardownDmnContext(ctx)
  })

  test('ALERT retryable → Brainstem Slot reset to pending in DB', async () => {
    const { workspace, eventBus, waitForHandlers } = ctx

    // Create a thread and an initial brainstem slot (error state)
    const thread = await workspace.createThread({ initiatedBy: 'integration-test-T032' })
    await workspace.writeSlot(thread.id, 'brainstem', {
      status: 'error',
      output: { error: 'tool timeout' },
    })

    // Emit ALERT event simulating Brainstem tool timeout
    eventBus.emit({
      event_type: 'brain.error',
      level: 'ALERT',
      brain: 'brainstem',
      thread_id: thread.id,
      payload: {
        retryable: true,
        errorMessage: 'tool execution timeout',
      },
    })

    await waitForHandlers()

    // Verify: Brainstem Slot status is now 'pending' (reset for retry)
    const slot = await workspace.readSlot(thread.id, 'brainstem')
    expect(slot).toBeDefined()
    expect(slot?.status).toBe('pending')
    expect((slot?.output as Record<string, unknown> | null)?.retry).toBe(true)
    expect((slot?.output as Record<string, unknown> | null)?.retryCount).toBe(1)
  })

  test('ALERT non-retryable → Thread state set to interrupted in DB', async () => {
    const { workspace, eventBus, waitForHandlers } = ctx

    const thread = await workspace.createThread({ initiatedBy: 'integration-test-T032b' })

    eventBus.emit({
      event_type: 'brain.error',
      level: 'ALERT',
      brain: 'cortex',
      thread_id: thread.id,
      payload: {
        retryable: false,
        errorMessage: 'fatal error',
      },
    })

    await waitForHandlers()

    const updated = await workspace.getThread(thread.id)
    expect(updated?.state).toBe('interrupted')
  })
})

// ─── T033: DEFER Scheduling ───────────────────────────────────────────────────

describeWithDb('DMN integration — DEFER scheduling (T033)', () => {
  let ctx: IntegrationDmnContext

  beforeAll(async () => {
    ctx = await createDmnContext()
  })

  afterAll(async () => {
    await teardownDmnContext(ctx)
  })

  test('Limbic slot.done DEFER → pending_observation written to DB with correct trigger_at', async () => {
    const { workspace, eventBus, waitForHandlers } = ctx

    const thread = await workspace.createThread({ initiatedBy: 'integration-test-T033' })
    const timeoutMs = 60_000

    eventBus.emit({
      event_type: 'slot.done',
      level: 'INFO',
      brain: 'limbic',
      thread_id: thread.id,
      payload: {
        output: {
          mode: 'DEFER',
          timeout_ms: timeoutMs,
          defer_reason: 'channel_unavailable',
        },
      },
    })

    const triggerAtLowerBound = Date.now() + timeoutMs - 500

    await waitForHandlers()

    const pending = await workspace.getPendingObservations()
    const deferPending = pending.filter(
      (p) => p.targetBrain === 'limbic' && p.note.includes('channel_unavailable'),
    )
    expect(deferPending.length).toBeGreaterThan(0)

    const triggerAt = deferPending[0]?.triggerAt
    expect(triggerAt).toBeDefined()
    expect(triggerAt?.getTime()).toBeGreaterThanOrEqual(triggerAtLowerBound)
  })
})

// ─── T034: brain.complete → episodic + segment + markUsed ─────────────────────

describeWithDb('DMN integration — brain.complete four responsibilities (T034)', () => {
  let ctx: IntegrationDmnContext

  beforeAll(async () => {
    ctx = await createDmnContext()
  })

  afterAll(async () => {
    await teardownDmnContext(ctx)
  })

  test('brain.complete → episodic written to DB with segment_id', async () => {
    const { workspace, eventBus, waitForHandlers } = ctx

    const thread = await workspace.createThread({ initiatedBy: 'integration-test-T034a' })

    eventBus.emit({
      event_type: 'brain.complete',
      level: 'INFO',
      brain: 'limbic',
      thread_id: thread.id,
      payload: {
        injectedMemoryIds: [],
        outputSlot: { status: 'done', output: { mode: 'RESPOND', content: 'Hello' } },
        stopReason: 'done',
      },
    })

    await waitForHandlers()

    const episodic = await workspace.searchMemory({
      type: 'episodic',
      tags: [`thread:${thread.id}`],
      excludeInvalid: true,
    })
    expect(episodic.length).toBeGreaterThan(0)
    expect(episodic[0]?.segmentId).toBeTruthy()
    expect(episodic[0]?.segmentSeq).toBe(0)
    expect(episodic[0]?.tags).toContain('brain_complete')
  })

  test('brain.complete with injectedMemoryIds → markMemoryUsed increments positive count', async () => {
    const { workspace, eventBus, waitForHandlers } = ctx

    const thread = await workspace.createThread({ initiatedBy: 'integration-test-T034b' })

    // Write a semantic memory to be injected
    const memory = await workspace.writeMemory({
      type: 'semantic',
      content: 'test knowledge for injection',
      baseImportance: 0.5,
      tags: ['test'],
    })

    eventBus.emit({
      event_type: 'brain.complete',
      level: 'INFO',
      brain: 'limbic',
      thread_id: thread.id,
      payload: {
        injectedMemoryIds: [memory.id],
        outputSlot: { status: 'done', output: { mode: 'RESPOND', content: 'Answer' } },
        stopReason: 'done',
      },
    })

    await waitForHandlers()

    // Verify usage_outcomes.positive incremented
    const updated = await workspace.searchMemory({
      type: 'semantic',
      tags: ['test'],
      excludeInvalid: true,
    })
    const updatedMemory = updated.find((m) => m.id === memory.id)
    expect(updatedMemory?.usageOutcomes.positive).toBeGreaterThanOrEqual(1)
  })
})

// ─── T035: Consolidation smoke test (requires ANTHROPIC_API_KEY) ──────────────

const describeWithApiKey = process.env.ANTHROPIC_API_KEY
  ? describeWithDb
  : (name: string, _fn: () => void) => {
      console.log(`⏭  Skipping smoke test: "${name}" (ANTHROPIC_API_KEY not set)`)
    }

describeWithApiKey('DMN Consolidation smoke test (T035)', () => {
  test(
    'runConsolidationNow() completes without DB errors',
    async () => {
      const { db, client } = createTestDb()
      const workspace = new CognitiveWorkspace(db)
      const eventBus = new BrainEventBus()

      const dmnService = new DmnService({
        workspace,
        eventBus,
        llm: {
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: 'claude-haiku-4-5-20251001',
        },
        consolidationIntervalMs: 999_999,
      })

      try {
        // Write some episodic memory as input
        for (let i = 0; i < 3; i++) {
          await workspace.writeMemory({
            type: 'episodic',
            content: `test event ${i}: user asked about the weather`,
            baseImportance: 0.5,
            tags: ['test', 'smoke'],
          })
        }

        // Trigger one consolidation cycle
        await dmnService.runConsolidationNow()

        // Does not need to verify LLM output specifics — just that it ran without error
        expect(true).toBe(true)
      } finally {
        await dmnService.stop()
        await (client as { end: () => Promise<void> }).end()
      }
    },
    { timeout: 60_000 },
  )
})
