import { describe, expect, test } from 'bun:test'
import type { BrainAdapter } from '../../src/adapters/index'
import type { ContextAssemblerConfig } from '../../src/context/index'
import { BrainEventBus } from '../../src/eventbus/index'
import { ThreadRunner } from '../../src/runner/index'
import type { BrainOutput, CognitiveBrainType, Slot, Thread } from '../../src/types/index'
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
    entityId: null,
    goal: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeSlot(brain: CognitiveBrainType, output: BrainOutput | Record<string, unknown>): Slot {
  return {
    id: `slot-${brain}`,
    threadId: 'thread-1',
    brain,
    status: 'done',
    input: null,
    output,
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
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => [] // prevent DB calls from assembleBlock4
    workspace.readSlot = async () => null
  }

  test('limbic reply + null next → complete + thread.reply event emitted', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    const emitted: string[] = []

    eventBus.subscribe((evt) => {
      emitted.push(evt.event_type)
    })

    patchWorkspace(workspace, thread, [makeSlot('limbic', { reply: 'Hello' })])

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'limbic', 'done')
    await new Promise((r) => setTimeout(r, 20))

    expect(thread.state).toBe('complete')
    expect(emitted).toContain('thread.reply')
    runner.stop()
  })

  test('limbic no next → complete (no reply event)', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    const emitted: string[] = []

    eventBus.subscribe((evt) => {
      emitted.push(evt.event_type)
    })

    patchWorkspace(workspace, thread, [makeSlot('limbic', {})])

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'limbic', 'done')
    await new Promise((r) => setTimeout(r, 20))

    expect(thread.state).toBe('complete')
    expect(emitted).not.toContain('thread.reply')
    runner.stop()
  })

  test('limbic next: cortex → cortex adapter called', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let cortexCalled = false

    patchWorkspace(workspace, thread, [makeSlot('limbic', { next: 'cortex' })])
    workspace.getSlotsByThread = async () => {
      if (cortexCalled) return []
      return [makeSlot('limbic', { next: 'cortex' })]
    }

    const cortexAdapter: BrainAdapter = {
      run: async () => {
        cortexCalled = true
        thread.state = 'complete'
        return {
          sessionId: 'sess-c',
          output: { next: 'limbic' },
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

  test('cortex next: brainstem → brainstem adapter called', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let brainstemCalled = false

    patchWorkspace(workspace, thread, [makeSlot('cortex', { next: 'brainstem' })])

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
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []
    workspace.readSlot = async () => null
  }

  // T049: cortex next: limbic → limbic activated
  test('cortex next: limbic → limbic adapter called', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let limbicCalled = false

    patchWorkspace(workspace, thread, () => [makeSlot('cortex', { next: 'limbic' })])

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

  // T050: Cortex next: brainstem → Brainstem activated; Brainstem next: limbic → Limbic activated
  test('cortex next: brainstem → brainstem called; brainstem next: limbic → limbic called', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let brainstemCalled = false
    let limbicCalled = false

    // Initial state: cortex done with next=brainstem
    const slots: Slot[] = [makeSlot('cortex', { next: 'brainstem' })]

    patchWorkspace(workspace, thread, () => [...slots])

    const brainstemAdapter: BrainAdapter = {
      run: async () => {
        brainstemCalled = true
        // After brainstem runs, add its slot
        slots.push(makeSlot('brainstem', { next: 'limbic', handoff: 'task done' }))
        return {
          sessionId: 'sess-b',
          output: { next: 'limbic', handoff: 'task done' },
          stopReason: 'done',
          injectedMemoryIds: [],
        }
      },
      inject: async () => {},
      abort: () => {},
    }

    const limbicAdapter: BrainAdapter = {
      run: async () => {
        limbicCalled = true
        thread.state = 'complete'
        return { sessionId: 'sess-l', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    workspace.writeSlot = async (_tid, _brain, _data) => makeSlot('brainstem', {})

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([
      ['brainstem', brainstemAdapter],
      ['limbic', limbicAdapter],
    ])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'cortex', 'done')
    await new Promise((r) => setTimeout(r, 100))

    expect(brainstemCalled).toBe(true)
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

    workspace.createThread = async () => {
      createdThreads.push('pending-thread')
      return pendingThread
    }
    workspace.removePending = async () => {}
    workspace.getThread = async () => pendingThread
    workspace.getSlotsByThread = async () => []
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => [] // empty during recovery
    workspace.searchMemory = async () => []
    workspace.readSlot = async () => null
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

    // Set real pending items after recovery, before routePending call
    workspace.getPendingObservations = async () => [
      {
        id: 'obs-1',
        targetBrain: 'brainstem',
        note: 'test pending',
        threadId: null,
        triggerAt: new Date(Date.now() - 1000), // already due
        expiresAt: new Date(Date.now() + 60_000),
        addedAt: new Date(),
        baseImportance: 0.5,
      },
    ]
    await runner.routePending()

    expect(createdThreads).toHaveLength(1)
    expect(brainstemCalled).toBe(true)
    runner.stop()
  })

  // Fix 1: limbic DEFER → sets thread state to 'waiting' + stores threadId in pending
  test('limbic next: self → sets thread state to waiting and writes pending with threadId', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let writtenState: string | null = null
    let writtenPending: { threadId?: string } | null = null

    patchWorkspace(workspace, thread, () => [
      makeSlot('limbic', { next: 'self', timeout_ms: 5000 }),
    ])
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
      writtenState = state
    }
    workspace.writePending = async (params) => {
      writtenPending = params
      return {
        id: 'p1',
        targetBrain: 'limbic',
        note: '',
        threadId: params.threadId ?? null,
        triggerAt: new Date(),
        expiresAt: new Date(),
        baseImportance: 0.5,
        addedAt: new Date(),
      }
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'limbic', 'done')
    await new Promise((r) => setTimeout(r, 50))

    expect(writtenState).toBe('waiting')
    expect(writtenPending?.threadId).toBe('thread-1')
    runner.stop()
  })

  // Fix 1: crash recovery interrupts waiting threads with no pending (not re-activates)
  test('crash recovery does not re-activate waiting threads', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const waitingThread = makeThread({ id: 'thread-1', state: 'waiting' })
    let limbicActivated = false

    // getActiveThreads returns only 'active' threads — waiting thread excluded
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => [waitingThread]
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => [] // no live pending → thread is stuck
    workspace.updateThreadState = async (_id, state) => { waitingThread.state = state }
    workspace.getThread = async () => waitingThread
    workspace.getSlotsByThread = async () => []
    workspace.searchMemory = async () => []

    const limbicAdapter: BrainAdapter = {
      run: async () => {
        limbicActivated = true
        return { sessionId: 'sess', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['limbic', limbicAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    // Give recovery time to run
    await new Promise((r) => setTimeout(r, 30))
    expect(limbicActivated).toBe(false)
    runner.stop()
  })

  // Fix 1: routePending with threadId resumes original thread instead of creating new one
  test('routePending() resumes original thread when pending has threadId', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const originalThread = makeThread({ id: 'original-thread', state: 'waiting' })
    const newThreads: string[] = []
    let activatedOnThread: string | null = null

    workspace.createThread = async () => {
      newThreads.push('created')
      return makeThread({ id: 'new-thread' })
    }
    workspace.removePending = async () => {}
    workspace.getThread = async (id) => (id === 'original-thread' ? originalThread : null)
    workspace.getSlotsByThread = async () => []
    workspace.getActiveThreads = async () => []
    // During recovery, originalThread has live pending → leave it alone
    workspace.getWaitingThreads = async () => [originalThread]
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => [
      {
        id: 'obs-defer',
        targetBrain: 'limbic',
        note: 'DEFER timeout',
        threadId: 'original-thread',
        triggerAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 60_000),
        addedAt: new Date(),
        baseImportance: 0.5,
      },
    ]
    workspace.searchMemory = async () => []
    workspace.readSlot = async () => null
    workspace.updateThreadState = async (id, state) => {
      if (id === 'original-thread') originalThread.state = state
    }

    const limbicAdapter: BrainAdapter = {
      run: async (params) => {
        activatedOnThread = params.threadId
        originalThread.state = 'complete'
        return { sessionId: 'sess', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['limbic', limbicAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    await runner.routePending()

    // No new thread created; activated on original thread
    expect(newThreads).toHaveLength(0)
    expect(activatedOnThread).toBe('original-thread')
    // Original thread state was set back to active before activation
    expect(originalThread.state).toBe('complete') // adapter completed it
    runner.stop()
  })

  // T011: isLegalTransition — cortex next: self → interrupted
  test('cortex next: self → thread enters interrupted state', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    const emitted: string[] = []

    eventBus.subscribe((evt) => {
      emitted.push(evt.event_type)
    })

    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => [makeSlot('cortex', { next: 'self' })]
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'cortex', 'done')
    await new Promise((r) => setTimeout(r, 50))

    expect(thread.state).toBe('interrupted')
    expect(emitted).toContain('thread.interrupted')
    runner.stop()
  })

  // T011: isLegalTransition — cortex next: cortex → interrupted (self-loop illegal)
  test('cortex next: cortex → thread enters interrupted state', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()

    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => [makeSlot('cortex', { next: 'cortex' })]
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'cortex', 'done')
    await new Promise((r) => setTimeout(r, 50))

    expect(thread.state).toBe('interrupted')
    runner.stop()
  })

  // T010: handoff passing — brainstem next: limbic + handoff → writeSlot called for limbic
  test('handoff: brainstem next: limbic with handoff → writeSlot called for limbic input', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let writtenSlotBrain: string | null = null
    let writtenSlotData: unknown = null

    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => [
      makeSlot('brainstem', { next: 'limbic', handoff: 'task done' }),
    ]
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []
    workspace.readSlot = async () => null
    workspace.writeSlot = async (_tid, brain, data) => {
      writtenSlotBrain = brain
      writtenSlotData = data
      return makeSlot('limbic', {})
    }

    const limbicAdapter: BrainAdapter = {
      run: async () => {
        thread.state = 'complete'
        return { sessionId: 'sess-l', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['limbic', limbicAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'brainstem', 'done')
    await new Promise((r) => setTimeout(r, 50))

    expect(writtenSlotBrain).toBe('limbic')
    expect(writtenSlotData).toEqual({ input: { handoff: 'task done' } })
    runner.stop()
  })

  // T009: thread.reply event payload
  test('thread.reply event has correct payload', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    const replyEvents: Array<{ event_type: string; payload: unknown }> = []

    eventBus.subscribe((evt) => {
      if (evt.event_type === 'thread.reply') {
        replyEvents.push({ event_type: evt.event_type, payload: evt.payload })
      }
    })

    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => [makeSlot('limbic', { reply: 'Hello, World!' })]
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'limbic', 'done')
    await new Promise((r) => setTimeout(r, 20))

    expect(replyEvents).toHaveLength(1)
    expect(replyEvents[0]?.payload).toMatchObject({ reply: 'Hello, World!', threadId: 'thread-1' })
    runner.stop()
  })

  // ── Working memory cleanup tests ─────────────────────────────────────────────

  // Scenario A: clearWorkingMemory called on normal completion (next === null)
  test('clearWorkingMemory called when thread completes normally (next: null)', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let clearCalled = false
    let clearCalledWith: string | null = null

    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => [makeSlot('limbic', { next: null })]
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []
    workspace.clearWorkingMemory = async (threadId) => {
      clearCalled = true
      clearCalledWith = threadId
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'limbic', 'done')
    await new Promise((r) => setTimeout(r, 30))

    expect(clearCalled).toBe(true)
    expect(clearCalledWith).toBe('thread-1')
    runner.stop()
  })

  // Scenario B: clearWorkingMemory called on interrupted state (illegal transition)
  test('clearWorkingMemory called when thread is interrupted (illegal transition)', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let clearCalled = false

    workspace.getThread = async () => thread
    // cortex → self is illegal per legal transition table
    workspace.getSlotsByThread = async () => [makeSlot('cortex', { next: 'self' })]
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []
    workspace.clearWorkingMemory = async () => {
      clearCalled = true
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'cortex', 'done')
    await new Promise((r) => setTimeout(r, 30))

    expect(clearCalled).toBe(true)
    runner.stop()
  })

  // Scenario C: clearWorkingMemory NOT called on DEFER (limbic next: self)
  test('clearWorkingMemory NOT called on DEFER (limbic next: self)', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let clearCalled = false

    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => [makeSlot('limbic', { next: 'self' })]
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []
    workspace.writePending = async () => ({
      id: 'p1',
      targetBrain: 'limbic',
      threadId: 'thread-1',
      note: '',
      triggerAt: null,
      expiresAt: null,
      createdAt: new Date(),
    })
    workspace.clearWorkingMemory = async () => {
      clearCalled = true
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    workspace.notifySlotDone('thread-1', 'limbic', 'done')
    await new Promise((r) => setTimeout(r, 30))

    expect(clearCalled).toBe(false)
    runner.stop()
  })

  // Scenario D: cleanup failure is swallowed — no error propagates from route()
  test('clearWorkingMemory failure does not propagate on thread completion', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread()
    let notifyCalledAfterError = false

    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => [makeSlot('limbic', { next: null })]
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []
    workspace.clearWorkingMemory = async () => {
      throw new Error('db error')
    }
    workspace.notifyThreadComplete = (threadId) => {
      notifyCalledAfterError = true
      // Call the default implementation to fire subscribers
      CognitiveWorkspace.prototype.notifyThreadComplete.call(workspace, threadId)
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    // Should not throw
    workspace.notifySlotDone('thread-1', 'limbic', 'done')
    await new Promise((r) => setTimeout(r, 30))

    // notifyThreadComplete still fires even though clearWorkingMemory threw
    expect(notifyCalledAfterError).toBe(true)
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
    entityId: string | null = null,
  ) {
    const thread = { trigger, entityId }
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

  test('limbic + entityId present → { entityId } (entityId takes priority over trigger)', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'limbic', 'hello', null, 'user:alex')
    expect(result).toEqual({ entityId: 'user:alex' })
  })

  test('limbic + entityId null + trigger present → { situation: trigger }', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'limbic', 'user said hello', null, null)
    expect(result).toEqual({ situation: 'user said hello' })
  })

  test('limbic + entityId null + trigger null → undefined', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'limbic', null, null, null)
    expect(result).toBeUndefined()
  })

  test('cortex + entityId present → { situation: trigger } (cortex ignores entityId)', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'cortex', 'plan this task', null, 'user:alex')
    expect(result).toEqual({ situation: 'plan this task' })
  })

  test('cortex + trigger present + entityId null → { situation: trigger }', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'cortex', 'plan this task', null, null)
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
    const result = callBuildBlock4Opts(runner, 'brainstem', 'user trigger', { next: 'brainstem' })
    expect(result).toEqual({ taskType: 'user trigger' })
  })

  test('brainstem + no cortex slot and no trigger → undefined', () => {
    const runner = makeTestRunner()
    const result = callBuildBlock4Opts(runner, 'brainstem', null)
    expect(result).toBeUndefined()
  })
})

// ─── activateBrain triggerContent tests (T029-C, T029-D) ─────────────────────

describe('ThreadRunner.trigger() — initialPrompt wiring (T029)', () => {
  test('T029-C: trigger() passes thread.trigger as initialPrompt for new session', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread({ trigger: 'approve the budget' })

    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => []
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []
    workspace.readSlot = async () => null
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }

    let capturedParams: { initialPrompt?: string } | null = null
    const limbicAdapter: BrainAdapter = {
      run: async (params) => {
        capturedParams = params
        return { sessionId: 'sess-l', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['limbic', limbicAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    await runner.trigger('limbic', 'thread-1')

    expect(capturedParams?.initialPrompt).toBe('approve the budget')
    runner.stop()
  })

  test('T029-D: trigger() uses placeholder when thread.trigger is null', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const thread = makeThread({ trigger: null })

    workspace.getThread = async () => thread
    workspace.getSlotsByThread = async () => []
    workspace.getActiveThreads = async () => []
    workspace.getWaitingThreads = async () => []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () => []
    workspace.searchMemory = async () => []
    workspace.readSlot = async () => null
    workspace.updateThreadState = async (_id, state) => {
      thread.state = state
    }

    let capturedParams: { initialPrompt?: string } | null = null
    const limbicAdapter: BrainAdapter = {
      run: async (params) => {
        capturedParams = params
        return { sessionId: 'sess-l', output: {}, stopReason: 'done', injectedMemoryIds: [] }
      },
      inject: async () => {},
      abort: () => {},
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>([['limbic', limbicAdapter]])
    const runner = makeRunner(adapters, workspace, eventBus)
    await runner.start()

    await runner.trigger('limbic', 'thread-1')

    expect(capturedParams?.initialPrompt).toMatch(/^Thread thread-1 — activate limbic$/)
    runner.stop()
  })
})

// ─── GAP-2: recoverInFlightThreads — waiting thread handling ─────────────────

describe('recoverInFlightThreads — waiting threads', () => {
  function patchWorkspaceForRecovery(
    workspace: CognitiveWorkspace,
    opts: {
      activeThreads?: Thread[]
      waitingThreads?: Thread[]
      pendingObservations?: Array<{ id: string; threadId: string | null; triggerAt: Date | null; expiresAt: Date }>
    },
  ) {
    workspace.getActiveThreads = async () => opts.activeThreads ?? []
    workspace.getWaitingThreads = async () => opts.waitingThreads ?? []
    workspace.removeExpiredPending = async () => {}
    workspace.getPendingObservations = async () =>
      (opts.pendingObservations ?? []).map((p) => ({
        id: p.id,
        targetBrain: 'limbic' as const,
        note: 'test',
        threadId: p.threadId,
        triggerAt: p.triggerAt,
        expiresAt: p.expiresAt,
        baseImportance: 0.5,
        addedAt: new Date(),
      }))
    workspace.updateThreadState = async (_id, state) => {
      const t = (opts.waitingThreads ?? []).find((w) => w.id === _id)
      if (t) t.state = state
    }
    workspace.searchMemory = async () => []
  }

  test('waiting thread with live pending is left alone (routePending handles it)', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const waitingThread = makeThread({ id: 'wait-1', state: 'waiting' })
    const emitted: string[] = []
    eventBus.subscribe((e) => emitted.push(e.event_type))

    patchWorkspaceForRecovery(workspace, {
      waitingThreads: [waitingThread],
      pendingObservations: [
        { id: 'p-1', threadId: 'wait-1', triggerAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 120_000) },
      ],
    })

    const runner = makeRunner(new Map(), workspace, eventBus)
    await runner.start()

    // waiting thread with live pending should NOT be interrupted
    expect(waitingThread.state).toBe('waiting')
    expect(emitted).not.toContain('thread.interrupted')
    runner.stop()
  })

  test('waiting thread with no pending is interrupted on recovery', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const eventBus = new BrainEventBus()
    const waitingThread = makeThread({ id: 'wait-2', state: 'waiting' })
    const emitted: Array<{ type: string; threadId: string }> = []
    eventBus.subscribe((e) => emitted.push({ type: e.event_type, threadId: e.thread_id ?? '' }))

    patchWorkspaceForRecovery(workspace, {
      waitingThreads: [waitingThread],
      pendingObservations: [], // no live pending
    })

    const runner = makeRunner(new Map(), workspace, eventBus)
    await runner.start()

    expect(waitingThread.state).toBe('interrupted')
    expect(emitted.some((e) => e.type === 'thread.interrupted' && e.threadId === 'wait-2')).toBe(true)
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
