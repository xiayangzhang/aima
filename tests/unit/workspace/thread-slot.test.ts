import { describe, expect, test } from 'bun:test'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import type { DrizzleDB } from '../../../src/workspace/index'

// ─── Mock Row Shapes ──────────────────────────────────────────────────────────

type ThreadRow = {
  id: string
  state: 'active' | 'waiting' | 'complete' | 'interrupted'
  sourceChannel: string | null
  initiatedBy: string
  trigger: string | null
  createdAt: Date
  updatedAt: Date
}

type SlotRow = {
  id: string
  threadId: string
  brain: string
  status: string
  input: unknown
  output: unknown
  intent: string | null
  complexityHint: string | null
  executionSessionId: string | null
  createdAt: Date
  updatedAt: Date
}

// ─── Mock DB Factory ──────────────────────────────────────────────────────────

interface MockDbConfig {
  insertResult?: ThreadRow | SlotRow
  insertUpsertResult?: SlotRow
  selectResult?: ThreadRow[]
  threadFindFirst?: ThreadRow | undefined
  slotFindFirst?: SlotRow | undefined
}

function makeMockDb(config: MockDbConfig = {}): DrizzleDB {
  const mock = {
    insert: () => ({
      values: () => ({
        returning: async () => (config.insertResult !== undefined ? [config.insertResult] : []),
        onConflictDoUpdate: () => ({
          returning: async () =>
            config.insertUpsertResult !== undefined
              ? [config.insertUpsertResult]
              : config.insertResult !== undefined
                ? [config.insertResult]
                : [],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => config.selectResult ?? [],
      }),
    }),
    query: {
      threads: {
        findFirst: async () => config.threadFindFirst,
      },
      slots: {
        findFirst: async () => config.slotFindFirst,
      },
    },
  }
  return mock as unknown as DrizzleDB
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const T0 = new Date('2025-01-01T00:00:00Z')

function makeThreadRow(overrides?: Partial<ThreadRow>): ThreadRow {
  return {
    id: 'thread-1',
    state: 'active',
    sourceChannel: null,
    initiatedBy: 'dmn',
    trigger: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

function makeSlotRow(overrides?: Partial<SlotRow>): SlotRow {
  return {
    id: 'slot-1',
    threadId: 'thread-1',
    brain: 'cortex',
    status: 'pending',
    input: null,
    output: null,
    intent: null,
    complexityHint: null,
    executionSessionId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

// ─── Thread Tests ─────────────────────────────────────────────────────────────

describe('Thread operations', () => {
  test('createThread returns Thread with correct fields', async () => {
    const row = makeThreadRow({ sourceChannel: 'teams', trigger: 'hello' })
    const db = makeMockDb({ insertResult: row })
    const ws = new CognitiveWorkspace(db)

    const thread = await ws.createThread({
      initiatedBy: 'dmn',
      sourceChannel: 'teams',
      trigger: 'hello',
    })

    expect(thread.id).toBe('thread-1')
    expect(thread.state).toBe('active')
    expect(thread.sourceChannel).toBe('teams')
    expect(thread.initiatedBy).toBe('dmn')
    expect(thread.trigger).toBe('hello')
    expect(thread.createdAt).toEqual(T0)
    expect(thread.updatedAt).toEqual(T0)
  })

  test('createThread sets default state to active', async () => {
    const db = makeMockDb({ insertResult: makeThreadRow() })
    const ws = new CognitiveWorkspace(db)

    const thread = await ws.createThread({ initiatedBy: 'dmn' })
    expect(thread.state).toBe('active')
  })

  test('createThread handles null optional fields', async () => {
    const db = makeMockDb({ insertResult: makeThreadRow() })
    const ws = new CognitiveWorkspace(db)

    const thread = await ws.createThread({ initiatedBy: 'dmn' })
    expect(thread.sourceChannel).toBeNull()
    expect(thread.trigger).toBeNull()
  })

  test('createThread throws when insert returns no rows', async () => {
    const db = makeMockDb({ insertResult: undefined })
    const ws = new CognitiveWorkspace(db)

    await expect(ws.createThread({ initiatedBy: 'dmn' })).rejects.toThrow('Insert returned no rows')
  })

  test('getThread returns Thread for existing id', async () => {
    const row = makeThreadRow({ id: 'abc-123', state: 'waiting' })
    const db = makeMockDb({ threadFindFirst: row })
    const ws = new CognitiveWorkspace(db)

    const thread = await ws.getThread('abc-123')
    expect(thread).not.toBeNull()
    expect(thread?.id).toBe('abc-123')
    expect(thread?.state).toBe('waiting')
  })

  test('getThread returns null for unknown id', async () => {
    const db = makeMockDb({ threadFindFirst: undefined })
    const ws = new CognitiveWorkspace(db)

    const thread = await ws.getThread('nonexistent')
    expect(thread).toBeNull()
  })

  test('updateThreadState resolves without error', async () => {
    const db = makeMockDb()
    const ws = new CognitiveWorkspace(db)

    await expect(ws.updateThreadState('thread-1', 'complete')).resolves.toBeUndefined()
  })

  test('getActiveThreads returns threads from select result', async () => {
    const rows = [
      makeThreadRow({ id: 'a', state: 'active' }),
      makeThreadRow({ id: 'b', state: 'waiting' }),
      makeThreadRow({ id: 'c', state: 'interrupted' }),
    ]
    const db = makeMockDb({ selectResult: rows })
    const ws = new CognitiveWorkspace(db)

    const threads = await ws.getActiveThreads()
    expect(threads).toHaveLength(3)
    expect(threads.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  test('getActiveThreads returns empty array when no active threads', async () => {
    const db = makeMockDb({ selectResult: [] })
    const ws = new CognitiveWorkspace(db)

    const threads = await ws.getActiveThreads()
    expect(threads).toHaveLength(0)
  })
})

// ─── Slot Tests ───────────────────────────────────────────────────────────────

describe('Slot operations', () => {
  test('writeSlot creates new slot and returns Slot', async () => {
    const row = makeSlotRow({ brain: 'cortex', status: 'running', input: { msg: 'hello' } })
    const db = makeMockDb({ insertResult: row })
    const ws = new CognitiveWorkspace(db)

    const slot = await ws.writeSlot('thread-1', 'cortex', {
      status: 'running',
      input: { msg: 'hello' },
    })

    expect(slot.id).toBe('slot-1')
    expect(slot.threadId).toBe('thread-1')
    expect(slot.brain).toBe('cortex')
    expect(slot.status).toBe('running')
    expect(slot.input).toEqual({ msg: 'hello' })
  })

  test('writeSlot upserts (overwrites) on same threadId+brain', async () => {
    const updatedRow = makeSlotRow({
      id: 'slot-1',
      status: 'done',
      output: { result: 42 },
      updatedAt: new Date('2025-01-02T00:00:00Z'),
    })
    const db = makeMockDb({ insertUpsertResult: updatedRow })
    const ws = new CognitiveWorkspace(db)

    const slot = await ws.writeSlot('thread-1', 'cortex', {
      status: 'done',
      output: { result: 42 },
    })

    expect(slot.status).toBe('done')
    expect(slot.output).toEqual({ result: 42 })
  })

  test('writeSlot throws when upsert returns no rows', async () => {
    const db = makeMockDb({ insertResult: undefined, insertUpsertResult: undefined })
    const ws = new CognitiveWorkspace(db)

    await expect(ws.writeSlot('thread-1', 'cortex', {})).rejects.toThrow('Upsert returned no rows')
  })

  test('writeSlot preserves null fields when not provided', async () => {
    const row = makeSlotRow()
    const db = makeMockDb({ insertResult: row })
    const ws = new CognitiveWorkspace(db)

    const slot = await ws.writeSlot('thread-1', 'cortex', {})
    expect(slot.input).toBeNull()
    expect(slot.output).toBeNull()
    expect(slot.intent).toBeNull()
    expect(slot.complexityHint).toBeNull()
    expect(slot.executionSessionId).toBeNull()
  })

  test('writeSlot maps intent and complexityHint fields', async () => {
    const row = makeSlotRow({ intent: 'execute', complexityHint: 'complex' })
    const db = makeMockDb({ insertResult: row })
    const ws = new CognitiveWorkspace(db)

    const slot = await ws.writeSlot('thread-1', 'cortex', {
      intent: 'execute',
      complexityHint: 'complex',
    })

    expect(slot.intent).toBe('execute')
    expect(slot.complexityHint).toBe('complex')
  })

  test('readSlot returns Slot for existing threadId+brain', async () => {
    const row = makeSlotRow({ status: 'done' })
    const db = makeMockDb({ slotFindFirst: row })
    const ws = new CognitiveWorkspace(db)

    const slot = await ws.readSlot('thread-1', 'cortex')
    expect(slot).not.toBeNull()
    expect(slot?.status).toBe('done')
  })

  test('readSlot returns null for unknown threadId+brain', async () => {
    const db = makeMockDb({ slotFindFirst: undefined })
    const ws = new CognitiveWorkspace(db)

    const slot = await ws.readSlot('thread-99', 'limbic')
    expect(slot).toBeNull()
  })

  test('getSlotsByThread returns all slots for a thread', async () => {
    const rows = [
      makeSlotRow({ id: 's1', brain: 'cortex' }),
      makeSlotRow({ id: 's2', brain: 'limbic' }),
    ] as SlotRow[]
    const db = makeMockDb({ selectResult: rows as unknown as ThreadRow[] })
    const ws = new CognitiveWorkspace(db)

    const slots = await ws.getSlotsByThread('thread-1')
    expect(slots).toHaveLength(2)
    expect(slots[0]?.id).toBe('s1')
    expect(slots[1]?.id).toBe('s2')
  })

  test('getSlotsByThread returns empty array when no slots', async () => {
    const db = makeMockDb({ selectResult: [] })
    const ws = new CognitiveWorkspace(db)

    const slots = await ws.getSlotsByThread('thread-1')
    expect(slots).toHaveLength(0)
  })
})

