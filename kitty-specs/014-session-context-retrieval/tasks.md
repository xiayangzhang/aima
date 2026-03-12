# Tasks: Session Context Retrieval (Feature 014)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-03-12

## Subtask Index

| ID | Description | WP | Status |
|---|---|---|---|
| T001 | Add `getSessionContext` to `ICognitiveWorkspace` interface | WP01 | planned |
| T002 | Add `sessionId` index to DB schema + migration SQL | WP01 | planned |
| T003 | Implement `getSessionContext` in `CognitiveWorkspace` | WP01 | planned |
| T004 | Write unit tests (6 scenarios, V1–V6 from quickstart.md) | WP01 | planned |

---

## Phase 1 — Implementation

### WP01 — getSessionContext Implementation

**File**: [tasks/WP01-get-session-context-impl.md](tasks/WP01-get-session-context-impl.md)
**Priority**: P1 | **Estimated prompt size**: ~280 lines
**Dependencies**: none

**Goal**: 新增 `getSessionContext(sessionId)` 接口方法，实现查询，补充 DB 索引，编写单元测试。

**Subtasks**:
- [x] T001 — `ICognitiveWorkspace` 接口新增 `getSessionContext` 签名
- [x] T002 — `src/schema/memories.ts` 新增 `sessionId` 索引 + migration SQL
- [x] T003 — `src/workspace/index.ts` 实现 `getSessionContext`
- [x] T004 — `tests/unit/workspace/workspace-session-context.test.ts` 单元测试

**Parallelization**: 无（T001→T002→T003→T004 顺序依赖）
**Risks**: `asc` import 需确认已从 drizzle-orm 导入；注意 `forgotten=false` 过滤与其他方法保持一致

**Independent test**:
```bash
cd /Volumes/leoyun/aima && bun test tests/unit/workspace/workspace-session-context.test.ts
```

---

## Definition of Done

- [ ] WP01 lane = done (reviewed and approved)
- [ ] `bun test` 全量零回归
