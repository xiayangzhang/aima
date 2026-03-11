---
work_package_id: WP03
title: 集成测试（真实 PostgreSQL）
lane: planned
dependencies: []
subtasks: [T016, T017, T018, T019]
assignee: claude
agent: claude
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP03 — 集成测试（真实 PostgreSQL）

## 目标

用真实 PostgreSQL 验证 WP01 三个方法和 WP02 路由的 SQL 语义正确性。单元测试验证调用路径，集成测试验证数据库行为——包括 ILIKE 匹配、排序（importance/lastAccessedAt）、limit 截断、类型纯净度、forgotten/tInvalid 过滤。

## 实施命令

```bash
spec-kitty implement WP03 --base WP02
```

## 上下文

### 关键文件

- **新建**：`tests/integration/workspace/brain-retrieval.test.ts`

### 测试基础设施

```typescript
// 复用已有工具（参见 tests/integration/helpers/db.ts）：
import { createTestDb, withTransaction } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'
```

`withTransaction` 模式在事务中运行测试，结束时强制 ROLLBACK——**所有写入自动清理，无需手动 afterEach 清理数据**。这是本项目的标准隔离模式。

### 连接要求

```bash
AIMA_TEST_DATABASE_URL=postgresql://aima:aima@localhost:5434/aima_test
```

若环境变量未设置，`describeWithDb` 自动 skip（不报错）。

### 文件结构

```typescript
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestDb, withTransaction } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'

// 每个 describeWithDb 块有独立的 testDb，独立的 afterAll(() => client.end())
// 宪法规定：不共享连接
```

---

## 子任务

### T016 — `getEntityContext` 集成测试

**测试场景**：

```typescript
describeWithDb('getEntityContext (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>
  beforeAll(() => { testDb = createTestDb() })
  afterAll(async () => { await testDb.client.end() })

  test('returns only memories with matching entityId', async () => {
    await withTransaction(testDb.db, async (ws) => {
      // 写入 entity-A 的记忆（semantic）
      const memA = await ws.writeMemory({
        type: 'semantic',
        content: 'fact about entity A',
        entityId: 'entity-test-A',
      })
      // 写入 entity-B 的记忆（不应出现）
      await ws.writeMemory({
        type: 'semantic',
        content: 'fact about entity B',
        entityId: 'entity-test-B',
      })
      // 写入无 entity 的记忆（不应出现）
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

  test('does not return forgotten memories', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const mem = await ws.writeMemory({
        type: 'semantic',
        content: 'to be forgotten',
        entityId: 'entity-forgotten',
      })
      await ws.invalidateMemory(mem.id)  // t_invalid をセット

      const results = await ws.getEntityContext('entity-forgotten')
      // t_invalid 的记忆不应出现
      expect(results.every((r) => r.tInvalid === null)).toBe(true)
    })
  })

  test('respects limit', async () => {
    await withTransaction(testDb.db, async (ws) => {
      // 写入 5 条同 entity 的记忆
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
```

---

### T017 — `findSimilarSituations` 集成测试

```typescript
describeWithDb('findSimilarSituations (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>
  beforeAll(() => { testDb = createTestDb() })
  afterAll(async () => { await testDb.client.end() })

  test('returns correct groups: episodes, procedures, facts', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'episodic', content: '客户投诉了延误问题', baseImportance: 0.7 })
      await ws.writeMemory({ type: 'procedural', content: '处理客户投诉的步骤', baseImportance: 0.8 })
      await ws.writeMemory({ type: 'semantic', content: '投诉处理政策规定', baseImportance: 0.6 })
      // 不含关键词的记忆（不应出现）
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

      // 两条都应匹配（ILIKE 大小写不敏感）
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
      // 写入 5 条 episodic 含关键词
      for (let i = 0; i < 5; i++) {
        await ws.writeMemory({ type: 'episodic', content: `关键词事件 ${i}` })
      }

      const result = await ws.findSimilarSituations('关键词', { limit: 3 })
      expect(result.episodes.length).toBeLessThanOrEqual(3)
    })
  })

  test('does not return forgotten/invalid memories', async () => {
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
```

---

### T018 — `getProcedure` 集成测试

```typescript
describeWithDb('getProcedure (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>
  beforeAll(() => { testDb = createTestDb() })
  afterAll(async () => { await testDb.client.end() })

  test('returns only procedural type memories', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'procedural', content: '报销审批流程步骤' })
      await ws.writeMemory({ type: 'semantic', content: '报销政策说明' })  // 不应出现
      await ws.writeMemory({ type: 'episodic', content: '报销案例记录' })  // 不应出现

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

  test('respects limit (default 3)', async () => {
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
```

---

### T019 — `assembleBlock4` 集成路由测试

**目的**：在真实 workspace 上验证 `assembleBlock4` 路由行为——调用正确的方法且返回内容包含正确记忆。

```typescript
describeWithDb('assembleBlock4 routing (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>
  beforeAll(() => { testDb = createTestDb() })
  afterAll(async () => { await testDb.client.end() })

  test('limbic + entityId: injects entity-specific memories', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({
        type: 'semantic',
        content: 'Client ABC prefers email communication',
        entityId: 'client-abc',
        baseImportance: 0.8,
      })
      // 其他 entity 的记忆（不应出现）
      await ws.writeMemory({
        type: 'semantic',
        content: 'Client XYZ info',
        entityId: 'client-xyz',
      })

      const { text, injectedMemoryIds } = await assembleBlock4(
        'limbic',
        ws,
        'thread-1',
        { entityId: 'client-abc' },
      )

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

      const { text } = await assembleBlock4(
        'cortex',
        ws,
        'thread-1',
        { situation: 'invoice' },
      )

      expect(text).toContain('invoice')
    })
  })

  test('brainstem + taskType: injects only procedural memories matching taskType', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'procedural', content: 'approval workflow steps for budget' })
      await ws.writeMemory({ type: 'semantic', content: 'budget policy' })  // 不应注入

      const { text } = await assembleBlock4(
        'brainstem',
        ws,
        'thread-1',
        { taskType: 'approval' },
      )

      expect(text).toContain('approval workflow steps for budget')
    })
  })

  test('limbic without entityId: falls back to searchMemory (returns any semantic/episodic)', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({ type: 'semantic', content: 'generic fact no entity' })

      // 无 opts，走 fallback
      const { text } = await assembleBlock4('limbic', ws, 'thread-1')

      // fallback 不报错，返回格式正确（可能包含也可能不包含该记忆，取决于 DB 中其他数据）
      // 主要验证不抛异常，返回结构正确
      expect(typeof text).toBe('string')
    })
  })
})
```

**注意**：T019 需要在文件顶部 import `assembleBlock4`：

```typescript
import { assembleBlock4 } from '../../../src/context/index'
```

---

## Definition of Done

- [ ] T016: `getEntityContext` 集成测试通过（实体过滤、types 过滤、forgotten 过滤、limit、importance 排序）
- [ ] T017: `findSimilarSituations` 集成测试通过（三组分类正确、ILIKE 匹配、limit、空结果）
- [ ] T018: `getProcedure` 集成测试通过（type 纯净、ILIKE、limit、排序）
- [ ] T019: `assembleBlock4` 集成路由测试通过（三种 brainType + opts 组合 + fallback）
- [ ] 所有测试在 `AIMA_TEST_DATABASE_URL` 设置时通过，未设置时 skip（不报错）
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过

## 完成命令

```bash
spec-kitty agent tasks move-task WP03 --to for_review --note "Ready: <summary>"
```

## 实施提示

1. `withTransaction` 内部一定会 ROLLBACK，不需要 beforeEach/afterEach 清理
2. 每个 `describeWithDb` 块必须有独立的 `createTestDb()` 和 `afterAll(() => client.end())`，不要在块之间共享 client
3. 如果 T019 中 `assembleBlock4` 的 fallback 路径因为 DB 中已有数据导致不可预测，改用更宽泛的断言（`typeof text === 'string'`）而不是精确匹配内容
4. 集成测试文件用 `import { afterAll, beforeAll, expect, test } from 'vitest'`（参见现有 `tests/integration/workspace/memory.test.ts`）
