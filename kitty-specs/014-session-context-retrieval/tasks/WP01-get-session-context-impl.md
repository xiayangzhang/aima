---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
  - "T003"
  - "T004"
title: "getSessionContext Implementation"
phase: "Phase 1 - Implementation"
lane: "done"
assignee: ""
agent: "claude"
shell_pid: "38549"
review_status: "approved"
dependencies: []
reviewed_by: "XIAYANG ZHANG"
history:
  - timestamp: "2026-03-12T10:40:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
---

# Work Package Prompt: WP01 — getSessionContext Implementation

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` field. If `has_feedback`, scroll to Review Feedback section.
- **Mark as acknowledged**: Update `review_status: acknowledged` when you begin addressing feedback.

---

## Review Feedback

*[Empty initially — reviewers populate if work is returned.]*

---

## Objectives & Success Criteria

为 AIMA 的 `ICognitiveWorkspace` 接口新增并实现 `getSessionContext(sessionId)` 方法，同时补充缺失的 DB 索引和单元测试。完成后：

- `getSessionContext` 出现在 `ICognitiveWorkspace` 接口签名中
- `src/workspace/index.ts` 有完整实现
- `memories` 表有 `session_id` 索引（Drizzle schema + migration SQL）
- 6 个测试场景（V1–V6）全部通过
- `bun test` 全量零回归

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/014-session-context-retrieval/spec.md`
- **Plan**: `kitty-specs/014-session-context-retrieval/plan.md` — 含关键 Spec Correction Notes（参数名是 `sessionId` 不是 `threadId`；anchor = 最早记录）
- **Source files**:
  - `src/types/index.ts` — `ICognitiveWorkspace` 接口
  - `src/schema/memories.ts` — Drizzle schema
  - `src/workspace/index.ts` — 实现类
- **Test file**: `tests/unit/workspace/workspace-session-context.test.ts`（新建）
- **Depends on**: 无（WP01 是唯一 WP）
- **Constraint**: 不新增表/列；不改已有方法签名；不引入回归

### Key background

`MemoryEntry` 已有 `sessionId: string | null` 字段，对应 `memories.session_id` 列。DMN Reactive 从 `brain.complete` 事件 payload 取 brain 的 LLM session ID，调 `getSessionContext(sessionId)` 获取该 session 的事件历史，用于段分配和话题检测判断。

当前 `ICognitiveWorkspace` 接口**不含**该方法（`getSessionContext` 在整个 src/ 目录下零引用），需从零新增。

---

## Subtasks & Detailed Guidance

### Subtask T001 — 新增接口方法签名

**Purpose**: 在 `ICognitiveWorkspace` 接口中声明 `getSessionContext`，使所有实现类强制提供该方法。

**Location**: `src/types/index.ts`，`ICognitiveWorkspace` 接口的 `// ── Memory` 区块末尾，`getLatestSegmentStates()` 行之前。

**Steps**:

1. 打开 `src/types/index.ts`，找到 `ICognitiveWorkspace` 接口（约第 147 行）
2. 在 `getLatestSegmentStates()` 这一行**前面**新增：

```typescript
  getSessionContext(sessionId: string): Promise<{
    anchor: MemoryEntry | null
    events: MemoryEntry[]
  }>
```

结果片段（加上前后邻居行供定位）：
```typescript
  getProcedure(taskType: string, opts?: { limit?: number }): Promise<MemoryEntry[]>
  // ── DMN Segment Tracking ─────────────────────────────────────────────────
  getSessionContext(sessionId: string): Promise<{
    anchor: MemoryEntry | null
    events: MemoryEntry[]
  }>
  getLatestSegmentStates(): Promise<Map<string, { segmentId: string; nextSeq: number }>>
```

**Files**: `src/types/index.ts`

**Validation**:
- [ ] `grep -n "getSessionContext" src/types/index.ts` 有输出
- [ ] TypeScript 编译不报错（`bun run typecheck` 或类似命令；若无，等 T003 实现后再验证）

**Notes**: 方法返回类型内联，不需要新增独立 interface。

---

### Subtask T002 — 新增 sessionId DB 索引

**Purpose**: `memories` 表目前有 `threadId` 索引但没有 `sessionId` 索引。`getSessionContext` 按 `session_id` 查询，需要索引支撑性能。

**Location**: `src/schema/memories.ts`

**Steps**:

1. 打开 `src/schema/memories.ts`，找到 `(table) => ({` 部分（约第 50 行）
2. 在 `threadIdIdx` 行后新增：

```typescript
    sessionIdIdx: index('idx_memories_session_id')
      .on(table.sessionId)
      .where(sql`session_id IS NOT NULL`),
```

完整 index 区块应如下所示（新增行标注 `// NEW`）：
```typescript
  (table) => ({
    typeIdx: index('idx_memories_type').on(table.type),
    tagsIdx: index('idx_memories_tags').using('gin', table.tags),
    entityIdIdx: index('idx_memories_entity_id').on(table.entityId),
    segmentIdIdx: index('idx_memories_segment_id').on(table.segmentId),
    tInvalidIdx: index('idx_memories_t_invalid').on(table.tInvalid).where(sql`t_invalid IS NULL`),
    threadIdIdx: index('idx_memories_thread_id').on(table.threadId),
    sessionIdIdx: index('idx_memories_session_id')  // NEW
      .on(table.sessionId)
      .where(sql`session_id IS NOT NULL`),
  }),
```

3. 检查项目是否有 `migrations/` 目录或类似机制：

```bash
ls /Volumes/leoyun/aima/src/schema/
```

如果有 migration SQL 文件目录（如 `migrations/` 或 `drizzle/`），新增 migration 文件。如果项目使用 Drizzle `push`（开发环境），可以跳过 SQL 文件，只更新 schema。

**Migration SQL**（如需独立文件）：
```sql
-- Migration: add session_id index to memories table
CREATE INDEX IF NOT EXISTS idx_memories_session_id
  ON memories(session_id)
  WHERE session_id IS NOT NULL;
```

**Files**: `src/schema/memories.ts`（必改）；migration SQL 文件（视项目实际）

**Validation**:
- [ ] `grep -n "sessionIdIdx" src/schema/memories.ts` 有输出
- [ ] Schema 文件无语法错误

**Notes**: 使用局部索引（`WHERE session_id IS NOT NULL`）减少索引体积，与 `tInvalidIdx` 的模式一致。

---

### Subtask T003 — 实现 getSessionContext

**Purpose**: 在 `CognitiveWorkspace` 类中添加 `getSessionContext` 实现，满足接口约束。

**Location**: `src/workspace/index.ts`，`// ── Hippocampus Consolidation methods` 区块之前（`getEntityContext`、`findSimilarSituations`、`getProcedure` 附近）

**Steps**:

1. 打开 `src/workspace/index.ts`，确认顶部 import 已包含 `asc`（来自 drizzle-orm）。如果没有，在 import 列表中添加：

```typescript
import {
  and,
  // ... existing imports ...
  asc,  // ADD IF MISSING
  // ...
} from 'drizzle-orm'
```

2. 在 `getProcedure` 方法结束后、`// ── Hippocampus Consolidation methods` 注释前，新增：

```typescript
  async getSessionContext(sessionId: string): Promise<{
    anchor: MemoryEntry | null
    events: MemoryEntry[]
  }> {
    const rows = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.type, 'episodic'),
          eq(memories.sessionId, sessionId),
          isNull(memories.tInvalid),
          eq(memories.forgotten, false),
        ),
      )
      .orderBy(asc(memories.createdAt))

    if (rows.length === 0) return { anchor: null, events: [] }

    const events = rows.map(mapMemoryRow)
    return { anchor: events[0], events }
  }
```

**逻辑说明**：
- `type = 'episodic'`：只查 episodic，过滤掉 working/semantic/procedural/implicit
- `sessionId = sessionId`：严格按 session 隔离，不混入其他 session 的记忆
- `tInvalid IS NULL`：排除软删除记录（与 `searchMemory` 的 `excludeInvalid` 默认行为一致）
- `forgotten = false`：排除标记为 forgotten 的记录（与其他方法一致）
- `ORDER BY created_at ASC`：时间升序，最早记录在前
- `anchor = events[0]`：最早记录就是 anchor（时间戳最小）
- 空结果直接 early return `{ anchor: null, events: [] }`

**Files**: `src/workspace/index.ts`

**Validation**:
- [ ] `grep -n "getSessionContext" src/workspace/index.ts` 有输出
- [ ] TypeScript 编译无报错（interface 和 class 签名一致）
- [ ] `asc` 已正确 import（检查 import 区块）

**Edge cases**:
- `sessionId` 不存在 → 查询返回 0 行 → early return `{ anchor: null, events: [] }`，不抛异常 ✓
- 只有 1 条记录 → `events[0]` = anchor，`events` = `[anchor]`，两者指向同一条 ✓
- 全部记录软删除 → 0 行 → `{ anchor: null, events: [] }` ✓

---

### Subtask T004 — 单元测试

**Purpose**: 验证 `getSessionContext` 在 6 个核心场景下的行为，覆盖 spec 全部 acceptance criteria。

**Location**: 新建 `tests/unit/workspace/workspace-session-context.test.ts`

**Steps**:

1. 参考 `tests/unit/workspace/` 目录下现有测试文件，了解 workspace 测试的 setup 模式（DB mock 或 in-memory 还是真实 DB）

2. 新建 `tests/unit/workspace/workspace-session-context.test.ts`，包含以下 6 个测试场景：

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
// import workspace setup helpers from existing tests

describe('CognitiveWorkspace.getSessionContext', () => {
  // setup: 初始化 workspace（参考其他测试文件的 setup）

  // V1 — 正常返回多条记录（anchor = 最早，events 升序）
  it('returns anchor as earliest episodic and events in ascending order', async () => {
    const m1 = await workspace.writeMemory({ type: 'episodic', content: 'first', sessionId: 'sess-A' })
    // small delay or use fixed timestamps to ensure order
    const m2 = await workspace.writeMemory({ type: 'episodic', content: 'second', sessionId: 'sess-A' })
    const m3 = await workspace.writeMemory({ type: 'episodic', content: 'third', sessionId: 'sess-A' })

    const ctx = await workspace.getSessionContext('sess-A')

    expect(ctx.anchor).not.toBeNull()
    expect(ctx.anchor!.id).toBe(m1.id)
    expect(ctx.events).toHaveLength(3)
    expect(ctx.events[0].id).toBe(m1.id)
    expect(ctx.events[2].id).toBe(m3.id)
  })

  // V2 — 不存在的 sessionId 返回空结果，不抛异常
  it('returns { anchor: null, events: [] } for non-existent sessionId', async () => {
    const ctx = await workspace.getSessionContext('session-does-not-exist')

    expect(ctx.anchor).toBeNull()
    expect(ctx.events).toHaveLength(0)
  })

  // V3 — 跨 session 隔离：不混入其他 session 的记忆
  it('does not mix memories from other sessions', async () => {
    await workspace.writeMemory({ type: 'episodic', content: 'sess-A event', sessionId: 'sess-A' })
    await workspace.writeMemory({ type: 'episodic', content: 'sess-B event', sessionId: 'sess-B' })

    const ctx = await workspace.getSessionContext('sess-A')

    expect(ctx.events.every(e => e.sessionId === 'sess-A')).toBe(true)
    expect(ctx.events.some(e => e.sessionId === 'sess-B')).toBe(false)
  })

  // V4 — 软删除记录不出现在结果中
  it('excludes soft-deleted memories', async () => {
    const m = await workspace.writeMemory({ type: 'episodic', content: 'to delete', sessionId: 'sess-C' })
    await workspace.invalidateMemory(m.id)

    const ctx = await workspace.getSessionContext('sess-C')

    expect(ctx.anchor).toBeNull()
    expect(ctx.events).toHaveLength(0)
  })

  // V5 — 非 episodic 类型不返回
  it('only returns episodic memories, not other types', async () => {
    await workspace.writeMemory({ type: 'working', content: 'working mem', sessionId: 'sess-D' })
    await workspace.writeMemory({ type: 'semantic', content: 'semantic mem', sessionId: 'sess-D' })

    const ctx = await workspace.getSessionContext('sess-D')

    expect(ctx.anchor).toBeNull()
    expect(ctx.events).toHaveLength(0)
  })

  // V6 — 单条记录：anchor 和 events[0] 指向同一条
  it('returns same entry as both anchor and events[0] when only one record exists', async () => {
    const m = await workspace.writeMemory({ type: 'episodic', content: 'only one', sessionId: 'sess-E' })

    const ctx = await workspace.getSessionContext('sess-E')

    expect(ctx.anchor).not.toBeNull()
    expect(ctx.anchor!.id).toBe(m.id)
    expect(ctx.events).toHaveLength(1)
    expect(ctx.events[0].id).toBe(m.id)
  })
})
```

3. 参考 `tests/unit/workspace/` 目录下现有测试文件的 setup/teardown 模式，补充必要的 `beforeEach`/`afterEach` 代码（清空 memories 表或使用 isolated schema）

**Files**: `tests/unit/workspace/workspace-session-context.test.ts`（新建）

**Validation**:
- [ ] `bun test tests/unit/workspace/workspace-session-context.test.ts` → 6/6 pass
- [ ] `bun test` 全量 → 零新增 failure（注意：pre-existing failures 是已知的，不算回归）

**Edge case — 时序问题**：
如果测试数据库写入太快，多条 `writeMemory` 的 `createdAt` 可能相同（同一毫秒内）。参考现有测试看是否有类似处理。若需要，可以在测试内用不同的固定 `createdAt`（若 `CreateMemoryParams` 支持传入），或接受 `events` 包含 3 条但 anchor 是其中任一最早记录（只断言 `anchor.id` 在 events 中）。

---

## Risks & Mitigations

| 风险 | 可能性 | 缓解方案 |
|---|---|---|
| `asc` 未在 workspace.ts 顶部 import | 低（其他方法用了 `desc`，`asc` 可能缺失） | T003 第一步检查并添加 |
| 测试时序问题（同毫秒多条写入） | 中 | 参考现有测试的处理，或断言 events.length 而非精确顺序 |
| Drizzle schema 索引语法错误 | 低 | 参考现有 `tInvalidIdx` 的 `.where(sql\`...\`)` 写法 |
| Interface 实现不完整（TypeScript 报错） | 低 | T001 先加接口，T003 再实现；tsc 一次性验证 |

## Definition of Done Checklist

- [ ] `grep -n "getSessionContext" src/types/index.ts` → 有接口签名
- [ ] `grep -n "sessionIdIdx" src/schema/memories.ts` → 有索引定义
- [ ] `grep -n "getSessionContext" src/workspace/index.ts` → 有实现
- [ ] `bun test tests/unit/workspace/workspace-session-context.test.ts` → 6/6 pass
- [ ] `bun test` → 全量零新增 failure

## Review Guidance

- 验证 T001：`ICognitiveWorkspace` 中 `getSessionContext` 签名位置正确（Memory 区块，非 Segment 区块）
- 验证 T002：索引用了局部索引（`WHERE session_id IS NOT NULL`），不是全局索引
- 验证 T003：4 个 WHERE 条件都有（type=episodic、sessionId=?、tInvalid IS NULL、forgotten=false）；ORDER BY created_at ASC；anchor = events[0]
- 验证 T004：6 个测试场景都有，V3 验证了跨 session 隔离

## Activity Log

- 2026-03-12T10:40:00Z – system – lane=planned – Prompt created.
- 2026-03-12T12:28:43Z – claude – shell_pid=38549 – lane=doing – Started review via workflow command
- 2026-03-12T12:29:12Z – claude – shell_pid=38549 – lane=done – Review passed: all subtasks complete; 6/6 unit + 6/6 integration tests pass; 417 total zero regression; migration 0003 applied
