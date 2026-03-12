# Tasks: Thread Goal Feedback Signal (Feature 019)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-03-13

## Subtask Index

| ID | Description | WP | Status |
|---|---|---|---|
| T001 | `threads` 表新增 `goal text` 列（Drizzle schema + migration） | WP01 | planned |
| T002 | `Thread` interface + `CreateThreadParams` 新增 `goal` 字段 | WP01 | planned |
| T003 | `mapThreadRow` + `createThread` 实现 goal 字段映射与写入 | WP01 | planned |
| T004 | `feedbackMemoryUsage` 升级为 goal-aware（含 LLM 评估 + 回退逻辑） | WP02 | planned |
| T005 | 单元测试：V1-V7 场景（goal 评估路径 + 无 goal 回退 + 异常处理） | WP02 | planned |
| T006 | 零回归验证（`bun test` 全量通过） | WP02 | planned |

---

## Phase 1 — Schema + Workspace API

### WP01 — Thread.goal Schema & API

**File**: [tasks/WP01-thread-goal-schema.md](tasks/WP01-thread-goal-schema.md)
**Priority**: P1 | **Estimated prompt size**: ~180 lines
**Dependencies**: 无

**Goal**: 为 `threads` 表添加 `goal text` 列，更新 Drizzle schema，生成 migration，更新 TypeScript 类型和 workspace 实现。

**Subtasks**:
- [ ] T001 — `src/schema/threads.ts` 新增 `goal: text('goal')`，生成 migration
- [ ] T002 — `src/types/index.ts` 更新 `Thread` interface 和 `CreateThreadParams`
- [ ] T003 — `src/workspace/index.ts` 更新 `mapThreadRow` 和 `createThread`

**Independent test**:
```bash
cd /Volumes/leoyun/aima && bun tsc --noEmit
```

---

## Phase 2 — DMN Goal-Based Feedback

### WP02 — DMN Goal Feedback Signal

**File**: [tasks/WP02-dmn-goal-feedback.md](tasks/WP02-dmn-goal-feedback.md)
**Priority**: P1 | **Estimated prompt size**: ~280 lines
**Dependencies**: WP01（`Thread.goal` 字段必须存在，`createThread` 必须支持 goal）

**Goal**: 升级 `feedbackMemoryUsage`，使其在 thread 有 goal 时调用 Haiku LLM 评估质量，以 positive/negative 替代启发式；评估失败时静默回退。

**Subtasks**:
- [ ] T004 — `src/dmn/reactive/index.ts` 升级 `feedbackMemoryUsage`
- [ ] T005 — `tests/unit/dmn/dmn-reactive.test.ts` 新增 V1-V7 场景
- [ ] T006 — `bun test` 全量零回归验证

**Independent test**:
```bash
cd /Volumes/leoyun/aima && bun test tests/unit/dmn/
```

---

## Definition of Done

- [ ] WP01 lane = done
- [ ] WP02 lane = done
- [ ] `bun tsc --noEmit` 零编译错误
- [ ] `bun test` 全量零回归
