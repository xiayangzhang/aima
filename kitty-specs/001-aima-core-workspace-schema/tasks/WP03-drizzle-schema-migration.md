---
work_package_id: WP03
title: Drizzle Schema + Migration
lane: "doing"
dependencies: []
subtasks:
- T012
- T013
- T014
- T015
- T016
- T017
phase: Phase 1 - Foundation
assignee: ''
agent: "claude"
shell_pid: "10053"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-10T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP03 — Drizzle Schema + Migration

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, read Review Feedback section first.

---

## Review Feedback

*[Empty — no feedback yet]*

---

## Objectives & Success Criteria

4 张表的 Drizzle schema 定义完成，迁移文件生成并执行成功。完成标准：
- `bun run db:generate` 成功生成迁移文件（`drizzle/migrations/` 下有 SQL 文件）
- `bun run db:migrate` 在测试数据库上执行成功，无报错
- `\dt` 列出 4 张表：threads / slots / memories / pending_observations
- 所有列、枚举、约束、索引与 `data-model.md` 完全一致
- `bun run typecheck` 零错误（schema 文件类型正确）

## Context & Constraints

- **Repo**: `/Volumes/leoyun/aima/`
- **Data Model**: `kitty-specs/001-aima-core-workspace-schema/data-model.md`（权威 SQL 定义）
- **Types**: `src/types/index.ts`（WP02 输出，pgEnum 值必须引用这里的类型值）
- **DB**: PostgreSQL 16+，连接信息从 `.env` 读取（`DATABASE_URL`）
- **Drizzle**: `drizzle-orm` ^0.38.0 + `drizzle-kit` ^0.30.0，dialect: postgresql
- **Driver**: `postgres` (npm)，不是 `pg`

实现命令：`spec-kitty implement WP03 --base WP02`

---

## Subtasks & Detailed Guidance

### T012 — `src/schema/threads.ts`

**Purpose**: 定义 threads 表和 thread_state enum。

**Steps**:
1. 创建 `src/schema/threads.ts`：

```typescript
import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const threadStateEnum = pgEnum('thread_state', [
  'active',
  'waiting',
  'complete',
  'interrupted',
])

export const threads = pgTable('threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: threadStateEnum('state').notNull().default('active'),
  sourceChannel: text('source_channel'),
  initiatedBy: text('initiated_by').notNull(),
  trigger: text('trigger'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type ThreadRow = typeof threads.$inferSelect
export type NewThreadRow = typeof threads.$inferInsert
```

2. 验证枚举值与 `src/types/index.ts` 中 `ThreadState` 的值完全一致（4个值）。

**Files**: `src/schema/threads.ts`（新建）

---

### T013 — `src/schema/slots.ts`

**Purpose**: 定义 slots 表，包含 brain_type、slot_status 两个 enum，以及 UNIQUE(thread_id, brain) 约束。

**Steps**:
1. 创建 `src/schema/slots.ts`：

```typescript
import { jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { threads } from './threads.js'

export const brainTypeEnum = pgEnum('brain_type', [
  'limbic',
  'cortex',
  'brainstem',
  'amygdala',
  'dmn',
])

export const slotStatusEnum = pgEnum('slot_status', [
  'pending',
  'running',
  'done',
  'error',
])

export const slots = pgTable(
  'slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    brain: brainTypeEnum('brain').notNull(),
    status: slotStatusEnum('status').notNull().default('pending'),
    input: jsonb('input'),
    output: jsonb('output'),
    intent: text('intent'),          // 'communicate' | 'execute' | 'both', Cortex only
    complexityHint: text('complexity_hint'),  // 'simple' | 'complex', Cortex only
    executionSessionId: text('execution_session_id'),  // Brainstem only
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    threadBrainUnique: unique('slots_thread_brain_unique').on(table.threadId, table.brain),
  }),
)

export type SlotRow = typeof slots.$inferSelect
export type NewSlotRow = typeof slots.$inferInsert
```

2. 确认 `brainTypeEnum` 的 5 个值与 `BrainType` 完全一致。
3. 确认 UNIQUE 约束名称 `slots_thread_brain_unique`（writeSlot upsert 时需要知道约束名）。

**注意**: `intent` 和 `complexityHint` 存为 text 而非 enum，因为 Cortex 可能传 null，且避免额外 pgEnum 迁移复杂度。

**Files**: `src/schema/slots.ts`（新建）

---

### T014 — `src/schema/memories.ts`

**Purpose**: 定义 memories 表，包含 memory_type enum、GIN index on tags、supersedes_id 自引用。

**Steps**:
1. 创建 `src/schema/memories.ts`：

```typescript
import {
  boolean,
  float8,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const memoryTypeEnum = pgEnum('memory_type', [
  'semantic',
  'episodic',
  'procedural',
  'working',
  'implicit',
])

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: memoryTypeEnum('type').notNull(),
    content: text('content').notNull(),
    entityId: text('entity_id'),
    segmentId: text('segment_id'),
    segmentSeq: integer('segment_seq'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    baseImportance: float8('base_importance').notNull().default(0.5),
    usageOutcomes: jsonb('usage_outcomes')
      .notNull()
      .default(sql`'{"positive":0,"negative":0,"neutral":0}'::jsonb`),
    sourceBrain: text('source_brain'),
    threadId: text('thread_id'),
    sessionId: text('session_id'),
    supersedesId: uuid('supersedes_id').references((): ReturnType<typeof uuid> => memories.id),
    tInvalid: timestamp('t_invalid', { withTimezone: true }),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    pinned: boolean('pinned').notNull().default(false),
    forgotten: boolean('forgotten').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    typeIdx: index('idx_memories_type').on(table.type),
    tagsIdx: index('idx_memories_tags').using('gin', table.tags),
    entityIdIdx: index('idx_memories_entity_id').on(table.entityId),
    segmentIdIdx: index('idx_memories_segment_id').on(table.segmentId),
    tInvalidIdx: index('idx_memories_t_invalid')
      .on(table.tInvalid)
      .where(sql`t_invalid IS NULL`),
    threadIdIdx: index('idx_memories_thread_id').on(table.threadId),
  }),
)

export type MemoryRow = typeof memories.$inferSelect
export type NewMemoryRow = typeof memories.$inferInsert
```

2. **GIN 索引**: `using('gin', table.tags)` 支持 `@>` 操作符（tags 包含查询）。
3. **自引用 FK**: `supersedesId` 使用 `(): ReturnType<typeof uuid>` 延迟引用避免循环依赖。
4. **部分索引 tInvalidIdx**: `WHERE t_invalid IS NULL` 只索引有效记忆，大幅减少索引大小。
5. **float8**: Drizzle 的 `float8()` 对应 PostgreSQL `DOUBLE PRECISION`，用于 `base_importance`。

**Files**: `src/schema/memories.ts`（新建）

---

### T015 — `src/schema/pending.ts`

**Purpose**: 定义 pending_observations 表和 3 个索引。

**Steps**:
1. 创建 `src/schema/pending.ts`：

```typescript
import { float8, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const pendingObservations = pgTable(
  'pending_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetBrain: text('target_brain').notNull(),  // BrainType value
    note: text('note').notNull(),
    triggerAt: timestamp('trigger_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    baseImportance: float8('base_importance').notNull().default(0.5),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiresAtIdx: index('idx_pending_expires_at').on(table.expiresAt),
    triggerAtIdx: index('idx_pending_trigger_at').on(table.triggerAt),
    baseImportanceIdx: index('idx_pending_base_importance').on(table.baseImportance),
  }),
)

export type PendingRow = typeof pendingObservations.$inferSelect
export type NewPendingRow = typeof pendingObservations.$inferInsert
```

2. `targetBrain` 存为 text（不是 brainTypeEnum）——避免 pending 表强依赖 brain_type enum，保持独立性。
3. 三个索引目的：
   - `expires_at`：`removeExpiredPending` 批量清理
   - `trigger_at`：`getPendingObservations` 路由判断（立即路由 vs 定时触发）
   - `base_importance`：容量淘汰时排序

**Files**: `src/schema/pending.ts`（新建）

---

### T016 — `src/schema/index.ts`

**Purpose**: 统一 re-export，供 workspace 模块和 drizzle.config.ts 使用。

**Steps**:
1. 创建 `src/schema/index.ts`：

```typescript
export * from './threads.js'
export * from './slots.js'
export * from './memories.js'
export * from './pending.js'
```

2. 更新 `drizzle.config.ts` 确认 schema 路径指向 `./src/schema/index.ts`（WP01 中已配置，验证即可）。

**Files**: `src/schema/index.ts`（新建）

---

### T017 — 执行 migration 验证

**Purpose**: 用 drizzle-kit 生成迁移 SQL 并在测试数据库上执行，验证 schema 定义正确。

**Prerequisites**:
- 本地 PostgreSQL 已运行（见 `quickstart.md` 的 Docker 启动命令）
- `.env` 文件存在，包含 `DATABASE_URL=postgres://aima:aima@localhost:5432/aima_dev`

**Steps**:
1. 生成迁移文件：
```bash
cd /Volumes/leoyun/aima
bun run db:generate
```
预期：`drizzle/migrations/` 下生成 `0000_*.sql` 文件，包含所有 CREATE TABLE、CREATE TYPE、CREATE INDEX 语句。

2. 执行迁移：
```bash
bun run db:migrate
```
预期：无报错，控制台输出迁移成功信息。

3. 验证表结构（连接数据库后）：
```sql
-- 4 张表
\dt
-- 确认枚举类型
\dT+ brain_type
\dT+ thread_state
\dT+ slot_status
\dT+ memory_type
-- 确认 slots 唯一约束
\d slots
-- 确认 memories GIN 索引
\d memories
```

4. 运行 `bun run typecheck` 确认 schema 文件的类型正确。

**如果 migration 失败**:
- 检查 `DATABASE_URL` 是否正确
- 检查 PostgreSQL 是否运行：`docker ps | grep aima-postgres`
- 查看 drizzle-kit 输出的完整错误信息

**Files**: 只运行命令，生成 `drizzle/migrations/0000_*.sql`

---

## Risks & Mitigations

- **pgEnum 变更破坏性**: 一旦 enum 值写入生产数据，添加/删除值需要迁移脚本。初期一次性把所有值定义完整，避免后续迁移复杂度。
- **自引用 FK 循环依赖**: `supersedesId` 用 `() =>` 延迟引用，TypeScript 编译时避免循环引用错误。
- **GIN 索引语法**: Drizzle 0.38 的 `.using('gin', ...)` 语法——确认使用的版本支持此语法，否则回退到 `sql` raw 方式。

## Definition of Done Checklist

- [ ] T012: `threads` 表 + `threadStateEnum` 定义正确
- [ ] T013: `slots` 表 + `brainTypeEnum` + `slotStatusEnum` + UNIQUE 约束定义正确
- [ ] T014: `memories` 表 + `memoryTypeEnum` + GIN index + 自引用 FK 定义正确
- [ ] T015: `pending_observations` 表 + 3 个索引定义正确
- [ ] T016: `src/schema/index.ts` re-export 所有表和 enum
- [ ] T017: `bun run db:generate` 生成迁移文件，`bun run db:migrate` 执行成功，4 张表存在于数据库

## Review Guidance

- 核对 `brainTypeEnum` 的 5 个值与 data-model.md `brain_type` 枚举完全一致
- 核对 `memories` 表的 `tags` 默认值是 `'{}'::text[]`（Postgres array，不是 JSON array）
- 核对 `usage_outcomes` 默认值是正确的 JSONB（`{"positive":0,"negative":0,"neutral":0}`）
- 确认 `slots` 的 UNIQUE 约束使用了自定义名称（写 upsert 时需要引用此名称）
- 确认 `memories` 的部分索引 `WHERE t_invalid IS NULL` 已包含

## Activity Log

- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
- 2026-03-10T10:08:58Z – claude – shell_pid=97661 – lane=doing – Started implementation via workflow command
- 2026-03-10T10:13:30Z – claude – shell_pid=97661 – lane=for_review – Ready for review: 4 schema files (threads/slots/memories/pending_observations) + schema/index.ts. db:generate ✓ (0000_huge_legion.sql), db:migrate ✓ (4 tables + 4 enums). slots UNIQUE constraint ✓, memories GIN index ✓, partial index WHERE t_invalid IS NULL ✓. Note: tsconfig changed NodeNext→Bundler (needed for drizzle-kit CJS compat + tsup bundled lib pattern)
- 2026-03-10T10:16:20Z – claude – shell_pid=10053 – lane=doing – Started review via workflow command
