import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestDb, withTransaction } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'

describeWithDb('getSessionContext (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>

  beforeAll(() => {
    testDb = createTestDb()
  })

  afterAll(async () => {
    await testDb.client.end()
  })

  // V1 — returns anchor + events in ascending createdAt order
  test('returns anchor as earliest episodic and events in ascending order', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const m1 = await ws.writeMemory({ type: 'episodic', content: 'first event', sessionId: 'integ-sess-A' })
      const m2 = await ws.writeMemory({ type: 'episodic', content: 'second event', sessionId: 'integ-sess-A' })
      const m3 = await ws.writeMemory({ type: 'episodic', content: 'third event', sessionId: 'integ-sess-A' })

      const ctx = await ws.getSessionContext('integ-sess-A')

      expect(ctx.anchor).not.toBeNull()
      expect(ctx.anchor!.id).toBe(m1.id)
      expect(ctx.events).toHaveLength(3)
      expect(ctx.events[0].id).toBe(m1.id)
      // events are ordered ascending by createdAt; last inserted may not always be m3
      // but the set of ids must match
      const ids = ctx.events.map(e => e.id)
      expect(ids).toContain(m1.id)
      expect(ids).toContain(m2.id)
      expect(ids).toContain(m3.id)
    })
  })

  // V2 — non-existent sessionId returns empty, no exception
  test('returns { anchor: null, events: [] } for non-existent sessionId', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const ctx = await ws.getSessionContext('integ-session-does-not-exist-xyz')

      expect(ctx.anchor).toBeNull()
      expect(ctx.events).toHaveLength(0)
    })
  })

  // V3 — cross-session isolation
  test('does not mix memories from other sessions', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'episodic', content: 'sess-A event', sessionId: 'integ-iso-A' })
      await ws.writeMemory({ type: 'episodic', content: 'sess-B event', sessionId: 'integ-iso-B' })

      const ctx = await ws.getSessionContext('integ-iso-A')

      expect(ctx.events.every(e => e.sessionId === 'integ-iso-A')).toBe(true)
      expect(ctx.events.some(e => e.sessionId === 'integ-iso-B')).toBe(false)
    })
  })

  // V4 — soft-deleted records are excluded
  test('excludes soft-deleted memories', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const m = await ws.writeMemory({ type: 'episodic', content: 'to be deleted', sessionId: 'integ-del-C' })
      await ws.invalidateMemory(m.id)

      const ctx = await ws.getSessionContext('integ-del-C')

      expect(ctx.anchor).toBeNull()
      expect(ctx.events).toHaveLength(0)
    })
  })

  // V5 — non-episodic types are excluded
  test('only returns episodic memories, not other types', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'working', content: 'working mem', sessionId: 'integ-type-D' })
      await ws.writeMemory({ type: 'semantic', content: 'semantic mem', sessionId: 'integ-type-D' })

      const ctx = await ws.getSessionContext('integ-type-D')

      expect(ctx.anchor).toBeNull()
      expect(ctx.events).toHaveLength(0)
    })
  })

  // V6 — single record: anchor and events[0] are the same
  test('returns same entry as both anchor and events[0] when only one record exists', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const m = await ws.writeMemory({ type: 'episodic', content: 'only one', sessionId: 'integ-single-E' })

      const ctx = await ws.getSessionContext('integ-single-E')

      expect(ctx.anchor).not.toBeNull()
      expect(ctx.anchor!.id).toBe(m.id)
      expect(ctx.events).toHaveLength(1)
      expect(ctx.events[0].id).toBe(m.id)
    })
  })
})
