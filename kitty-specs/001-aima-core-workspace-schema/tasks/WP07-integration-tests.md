---
work_package_id: WP07
title: 集成测试套件
lane: "doing"
dependencies: []
subtasks:
- T031
- T032
- T033
- T034
phase: Phase 3 - Verification
assignee: ''
agent: "claude"
shell_pid: "36246"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-10T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP07 — 集成测试套件

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, read Review Feedback section first.

---

## Review Feedback

*[Empty — no feedback yet]*

---

## Objectives & Success Criteria

在真实 PostgreSQL 上验证全部 DAO 方法，含并发写锁和事务原子性。完成标准：
- `bun run test:integration` 全部通过（需 `AIMA_TEST_DATABASE_URL` 就位）
- Thread/Slot 完整生命周期测试通过
- Pending 并发写（10 个 Promise.all）后行数 <= capacity
- Memory supersedes_id 事务原子性测试通过（新记录存在 + 旧记录 t_invalid 非 null）
- 无 `AIMA_TEST_DATABASE_URL` 时测试 gracefully skip，打印提示而非报错

## Context & Constraints

- **Repo**: `/Volumes/leoyun/aima/`
- **Test DB**: `AIMA_TEST_DATABASE_URL`（独立于开发库，见 `quickstart.md`）
- **隔离策略**: 每个 `test()` 用 `BEGIN`/`ROLLBACK` 包裹——测试结束后所有数据回滚，避免测试间污染
- **vitest 配置**: `vitest.integration.config.ts`（WP01 T005 已创建），`pool: 'forks'`，`singleFork: true`（避免多 worker 并发连接问题）
- **迁移**: 集成测试运行前，确认 schema 最新（手动运行 `bun run db:migrate` 在测试库上）

实现命令：`spec-kitty implement WP07 --base WP06`

---

## Subtasks & Detailed Guidance

### T031 — 集成测试基础设施

**Purpose**: 建立所有集成测试共用的 DB 连接 helper 和事务 fixture，保证测试隔离。

**Steps**:
1. 创建 `tests/integration/helpers/db.ts`：

```typescript
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../../src/schema/index.js'
import { CognitiveWorkspace } from '../../../src/workspace/index.js'

const TEST_DB_URL = process.env['AIMA_TEST_DATABASE_URL']

export function isTestDbAvailable(): boolean {
  return Boolean(TEST_DB_URL)
}

export function createTestDb() {
  if (!TEST_DB_URL) {
    throw new Error(
      'AIMA_TEST_DATABASE_URL not set. Skipping integration tests.\n' +
      'See kitty-specs/001-aima-core-workspace-schema/quickstart.md for setup.'
    )
  }
  const client = postgres(TEST_DB_URL)
  const db = drizzle(client, { schema })
  return { db, client }
}

// 每个测试用例的 fixture：在事务内运行，测试结束后回滚
export async function withTransaction<T>(
  db: ReturnType<typeof createTestDb>['db'],
  fn: (workspace: CognitiveWorkspace) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    // 注意：Drizzle 的 transaction 回调里不能嵌套另一个 transaction（会被提升）
    // 使用独立的 CognitiveWorkspace 实例，注入事务上下文
    const workspace = new CognitiveWorkspace(tx as unknown as ReturnType<typeof createTestDb>['db'])
    try {
      const result = await fn(workspace)
      // 手动 ROLLBACK（通过 throw 触发 Drizzle 的事务回滚）
      throw { __rollback: true, result }
    } catch (e) {
      if (e && typeof e === 'object' && '__rollback' in e) {
        return (e as { result: T }).result
      }
      throw e
    }
  }).catch((e) => {
    if (e && typeof e === 'object' && '__rollback' in e) {
      return (e as { result: T }).result
    }
    throw e
  })
}
```

**注意**: 事务隔离策略：Drizzle 的 `db.transaction()` 如果回调 throws，会自动 ROLLBACK。通过故意抛出一个带标记的对象来触发回滚，同时传递结果值。这比 `BEGIN`/`ROLLBACK` SQL 更简洁。

2. 创建 `tests/integration/helpers/skip.ts`：

```typescript
import { isTestDbAvailable } from './db.js'

// 用于 describe/test 的条件跳过
export function describeWithDb(name: string, fn: () => void) {
  if (!isTestDbAvailable()) {
    console.log(`⏭  Skipping integration tests: ${name} (AIMA_TEST_DATABASE_URL not set)`)
    return
  }
  // vitest 的 describe
  describe(name, fn)
}
```

**Files**: `tests/integration/helpers/db.ts`（新建），`tests/integration/helpers/skip.ts`（新建）

---

### T032 — Thread & Slot 集成测试

**Purpose**: 在真实 PostgreSQL 上验证 Thread/Slot 完整生命周期。

**Steps**:
1. 创建 `tests/integration/workspace/thread-slot.test.ts`：

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, withTransaction } from '../helpers/db.js'
import { describeWithDb } from '../helpers/skip.js'

let testDb: ReturnType<typeof createTestDb>

beforeAll(() => {
  testDb = createTestDb()
})

afterAll(async () => {
  await testDb.client.end()
})

describeWithDb('Thread lifecycle (integration)', () => {
  test('createThread and getThread round-trip', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const thread = await ws.createThread({
        initiatedBy: 'external:teams',
        trigger: 'integration test',
      })

      expect(thread.id).toBeTypeOf('string')
      expect(thread.state).toBe('active')
      expect(thread.initiatedBy).toBe('external:teams')

      const fetched = await ws.getThread(thread.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(thread.id)
    })
  })

  test('updateThreadState changes state and updates updatedAt', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const thread = await ws.createThread({ initiatedBy: 'dmn' })
      const before = thread.updatedAt

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10))
      await ws.updateThreadState(thread.id, 'complete')

      const updated = await ws.getThread(thread.id)
      expect(updated!.state).toBe('complete')
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(before.getTime())
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

  test('Slot upsert: same threadId+brain overwrites, does not create new row', async () => {
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

      // 应该是同一条记录（upsert，id 不变）
      expect(slot1.id).toBe(slot2.id)
      expect(slot2.status).toBe('done')
      expect(slot2.output).toEqual({ response: 'world' })

      // 确认 thread 只有一个 cortex slot
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
})
```

**Files**: `tests/integration/workspace/thread-slot.test.ts`（新建）

---

### T033 — Pending 集成测试（含并发写）

**Purpose**: 验证 pending_observations 的容量淘汰和并发写安全性。

**Steps**:
1. 创建 `tests/integration/workspace/pending.test.ts`：

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from '../helpers/db.js'
import { describeWithDb } from '../helpers/skip.js'
import { CognitiveWorkspace } from '../../../src/workspace/index.js'

let testDb: ReturnType<typeof createTestDb>
let ws: CognitiveWorkspace

beforeAll(() => {
  testDb = createTestDb()
  ws = new CognitiveWorkspace(testDb.db, { pendingCapacity: 5 })  // 小容量方便测试
})

afterAll(async () => {
  await testDb.client.end()
})

describeWithDb('Pending observations (integration)', () => {
  test('writePending creates and retrieves observation', async () => {
    const pending = await ws.writePending({
      targetBrain: 'limbic',
      note: 'test observation',
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(pending.id).toBeTypeOf('string')
    expect(pending.targetBrain).toBe('limbic')
    expect(pending.baseImportance).toBe(0.5)

    // 清理
    await ws.removePending(pending.id)
  })

  test('capacity eviction: when at capacity, lowest importance evicted', async () => {
    const expiresAt = new Date(Date.now() + 60_000)

    // 写入 5 条（capacity = 5），importance 从 0.1 到 0.5
    const written: string[] = []
    for (let i = 0; i < 5; i++) {
      const p = await ws.writePending({
        targetBrain: 'cortex',
        note: `obs-${i}`,
        expiresAt,
        baseImportance: (i + 1) * 0.1,  // 0.1, 0.2, 0.3, 0.4, 0.5
      })
      written.push(p.id)
    }

    // 写入第 6 条（触发淘汰），importance 为 0.9（高）
    const high = await ws.writePending({
      targetBrain: 'cortex',
      note: 'high-importance',
      expiresAt,
      baseImportance: 0.9,
    })

    // 验证行数 <= 5（capacity）
    const all = await ws.getPendingObservations()
    const ourObs = all.filter((p) =>
      [...written, high.id].includes(p.id)
    )
    expect(ourObs.length).toBeLessThanOrEqual(5)

    // 验证最低 importance（0.1）的记录被淘汰
    const ids = ourObs.map((p) => p.id)
    expect(ids).not.toContain(written[0])  // importance 0.1 被淘汰
    expect(ids).toContain(high.id)         // high importance 0.9 保留

    // 清理
    for (const id of [...written, high.id]) {
      await ws.removePending(id).catch(() => {})  // 已被淘汰的忽略错误
    }
  })

  test('concurrent writes respect capacity (advisory lock prevents race)', async () => {
    const expiresAt = new Date(Date.now() + 60_000)
    const capacity = 5

    // 使用小容量 workspace
    const concurrentWs = new CognitiveWorkspace(testDb.db, { pendingCapacity: capacity })

    // 并发写入 10 条
    const writes = Array.from({ length: 10 }, (_, i) =>
      concurrentWs.writePending({
        targetBrain: 'dmn',
        note: `concurrent-${i}`,
        expiresAt,
        baseImportance: Math.random(),
      })
    )
    await Promise.all(writes)

    // 验证总行数不超过 capacity
    const all = await concurrentWs.getPendingObservations()
    const concurrentObs = all.filter((p) => p.note.startsWith('concurrent-'))
    expect(concurrentObs.length).toBeLessThanOrEqual(capacity)

    // 清理
    for (const obs of concurrentObs) {
      await concurrentWs.removePending(obs.id)
    }
  })

  test('removeExpiredPending cleans up expired records', async () => {
    const past = new Date(Date.now() - 1000)  // 1 second ago

    const expired = await ws.writePending({
      targetBrain: 'brainstem',
      note: 'expired obs',
      expiresAt: past,
    })

    await ws.removeExpiredPending(new Date())

    const all = await ws.getPendingObservations()
    const ids = all.map((p) => p.id)
    expect(ids).not.toContain(expired.id)
  })
})
```

**Files**: `tests/integration/workspace/pending.test.ts`（新建）

---

### T034 — Memory 集成测试

**Purpose**: 在真实 PostgreSQL 上验证 memory 写入、搜索、supersedes 原子性。

**Steps**:
1. 创建 `tests/integration/workspace/memory.test.ts`：

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, withTransaction } from '../helpers/db.js'
import { describeWithDb } from '../helpers/skip.js'

let testDb: ReturnType<typeof createTestDb>

beforeAll(() => {
  testDb = createTestDb()
})

afterAll(async () => {
  await testDb.client.end()
})

describeWithDb('Memory operations (integration)', () => {
  test('writeMemory and searchMemory round-trip', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({
        type: 'semantic',
        content: 'Cortex determined user intent is to schedule a meeting',
        tags: ['intent', 'schedule'],
        entityId: 'user-alice',
      })

      const results = await ws.searchMemory({ type: 'semantic', tags: ['intent'] })
      expect(results.length).toBeGreaterThanOrEqual(1)
      const found = results.find((m) => m.entityId === 'user-alice')
      expect(found).toBeTruthy()
      expect(found!.content).toContain('schedule a meeting')
    })
  })

  test('searchMemory tags AND semantics: all tags must match', async () => {
    await withTransaction(testDb.db, async (ws) => {
      await ws.writeMemory({
        type: 'semantic',
        content: 'Memory with tags A and B',
        tags: ['tagA', 'tagB'],
      })
      await ws.writeMemory({
        type: 'semantic',
        content: 'Memory with only tag A',
        tags: ['tagA'],
      })

      // Search for both A and B — should only match the first record
      const results = await ws.searchMemory({ tags: ['tagA', 'tagB'] })
      const withBoth = results.filter((m) => m.tags.includes('tagB'))
      const withoutB = results.filter((m) => !m.tags.includes('tagB') && m.tags.includes('tagA'))

      expect(withBoth.length).toBeGreaterThanOrEqual(1)
      expect(withoutB.length).toBe(0)  // tagA-only record should NOT appear
    })
  })

  test('supersedes_id: atomically invalidates old record', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const original = await ws.writeMemory({
        type: 'procedural',
        content: 'Old procedure for task X',
        tags: ['procedure', 'taskX'],
      })

      const updated = await ws.writeMemory({
        type: 'procedural',
        content: 'Updated procedure for task X (v2)',
        tags: ['procedure', 'taskX'],
        supersedesId: original.id,
      })

      // 新记录存在
      expect(updated.supersedesId).toBe(original.id)

      // 旧记录已被软删除
      const all = await ws.searchMemory({ type: 'procedural', excludeInvalid: false })
      const old = all.find((m) => m.id === original.id)
      expect(old).toBeTruthy()
      expect(old!.tInvalid).not.toBeNull()

      // searchMemory 默认排除失效记录
      const valid = await ws.searchMemory({ type: 'procedural' })
      const ids = valid.map((m) => m.id)
      expect(ids).not.toContain(original.id)  // 旧记录不在结果中
      expect(ids).toContain(updated.id)        // 新记录在结果中
    })
  })

  test('markMemoryUsed increments correct counter', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const mem = await ws.writeMemory({
        type: 'episodic',
        content: 'Brainstem executed tool call successfully',
      })

      await ws.markMemoryUsed([mem.id], 'positive')
      await ws.markMemoryUsed([mem.id], 'positive')
      await ws.markMemoryUsed([mem.id], 'negative')

      const results = await ws.searchMemory({ type: 'episodic', excludeInvalid: false })
      const updated = results.find((m) => m.id === mem.id)
      expect(updated!.usageOutcomes.positive).toBe(2)
      expect(updated!.usageOutcomes.negative).toBe(1)
      expect(updated!.usageOutcomes.neutral).toBe(0)
    })
  })

  test('clearWorkingMemory removes only working memories for that thread', async () => {
    await withTransaction(testDb.db, async (ws) => {
      const threadId = 'test-thread-uuid'

      await ws.writeMemory({ type: 'working', content: 'working memory 1', threadId })
      await ws.writeMemory({ type: 'working', content: 'working memory 2', threadId })
      await ws.writeMemory({ type: 'semantic', content: 'semantic memory', threadId })

      await ws.clearWorkingMemory(threadId)

      const remaining = await ws.searchMemory({ excludeInvalid: false })
      const workingForThread = remaining.filter(
        (m) => m.type === 'working' && m.threadId === threadId
      )
      const semanticForThread = remaining.filter(
        (m) => m.type === 'semantic' && m.threadId === threadId
      )

      expect(workingForThread).toHaveLength(0)   // working 已删除
      expect(semanticForThread).toHaveLength(1)  // semantic 保留
    })
  })
})
```

**Files**: `tests/integration/workspace/memory.test.ts`（新建）

---

## Risks & Mitigations

- **测试 DB 连接失败**: `isTestDbAvailable()` 检查环境变量，`describeWithDb` 在变量缺失时跳过整个 describe 块并打印提示——不影响 CI（如果 CI 没有 PostgreSQL）
- **并发测试不稳定**: T033 的 `Promise.all(10 writes)` 依赖 advisory lock。如果 lock 实现有问题，行数可能超过 capacity。这是有意为之的关键验证点。
- **withTransaction 回滚策略**: 通过故意抛出带标记的对象来触发 Drizzle 的事务回滚，同时传递测试结果。这是一个已知的模式，但需要确认 Drizzle 0.38 的 transaction 行为与此兼容。

## Definition of Done Checklist

- [ ] T031: `tests/integration/helpers/db.ts` 实现 `createTestDb()` + `withTransaction()`，环境变量缺失时 gracefully skip
- [ ] T032: Thread & Slot 集成测试——lifecycle、updateState、getActive、upsert 全部通过
- [ ] T033: Pending 集成测试——容量淘汰、advisory lock 并发写（10 个 Promise.all）验证通过
- [ ] T034: Memory 集成测试——write、tags AND、supersedes 原子性、markUsed、clearWorking 全部通过
- [ ] `bun run test:integration` 全部通过（需 `AIMA_TEST_DATABASE_URL`）

## Review Guidance

- 检查 `withTransaction` 的回滚策略是否正确——通过故意 throw + catch 模式触发回滚
- 检查并发测试 T033 的断言：`concurrentObs.length <= capacity`（不是等于）
- 检查 T034 的 supersedes 测试：同时验证新记录存在、旧记录 `t_invalid` 非 null、默认查询不包含旧记录
- 确认 `beforeAll`/`afterAll` 正确关闭 postgres 连接（`client.end()`），避免 vitest 进程无法退出

## Activity Log

- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
- 2026-03-10T11:35:00Z – claude – shell_pid=36246 – lane=doing – Started implementation via workflow command
