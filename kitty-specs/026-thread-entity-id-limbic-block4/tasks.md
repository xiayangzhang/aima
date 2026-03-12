# Tasks: Thread Entity ID for Limbic Block 4

**Feature**: 026-thread-entity-id-limbic-block4
**Total WPs**: 1
**Total Subtasks**: 3

---

## Phase 1 — Implementation

### WP01: Thread Entity ID — Schema, Workspace, Runner, Tests
**Priority**: P0 | **Status**: planned | **File**: [WP01-thread-entity-id-limbic-block4.md](tasks/WP01-thread-entity-id-limbic-block4.md)

`entity_id` 列从数据库 → Drizzle schema → TypeScript 类型 → workspace 方法 → runner 集成，打通全链路，解锁 Limbic Block 4 的实体感知检索路径。

**Subtasks**:
- [ ] T001: Schema + 迁移 + 类型 + Workspace（`threads.ts`、`0005` SQL 迁移、`types/index.ts`、`workspace/index.ts` 的 `mapThreadRow` + `createThread`）
- [ ] T002: Runner 集成（`runner/index.ts`：扩展 `buildBlock4Opts` Pick 类型，Limbic 分支优先 entityId）
- [ ] T003: 单元测试（≥6 个：createThread entityId 持久化、buildBlock4Opts entityId 路径、null fallback、Cortex regression、Block 4 assembly getEntityContext 调用）

**Dependencies**: none
**Estimated prompt size**: ~250 lines
