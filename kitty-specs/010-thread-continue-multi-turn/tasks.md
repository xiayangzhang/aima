# Tasks: Thread Continue (Multi-Turn Dialog)

**Feature**: 010-thread-continue-multi-turn
**Total WPs**: 1
**Total Subtasks**: 3

---

## Phase 1 — Implementation

### WP01: reopenThread + AIMAInstance.continue()
**Priority**: P0 | **Status**: planned | **File**: [WP01-reopen-thread-and-continue.md](tasks/WP01-reopen-thread-and-continue.md)

`CognitiveWorkspace.reopenThread()` + `AIMAInstance.continue()`，复用现有路由路径，不新增模块。

**Subtasks**:
- [x] T001: `CognitiveWorkspace.reopenThread(id, trigger)` — 原子更新 state+trigger，带状态校验
- [x] T002: `AIMAInstance.continue(threadId, input)` — 调用 reopenThread，走 receive() 相同路径
- [x] T003: ≥6 测试（session 保留、状态转换、错误路径、trigger 更新）

**Dependencies**: none
**Estimated prompt size**: ~280 lines
