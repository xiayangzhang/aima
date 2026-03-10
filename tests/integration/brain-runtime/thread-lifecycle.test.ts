import { afterEach, beforeEach, expect, test } from 'vitest'
import type { BrainAdapter } from '../../../src/adapters/index'
import type { ContextAssemblerConfig } from '../../../src/context/index'
import { BrainEventBus } from '../../../src/eventbus/index'
import { ThreadRunner } from '../../../src/runner/index'
import type { CognitiveBrainType } from '../../../src/types/index'
import type { CognitiveWorkspace } from '../../../src/workspace/index'
import { createTestDb } from '../helpers/db'
import { MockBrainAdapter } from '../helpers/mock-brain-adapter'
import { describeWithDb as skipIfNoDb } from '../helpers/skip'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const assemblerConfig: ContextAssemblerConfig = {
  identities: {
    limbic: { role: 'Limbic', instructions: 'Route intent.' },
    cortex: { role: 'Cortex', instructions: 'Plan.' },
    brainstem: { role: 'Brainstem', instructions: 'Execute.' },
  },
}

// ─── T053: Limbic RESPOND path ────────────────────────────────────────────────

skipIfNoDb('Thread lifecycle (integration)', () => {
  let workspace: CognitiveWorkspace
  let pgClient: { end: () => Promise<void> }
  let runner: ThreadRunner

  beforeEach(async () => {
    const { db, client } = createTestDb()
    pgClient = client as { end: () => Promise<void> }
    const { CognitiveWorkspace } = await import('../../../src/workspace/index')
    workspace = new CognitiveWorkspace(db)
  })

  afterEach(async () => {
    runner?.stop()
    await pgClient.end()
  })

  // T053: Limbic RESPOND → Thread complete
  test('Limbic RESPOND path completes thread', async () => {
    const eventBus = new BrainEventBus()

    const limbicAdapter = new MockBrainAdapter(workspace, (_params, _count) => ({
      status: 'done',
      output: { mode: 'RESPOND', content: 'Hello from mock Limbic' },
    }))

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['limbic', limbicAdapter]])
    runner = new ThreadRunner({ workspace, eventBus, adapters, assemblerConfig })
    await runner.start()

    const thread = await workspace.createThread({ initiatedBy: 'integration-test' })
    const waitP = workspace.waitForComplete(thread.id)

    await runner.trigger('limbic', thread.id)
    await waitP

    const finalThread = await workspace.getThread(thread.id)
    expect(finalThread?.state).toBe('complete')

    const slot = await workspace.readSlot(thread.id, 'limbic')
    expect(slot?.status).toBe('done')
    expect((slot?.output as Record<string, unknown>)?.mode).toBe('RESPOND')
  })

  // T054: Limbic ROUTE → Cortex communicate → Limbic RESPOND
  test('Limbic ROUTE → Cortex → Limbic path completes thread', async () => {
    const eventBus = new BrainEventBus()
    let limbicCallCount = 0

    const limbicAdapter = new MockBrainAdapter(workspace, (_params, count) => {
      limbicCallCount = count
      if (count === 1) {
        return { status: 'done', output: { mode: 'ROUTE' } }
      }
      return { status: 'done', output: { mode: 'RESPOND', content: 'Final answer' } }
    })

    const cortexAdapter = new MockBrainAdapter(workspace, () => ({
      status: 'done',
      output: { intent: 'communicate' },
    }))

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([
      ['limbic', limbicAdapter],
      ['cortex', cortexAdapter],
    ])
    runner = new ThreadRunner({ workspace, eventBus, adapters, assemblerConfig })
    await runner.start()

    const thread = await workspace.createThread({ initiatedBy: 'integration-test' })
    const waitP = workspace.waitForComplete(thread.id)

    await runner.trigger('limbic', thread.id)
    await waitP

    const finalThread = await workspace.getThread(thread.id)
    expect(finalThread?.state).toBe('complete')
    expect(limbicCallCount).toBeGreaterThanOrEqual(2)

    const cortexSlot = await workspace.readSlot(thread.id, 'cortex')
    expect(cortexSlot?.status).toBe('done')
  })

  // T055: Crash recovery — ThreadRunner.start() re-activates in-flight Thread
  test('Crash recovery: start() re-activates thread with done limbic ROUTE slot', async () => {
    const eventBus = new BrainEventBus()
    let cortexCalled = false

    const cortexAdapter = new MockBrainAdapter(workspace, () => {
      cortexCalled = true
      return { status: 'done', output: { intent: 'communicate' } }
    })

    const limbicAdapter = new MockBrainAdapter(workspace, () => ({
      status: 'done',
      output: { mode: 'RESPOND', content: 'Recovery complete' },
    }))

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([
      ['limbic', limbicAdapter],
      ['cortex', cortexAdapter],
    ])

    // Simulate crash: create thread + write limbic ROUTE slot directly
    const thread = await workspace.createThread({ initiatedBy: 'crash-test' })
    await workspace.writeSlot(thread.id, 'limbic', {
      status: 'done',
      output: { mode: 'ROUTE' },
    })

    // Start runner — crash recovery should pick up the thread
    runner = new ThreadRunner({ workspace, eventBus, adapters, assemblerConfig })
    const waitP = workspace.waitForComplete(thread.id)
    await runner.start()
    await waitP

    expect(cortexCalled).toBe(true)
    const finalThread = await workspace.getThread(thread.id)
    expect(finalThread?.state).toBe('complete')
  })
})

// ─── T056: E2E smoke test (skipped without API key) ─────────────────────────

const describeE2E = process.env.ANTHROPIC_API_KEY
  ? skipIfNoDb
  : (_name: string, _fn: () => void) => {}

describeE2E('E2E smoke test (requires ANTHROPIC_API_KEY + DB)', () => {
  test(
    'AIMAInstance.receive() completes with real LLM',
    async () => {
      const { createAIMAInstance } = await import('../../../src/instance')
      const dbUrl = process.env.AIMA_TEST_DATABASE_URL ?? ''
      const instance = await createAIMAInstance({
        databaseUrl: dbUrl,
        adapter: 'claude-sdk',
        apiKey: process.env.ANTHROPIC_API_KEY,
      })

      try {
        const { threadId } = await instance.receive({
          content: 'Respond with exactly: AIMA_TEST_OK',
          channel: 'e2e-test',
        })
        expect(threadId).toBeTruthy()
      } finally {
        await instance.stop()
      }
    },
    { timeout: 60_000 },
  )
})
