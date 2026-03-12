# Tasks: receive() Input Content Delivery (Feature 029)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-03-13

## Subtask Index

| ID | Description | WP | Status |
|---|---|---|---|
| T001 | Fix `receive()` to store `input.content` as `thread.trigger` | WP01 | planned |
| T002 | Add `triggerContent?` param to `activateBrain()`, update callers | WP01 | planned |
| T003 | Add `trigger` display to `assembleBlock3()` | WP01 | planned |
| T004 | Unit tests T029-A through T029-G | WP01 | planned |

---

## Phase 1 — Fix and Test

### WP01 — Input Content Delivery Fix

**File**: [tasks/WP01-input-content-delivery-fix.md](tasks/WP01-input-content-delivery-fix.md)
**Priority**: P1 | **Estimated prompt size**: ~250 lines
**Dependencies**: none

**Goal**: Fix three-file content delivery gap so external input reaches Limbic's LLM call and Block 3 context.

**Subtasks**:
- [x] T001 — `receive()` trigger fix
- [x] T002 — `activateBrain()` triggerContent param
- [x] T003 — `assembleBlock3()` trigger display
- [x] T004 — Unit tests

**Independent test**:
```bash
cd /Volumes/leoyun/aima && bun test
```

---

## Definition of Done

- [ ] WP01 lane = done
- [ ] `bun test` 全量零回归
