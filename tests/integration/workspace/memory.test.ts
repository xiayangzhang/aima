import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestDb, withTransaction } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'

describeWithDb('Memory operations (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>

  beforeAll(() => {
    testDb = createTestDb()
  })

  afterAll(async () => {
    await testDb.client.end()
  })

  test('writeMemory and searchMemory round-trip', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const mem = await ws.writeMemory({
        type: 'semantic',
        content: 'Cortex determined user intent is to schedule a meeting',
        tags: ['intent', 'schedule'],
        entityId: 'entity-integration-test',
      })

      expect(mem.id).toBeTypeOf('string')
      expect(mem.type).toBe('semantic')
      expect(mem.tInvalid).toBeNull()

      const results = await ws.searchMemory({
        type: 'semantic',
        entityId: 'entity-integration-test',
      })
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.some((m) => m.id === mem.id)).toBe(true)
    })
  })

  test('searchMemory tags AND semantics: all specified tags must match', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({
        type: 'semantic',
        content: 'Memory with tags A and B',
        tags: ['integ-tagA', 'integ-tagB'],
      })
      await ws.writeMemory({
        type: 'semantic',
        content: 'Memory with only tag A',
        tags: ['integ-tagA'],
      })

      const results = await ws.searchMemory({ tags: ['integ-tagA', 'integ-tagB'] })
      const withBoth = results.filter((m) => m.tags.includes('integ-tagB'))
      const withoutB = results.filter(
        (m) => m.tags.includes('integ-tagA') && !m.tags.includes('integ-tagB'),
      )

      expect(withBoth.length).toBeGreaterThanOrEqual(1)
      expect(withoutB.length).toBe(0)
    })
  })

  test('excludeInvalid default true: soft-deleted records not returned', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const original = await ws.writeMemory({
        type: 'procedural',
        content: 'Old procedure',
        tags: ['integ-supersedes-test'],
      })

      await ws.writeMemory({
        type: 'procedural',
        content: 'New procedure',
        tags: ['integ-supersedes-test'],
        supersedesId: original.id,
      })

      const valid = await ws.searchMemory({ tags: ['integ-supersedes-test'] })
      expect(valid.map((m) => m.id)).not.toContain(original.id)

      const all = await ws.searchMemory({ tags: ['integ-supersedes-test'], excludeInvalid: false })
      expect(all.map((m) => m.id)).toContain(original.id)
    })
  })

  test('supersedes_id: atomically invalidates old and creates new record', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const original = await ws.writeMemory({
        type: 'procedural',
        content: 'Old procedure for task X',
        tags: ['integ-atomic-test'],
      })

      const updated = await ws.writeMemory({
        type: 'procedural',
        content: 'Updated procedure for task X (v2)',
        tags: ['integ-atomic-test'],
        supersedesId: original.id,
      })

      expect(updated.supersedesId).toBe(original.id)
      expect(updated.tInvalid).toBeNull()

      const all = await ws.searchMemory({ tags: ['integ-atomic-test'], excludeInvalid: false })
      const oldRecord = all.find((m) => m.id === original.id)
      expect(oldRecord).toBeTruthy()
      expect(oldRecord?.tInvalid).not.toBeNull()

      const valid = await ws.searchMemory({ tags: ['integ-atomic-test'] })
      const ids = valid.map((m) => m.id)
      expect(ids).not.toContain(original.id)
      expect(ids).toContain(updated.id)
    })
  })

  test('markMemoryUsed increments correct counter on real DB', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const mem = await ws.writeMemory({
        type: 'episodic',
        content: 'Brainstem executed tool call',
        tags: ['integ-mark-used'],
      })

      await ws.markMemoryUsed([mem.id], 'positive')
      await ws.markMemoryUsed([mem.id], 'positive')
      await ws.markMemoryUsed([mem.id], 'negative')

      const results = await ws.searchMemory({ tags: ['integ-mark-used'], excludeInvalid: false })
      const result = results.find((m) => m.id === mem.id)
      expect(result?.usageOutcomes.positive).toBe(2)
      expect(result?.usageOutcomes.negative).toBe(1)
      expect(result?.usageOutcomes.neutral).toBe(0)
    })
  })

  test('clearWorkingMemory removes only working type for that thread', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const threadId = '00000000-0000-0000-0000-000000000099'

      await ws.writeMemory({ type: 'working', content: 'working 1', threadId })
      await ws.writeMemory({ type: 'working', content: 'working 2', threadId })
      await ws.writeMemory({ type: 'semantic', content: 'semantic stays', threadId })

      await ws.clearWorkingMemory(threadId)

      const all = await ws.searchMemory({ excludeInvalid: false, limit: 1000 })
      const workingForThread = all.filter((m) => m.type === 'working' && m.threadId === threadId)
      const semanticForThread = all.filter((m) => m.type === 'semantic' && m.threadId === threadId)

      expect(workingForThread).toHaveLength(0)
      expect(semanticForThread).toHaveLength(1)
    })
  })

  test('getByTags returns memories matching all specified tags (AND semantics)', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({
        type: 'implicit',
        content: JSON.stringify({ tool: 'spawn_execution_session', decision: 'block', reason: 'dangerous' }),
        tags: ['amygdala_eval', 'spawn_execution_session', 'block'],
        sourceBrain: 'amygdala',
      })
      await ws.writeMemory({
        type: 'implicit',
        content: JSON.stringify({ tool: 'other_tool', decision: 'allow', reason: 'safe' }),
        tags: ['amygdala_eval', 'other_tool', 'allow'],
        sourceBrain: 'amygdala',
      })

      const results = await ws.getByTags(['amygdala_eval', 'spawn_execution_session'])
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.every((m) => m.tags.includes('spawn_execution_session'))).toBe(true)
      expect(results.some((m) => m.tags.includes('other_tool'))).toBe(false)
    })
  })

  test('getByTags respects limit parameter', async () => {
    await withTransaction(testDb.db, async (ws) => {
      for (let i = 0; i < 5; i++) {
        await ws.writeMemory({
          type: 'implicit',
          content: JSON.stringify({ tool: 'limit_test_tool', decision: 'allow', reason: `entry ${i}` }),
          tags: ['amygdala_eval', 'limit_test_tool', 'allow'],
          sourceBrain: 'amygdala',
        })
      }
      const results = await ws.getByTags(['amygdala_eval', 'limit_test_tool'], undefined, 3)
      expect(results.length).toBeLessThanOrEqual(3)
    })
  })

  test('getByTags excludes soft-deleted records (tInvalid is set)', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const mem = await ws.writeMemory({
        type: 'implicit',
        content: JSON.stringify({ tool: 'soft_deleted_tool', decision: 'block', reason: 'old' }),
        tags: ['amygdala_eval', 'soft_deleted_tool', 'block'],
        sourceBrain: 'amygdala',
      })
      await ws.invalidateMemory(mem.id)

      const results = await ws.getByTags(['amygdala_eval', 'soft_deleted_tool'])
      expect(results.every((m) => m.id !== mem.id)).toBe(true)
    })
  })
})
