---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
  - "T003"
title: "Thread.goal Schema & Workspace API"
phase: "Phase 1 - Schema + API"
lane: "planned"
assignee: ""
agent: ""
shell_pid: ""
review_status: ""
dependencies: []
reviewed_by: ""
history:
  - timestamp: "2026-03-13T00:00:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via spec-kitty agent workflow"
---

# Work Package Prompt: WP01 — Thread.goal Schema & Workspace API

## Objectives & Success Criteria

为 `threads` 表添加可选的 `goal text` 列，更新 TypeScript 类型和 workspace 实现，生成 Drizzle migration。完成后：

- `threads` 表含 `goal text` 列（nullable，无默认值）
- `Thread` interface 含 `goal: string | null` 字段
- `CreateThreadParams` 含 `goal?: string` 可选字段
- `CognitiveWorkspace.createThread` 将 `goal` 写入 DB
- `mapThreadRow` 将 DB row 的 `goal` 字段映射到 `Thread.goal`
- 现有调用 `createThread` 不传 goal 时仍正常工作（无破坏性变更）
- `bun tsc --noEmit` 零编译错误

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/019-thread-goal-feedback-signal/spec.md`
- **Plan**: `kitty-specs/019-thread-goal-feedback-signal/plan.md` — 含完整实现草稿
- **Source files**:
  - `src/schema/threads.ts` — Drizzle schema（新增 `goal: text('goal')`）
  - `src/types/index.ts` — `Thread` interface + `CreateThreadParams`
  - `src/workspace/index.ts` — `mapThreadRow` + `createThread`
- **Depends on**: 无
- **Constraints**:
  - `goal` 必须是 nullable（不是 `.notNull()`），现有 threads 数据不受影响
  - `CreateThreadParams.goal` 必须是可选字段（`goal?: string`），不能是必填
  - 不新增任何 `ICognitiveWorkspace` 方法
  - 不改 `updateThreadState`、`reopenThread`、`getThread` 等其他方法

---

## Subtasks & Detailed Guidance

### Subtask T001 — Drizzle schema 变更 + 生成 migration

**Purpose**: 在 `threads` pgTable 定义中新增 `goal text` 列，然后生成 migration 文件。

**Steps**:

1. 打开 `src/schema/threads.ts`，在 `threads` pgTable 定义中，`updatedAt` 字段后新增：

```typescript
goal: text('goal'),
```

最终结构应为：
```typescript
export const threads = pgTable('threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: threadStateEnum('state').notNull().default('active'),
  sourceChannel: text('source_channel'),
  initiatedBy: text('initiated_by').notNull(),
  trigger: text('trigger'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  goal: text('goal'),
})
```

2. 生成 migration：
```bash
cd /Volumes/leoyun/aima && bun run db:generate
```
（或等效的 `drizzle-kit generate` 命令，见 `package.json` scripts）

**Files**: `src/schema/threads.ts`，`drizzle/migrations/` 新文件

**Validation**:
- [ ] `grep -n "goal" src/schema/threads.ts` → `goal: text('goal')` 存在
- [ ] `ls drizzle/migrations/` → 新增了 migration 文件
- [ ] migration SQL 含 `ALTER TABLE threads ADD COLUMN goal text`（或等效）

---

### Subtask T002 — 更新 TypeScript 类型

**Purpose**: 在 `src/types/index.ts` 中更新 `Thread` interface 和 `CreateThreadParams`，添加 `goal` 字段。

**Steps**:

1. 在 `Thread` interface（约第 35 行）的 `trigger: string | null` 字段后新增：
```typescript
goal: string | null
```

最终 `Thread` interface 应含：
```typescript
export interface Thread {
  id: string
  state: ThreadState
  sourceChannel: string | null
  initiatedBy: string
  trigger: string | null
  goal: string | null
  createdAt: Date
  updatedAt: Date
}
```

2. 在 `CreateThreadParams` interface（约第 99 行）中新增：
```typescript
goal?: string
```

最终 `CreateThreadParams` 应含：
```typescript
export interface CreateThreadParams {
  trigger?: string
  initiatedBy: string
  sourceChannel?: string | null
  goal?: string
}
```

**Files**: `src/types/index.ts`

**Validation**:
- [ ] `grep -n "goal" src/types/index.ts` → 两处 match（Thread.goal 和 CreateThreadParams.goal）
- [ ] TypeScript 编译通过（T003 完成后验证）

---

### Subtask T003 — 更新 workspace 实现

**Purpose**: 在 `src/workspace/index.ts` 中更新 `mapThreadRow` 和 `createThread`，使 `goal` 字段被正确映射和写入。

**Steps**:

1. 更新 `mapThreadRow`（约第 50-60 行），在 `trigger: row.trigger` 后新增：
```typescript
goal: row.goal ?? null,
```

最终 `mapThreadRow` 函数应返回：
```typescript
return {
  id: row.id,
  state: row.state,
  sourceChannel: row.sourceChannel,
  initiatedBy: row.initiatedBy,
  trigger: row.trigger,
  goal: row.goal ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
}
```

2. 更新 `createThread`（约第 209-221 行）的 `insert.values` 调用，新增：
```typescript
goal: params.goal ?? null,
```

最终 `createThread` 的 `.values({...})` 应含：
```typescript
.values({
  initiatedBy: params.initiatedBy,
  trigger: params.trigger ?? null,
  sourceChannel: params.sourceChannel ?? null,
  goal: params.goal ?? null,
})
```

**Files**: `src/workspace/index.ts`

**Validation**:
- [ ] `grep -n "goal" src/workspace/index.ts` → `mapThreadRow` 和 `createThread` 各含一处
- [ ] `bun tsc --noEmit` → 零编译错误
- [ ] 现有 `createThread` 调用（无 goal 参数）仍正常工作

---

## Risks & Mitigations

| 风险 | 可能性 | 缓解方案 |
|---|---|---|
| `NewThreadRow` 类型由 Drizzle infer，goal 字段为可选——无需手动更新 | 低 | Drizzle `$inferInsert` 自动将 nullable 列标记为可选，无需修改 `NewThreadRow` |
| `db:generate` 命令名称不同 | 低 | 检查 `package.json` 的 scripts，找正确的 drizzle-kit generate 命令 |
| Drizzle `row.goal` 类型推断 | 低 | nullable text 列推断为 `string \| null`，`?? null` 处理 undefined 边界情况 |

## Definition of Done Checklist

- [ ] `grep -n "goal" src/schema/threads.ts` → `goal: text('goal')` 存在
- [ ] `grep -n "goal" src/types/index.ts` → `Thread.goal: string | null` 和 `CreateThreadParams.goal?: string` 均存在
- [ ] `grep -n "goal" src/workspace/index.ts` → `mapThreadRow` 含 `goal: row.goal ?? null`，`createThread` 含 `goal: params.goal ?? null`
- [ ] Drizzle migration 文件已生成，含 `goal` 列变更
- [ ] `bun tsc --noEmit` 零编译错误
- [ ] `bun test` 零回归（现有测试全通过）

## Review Guidance

- 验证 T001：`goal` 列没有 `.notNull()` 修饰（必须是 nullable）
- 验证 T002：`Thread.goal` 是 `string | null`（非可选，entity 中必须存在该字段）；`CreateThreadParams.goal` 是 `goal?: string`（可选，不传时为 undefined）
- 验证 T003：`mapThreadRow` 使用 `row.goal ?? null` 而非直接 `row.goal`（防御 undefined）
- 验证 T003：`createThread` 使用 `params.goal ?? null` 写入（undefined 被转为 null 存 DB）

## Activity Log

- 2026-03-13T00:00:00Z – system – lane=planned – Prompt generated via spec-kitty agent workflow
