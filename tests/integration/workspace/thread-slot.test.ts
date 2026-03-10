import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestDb, withTransaction } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'

describeWithDb('Thread lifecycle (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>

  beforeAll(() => {
    testDb = createTestDb()
  })

  afterAll(async () => {
    await testDb.client.end()
  })

  test('createThread and getThread round-trip', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const thread = await ws.createThread({
        initiatedBy: 'external:teams',
        trigger: 'integration test',
      })

      expect(thread.id).toBeTypeOf('string')
      expect(thread.state).toBe('active')
      expect(thread.initiatedBy).toBe('external:teams')
      expect(thread.trigger).toBe('integration test')

      const fetched = await ws.getThread(thread.id)
      expect(fetched).not.toBeNull()
      expect(fetched?.id).toBe(thread.id)
      expect(fetched?.state).toBe('active')
    })
  })

  test('updateThreadState changes state and updatedAt', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const thread = await ws.createThread({ initiatedBy: 'dmn' })
      const before = thread.updatedAt

      await new Promise((r) => setTimeout(r, 10))
      await ws.updateThreadState(thread.id, 'complete')

      const updated = await ws.getThread(thread.id)
      expect(updated?.state).toBe('complete')
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(before.getTime())
    })
  })

  test('getActiveThreads excludes complete threads', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const t1 = await ws.createThread({ initiatedBy: 'dmn' })
      const t2 = await ws.createThread({ initiatedBy: 'external:webhook' })
      await ws.updateThreadState(t2.id, 'complete')

      const active = await ws.getActiveThreads()
      const ids = active.map((t) => t.id)
      expect(ids).toContain(t1.id)
      expect(ids).not.toContain(t2.id)
    })
  })

  test('getActiveThreads includes waiting and interrupted threads', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const t1 = await ws.createThread({ initiatedBy: 'dmn' })
      const t2 = await ws.createThread({ initiatedBy: 'dmn' })
      await ws.updateThreadState(t1.id, 'waiting')
      await ws.updateThreadState(t2.id, 'interrupted')

      const active = await ws.getActiveThreads()
      const ids = active.map((t) => t.id)
      expect(ids).toContain(t1.id)
      expect(ids).toContain(t2.id)
    })
  })

  test('writeSlot upsert: same threadId+brain overwrites, keeps same id', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const thread = await ws.createThread({ initiatedBy: 'dmn' })

      const slot1 = await ws.writeSlot(thread.id, 'cortex', {
        status: 'running',
        input: { query: 'hello' },
      })

      const slot2 = await ws.writeSlot(thread.id, 'cortex', {
        status: 'done',
        output: { response: 'world' },
      })

      expect(slot1.id).toBe(slot2.id)
      expect(slot2.status).toBe('done')
      expect(slot2.output).toEqual({ response: 'world' })
      expect(slot2.updatedAt.getTime()).toBeGreaterThanOrEqual(slot1.updatedAt.getTime())

      const allSlots = await ws.getSlotsByThread(thread.id)
      const cortexSlots = allSlots.filter((s) => s.brain === 'cortex')
      expect(cortexSlots).toHaveLength(1)
    })
  })

  test('getSlotsByThread returns all brain slots for thread', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const thread = await ws.createThread({ initiatedBy: 'dmn' })

      await ws.writeSlot(thread.id, 'limbic', { status: 'done' })
      await ws.writeSlot(thread.id, 'cortex', { status: 'done' })
      await ws.writeSlot(thread.id, 'brainstem', { status: 'running' })

      const slots = await ws.getSlotsByThread(thread.id)
      expect(slots).toHaveLength(3)
      const brains = slots.map((s) => s.brain).sort()
      expect(brains).toEqual(['brainstem', 'cortex', 'limbic'])
    })
  })

  test('readSlot returns null for nonexistent threadId+brain', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const slot = await ws.readSlot('00000000-0000-0000-0000-000000000000', 'cortex')
      expect(slot).toBeNull()
    })
  })
})
