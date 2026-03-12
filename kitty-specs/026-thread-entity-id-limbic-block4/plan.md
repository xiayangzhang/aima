# Implementation Plan: Thread Entity ID for Limbic Block 4

**Branch**: `026-thread-entity-id-limbic-block4` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

---

## Summary

在 `threads` 表添加 `entity_id text` 列，透传到 `buildBlock4Opts`，解锁 Limbic 的实体感知检索路径。

改动分三层：
1. **Schema + 迁移**：`src/schema/threads.ts` 新增列；`drizzle/migrations/0005_thread_entity_id.sql`
2. **类型 + Workspace**：`src/types/index.ts` 更新 `Thread` 和 `CreateThreadParams`；`src/workspace/index.ts` 更新 `mapThreadRow` 和 `createThread`
3. **Runner 集成**：`src/runner/index.ts` 扩展 `buildBlock4Opts` 的 Pick 类型 + Limbic 分支逻辑

改动范围极小：4 个文件，1 个新迁移文件，约 25 行净增量。

---

## Technical Context

**Language/Version**: TypeScript（Bun runtime）
**Primary Dependencies**: Drizzle ORM, PostgreSQL — 现有依赖，无新增
**Testing**: Bun test（单元）；DB 相关测试需要 `AIMA_TEST_DATABASE_URL`
**Constraints**: Cortex 路径零 regression；无 entityId 的 Limbic Thread fallback 行为完全保留

---

## Architecture Decisions

### AD-01：entityId 在 Thread 上（非 Slot 或 opts 外部传入）

**决策**：`entityId` 存在 `threads` 表，而不是在每次 `activateBrain()` 调用时从外部传入。

原因：
- Thread 代表一次认知上下文边界——与哪个实体相关是 Thread 级别属性，不是单次激活的临时 hint
- 存在 Thread 上意味着 `continue()` 续接时实体关联自动延续，无需调用方重复传入
- DMN 的 `routePending()` 路径也能自动继承（DEFER recovery 时 Thread 已有 entityId）

**被拒绝的替代方案**：在 `trigger()` / `activateBrain()` 添加 `entityId` 参数 — 会破坏所有现有调用点，且语义上 entityId 是 Thread 属性而非激活参数。

### AD-02：Limbic 优先 entityId，Cortex 不改

**决策**：`buildBlock4Opts` 对 Limbic 的优先级：`entityId` > `trigger(situation)` > `undefined`。Cortex 保持原逻辑不变。

原因（效果导向）：
- Limbic 是关系认知脑区，实体感知检索正是其设计用途
- Cortex 使用 `findSimilarSituations()` 做情景匹配，与 entityId 无语义关联
- 不合并为 `if (brain === 'limbic' || brain === 'cortex')` 的原因：两个脑区的 Block 4 逻辑已经不同，合并分支会掩盖差异

### AD-03：nullable，无 NOT NULL 约束

**决策**：`entity_id text`（无 NOT NULL），现有行迁移后自动为 NULL，Drizzle 类型为 `text('entity_id')`（可选，默认 null）。

原因：
- 大多数 Thread 不关联特定实体（DMN 发起的 Thread、系统内部任务等）
- 强制 NOT NULL 会破坏所有现有 `createThread()` 调用点

---

## Source Code Changes

```
drizzle/migrations/
└── 0005_thread_entity_id.sql    ← 新建：ALTER TABLE threads ADD COLUMN entity_id text

src/
├── schema/threads.ts            ← 新增 entityId 列定义
├── types/index.ts               ← Thread.entityId + CreateThreadParams.entityId
├── workspace/index.ts           ← mapThreadRow + createThread
└── runner/index.ts              ← buildBlock4Opts Pick 类型 + Limbic 分支

tests/unit/
└── runner.test.ts               ← 新增 buildBlock4Opts entityId 测试（或现有文件）
tests/unit/
└── workspace.test.ts            ← 新增 createThread entityId 测试（或现有文件）
```

---

## Work Package Breakdown

### WP01 — Thread Entity ID: Schema + Workspace + Runner + Tests

**范围**：全部实现（改动极小，单 WP）。

**子任务**：
- T001: Schema + 迁移 + 类型 + Workspace（`threads.ts`、`0005` 迁移、`types/index.ts`、`workspace/index.ts`）
- T002: Runner 集成（`runner/index.ts` 的 `buildBlock4Opts` 扩展）
- T003: 单元测试（≥6 个：createThread with entityId、buildBlock4Opts entityId/null/cortex regression、Block 4 assembly getEntityContext 调用）

**产出**：5 个文件变更（含 1 个新迁移），约 25 行净增量，≥6 新测试

---

## Success Gates

| Gate | Criteria |
|------|----------|
| 类型检查 | `bun run typecheck` 零错误 |
| Lint | `biome check` 通过 |
| 现有测试 | 全部通过（零 regression） |
| 新增测试 | ≥6 个，全绿 |
| entityId 持久化 | `createThread({ entityId: 'x' })` → DB 写入正确 |
| Limbic 路径 | entityId 非 null 时，Block 4 opts = `{ entityId }` |
| Cortex 不变 | Thread 有 entityId 时 Cortex 仍返回 `{ situation }` |

---

## Complexity Tracking

极小改动：4 个现有文件各 +2–8 行，1 个新迁移文件。单 WP 足够。
