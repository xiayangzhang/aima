import { afterAll, beforeAll, expect, test } from 'vitest'
import { assembleBlock4 } from '../../../src/context/index'
import { createTestDb, withTransaction } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'

// ─── getEntityContext ─────────────────────────────────────────────────────────

describeWithDb('getEntityContext (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>
  beforeAll(() => {
    testDb = createTestDb()
  })
  afterAll(async () => {
    await testDb.client.end()
  })

  test('returns only memories with matching entityId', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const memA = await ws.writeMemory({
        type: 'semantic',
        content: 'fact about entity A',
        entityId: 'entity-test-A',
      })
      await ws.writeMemory({
        type: 'semantic',
        content: 'fact about entity B',
        entityId: 'entity-test-B',
      })
      await ws.writeMemory({
        type: 'semantic',
        content: 'generic fact',
      })

      const results = await ws.getEntityContext('entity-test-A')

      expect(results).toHaveLength(1)
      expect(results[0]?.id).toBe(memA.id)
      expect(results[0]?.entityId).toBe('entity-test-A')
    })
  })

  test('returns memories of all types for the entity by default', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'semantic', content: 'semantic fact', entityId: 'entity-multi' })
      await ws.writeMemory({ type: 'episodic', content: 'past event', entityId: 'entity-multi' })
      await ws.writeMemory({ type: 'procedural', content: 'procedure', entityId: 'entity-multi' })

      const results = await ws.getEntityContext('entity-multi')

      expect(results).toHaveLength(3)
      const types = results.map((r) => r.type)
      expect(types).toContain('semantic')
      expect(types).toContain('episodic')
      expect(types).toContain('procedural')
    })
  })

  test('filters by types when specified', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'semantic', content: 'semantic', entityId: 'entity-typefilter' })
      await ws.writeMemory({ type: 'episodic', content: 'episodic', entityId: 'entity-typefilter' })

      const results = await ws.getEntityContext('entity-typefilter', { types: ['semantic'] })

      expect(results).toHaveLength(1)
      expect(results[0]?.type).toBe('semantic')
    })
  })

  test('does not return invalidated memories', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const mem = await ws.writeMemory({
        type: 'semantic',
        content: 'to be invalidated',
        entityId: 'entity-invalid',
      })
      await ws.invalidateMemory(mem.id)

      const results = await ws.getEntityContext('entity-invalid')
      expect(results.every((r) => r.tInvalid === null)).toBe(true)
    })
  })

  test('respects limit', async () => {
    await withTransaction(testDb.db, async (ws) => {
      for (let i = 0; i < 5; i++) {
        await ws.writeMemory({
          type: 'semantic',
          content: `fact ${i}`,
          entityId: 'entity-limit',
        })
      }

      const results = await ws.getEntityContext('entity-limit', { limit: 3 })
      expect(results).toHaveLength(3)
    })
  })

  test('orders by base_importance desc', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const low = await ws.writeMemory({
        type: 'semantic',
        content: 'low importance',
        entityId: 'entity-order',
        baseImportance: 0.2,
      })
      const high = await ws.writeMemory({
        type: 'semantic',
        content: 'high importance',
        entityId: 'entity-order',
        baseImportance: 0.9,
      })

      const results = await ws.getEntityContext('entity-order')
      expect(results[0]?.id).toBe(high.id)
      expect(results[1]?.id).toBe(low.id)
    })
  })

  test('returns empty array when no matching entity', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const results = await ws.getEntityContext('entity-nonexistent-xyz-12345')
      expect(results).toHaveLength(0)
    })
  })
})

// ─── findSimilarSituations ────────────────────────────────────────────────────

describeWithDb('findSimilarSituations (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>
  beforeAll(() => {
    testDb = createTestDb()
  })
  afterAll(async () => {
    await testDb.client.end()
  })

  test('returns correct groups: episodes, procedures, facts', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'episodic', content: '客户投诉了延误问题', baseImportance: 0.7 })
      await ws.writeMemory({
        type: 'procedural',
        content: '处理客户投诉的步骤',
        baseImportance: 0.8,
      })
      await ws.writeMemory({ type: 'semantic', content: '投诉处理政策规定', baseImportance: 0.6 })
      await ws.writeMemory({ type: 'episodic', content: '正常会议记录', baseImportance: 0.9 })

      const result = await ws.findSimilarSituations('投诉')

      expect(result.episodes).toHaveLength(1)
      expect(result.episodes[0]?.type).toBe('episodic')
      expect(result.episodes[0]?.content).toContain('投诉')

      expect(result.procedures).toHaveLength(1)
      expect(result.procedures[0]?.type).toBe('procedural')

      expect(result.facts).toHaveLength(1)
      expect(result.facts[0]?.type).toBe('semantic')
    })
  })

  test('ILIKE is case-insensitive for ASCII content', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'semantic', content: 'Invoice processing procedure' })
      await ws.writeMemory({ type: 'semantic', content: 'invoice approval flow' })

      const result = await ws.findSimilarSituations('INVOICE')

      expect(result.facts.length).toBeGreaterThanOrEqual(2)
    })
  })

  test('returns empty arrays when no content matches', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'episodic', content: '完全不相关的内容' })

      const result = await ws.findSimilarSituations('xyzzy-nonexistent-keyword-99999')

      expect(result.episodes).toHaveLength(0)
      expect(result.procedures).toHaveLength(0)
      expect(result.facts).toHaveLength(0)
    })
  })

  test('respects per-group limit', async () => {
    await withTransaction(testDb.db, async (ws) => {
      for (let i = 0; i < 5; i++) {
        await ws.writeMemory({ type: 'episodic', content: `关键词事件 ${i}` })
      }

      const result = await ws.findSimilarSituations('关键词', { limit: 3 })
      expect(result.episodes.length).toBeLessThanOrEqual(3)
    })
  })

  test('does not return invalidated memories', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const mem = await ws.writeMemory({
        type: 'semantic',
        content: '应该被过滤的投诉记录',
      })
      await ws.invalidateMemory(mem.id)

      const result = await ws.findSimilarSituations('投诉')
      const allResults = [...result.episodes, ...result.procedures, ...result.facts]
      expect(allResults.every((r) => r.tInvalid === null)).toBe(true)
    })
  })
})

// ─── getProcedure ─────────────────────────────────────────────────────────────

describeWithDb('getProcedure (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>
  beforeAll(() => {
    testDb = createTestDb()
  })
  afterAll(async () => {
    await testDb.client.end()
  })

  test('returns only procedural type memories', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'procedural', content: '报销审批流程步骤' })
      await ws.writeMemory({ type: 'semantic', content: '报销政策说明' })
      await ws.writeMemory({ type: 'episodic', content: '报销案例记录' })

      const results = await ws.getProcedure('报销')

      expect(results.every((r) => r.type === 'procedural')).toBe(true)
      expect(results.length).toBeGreaterThanOrEqual(1)
    })
  })

  test('ILIKE matches content containing taskType', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const mem = await ws.writeMemory({
        type: 'procedural',
        content: '采购订单审批：第一步提交申请，第二步部门主管审核',
      })
      await ws.writeMemory({
        type: 'procedural',
        content: '完全不相关的流程',
      })

      const results = await ws.getProcedure('采购')

      expect(results.some((r) => r.id === mem.id)).toBe(true)
      expect(results.every((r) => r.content.includes('采购'))).toBe(true)
    })
  })

  test('returns empty when taskType keyword not in any procedural content', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'procedural', content: '其他流程内容' })

      const results = await ws.getProcedure('xyzzy-nonexistent-task-keyword')
      expect(results).toHaveLength(0)
    })
  })

  test('respects default limit 3', async () => {
    await withTransaction(testDb.db, async (ws) => {
      for (let i = 0; i < 5; i++) {
        await ws.writeMemory({ type: 'procedural', content: `审批流程变体 ${i}` })
      }

      const results = await ws.getProcedure('审批')
      expect(results.length).toBeLessThanOrEqual(3)
    })
  })

  test('respects custom limit', async () => {
    await withTransaction(testDb.db, async (ws) => {
      for (let i = 0; i < 5; i++) {
        await ws.writeMemory({ type: 'procedural', content: `流程 ${i}` })
      }

      const results = await ws.getProcedure('流程', { limit: 2 })
      expect(results.length).toBeLessThanOrEqual(2)
    })
  })

  test('orders by base_importance desc', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const low = await ws.writeMemory({
        type: 'procedural',
        content: '低重要度报销流程',
        baseImportance: 0.2,
      })
      const high = await ws.writeMemory({
        type: 'procedural',
        content: '高重要度报销流程',
        baseImportance: 0.9,
      })

      const results = await ws.getProcedure('报销', { limit: 2 })
      expect(results[0]?.id).toBe(high.id)
      expect(results[1]?.id).toBe(low.id)
    })
  })
})

// ─── assembleBlock4 routing ───────────────────────────────────────────────────

describeWithDb('assembleBlock4 routing (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>
  beforeAll(() => {
    testDb = createTestDb()
  })
  afterAll(async () => {
    await testDb.client.end()
  })

  test('limbic + entityId: injects entity-specific memories', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({
        type: 'semantic',
        content: 'Client ABC prefers email communication',
        entityId: 'client-abc',
        baseImportance: 0.8,
      })
      await ws.writeMemory({
        type: 'semantic',
        content: 'Client XYZ info',
        entityId: 'client-xyz',
      })

      const { text, injectedMemoryIds } = await assembleBlock4('limbic', ws, 'thread-1', {
        entityId: 'client-abc',
      })

      expect(text).toContain('Client ABC prefers email communication')
      expect(text).not.toContain('Client XYZ info')
      expect(injectedMemoryIds).toHaveLength(1)
    })
  })

  test('cortex + situation: injects situation-matched memories across types', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'episodic', content: 'past invoice dispute resolution' })
      await ws.writeMemory({ type: 'procedural', content: 'invoice dispute handling procedure' })
      await ws.writeMemory({ type: 'semantic', content: 'invoice policy document' })

      const { text } = await assembleBlock4('cortex', ws, 'thread-1', { situation: 'invoice' })

      expect(text).toContain('invoice')
    })
  })

  test('brainstem + taskType: injects only procedural memories matching taskType', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'procedural', content: 'approval workflow steps for budget' })
      await ws.writeMemory({ type: 'semantic', content: 'budget policy' })

      const { text } = await assembleBlock4('brainstem', ws, 'thread-1', { taskType: 'approval' })

      expect(text).toContain('approval workflow steps for budget')
    })
  })

  test('limbic without entityId: falls back gracefully without error', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'semantic', content: 'generic fact no entity' })

      const { text } = await assembleBlock4('limbic', ws, 'thread-1')

      expect(typeof text).toBe('string')
    })
  })
})
