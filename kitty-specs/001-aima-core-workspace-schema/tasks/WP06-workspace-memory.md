---
work_package_id: WP06
title: CognitiveWorkspace — Memory
lane: "doing"
dependencies: []
subtasks:
- T026
- T027
- T028
- T029
- T030
phase: Phase 2 - Core DAO
assignee: ''
agent: "claude"
shell_pid: "69705"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-10T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP06 — CognitiveWorkspace — Memory

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, read Review Feedback section first.

---

## Review Feedback

*[Empty — no feedback yet]*

---

## Objectives & Success Criteria

Memory 的完整 DAO 实现，含 supersedes_id 原子失效、searchMemory 多条件过滤、markMemoryUsed 计数器和 clearWorkingMemory。完成标准：
- `bun test tests/unit/workspace/memory.test.ts` 全部通过
- `writeMemory` 在有 `supersedesId` 时，新写和旧记录失效在同一事务内
- `searchMemory` 的 tags 过滤是 AND 匹配（entry 必须包含**所有**指定 tag）
- `markMemoryUsed` 正确递增对应计数器（`positive`/`negative`/`neutral`）

## Context & Constraints

- **Repo**: `/Volumes/leoyun/aima/`
- **supersedes 语义**: 写入新记录 + 将旧记录 `t_invalid` 设为当前时间，必须在同一 `db.transaction()` 内原子完成
- **tags AND 过滤**: 用 PostgreSQL `@>` 操作符（GIN 索引支持），`tags @> ARRAY['tag1', 'tag2']` 匹配包含所有 tag 的记录
- **markMemoryUsed 更新策略**: 应用层 SELECT + UPDATE（先读出 usage_outcomes JSONB，递增后写回），避免复杂的 JSONB 原地操作
- **excludeInvalid 默认 true**: 默认只返回 `t_invalid IS NULL` 的记录

实现命令：`spec-kitty implement WP06 --base WP03`

---

## Subtasks & Detailed Guidance

### T026 — writeMemory + supersedes_id 原子失效

**Purpose**: 实现 writeMemory，处理普通写入和带 supersedes_id 的原子失效-替换。

**Steps**:
1. 替换 `writeMemory` 的 throw 占位：

```typescript
import { memories } from '../schema/index.js'

async writeMemory(params: CreateMemoryParams): Promise<MemoryEntry> {
  const performInsert = async (tx: typeof this.db) => {
    const [row] = await tx
      .insert(memories)
      .values({
        type: params.type,
        content: params.content,
        entityId: params.entityId ?? null,
        segmentId: params.segmentId ?? null,
        segmentSeq: params.segmentSeq ?? null,
        tags: params.tags ?? [],
        baseImportance: params.baseImportance ?? 0.5,
        // usageOutcomes 使用 DB 默认值 {positive:0, negative:0, neutral:0}
        sourceBrain: params.sourceBrain ?? null,
        threadId: params.threadId ?? null,
        sessionId: params.sessionId ?? null,
        supersedesId: params.supersedesId ?? null,
        expiresAt: params.expiresAt ?? null,
        pinned: params.pinned ?? false,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')
    return row
  }

  if (params.supersedesId) {
    // 有 supersedesId：在事务内原子完成 insert + 旧记录失效
    const row = await this.db.transaction(async (tx) => {
      const newRow = await performInsert(tx)

      // 将被取代的旧记录标记为失效（软删除）
      await tx
        .update(memories)
        .set({ tInvalid: new Date(), updatedAt: new Date() })
        .where(eq(memories.id, params.supersedesId!))

      return newRow
    })
    return mapMemoryRow(row)
  }

  // 无 supersedesId：普通 insert
  const row = await performInsert(this.db)
  return mapMemoryRow(row)
}
```

2. 添加 memory mapper（注意 `usageOutcomes` 的 JSONB → TypeScript 转换）：

```typescript
function mapMemoryRow(row: typeof memories.$inferSelect): MemoryEntry {
  const outcomes = row.usageOutcomes as { positive: number; negative: number; neutral: number }
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    entityId: row.entityId,
    segmentId: row.segmentId,
    segmentSeq: row.segmentSeq,
    tags: row.tags,
    baseImportance: row.baseImportance,
    usageOutcomes: outcomes,
    sourceBrain: (row.sourceBrain as BrainType) ?? null,
    threadId: row.threadId,
    sessionId: row.sessionId,
    supersedesId: row.supersedesId,
    tInvalid: row.tInvalid,
    lastAccessedAt: row.lastAccessedAt,
    pinned: row.pinned,
    forgotten: row.forgotten,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
```

**supersedes 原子性说明**:
- 事务确保：新记录写入成功 AND 旧记录标记失效，两者同时成功或同时回滚
- 旧记录只设 `t_invalid`（软删除），不物理删除——审计需要完整历史记录

**Files**: `src/workspace/index.ts`（修改）

---

### T027 — 实现 searchMemory

**Purpose**: 多条件过滤的 memory 检索，支持 type、tags、entityId、segmentId、excludeInvalid、limit。

**Steps**:
1. 替换 `searchMemory` 的 throw 占位：

```typescript
import { and, desc, isNull, arrayContains } from 'drizzle-orm'

async searchMemory(filters: MemorySearchFilters): Promise<MemoryEntry[]> {
  const conditions = []

  // type 过滤
  if (filters.type !== undefined) {
    conditions.push(eq(memories.type, filters.type))
  }

  // tags AND 过滤：entry 必须包含所有指定 tag
  // PostgreSQL: tags @> ARRAY['tag1', 'tag2']::text[]
  if (filters.tags && filters.tags.length > 0) {
    conditions.push(sql`${memories.tags} @> ${sql.array(filters.tags, 'text')}`)
  }

  // entityId 精确匹配
  if (filters.entityId !== undefined) {
    conditions.push(eq(memories.entityId, filters.entityId))
  }

  // segmentId 精确匹配
  if (filters.segmentId !== undefined) {
    conditions.push(eq(memories.segmentId, filters.segmentId))
  }

  // excludeInvalid 默认 true：只返回 t_invalid IS NULL 的记录
  if (filters.excludeInvalid !== false) {
    conditions.push(isNull(memories.tInvalid))
  }

  const rows = await this.db
    .select()
    .from(memories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(memories.baseImportance))  // 高重要度记录排前面
    .limit(filters.limit ?? 20)

  return rows.map(mapMemoryRow)
}
```

**tags 过滤说明**:
- `@>` 操作符：左边的 array 包含右边的所有元素（AND 语义）
- `sql.array(filters.tags, 'text')` 生成正确的 PostgreSQL `ARRAY[...]::text[]` 类型转换
- GIN 索引（WP03 T014 中定义）会加速此查询

**Files**: `src/workspace/index.ts`（修改）

---

### T028 — 实现 markMemoryUsed

**Purpose**: 批量递增多条记忆的 usage_outcomes 计数器。

**Steps**:
1. 替换 `markMemoryUsed` 的 throw 占位：

```typescript
async markMemoryUsed(ids: string[], outcome: UsageOutcome): Promise<void> {
  if (ids.length === 0) return

  // 应用层 SELECT + UPDATE 策略：
  // 先读出 JSONB 字段，在应用层递增，再写回
  // 避免复杂的 PostgreSQL jsonb_set 语法
  const rows = await this.db
    .select({ id: memories.id, usageOutcomes: memories.usageOutcomes })
    .from(memories)
    .where(inArray(memories.id, ids))

  // 批量 UPDATE（在事务外逐条更新，因为每条的新值不同）
  await this.db.transaction(async (tx) => {
    for (const row of rows) {
      const outcomes = row.usageOutcomes as { positive: number; negative: number; neutral: number }
      const updated = {
        ...outcomes,
        [outcome]: (outcomes[outcome] ?? 0) + 1,
      }
      await tx
        .update(memories)
        .set({ usageOutcomes: updated, updatedAt: new Date() })
        .where(eq(memories.id, row.id))
    }
  })
}
```

**设计说明**:
- SELECT + UPDATE 的 race condition：如果两个调用同时 markUsed 同一条记忆，计数器可能丢失一次更新。这是可接受的最终一致性——usage_outcomes 是统计数据，不是精确账本。
- 用事务包裹所有 UPDATE：确保整批更新全部成功或全部回滚（防止部分更新的不一致状态）
- `ids.length === 0` 早返回：避免空数组传给 `inArray`（可能报错）

**Files**: `src/workspace/index.ts`（修改）

---

### T029 — 实现 clearWorkingMemory

**Purpose**: 清除指定 thread 的所有 working 类型记忆（Thread 结束时调用）。

**Steps**:
1. 替换 `clearWorkingMemory` 的 throw 占位：

```typescript
async clearWorkingMemory(threadId: string): Promise<void> {
  await this.db
    .delete(memories)
    .where(
      and(
        eq(memories.type, 'working'),
        eq(memories.threadId, threadId),
      ),
    )
}
```

**说明**:
- 物理删除（不是软删除 `t_invalid`）：working memory 是临时的，Thread 结束后不再需要
- 如果担心删错，可以在 WHERE 再加 `AND t_invalid IS NULL`，但这是多余的——所有 working memory 在 Thread 结束前都应该是有效的

**Files**: `src/workspace/index.ts`（修改）

---

### T030 — Memory 单元测试

**Purpose**: 验证所有 memory 方法的正确行为，重点测试 supersedes 失效和 searchMemory 过滤语义。

**Steps**:
1. 创建 `tests/unit/workspace/memory.test.ts`。

2. 必须覆盖的测试用例：

```typescript
describe('writeMemory', () => {
  test('writes memory with correct fields and defaults')
  test('uses default baseImportance 0.5 when not provided')
  test('uses default tags [] when not provided')
  test('uses default pinned false when not provided')

  describe('with supersedesId', () => {
    test('atomically inserts new and invalidates old (sets t_invalid)')
    test('new record has supersedesId pointing to old record')
    test('old record has t_invalid set to a Date')
  })
})

describe('searchMemory', () => {
  test('returns all valid memories when no filters')
  test('excludes t_invalid records by default (excludeInvalid: true)')
  test('includes t_invalid records when excludeInvalid: false')
  test('filters by type correctly')
  test('filters by tags with AND semantics (all tags must match)')
  test('filters by entityId')
  test('filters by segmentId')
  test('respects limit (default 20)')
  test('orders by baseImportance DESC')
})

describe('markMemoryUsed', () => {
  test('increments positive counter for outcome: positive')
  test('increments negative counter for outcome: negative')
  test('increments neutral counter for outcome: neutral')
  test('handles empty ids array (no-op)')
  test('updates multiple memories in one call')
})

describe('clearWorkingMemory', () => {
  test('deletes all working memories for the thread')
  test('does not delete non-working memories for the same thread')
  test('does not delete working memories for other threads')
})
```

3. 运行：
```bash
cd /Volumes/leoyun/aima
bun test tests/unit/workspace/memory.test.ts
```

**Files**: `tests/unit/workspace/memory.test.ts`（新建）

---

## Risks & Mitigations

- **tags `@>` 操作符语法**: Drizzle 的 `sql` tagged template 生成正确的 PostgreSQL 参数化查询。确认 `sql.array(tags, 'text')` 生成 `ARRAY[$1, $2, ...]::text[]` 格式，而非字符串拼接。
- **markMemoryUsed race condition**: 应用层 SELECT + UPDATE 在高并发下可能丢失更新。当前设计接受最终一致性（usage_outcomes 是统计数据）。如未来需要精确性，改用 PostgreSQL `jsonb_set` 原地更新。
- **supersedes 事务失败**: 如果旧记录 ID 不存在，UPDATE 不会报错（影响 0 行）。这是可接受的——调用方负责传入正确的 supersedesId。

## Definition of Done Checklist

- [ ] T026: `writeMemory` 普通路径和 supersedes 路径都实现，后者用 `db.transaction()`
- [ ] T027: `searchMemory` 支持所有过滤条件，tags 用 `@>` AND 语义，`excludeInvalid` 默认 true
- [ ] T028: `markMemoryUsed` 递增对应计数器，处理空 ids 数组
- [ ] T029: `clearWorkingMemory` 物理删除指定 thread 的 working 类型记忆
- [ ] T030: `bun test tests/unit/workspace/memory.test.ts` 全部通过，覆盖 supersedes 失效和 tags AND 语义

## Review Guidance

- 检查 `writeMemory` 的 `supersedesId` 路径是否用了 `db.transaction()`（不是 `db.execute`）
- 检查 `searchMemory` 的 tags 过滤是否用 `@>` 而非 `IN` 或其他操作符（`@>` = 包含所有）
- 检查 `markMemoryUsed` 的空数组早返回，避免 `inArray` 接收空数组
- 检查 `clearWorkingMemory` 是物理删除（`delete`）而非软删除（`update t_invalid`）

## Activity Log

- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
- 2026-03-10T10:19:10Z – claude – shell_pid=14517 – lane=doing – Started implementation via workflow command
- 2026-03-10T10:48:40Z – claude – shell_pid=14517 – lane=for_review – Ready for review: writeMemory (supersedes tx), searchMemory (tags @> AND, excludeInvalid), markMemoryUsed (batch SELECT+UPDATE in tx), clearWorkingMemory (physical DELETE). 25 unit tests, all passing.
- 2026-03-10T10:52:57Z – claude – shell_pid=69705 – lane=doing – Started review via workflow command
