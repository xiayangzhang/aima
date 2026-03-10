---
work_package_id: WP04
title: CognitiveWorkspace — Thread & Slot
lane: "doing"
dependencies: []
subtasks:
- T018
- T019
- T020
- T021
phase: Phase 2 - Core DAO
assignee: ''
agent: "claude"
shell_pid: "64216"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-10T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP04 — CognitiveWorkspace — Thread & Slot

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, read Review Feedback section first.

---

## Review Feedback

*[Empty — no feedback yet]*

---

## Objectives & Success Criteria

Thread 和 Slot 的完整 DAO 实现，含 writeSlot upsert 语义。完成标准：
- `bun test tests/unit/workspace/thread-slot.test.ts` 全部通过
- `CognitiveWorkspace` class 实现 `ICognitiveWorkspace` 接口（TypeScript 编译器验证）
- `writeSlot` upsert 在同 thread_id + brain 时正确覆盖（不新建行）
- `getActiveThreads` 正确过滤 `state NOT IN ('complete')`

## Context & Constraints

- **Repo**: `/Volumes/leoyun/aima/`
- **Schema**: `src/schema/` (WP03 输出)
- **Types**: `src/types/index.ts` (WP02 输出)
- **CLAUDE.md**: 单元测试用 mock DB（不依赖真实 PostgreSQL），集成测试在 WP07

实现命令：`spec-kitty implement WP04 --base WP03`

---

## Subtasks & Detailed Guidance

### T018 — CognitiveWorkspace class 骨架

**Purpose**: 建立 class 骨架——constructor 注入 Drizzle DB，实现 ICognitiveWorkspace 接口骨架（所有方法先 throw）。

**Steps**:
1. 创建 `src/workspace/index.ts`：

```typescript
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../schema/index.js'
import type {
  CreateMemoryParams,
  CreatePendingParams,
  CreateThreadParams,
  BrainType,
  ICognitiveWorkspace,
  MemoryEntry,
  MemorySearchFilters,
  PendingObservation,
  Slot,
  Thread,
  ThreadState,
  UsageOutcome,
  WriteSlotParams,
} from '../types/index.js'

export type DrizzleDB = PostgresJsDatabase<typeof schema>

export interface CognitiveWorkspaceOptions {
  pendingCapacity?: number  // default: 100
}

export class CognitiveWorkspace implements ICognitiveWorkspace {
  private readonly db: DrizzleDB
  private readonly pendingCapacity: number

  constructor(db: DrizzleDB, options: CognitiveWorkspaceOptions = {}) {
    this.db = db
    this.pendingCapacity = options.pendingCapacity ?? 100
  }

  // Thread methods — implemented in T019
  createThread(_params: CreateThreadParams): Promise<Thread> {
    throw new Error('Not implemented')
  }
  getThread(_id: string): Promise<Thread | null> {
    throw new Error('Not implemented')
  }
  updateThreadState(_id: string, _state: ThreadState): Promise<void> {
    throw new Error('Not implemented')
  }
  getActiveThreads(): Promise<Thread[]> {
    throw new Error('Not implemented')
  }

  // Slot methods — implemented in T020
  writeSlot(_threadId: string, _brain: BrainType, _data: WriteSlotParams): Promise<Slot> {
    throw new Error('Not implemented')
  }
  readSlot(_threadId: string, _brain: BrainType): Promise<Slot | null> {
    throw new Error('Not implemented')
  }
  getSlotsByThread(_threadId: string): Promise<Slot[]> {
    throw new Error('Not implemented')
  }

  // Pending methods — implemented in WP05
  writePending(_params: CreatePendingParams): Promise<PendingObservation> {
    throw new Error('Not implemented')
  }
  getPendingObservations(): Promise<PendingObservation[]> {
    throw new Error('Not implemented')
  }
  removeExpiredPending(_now: Date): Promise<void> {
    throw new Error('Not implemented')
  }
  removePending(_id: string): Promise<void> {
    throw new Error('Not implemented')
  }

  // Memory methods — implemented in WP06
  writeMemory(_params: CreateMemoryParams): Promise<MemoryEntry> {
    throw new Error('Not implemented')
  }
  searchMemory(_filters: MemorySearchFilters): Promise<MemoryEntry[]> {
    throw new Error('Not implemented')
  }
  markMemoryUsed(_ids: string[], _outcome: UsageOutcome): Promise<void> {
    throw new Error('Not implemented')
  }
  clearWorkingMemory(_threadId: string): Promise<void> {
    throw new Error('Not implemented')
  }
}
```

2. 确认 TypeScript 编译器将 class 声明为实现了 `ICognitiveWorkspace`（`implements` 关键字会在接口变化时报错）。

**Files**: `src/workspace/index.ts`（新建）

---

### T019 — 实现 Thread 操作

**Purpose**: 实现 createThread、getThread、updateThreadState、getActiveThreads。

**Steps**:
1. 在 `src/workspace/index.ts` 中，用以下实现替换 T018 的 throw 占位：

```typescript
import { eq, not, inArray } from 'drizzle-orm'
import { threads } from '../schema/index.js'

// createThread
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

// getThread
async getThread(id: string): Promise<Thread | null> {
  const row = await this.db.query.threads.findFirst({
    where: eq(threads.id, id),
  })
  return row ? mapThreadRow(row) : null
}

// updateThreadState — also updates updated_at
async updateThreadState(id: string, state: ThreadState): Promise<void> {
  await this.db
    .update(threads)
    .set({ state, updatedAt: new Date() })
    .where(eq(threads.id, id))
}

// getActiveThreads — state NOT IN ('complete')
async getActiveThreads(): Promise<Thread[]> {
  const rows = await this.db
    .select()
    .from(threads)
    .where(not(inArray(threads.state, ['complete'])))
  return rows.map(mapThreadRow)
}
```

2. 在 class 外添加 mapper helper（私有转换函数，将 DB row 映射到 TypeScript 类型）：

```typescript
// ─── Row Mappers ──────────────────────────────────────────────────────────────
// 这些 mappers 将 DB 的 snake_case row 转换为 TypeScript camelCase 接口

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
```

**设计要点**:
- `updateThreadState` 显式更新 `updatedAt`（Drizzle 不自动维护）
- `getActiveThreads` 用 `NOT IN ('complete')` 而非 `IN ('active', 'waiting', 'interrupted')`——确保新增状态不需要修改此查询
- mapper 函数放在 class 外部（不是方法），减少 `this` 引用

**Files**: `src/workspace/index.ts`（修改）

---

### T020 — 实现 Slot 操作

**Purpose**: 实现 writeSlot（upsert）、readSlot、getSlotsByThread。

**Steps**:
1. 添加 imports：`import { slots } from '../schema/index.js'`

2. 实现方法（替换 T018 的 throw 占位）：

```typescript
// writeSlot — upsert by (thread_id, brain), full overwrite on conflict
async writeSlot(threadId: string, brain: BrainType, data: WriteSlotParams): Promise<Slot> {
  const [row] = await this.db
    .insert(slots)
    .values({
      threadId,
      brain,
      status: data.status ?? 'pending',
      input: data.input ?? null,
      output: data.output ?? null,
      intent: data.intent ?? null,
      complexityHint: data.complexityHint ?? null,
      executionSessionId: data.executionSessionId ?? null,
    })
    .onConflictDoUpdate({
      target: [slots.threadId, slots.brain],
      set: {
        status: data.status ?? 'pending',
        input: data.input ?? null,
        output: data.output ?? null,
        intent: data.intent ?? null,
        complexityHint: data.complexityHint ?? null,
        executionSessionId: data.executionSessionId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning()

  if (!row) throw new Error('Upsert returned no rows')
  return mapSlotRow(row)
}

// readSlot
async readSlot(threadId: string, brain: BrainType): Promise<Slot | null> {
  const row = await this.db.query.slots.findFirst({
    where: (s, { and, eq: eqOp }) => and(eqOp(s.threadId, threadId), eqOp(s.brain, brain)),
  })
  return row ? mapSlotRow(row) : null
}

// getSlotsByThread
async getSlotsByThread(threadId: string): Promise<Slot[]> {
  const rows = await this.db
    .select()
    .from(slots)
    .where(eq(slots.threadId, threadId))
  return rows.map(mapSlotRow)
}
```

3. 添加 slot mapper：

```typescript
function mapSlotRow(row: typeof slots.$inferSelect): Slot {
  return {
    id: row.id,
    threadId: row.threadId,
    brain: row.brain as BrainType,
    status: row.status,
    input: row.input,
    output: row.output,
    intent: (row.intent as Slot['intent']) ?? null,
    complexityHint: (row.complexityHint as Slot['complexityHint']) ?? null,
    executionSessionId: row.executionSessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
```

**writeSlot 语义说明**:
- `onConflictDoUpdate` 目标：`[slots.threadId, slots.brain]`（UNIQUE 约束的两列）
- 冲突时完整覆盖旧值（不合并）——调用方负责传入完整的 WriteSlotParams
- `updatedAt` 在 set 中显式更新

**Files**: `src/workspace/index.ts`（修改）

---

### T021 — Thread & Slot 单元测试

**Purpose**: 用 mock DB 验证所有 Thread 和 Slot 方法的正确行为，不依赖真实 PostgreSQL。

**Steps**:
1. 创建 `tests/unit/workspace/thread-slot.test.ts`。

2. Mock DB 策略：使用简单的 in-memory 数据存储模拟 Drizzle DB：

```typescript
import { describe, test, expect, mock } from 'bun:test'
import { CognitiveWorkspace } from '../../../src/workspace/index.js'

// 创建一个最小化的 mock，只实现测试所需的方法
function createMockDb() {
  const threadStore = new Map<string, Record<string, unknown>>()
  const slotStore = new Map<string, Record<string, unknown>>()
  let idCounter = 0
  const nextId = () => `test-uuid-${++idCounter}`
  const now = () => new Date()

  return {
    insert: mock((table: unknown) => ({
      values: mock((values: Record<string, unknown>) => ({
        returning: mock(async () => {
          // 模拟 threads 表 insert
          const id = nextId()
          const row = { id, ...values, createdAt: now(), updatedAt: now() }
          if (table === 'threads') threadStore.set(id, row)
          return [row]
        }),
        onConflictDoUpdate: mock(({ set }: { set: Record<string, unknown> }) => ({
          returning: mock(async () => {
            // 模拟 upsert
            const existingKey = `${values['threadId']}-${values['brain']}`
            const existing = slotStore.get(existingKey)
            if (existing) {
              const updated = { ...existing, ...set }
              slotStore.set(existingKey, updated)
              return [updated]
            }
            const id = nextId()
            const row = { id, ...values, createdAt: now(), updatedAt: now() }
            slotStore.set(existingKey, row)
            return [row]
          }),
        })),
      })),
    })),
    // ... 其他 mock 方法
  }
}
```

**注意**: 单元测试的 mock 不需要完美——它只需要验证：
- 方法在正确输入下返回预期的 TypeScript 类型
- 边界情况（null 返回、upsert 覆盖）被处理

3. 必须覆盖的测试用例：

```typescript
describe('Thread operations', () => {
  test('createThread returns Thread with correct fields')
  test('createThread sets default state to active')
  test('getThread returns null for unknown id')
  test('updateThreadState updates state and updatedAt')
  test('getActiveThreads excludes complete threads')
  test('getActiveThreads includes active, waiting, interrupted threads')
})

describe('Slot operations', () => {
  test('writeSlot creates new slot')
  test('writeSlot upserts on same threadId+brain (overwrites)')
  test('readSlot returns null for unknown threadId+brain')
  test('getSlotsByThread returns all slots for thread')
  test('writeSlot preserves null fields when not provided')
})
```

4. 运行验证：
```bash
cd /Volumes/leoyun/aima
bun test tests/unit/workspace/thread-slot.test.ts
```

**Files**: `tests/unit/workspace/thread-slot.test.ts`（新建）

---

## Risks & Mitigations

- **writeSlot upsert 覆盖语义**: 当前语义是完整覆盖（调用方传入完整 WriteSlotParams）。如果调用方只想更新 `status` 而不改变 `input`/`output`，需要先 readSlot 再 merge。这是有意为之——避免 merge 语义的复杂性。
- **mock DB 维护成本**: mock 不用完美模拟 Drizzle—只需验证业务逻辑。并发和真实 DB 行为在 WP07 集成测试中验证。

## Definition of Done Checklist

- [ ] T018: `CognitiveWorkspace` class 骨架，constructor 注入 `DrizzleDB`，`implements ICognitiveWorkspace`
- [ ] T019: 4 个 Thread 方法实现完整，`getActiveThreads` 用 NOT IN 过滤
- [ ] T020: 3 个 Slot 方法实现完整，`writeSlot` 用 `onConflictDoUpdate`
- [ ] T021: `bun test tests/unit/workspace/thread-slot.test.ts` 全部通过，覆盖正常路径和边界情况

## Review Guidance

- 检查 `updateThreadState` 是否显式更新了 `updatedAt`（Drizzle 不自动维护）
- 检查 `getActiveThreads` 是否用 `NOT IN ('complete')` 而非硬编码其他状态
- 检查 `writeSlot` 的 `onConflictDoUpdate` 是否包含 `updatedAt: new Date()`
- 检查 mapper 函数的类型转换（`as BrainType` 等）是否合理——Drizzle pgEnum 返回的是 string，需要 cast

## Activity Log

- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
- 2026-03-10T10:19:03Z – claude – shell_pid=13938 – lane=doing – Started implementation via workflow command
- 2026-03-10T10:25:01Z – claude – shell_pid=13938 – lane=for_review – 20/20 unit tests passing, tsc clean, biome clean. Thread & Slot DAO complete with upsert semantics.
- 2026-03-10T10:49:59Z – claude – shell_pid=64216 – lane=doing – Started review via workflow command
