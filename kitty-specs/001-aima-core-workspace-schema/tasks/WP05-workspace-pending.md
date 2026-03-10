---
work_package_id: WP05
title: CognitiveWorkspace — Pending Observations
lane: planned
dependencies: []
subtasks:
- T022
- T023
- T024
- T025
phase: Phase 2 - Core DAO
assignee: ''
agent: ''
shell_pid: ''
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-10T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP05 — CognitiveWorkspace — Pending Observations

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, read Review Feedback section first.

---

## Review Feedback

*[Empty — no feedback yet]*

---

## Objectives & Success Criteria

Pending observations 完整 DAO 实现，含 advisory lock 并发保护和容量淘汰。完成标准：
- `bun test tests/unit/workspace/pending.test.ts` 全部通过
- `writePending` 在正常情况下返回正确的 `PendingObservation`
- 容量淘汰逻辑：写入超限时，按 `base_importance ASC, added_at ASC` 删除旧记录（单元测试 mock 验证逻辑）
- advisory lock 语句在 SQL 层面正确（集成测试 WP07 验证并发安全）

## Context & Constraints

- **Repo**: `/Volumes/leoyun/aima/`
- **Advisory lock key**: `hashtext('aima_pending_write')`，用 `pg_advisory_xact_lock`（事务级锁，事务结束自动释放）
- **容量上限**: 默认 100，通过 `CognitiveWorkspaceOptions.pendingCapacity` 配置
- **淘汰策略**: `base_importance ASC`（最低重要度优先淘汰），同等重要度时 `added_at ASC`（最早写入优先淘汰）——长期预测（trigger_at 最远）比低重要度记录更有价值

实现命令：`spec-kitty implement WP05 --base WP03`

---

## Subtasks & Detailed Guidance

### T022 — writePending + advisory lock

**Purpose**: 实现 writePending，包含 advisory lock 获取、容量检查、淘汰、insert，全部在一个事务内完成。

**Steps**:
1. 在 `src/workspace/index.ts` 中替换 `writePending` 的 throw 占位：

```typescript
import { sql, lt, or, isNull, asc } from 'drizzle-orm'
import { pendingObservations } from '../schema/index.js'

async writePending(params: CreatePendingParams): Promise<PendingObservation> {
  return await this.db.transaction(async (tx) => {
    // 1. 获取事务级 advisory lock，序列化并发写入
    //    pg_advisory_xact_lock 在事务结束时自动释放，不需要显式解锁
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('aima_pending_write'))`)

    // 2. 统计当前有效记录数（未过期的）
    const now = new Date()
    const [countResult] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingObservations)
      .where(lt(pendingObservations.expiresAt, now).negate())  // expires_at >= now

    const currentCount = countResult?.count ?? 0

    // 3. 超限时淘汰低优先级记录
    if (currentCount >= this.pendingCapacity) {
      const excess = currentCount - this.pendingCapacity + 1  // +1 为即将写入的记录腾位置
      const toEvict = await tx
        .select({ id: pendingObservations.id })
        .from(pendingObservations)
        .where(lt(pendingObservations.expiresAt, now).negate())
        .orderBy(asc(pendingObservations.baseImportance), asc(pendingObservations.addedAt))
        .limit(excess)

      if (toEvict.length > 0) {
        const evictIds = toEvict.map((r) => r.id)
        await tx
          .delete(pendingObservations)
          .where(inArray(pendingObservations.id, evictIds))
      }
    }

    // 4. 插入新记录
    const [row] = await tx
      .insert(pendingObservations)
      .values({
        targetBrain: params.targetBrain,
        note: params.note,
        triggerAt: params.triggerAt ?? null,
        expiresAt: params.expiresAt,
        baseImportance: params.baseImportance ?? 0.5,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')
    return mapPendingRow(row)
  })
}
```

**Advisory lock 说明**:
- `pg_advisory_xact_lock(hashtext('aima_pending_write'))` 是事务级排它锁
- 同一 key 的并发事务会等待前一个事务完成后才继续
- 事务回滚或提交时锁自动释放
- `hashtext('aima_pending_write')` 将字符串 key 转换为 bigint（advisory lock 接受 bigint）

**容量淘汰说明**:
- 先过滤有效记录（`expires_at >= now`），避免对已过期记录计数
- 淘汰顺序：`base_importance ASC`（最低重要度先淘汰），`added_at ASC`（最早写入先淘汰）
- "长期预测"（`trigger_at` 最远）不作为淘汰因素——重要度低的近期预测先被淘汰

**Files**: `src/workspace/index.ts`（修改）

---

### T023 — 实现 getPendingObservations、removeExpiredPending、removePending

**Purpose**: 三个查询/删除操作，逻辑相对简单。

**Steps**:
1. 替换对应的 throw 占位：

```typescript
// getPendingObservations — 返回所有未过期记录，按 triggerAt 排序（null 排前面 = 立即路由）
async getPendingObservations(): Promise<PendingObservation[]> {
  const now = new Date()
  const rows = await this.db
    .select()
    .from(pendingObservations)
    .where(lt(pendingObservations.expiresAt, now).negate())  // expires_at >= now
    .orderBy(
      // null triggerAt 排前面（立即路由），非 null 按时间升序
      sql`${pendingObservations.triggerAt} ASC NULLS FIRST`,
    )
  return rows.map(mapPendingRow)
}

// removeExpiredPending — 批量清理过期记录
async removeExpiredPending(now: Date): Promise<void> {
  await this.db
    .delete(pendingObservations)
    .where(lt(pendingObservations.expiresAt, now))  // expires_at < now
}

// removePending — 按 ID 删除（路由完成后调用）
async removePending(id: string): Promise<void> {
  await this.db
    .delete(pendingObservations)
    .where(eq(pendingObservations.id, id))
}
```

2. 添加 mapper：

```typescript
function mapPendingRow(row: typeof pendingObservations.$inferSelect): PendingObservation {
  return {
    id: row.id,
    targetBrain: row.targetBrain as BrainType,
    note: row.note,
    triggerAt: row.triggerAt,
    expiresAt: row.expiresAt,
    baseImportance: row.baseImportance,
    addedAt: row.addedAt,
  }
}
```

**Files**: `src/workspace/index.ts`（修改）

---

### T024 — 容量淘汰逻辑（包含在 T022 中）

**Purpose**: 容量淘汰是 writePending 事务的一部分，不是独立方法。此任务的工作是验证淘汰逻辑的正确性。

**Steps**:
1. 确认淘汰逻辑在 T022 中正确实现：
   - 只对**有效记录**（`expires_at >= now`）计数，不对已过期记录计数
   - 淘汰顺序：`base_importance ASC, added_at ASC`
   - 淘汰数量：`excess = currentCount - capacity + 1`（为新记录腾 1 个位置）

2. 边界情况确认：
   - 当前记录数 == capacity - 1：不淘汰，直接插入
   - 当前记录数 == capacity：淘汰 1 条，再插入
   - 当前记录数 > capacity（数据库里已超限）：淘汰到 capacity - 1，再插入（最终 = capacity）

**Files**: 无新文件（验证 T022 逻辑）

---

### T025 — Pending 单元测试

**Purpose**: 验证 writePending 的容量淘汰逻辑和其他 pending 操作。

**Steps**:
1. 创建 `tests/unit/workspace/pending.test.ts`。

2. Mock 策略：模拟 `db.transaction()` 回调，通过控制 SELECT COUNT 返回值来测试不同场景：

```typescript
import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { CognitiveWorkspace } from '../../../src/workspace/index.js'

// 重点测试场景
describe('writePending', () => {
  test('writes observation when under capacity')
  test('evicts lowest importance when at capacity')
  test('evicts oldest when same importance at capacity')
  test('does not count expired records toward capacity')
  test('returns PendingObservation with correct fields')
  test('uses default baseImportance 0.5 when not provided')
})

describe('getPendingObservations', () => {
  test('excludes expired observations')
  test('returns null triggerAt records first (immediate routing)')
})

describe('removeExpiredPending', () => {
  test('deletes records with expiresAt < now')
  test('keeps records with expiresAt >= now')
})

describe('removePending', () => {
  test('deletes record by id')
})
```

3. 注意：advisory lock 语句在单元测试中只需验证它被调用（`tx.execute` 被调用了）——并发安全性在 WP07 集成测试中验证。

4. 运行：
```bash
cd /Volumes/leoyun/aima
bun test tests/unit/workspace/pending.test.ts
```

**Files**: `tests/unit/workspace/pending.test.ts`（新建）

---

## Risks & Mitigations

- **Advisory lock 在单元测试中无法真正测试**: mock 只验证 SQL 语句被调用。并发正确性在 WP07 集成测试中验证（`Promise.all` 10 个并发 writePending）。
- **过期记录计数问题**: 如果不过滤过期记录，capacity 检查会把将被 `removeExpiredPending` 清理的记录也算进去，导致误淘汰。T022 的实现已用 `expires_at >= now` 过滤。
- **事务 + advisory lock 死锁**: 如果持有 advisory lock 的事务等待另一个持有 advisory lock 的事务，会死锁。这不会发生——advisory lock 用同一个 key，所有 writePending 调用会排队串行执行，不会形成环形等待。

## Definition of Done Checklist

- [ ] T022: `writePending` 实现完整——advisory lock + 容量检查 + 淘汰 + insert 全在一个事务
- [ ] T023: `getPendingObservations`（过滤过期）、`removeExpiredPending`（批量清理）、`removePending`（按 ID 删除）实现完整
- [ ] T024: 淘汰逻辑正确——按 `base_importance ASC, added_at ASC` 排序，只对未过期记录计数
- [ ] T025: `bun test tests/unit/workspace/pending.test.ts` 全部通过，覆盖容量淘汰路径

## Review Guidance

- 检查 advisory lock key 是否是 `hashtext('aima_pending_write')`（字符串 hash，统一使用）
- 检查容量计数是否**排除了已过期记录**（`expires_at >= now`）
- 检查淘汰顺序是否是 `base_importance ASC, added_at ASC`（不是 `trigger_at`）
- 检查 `removeExpiredPending` 的 `where` 条件是 `<` 而非 `<=`（严格小于 now）
- 检查 `getPendingObservations` 的排序：`triggerAt ASC NULLS FIRST`（null = 立即路由，排最前）

## Activity Log

- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
