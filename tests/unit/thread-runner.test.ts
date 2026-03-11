import { describe, expect, test } from 'bun:test'
import type { BrainAdapter } from '../../src/adapters/index'
import type { ContextAssemblerConfig } from '../../src/context/index'
import { BrainEventBus } from '../../src/eventbus/index'
import { ThreadRunner } from '../../src/runner/index'
import type { CognitiveBrainType, Slot, Thread } from '../../src/types/index'
import { CognitiveWorkspace } from '../../src/workspace/index'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

const config: ContextAssemblerConfig = {
  identities: {
    limbic: { role: 'Limbic', instructions: 'Manage emotion.' },
    cortex: { role: 'Cortex', instructions: 'Plan.' },
    brainstem: { role: 'Brainstem', instructions: 'Execute.' },
  },
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    state: 'active',
    sourceChannel: null,
    initiatedBy: 'test',
    trigger: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeSlot(brain: CognitiveBrainType, output: Record<string, unknown>): Slot {
  return {
    id: `slot-${brain}`,
    threadId: 'thread-1',
    brain,
    status: 'done',
    input: null,
    output,
    intent: null,
    complexityHint: null,
    executionSessionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeRunner(
  adapters: Map<CognitiveBrainType, BrainAdapter>,
  workspace: CognitiveWorkspace,
  eventBus: BrainEventBus,
) {
  return new ThreadRunner({ workspace, eventBus, adapters, assemblerConfig: config })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ThreadRunner routing', () => {
  function patchWorkspace(workspace: CognitiveWorkspace, thread: Thread, slots: Slot[]) {
    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => slots
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.searchMemory = async () => [] // prevent DB calls from assembleBlock4
  }

  test('limbic RESPOND → complete', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    patchWorkspace(workspace, thread, [makeSlot('limbic', { mode: 'RESPOND' })])

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'limbic', 'done')
    await new Promise((r) => setTimeout(r, 20))

    expect(thread.state).toBe('complete')
    runner.stop()
  })

  test('limbic ROUTE → cortex adapter called', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let cortexCalled = false

    patchWorkspace(workspace, thread, [makeSlot('limbic', { mode: 'ROUTE' })])
    workspace.getSlotsByThread = async () => {
      if (cortexCalled) return []
      return [makeSlot('limbic', { mode: 'ROUTE' })]
    }

    const cortexAdapter: BrainAdapter = {
      run: async () => {
        cortexCalled = true
        thread.state = 'complete'
        return {
          sessionId: 'sess-c',
          output: { intent: 'communicate' },
          stopReason: 'done',
          injectedMemoryIds: [],
        }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['cortex', cortexAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'limbic', 'done')
    await new Promise((r) => setTimeout(r, 50))

    expect(cortexCalled).toBe(true)
    runner.stop()
  })

  test('cortex execute → brainstem adapter called', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let brainstemCalled = false

    patchWorkspace(workspace, thread, [makeSlot('cortex', { intent: 'execute' })])

    const brainstemAdapter: BrainAdapter = {
      run: async () => {
        brainstemCalled = true
        thread.state = 'complete'
        return { sessionId: 'sess-b', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['brainstem', brainstemAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'cortex', 'done')
    await new Promise((r) => setTimeout(r, 50))

    expect(brainstemCalled).toBe(true)
    runner.stop()
  })
})

describe('ThreadRunner routing — extended', () => {
  function patchWorkspace(workspace: CognitiveWorkspace, thread: Thread, getSlots: () => Slot[]) {
    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => getSlots()
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.searchMemory = async () => []
  }

  // T049: cortex communicate → limbic activated
  test('cortex communicate → limbic adapter called', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let limbicCalled = false

    patchWorkspace(workspace, thread, () => [makeSlot('cortex', { intent: 'communicate' })])

    const limbicAdapter: BrainAdapter = {
      run: async () => {
        limbicCalled = true
        thread.state = 'complete'
        return { sessionId: 'sess-l', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['limbic', limbicAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'cortex', 'done')
    await new Promise((r) => setTimeout(r, 50))

    expect(limbicCalled).toBe(true)
    runner.stop()
  })

  // T050: Cortex intent=both → Limbic activated first
  test('cortex intent=both → limbic adapter called', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let limbicCalled = false

    patchWorkspace(workspace, thread, () => [makeSlot('cortex', { intent: 'both' })])

    const limbicAdapter: BrainAdapter = {
      run: async () => {
        limbicCalled = true
        thread.state = 'complete'
        return { sessionId: 'sess-l', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['limbic', limbicAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'cortex', 'done')
    await new Promise((r) => setTimeout(r, 50))

    expect(limbicCalled).toBe(true)
    runner.stop()
  })

  // T051: ThreadRunner pending routing
  test('routePending() activates target brain for due items', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()

    const createdThreads: string[] = []
    let brainstemCalled = false
    const pendingThread = makeThread({ id: 'pending-thread' })

    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => [
      {
        id: 'obs-1',
        targetBrain: 'brainstem',
        note: 'test pending',
        triggerAt: new Date(Date.now() - 1000), // already due
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      },
    ]
    workspace.createThread = async () => {
      createdThreads.push('pending-thread')
      return pendingThread
    }
    workspace.removePending = async () => {}
    workspace.getThread = async () => pendingThread
    workspace.getSlotsByThread = async () => []
    workspace.getActiveThreads = async () => []
    workspace.searchMemory = async () => []
    workspace.updateThreadState = async (_id, state) => {
      pendingThread.state = state
    }

    const brainstemAdapter: BrainAdapter = {
      run: async () => {
        brainstemCalled = true
        return { sessionId: 'sess', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['brainstem', brainstemAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    await runner.routePending()

    expect(createdThreads).toHaveLength(1)
    expect(brainstemCalled).toBe(true)
    runner.stop()
  })
})

// ─── buildBlock4Opts unit tests ───────────────────────────────────────────────

describe('ThreadRunner.buildBlock4Opts', () => {
  // Access private method for unit testing
  function callBuildBlock4Opts(
    runner: ThreadRunner,
    brain: CognitiveBrainType,
    trigger: string | null,
    cortexOutput: Record<string, unknown> | null = null,
  ) {
    const thread = { trigger }
    const slotMap: Record<string, { output: unknown } | undefined> =
      cortexOutput !== null ? { cortex: { output: cortexOutput } } : {}
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit testing
    return (runner as unknown as Record<string, any>).buildBlock4Opts(brain, thread, slotMap)
  }

  function makeTestRunner() {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    return makeRunner(adapters, workspace, eventBus)
  }

  test('limbic + trigger present → { situation: trigger }', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'limbic', 'user said hello')
    expect(result).toEqual({ situation: 'user said hello' })
  })

  test('limbic + trigger null → undefined', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'limbic', null)
    expect(result).toBeUndefined()
  })

  test('cortex + trigger present → { situation: trigger }', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'cortex', 'plan this task')
    expect(result).toEqual({ situation: 'plan this task' })
  })

  test('cortex + trigger null → undefined', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'cortex', null)
    expect(result).toBeUndefined()
  })

  test('brainstem + cortex slot has task_type → { taskType: cortex task_type } (ignores trigger)', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'brainstem', 'user trigger', {
      task_type: 'document_prep',
    })
    expect(result).toEqual({ taskType: 'document_prep' })
  })

  test('brainstem + cortex slot has no task_type → fallback to trigger', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'brainstem', 'user trigger', { intent: 'execute' })
    expect(result).toEqual({ taskType: 'user trigger' })
  })

  test('brainstem + no cortex slot and no trigger → undefined', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'brainstem', null)
    expect(result).toBeUndefined()
  })
})

describe('CognitiveWorkspace.waitForComplete', () => {
  test('resolves when thread_complete event fires', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    workspace.getThread = async () => makeThread({ state: 'active' })

    let resolved = false
    workspace.waitForComplete('thread-1').then(() => {
      resolved = true
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    workspace.notifyThreadComplete('thread-1')
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(true)
  })

  test('resolves immediately if thread already complete', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    workspace.getThread = async () => makeThread({ state: 'complete' })

    let resolved = false
    await workspace.waitForComplete('thread-1')
    resolved = true
    expect(resolved).toBe(true)
  })
})
