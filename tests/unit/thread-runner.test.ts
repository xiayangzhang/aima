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
