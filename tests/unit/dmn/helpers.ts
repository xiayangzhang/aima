import { mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { BrainEvent } from '../../../src/adapters/index'
import type { DmnConfig } from '../../../src/dmn/index'
import type {
  BrainType,
  CreateMemoryParams,
  CreatePendingParams,
  MemoryEntry,
  PendingObservation,
  Slot,
  Thread,
  ThreadState,
  UsageOutcome,
  WriteSlotParams,
} from '../../../src/types/index'

// ─── Mock Workspace ───────────────────────────────────────────────────────────

export function makeMockWorkspace() {
  const _memories: MemoryEntry[] = []
  const _pending: PendingObservation[] = []
  const _signals: Array<{ type: string; message: string }> = []
  const _threads: Thread[] = []
  const _slots: Map<string, Slot> = new Map()

  function makeMemoryEntry(params: CreateMemoryParams): MemoryEntry {
    return {
      id: randomUUID(),
      type: params.type,
      content: params.content,
      entityId: params.entityId ?? null,
      segmentId: params.segmentId ?? null,
      segmentSeq: params.segmentSeq ?? null,
      tags: params.tags ?? [],
      baseImportance: params.baseImportance ?? 0.5,
      usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
      sourceBrain: params.sourceBrain ?? null,
      threadId: params.threadId ?? null,
      sessionId: params.sessionId ?? null,
      supersedesId: params.supersedesId ?? null,
      tInvalid: null,
      lastAccessedAt: null,
      pinned: params.pinned ?? false,
      forgotten: false,
      expiresAt: params.expiresAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  const ws = {
    _memories,
    _pending,
    _signals,
    _threads,
    _slots,

    writeMemory: mock(async (params: CreateMemoryParams): Promise<MemoryEntry> => {
      const entry = makeMemoryEntry(params)
      _memories.push(entry)
      return entry
    }),

    searchMemory: mock(
      async (filters: {
        type?: string
        tags?: string[]
        excludeInvalid?: boolean
        limit?: number
        createdAfter?: Date
      }) => {
        let results = [..._memories]

        if (filters.type !== undefined) {
          results = results.filter((m) => m.type === filters.type)
        }
        if (filters.tags && filters.tags.length > 0) {
          results = results.filter((m) => filters.tags?.every((t) => m.tags.includes(t)))
        }
        if (filters.excludeInvalid !== false) {
          results = results.filter((m) => m.tInvalid === null)
        }
        if (filters.createdAfter !== undefined) {
          const after = filters.createdAfter
          results = results.filter((m) => m.createdAt > after)
        }
        if (filters.limit !== undefined) {
          results = results.slice(0, filters.limit)
        }
        return results
      },
    ),

    markMemoryUsed: mock(async (ids: string[], outcome: UsageOutcome): Promise<void> => {
      for (const id of ids) {
        const entry = _memories.find((m) => m.id === id)
        if (entry) {
          entry.usageOutcomes[outcome]++
          entry.lastAccessedAt = new Date()
        }
      }
    }),

    invalidateMemory: mock(async (id: string): Promise<void> => {
      const entry = _memories.find((m) => m.id === id)
      if (entry) {
        entry.tInvalid = new Date()
      }
    }),

    clearWorkingMemory: mock(async (_threadId: string): Promise<void> => {}),

    writePending: mock(async (params: CreatePendingParams): Promise<PendingObservation> => {
      const item: PendingObservation = {
        id: randomUUID(),
        targetBrain: params.targetBrain,
        note: params.note,
        threadId: params.threadId ?? null,
        triggerAt: params.triggerAt ?? null,
        expiresAt: params.expiresAt,
        baseImportance: params.baseImportance ?? 0.5,
        addedAt: new Date(),
      }
      _pending.push(item)
      return item
    }),

    getPendingObservations: mock(async (): Promise<PendingObservation[]> => [..._pending]),

    removePending: mock(async (id: string): Promise<void> => {
      const idx = _pending.findIndex((p) => p.id === id)
      if (idx !== -1) _pending.splice(idx, 1)
    }),

    removeExpiredPending: mock(async (_now: Date): Promise<void> => {}),

    pushSignal: mock((signal: { type: string; message: string }): void => {
      _signals.push(signal)
    }),

    createThread: mock(
      async (params: {
        initiatedBy: string
        trigger?: string
        sourceChannel?: string | null
      }): Promise<Thread> => {
        const thread: Thread = {
          id: randomUUID(),
          state: 'active',
          sourceChannel: params.sourceChannel ?? null,
          initiatedBy: params.initiatedBy,
          trigger: params.trigger ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        _threads.push(thread)
        return thread
      },
    ),

    getThread: mock(async (id: string): Promise<Thread | null> => {
      return _threads.find((t) => t.id === id) ?? null
    }),

    updateThreadState: mock(async (id: string, state: ThreadState): Promise<void> => {
      const thread = _threads.find((t) => t.id === id)
      if (thread) thread.state = state
    }),

    getActiveThreads: mock(async (): Promise<Thread[]> => {
      return _threads.filter((t) => t.state === 'active')
    }),

    getLatestSegmentStates: mock(async (): Promise<Map<string, { segmentId: string; nextSeq: number }>> => {
      return new Map()
    }),

    writeSlot: mock(
      async (threadId: string, brain: BrainType, data: WriteSlotParams): Promise<Slot> => {
        const key = `${threadId}:${brain}`
        const slot: Slot = {
          id: randomUUID(),
          threadId,
          brain,
          status: data.status ?? 'pending',
          input: data.input ?? null,
          output: data.output ?? null,
          intent: data.intent ?? null,
          complexityHint: data.complexityHint ?? null,
          executionSessionId: data.executionSessionId ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        _slots.set(key, slot)
        return slot
      },
    ),

    readSlot: mock(async (threadId: string, brain: BrainType): Promise<Slot | null> => {
      return _slots.get(`${threadId}:${brain}`) ?? null
    }),

    getSlotsByThread: mock(async (threadId: string): Promise<Slot[]> => {
      return [..._slots.values()].filter((s) => s.threadId === threadId)
    }),
  }

  return ws
}

// ─── Mock EventBus ────────────────────────────────────────────────────────────

export function makeMockEventBus() {
  const _emitted: BrainEvent[] = []
  const _subscribers: Array<(event: BrainEvent) => void> = []

  const bus = {
    _emitted,
    _subscribers,

    subscribe: mock((handler: (event: BrainEvent) => void): (() => void) => {
      _subscribers.push(handler)
      return () => {
        const idx = _subscribers.indexOf(handler)
        if (idx !== -1) _subscribers.splice(idx, 1)
      }
    }),

    emit: mock(
      (
        event: Omit<
          BrainEvent,
          'event_id' | 'occurred_at' | 'schema_version' | 'session_id' | 'causation_id'
        >,
      ): BrainEvent => {
        const full: BrainEvent = {
          event_id: randomUUID(),
          occurred_at: new Date(),
          schema_version: '1.0',
          session_id: null,
          causation_id: null,
          thread_id: null,
          ...event,
        }
        _emitted.push(full)
        return full
      },
    ),

    // Helper: dispatch an event to all subscribers and wait for in-flight handlers
    _trigger: async (event: Partial<BrainEvent> & { event_type: string }) => {
      const full: BrainEvent = {
        event_id: randomUUID(),
        occurred_at: new Date(),
        schema_version: '1.0',
        session_id: null,
        causation_id: null,
        thread_id: null,
        level: 'INFO',
        brain: 'cortex',
        payload: {},
        ...(event as BrainEvent),
      }
      for (const sub of [..._subscribers]) {
        sub(full)
      }
      // Yield to let fire-and-forget promises settle
      await new Promise<void>((r) => setTimeout(r, 20))
    },
  }

  return bus
}

// ─── Mock LLM ─────────────────────────────────────────────────────────────────

export function mockCallLlm(returnValue: string) {
  return mock(async (_prompt: string) => returnValue)
}

// ─── Config builder ───────────────────────────────────────────────────────────

export function makeDmnConfig(overrides: Partial<DmnConfig> = {}): {
  config: DmnConfig
  ws: ReturnType<typeof makeMockWorkspace>
  bus: ReturnType<typeof makeMockEventBus>
} {
  const ws = makeMockWorkspace()
  const bus = makeMockEventBus()
  return {
    config: {
      workspace: ws as unknown as DmnConfig['workspace'],
      eventBus: bus as unknown as DmnConfig['eventBus'],
      llm: { apiKey: 'test-key' },
      consolidationIntervalMs: 100,
      ...overrides,
    } as DmnConfig,
    ws,
    bus,
  }
}

// ─── Shared event factories ───────────────────────────────────────────────────

export function makeBrainCompleteEvent(
  threadId: string,
  brain: BrainType = 'cortex',
  payload: Record<string, unknown> = {},
): BrainEvent {
  return {
    event_id: randomUUID(),
    event_type: 'brain.complete',
    level: 'INFO',
    occurred_at: new Date(),
    brain,
    thread_id: threadId,
    session_id: null,
    causation_id: null,
    schema_version: '1.0',
    payload: {
      outputSlot: { status: 'done', output: { mode: 'RESPOND' } },
      stopReason: 'done',
      injectedMemoryIds: [],
      ...payload,
    },
  }
}

export function makeAlertEvent(
  threadId: string,
  brain: BrainType,
  retryable: boolean,
  extra: Record<string, unknown> = {},
): BrainEvent {
  return {
    event_id: randomUUID(),
    event_type: 'brain.error',
    level: 'ALERT',
    occurred_at: new Date(),
    brain,
    thread_id: threadId,
    session_id: null,
    causation_id: null,
    schema_version: '1.0',
    payload: { retryable, errorMessage: 'test error', ...extra },
  }
}
