---
work_package_id: WP01
title: Thread Entity ID — Schema, Workspace, Runner, Tests
lane: "planned"
dependencies: []
subtasks:
- T001
- T002
- T003
phase: Phase 1 - Implementation
assignee: ''
agent: ''
shell_pid: ''
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-13T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via spec-kitty agent
---

# Work Package Prompt: WP01 — Thread Entity ID: Schema, Workspace, Runner, Tests

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

打通 `entity_id` 从数据库到 Limbic Block 4 的完整链路：

1. **T001**: DB 迁移 + Drizzle schema + TypeScript 类型 + Workspace 方法更新
2. **T002**: Runner `buildBlock4Opts` 扩展——Limbic 优先使用 entityId
3. **T003**: 单元测试（≥6 个）

**Success Criteria**:
- `createThread({ entityId: 'user:alex', initiatedBy: 'external' })` 返回 `Thread`，`entityId === 'user:alex'`
- `createThread({ initiatedBy: 'external' })` 返回 `Thread`，`entityId === null`
- `buildBlock4Opts('limbic', { entityId: 'user:alex', trigger: '...' }, {})` 返回 `{ entityId: 'user:alex' }`
- `buildBlock4Opts('limbic', { entityId: null, trigger: 'hello' }, {})` 返回 `{ situation: 'hello' }`
- `buildBlock4Opts('cortex', { entityId: 'user:alex', trigger: 'hello' }, {})` 返回 `{ situation: 'hello' }`（Cortex 不变）
- Block 4 assembly：entityId hint 时调用 `getEntityContext`，不调用 `searchMemory`
- `bun run typecheck` 零错误，`biome check` 通过
- 现有测试零 regression

---

## Context

**Repository**: `/Volumes/leoyun/aima/`
**Implementation command**: `spec-kitty implement WP01`

### 现有代码：`src/schema/threads.ts`（当前）

```typescript
export const threads = pgTable('threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: threadStateEnum('state').notNull().default('active'),
  sourceChannel: text('source_channel'),
  initiatedBy: text('initiated_by').notNull(),
  trigger: text('trigger'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### 现有代码：`src/types/index.ts`（Thread 和 CreateThreadParams 当前定义）

```typescript
export interface Thread {
  id: string
  state: ThreadState
  sourceChannel: string | null
  initiatedBy: string
  trigger: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateThreadParams {
  trigger?: string
  initiatedBy: string
  sourceChannel?: string | null
}
```

### 现有代码：`src/workspace/index.ts`（mapThreadRow 和 createThread 当前实现）

```typescript
function mapThreadRow(row: typeof threads.$inferSelect): Thread {
  return {
    id: row.id,
    state: row.state,
    sourceChannel: row.sourceChannel,
    initiatedBy: row.initiatedBy,
    trigger: row.trigger,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async createThread(params: CreateThreadParams): Promise<Thread> {
  const [row] = await this.db
    .insert(threads)
    .values({
      initiatedBy: params.initiatedBy,
      trigger: params.trigger ?? null,
      sourceChannel: params.sourceChannel ?? null,
    })
    .returning()

  if (!row) throw new Error('Insert returned no rows')
  return mapThreadRow(row)
}
```

### 现有代码：`src/runner/index.ts`（`buildBlock4Opts` 当前实现）

```typescript
private buildBlock4Opts(
  brain: CognitiveBrainType,
  thread: Pick<Thread, 'trigger'>,
  slotMap: Record<string, Pick<Slot, 'output'> | undefined>,
): AssembleBlock4Opts | undefined {
  if (brain === 'limbic' || brain === 'cortex') {
    if (!thread.trigger) return undefined
    return { situation: thread.trigger }
  }

  if (brain === 'brainstem') {
    const cortexOutput = slotMap.cortex?.output as Record<string, unknown> | null | undefined
    const taskType = cortexOutput?.task_type as string | undefined
    const hint = taskType ?? thread.trigger ?? undefined
    if (!hint) return undefined
    return { taskType: hint }
  }

  return undefined
}
```

`buildBlock4Opts` 在两处被调用：
- `route()` 内部循环（`src/runner/index.ts:182`）：传入的 `thread` 对象是从 `workspace.getThread()` 取出的完整 `Thread`
- `trigger()` 方法（`src/runner/index.ts:217`）：同样是完整 `Thread`

两处调用都已经传完整 Thread，只需扩展 Pick 类型即可，不需要改调用点。

### 最新迁移文件（`drizzle/migrations/0004_vector_embedding.sql`）风格参考

```sql
-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to memories table
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
```

**文件结构**：
```
drizzle/migrations/
└── 0005_thread_entity_id.sql    ← T001: 新建

src/
├── schema/threads.ts            ← T001: 新增列
├── types/index.ts               ← T001: 更新接口
├── workspace/index.ts           ← T001: 更新 mapThreadRow + createThread
└── runner/index.ts              ← T002: 更新 buildBlock4Opts

tests/unit/                      ← T003: 新增测试
```

---

## Subtask Guidance

### T001: Schema + 迁移 + 类型 + Workspace

**Step 1**: 创建迁移文件 `drizzle/migrations/0005_thread_entity_id.sql`

```sql
-- Add entity_id to threads table
-- Nullable: not all threads are associated with a specific entity
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "entity_id" text;
```

**Step 2**: 更新 `src/schema/threads.ts`——在 `updatedAt` 之前插入新列：

```typescript
entityId: text('entity_id'),
```

完整表定义变为：
```typescript
export const threads = pgTable('threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: threadStateEnum('state').notNull().default('active'),
  sourceChannel: text('source_channel'),
  initiatedBy: text('initiated_by').notNull(),
  trigger: text('trigger'),
  entityId: text('entity_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

**Step 3**: 更新 `src/types/index.ts`——`Thread` 接口新增字段（在 `trigger` 之后）：

```typescript
export interface Thread {
  id: string
  state: ThreadState
  sourceChannel: string | null
  initiatedBy: string
  trigger: string | null
  entityId: string | null   // ← 新增：null = not entity-specific
  createdAt: Date
  updatedAt: Date
}
```

`CreateThreadParams` 新增可选参数（在 `sourceChannel` 之后）：

```typescript
export interface CreateThreadParams {
  trigger?: string
  initiatedBy: string
  sourceChannel?: string | null
  entityId?: string   // ← 新增：optional, defaults to null
}
```

**Step 4**: 更新 `src/workspace/index.ts`

`mapThreadRow` 新增映射（在 `trigger` 之后）：
```typescript
entityId: row.entityId,
```

`createThread` values 新增字段（在 `sourceChannel` 之后）：
```typescript
entityId: params.entityId ?? null,
```

**注意**：Drizzle 的 `$inferSelect` 会自动从 schema 推断 `entityId: string | null`，`row.entityId` 类型安全。

---

### T002: Runner 集成

**文件**: `src/runner/index.ts`

**变更 1**：扩展 `buildBlock4Opts` 的 Pick 类型签名，加入 `entityId`：

```typescript
private buildBlock4Opts(
  brain: CognitiveBrainType,
  thread: Pick<Thread, 'trigger' | 'entityId'>,   // ← 扩展
  slotMap: Record<string, Pick<Slot, 'output'> | undefined>,
): AssembleBlock4Opts | undefined {
```

**变更 2**：拆分 limbic/cortex 分支，Limbic 优先 entityId：

```typescript
if (brain === 'limbic') {
  if (thread.entityId) return { entityId: thread.entityId }
  if (thread.trigger) return { situation: thread.trigger }
  return undefined
}

if (brain === 'cortex') {
  if (!thread.trigger) return undefined
  return { situation: thread.trigger }
}
```

完整变更后的 `buildBlock4Opts`：

```typescript
private buildBlock4Opts(
  brain: CognitiveBrainType,
  thread: Pick<Thread, 'trigger' | 'entityId'>,
  slotMap: Record<string, Pick<Slot, 'output'> | undefined>,
): AssembleBlock4Opts | undefined {
  if (brain === 'limbic') {
    if (thread.entityId) return { entityId: thread.entityId }
    if (thread.trigger) return { situation: thread.trigger }
    return undefined
  }

  if (brain === 'cortex') {
    if (!thread.trigger) return undefined
    return { situation: thread.trigger }
  }

  if (brain === 'brainstem') {
    const cortexOutput = slotMap.cortex?.output as Record<string, unknown> | null | undefined
    const taskType = cortexOutput?.task_type as string | undefined
    const hint = taskType ?? thread.trigger ?? undefined
    if (!hint) return undefined
    return { taskType: hint }
  }

  return undefined
}
```

**注意**：两处调用点（`route()` 和 `trigger()`）都传完整 `Thread` 对象，Pick 类型扩展后无需修改调用点。

---

### T003: 测试（≥6 个）

找到现有测试文件中覆盖 `buildBlock4Opts` 或 `createThread` 的文件，在对应 describe block 中添加新测试。若没有现成文件，在 `tests/unit/` 创建 `runner-block4-opts.test.ts`。

**测试 1**: `createThread` with entityId 持久化
```typescript
// 验证 createThread({ entityId: 'user:alex', initiatedBy: 'test' })
// 返回的 Thread.entityId === 'user:alex'
// （需要 AIMA_TEST_DATABASE_URL，或 mock DB）
```

**测试 2**: `createThread` 无 entityId 时 entityId === null
```typescript
// createThread({ initiatedBy: 'test' }) → Thread.entityId === null
```

**测试 3**: `buildBlock4Opts` — Limbic + entityId 非 null
```typescript
// buildBlock4Opts('limbic', { entityId: 'user:alex', trigger: 'hello' }, {})
// 期望返回 { entityId: 'user:alex' }
// 不返回 { situation: 'hello' }
```

**测试 4**: `buildBlock4Opts` — Limbic + entityId null，有 trigger
```typescript
// buildBlock4Opts('limbic', { entityId: null, trigger: 'hello' }, {})
// 期望返回 { situation: 'hello' }（fallback 行为不变）
```

**测试 5**: `buildBlock4Opts` — Limbic + entityId null + 无 trigger
```typescript
// buildBlock4Opts('limbic', { entityId: null, trigger: null }, {})
// 期望返回 undefined
```

**测试 6**: `buildBlock4Opts` — Cortex 路径不受 entityId 影响（regression）
```typescript
// buildBlock4Opts('cortex', { entityId: 'user:alex', trigger: 'hello' }, {})
// 期望返回 { situation: 'hello' }（Cortex 不使用 entityId）
```

**测试 7**（可选）: Block 4 assembly — entityId hint 调用 `getEntityContext`
```typescript
// mock workspace.getEntityContext 和 workspace.searchMemory
// assembleBlock4('limbic', workspace, threadId, { entityId: 'user:alex' })
// 验证 getEntityContext('user:alex', { limit: 10 }) 被调用
// 验证 searchMemory 未被调用
```

**Mock 策略**：
- T001/T002 测试 `buildBlock4Opts`：直接实例化或调用私有方法（Bun test 支持），无需 DB
- T001 createThread 测试：若有 `AIMA_TEST_DATABASE_URL` 走集成测试；否则 mock `db.insert().values().returning()`
- T007 Block 4 测试：mock `CognitiveWorkspace` 的方法，不需要 DB

---

## Definition of Done

- [ ] T001: `0005_thread_entity_id.sql` 迁移文件创建
- [ ] T001: `src/schema/threads.ts` 新增 `entityId` 列
- [ ] T001: `src/types/index.ts` `Thread.entityId` + `CreateThreadParams.entityId` 更新
- [ ] T001: `src/workspace/index.ts` `mapThreadRow` + `createThread` 更新
- [ ] T002: `src/runner/index.ts` `buildBlock4Opts` Pick 类型扩展 + Limbic 分支逻辑更新
- [ ] T003: ≥6 测试全绿
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] 现有测试零 regression

---

## Risks & Notes

- **Drizzle schema vs DB 迁移同步**：`entityId` 列在 Drizzle schema 和 SQL 迁移中都要添加，缺一会导致 typecheck 失败或 runtime 错误。两处必须同时修改。
- **`$inferSelect` 类型**：Drizzle 从 `threads` schema 自动推断 `ThreadRow`，`text('entity_id')` 会被推断为 `string | null`。`mapThreadRow` 中 `row.entityId` 类型安全，无需显式转换。
- **调用点无需修改**：`route()` 和 `trigger()` 都传完整 `Thread`，只要 `Thread` 接口有 `entityId`，Pick 扩展自然生效。
- **迁移号**：当前最新为 `0004_vector_embedding.sql`，下一个为 `0005`。若合并前有其他 Feature 先加迁移，需改号。

---

## Reviewer Guidance

**Review focus**:
1. T001：`mapThreadRow` 是否正确映射 `row.entityId`（不是 `row.entity_id`——Drizzle 自动 camelCase）
2. T002：Limbic 分支是否正确优先 entityId（entityId 非 null 时不 fallback 到 situation）
3. T002：Cortex 分支是否完全不变（entityId 存在时仍返回 `{ situation }`）
4. T003：测试 3 是否验证 `{ entityId }` 而非 `{ situation }`（核心路径）
5. 迁移文件格式是否与现有迁移一致（IF NOT EXISTS，无 transaction）
