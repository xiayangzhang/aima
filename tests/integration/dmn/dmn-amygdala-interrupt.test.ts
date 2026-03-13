import { afterAll, beforeAll, expect, test } from 'vitest'
import type { MemoryEntry } from '../../../src/types/index'
import { describeWithDb } from '../helpers/skip'
import { createDmnContext, teardownDmnContext } from './helpers'
import type { IntegrationDmnContext } from './helpers'

// ─── Feature 023: amygdala.interrupt → DMN episodic write (integration) ───────

describeWithDb('DMN integration — amygdala interrupt episodic encoding (F023)', () => {
  let ctx: IntegrationDmnContext

  beforeAll(async () => {
    ctx = await createDmnContext()
  })

  afterAll(async () => {
    await teardownDmnContext(ctx)
  })

  /**
   * Poll the DB until a memory with the given tags appears (created after `after`),
   * or return undefined after a timeout. More robust than a fixed wait under parallel load.
   */
  async function pollForMemory(
    workspace: IntegrationDmnContext['workspace'],
    tags: string[],
    after: Date,
    maxMs = 3000,
  ): Promise<MemoryEntry | undefined> {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      const mems = await workspace.searchMemory({ type: 'episodic', tags, createdAfter: after })
      const match = mems.find((m) => tags.every((t) => m.tags.includes(t)))
      if (match) return match
      await new Promise((r) => setTimeout(r, 100))
    }
    return undefined
  }

  test('amygdala.interrupt ALERT with significance_boost=0.4 → episodic written to DB', async () => {
    const { workspace, eventBus } = ctx

    await workspace.createThread({ initiatedBy: 'integ-f023-block' })
    const before = new Date(Date.now() - 5)

    eventBus.emit({
      event_type: 'amygdala.interrupt',
      level: 'ALERT',
      brain: 'amygdala',
      payload: {
        tool: 'bash',
        decision: 'block',
        reason: 'blocked by default policy',
        significance_boost: 0.4,
      },
    })

    const episodic = await pollForMemory(workspace, ['amygdala_interrupt'], before)

    expect(episodic).toBeDefined()
    expect(episodic?.baseImportance).toBeCloseTo(0.9, 5) // Math.min(1.0, 0.5 + 0.4)
    expect(episodic?.sourceBrain).toBe('amygdala')

    const parsed = JSON.parse(episodic?.content ?? '{}') as Record<string, unknown>
    expect(parsed.decision).toBe('block')
    expect(parsed.tool).toBe('bash')
  })

  test('amygdala.interrupt ALERT with boost → significance_mark also written to DB', async () => {
    const { workspace, eventBus } = ctx

    await workspace.createThread({ initiatedBy: 'integ-f023-sigmark' })
    const before = new Date(Date.now() - 5)

    eventBus.emit({
      event_type: 'amygdala.interrupt',
      level: 'ALERT',
      brain: 'amygdala',
      payload: {
        tool: 'file_delete',
        decision: 'block',
        reason: 'blocked by default policy',
        significance_boost: 0.4,
      },
    })

    const sigMark = await pollForMemory(workspace, ['significance_mark', 'amygdala'], before)

    expect(sigMark).toBeDefined()
    expect(sigMark?.baseImportance).toBeCloseTo(1.0, 5) // Math.min(1.0, 0.7 + 0.4)

    const parsed = JSON.parse(sigMark?.content ?? '{}') as Record<string, unknown>
    expect(parsed.event_type).toBe('significance_mark')
    expect(parsed.trigger).toBe('amygdala')
    expect(parsed.boost).toBe(0.4)
  })

  test('amygdala.interrupt ALERT with no boost → baseImportance=0.5, no significance_mark', async () => {
    const { workspace, eventBus, waitForHandlers } = ctx

    await workspace.createThread({ initiatedBy: 'integ-f023-noboost' })
    const before = new Date(Date.now() - 5)

    eventBus.emit({
      event_type: 'amygdala.interrupt',
      level: 'ALERT',
      brain: 'amygdala',
      payload: {
        tool: 'bash',
        decision: 'block',
        reason: 'blocked by default policy',
        // no significance_boost
      },
    })

    // Wait for handler to settle before asserting absence of significance_mark
    const episodic = await pollForMemory(workspace, ['amygdala_interrupt'], before)

    expect(episodic).toBeDefined()
    expect(episodic?.baseImportance).toBeCloseTo(0.5, 5)

    // Give a moment for any unexpected significance_mark writes to appear
    await waitForHandlers()

    const sigMarks = await workspace.searchMemory({
      type: 'episodic',
      tags: ['significance_mark'],
      createdAfter: before,
    })
    expect(sigMarks.find((m) => m.tags.includes('significance_mark'))).toBeUndefined()
  })
})
