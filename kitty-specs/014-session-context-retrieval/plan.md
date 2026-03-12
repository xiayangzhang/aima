# Implementation Plan: Session Context Retrieval
*Path: kitty-specs/014-session-context-retrieval/plan.md*

**Branch**: `014-session-context-retrieval` | **Date**: 2026-03-12 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/kitty-specs/014-session-context-retrieval/spec.md`

## Summary

为 `ICognitiveWorkspace` 接口新增并实现 `getSessionContext(sessionId)` 方法。该方法查询指定 brain LLM session 内所有有效（未软删除）的 episodic 记忆，按时间升序返回完整列表，并将最早的记录作为 anchor 返回。DMN Reactive 用该方法了解当前 brain session 的历史事件序列，支撑段分配与话题检测决策。

## Technical Context

**Language/Version**: TypeScript (Node.js / Bun runtime，与项目一致)
**Primary Dependencies**: Drizzle ORM + PostgreSQL（已有，不新增依赖）
**Storage**: PostgreSQL `memories` 表（`session_id` 列已存在）
**Testing**: Bun test（`bun test`）
**Target Platform**: Linux server（AKS，与项目一致）
**Project Type**: Single project
**Performance Goals**: 单次查询 < 50ms（正常 session 记录数 < 100 条）
**Constraints**: 不修改已有接口签名；不引入回归；不新增 DB 表或列
**Scale/Scope**: 单 brain session 内 episodic 记录数通常 < 50 条；极端情况不做截断

## Spec Correction Notes

> **⚠️ 以下两处 spec 描述与代码实际不符，本 plan 以 plan 为准：**

### 1. 参数名：`sessionId`，非 `threadId`

spec.md 将参数称为 `threadId`，但：
- `ICognitiveWorkspace` 接口（`src/types/index.ts`）无该方法，需新增
- `MemoryEntry` 已有 `sessionId: string | null` 列，对应 brain 的 LLM session ID
- DMN Reactive 从 `brain.complete` 事件 payload 取 `session_id`（来源：Thread Runner 调 `activateBrain()` 后的 `BrainRunResult.session_id`）
- 因此参数应为 `sessionId`，按 `memories.session_id` 查询

### 2. Anchor 语义：最早 episodic，非 session_anchor 模式

`docs/02-memory-architecture.md` 场景 B 描述了"session anchor 压缩模式"（最近一条 `kind=session_anchor` + 其后增量事件），但该模式**当前未实现**：
- `memories` 表无 `kind` 列
- DMN Reactive 的 `buildEpisodicContent` 不写 `kind` 字段
- 没有任何代码写入 `session_anchor` 类型记录

本 feature 实现**简化版**：
- `anchor` = 该 session 时间最早的 episodic 记忆（即 spec 所描述的语义）
- `events` = 该 session 全部有效 episodic 记忆，按 `createdAt` 升序

session_anchor 压缩模式留待后续 feature 实现。

## Constitution Check

*无 constitution 文件，跳过。*

## Project Structure

### Documentation (this feature)

```
kitty-specs/014-session-context-retrieval/
├── plan.md              # This file
├── research.md          # N/A (trivial scope, no research needed)
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks/               # Phase 2 output (/spec-kitty.tasks)
```

### Source Code (repository root)

```
src/
├── types/index.ts           # ICognitiveWorkspace — 新增 getSessionContext 方法签名
└── workspace/index.ts       # CognitiveWorkspace — 实现 getSessionContext

tests/
└── unit/workspace/
    └── workspace-session-context.test.ts   # 新增单元测试
```

**Structure Decision**: Single project，改动集中在 2 个源文件 + 1 个测试文件，无新目录。

## Phase 0: Research

**研究结论**（无需外部研究，全部来自代码审查）：

| 决策 | 结论 | 依据 |
|---|---|---|
| 参数类型 | `sessionId: string` | `memories.session_id` 已有索引；DMN 传 `session_id` |
| 查询条件 | `type='episodic' AND session_id=? AND t_invalid IS NULL AND forgotten=false` | 与其他方法保持一致（见 `searchMemory`） |
| Anchor | `ORDER BY created_at ASC LIMIT 1` | 等价于 spec 的"最早记录" |
| Events | `ORDER BY created_at ASC`（全量，不截断） | spec FR-001，FR-005 |
| 空结果 | `{ anchor: null, events: [] }` | spec FR-005 |
| 索引 | 现有 `idx_memories_thread_id` 不覆盖 `session_id`；需新增索引 | 见 DB 审查 |

**索引缺口**：`memories` 表有 `threadId` 索引但无 `sessionId` 索引。`getSessionContext` 需按 `session_id` 查询，应新增索引 `CREATE INDEX idx_memories_session_id ON memories(session_id)`。

## Phase 1: Design & Contracts

### Data Model

无新表/新列。唯一变更：新增 DB 索引（见下）。

**新增索引**（Drizzle schema 更新 + migration SQL）：

```sql
CREATE INDEX idx_memories_session_id ON memories(session_id)
  WHERE session_id IS NOT NULL;
```

对应 `src/schema/memories.ts` 新增：
```typescript
sessionIdIdx: index('idx_memories_session_id')
  .on(table.sessionId)
  .where(sql`session_id IS NOT NULL`),
```

### Interface Contract

在 `ICognitiveWorkspace`（`src/types/index.ts`）的 `// ── Memory` 区块末尾新增：

```typescript
getSessionContext(sessionId: string): Promise<{
  anchor: MemoryEntry | null
  events: MemoryEntry[]
}>
```

**语义**：
- `anchor`：`sessionId` 下 `created_at` 最早的有效 episodic 记忆；若无则 `null`
- `events`：`sessionId` 下全部有效 episodic 记忆，按 `created_at` ASC 排序（含 anchor）

**有效**定义：`type='episodic' AND session_id=sessionId AND t_invalid IS NULL AND forgotten=false`

### Implementation Sketch

```typescript
async getSessionContext(sessionId: string): Promise<{
  anchor: MemoryEntry | null
  events: MemoryEntry[]
}> {
  const rows = await this.db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.type, 'episodic'),
        eq(memories.sessionId, sessionId),
        isNull(memories.tInvalid),
        eq(memories.forgotten, false),
      ),
    )
    .orderBy(asc(memories.createdAt))

  if (rows.length === 0) return { anchor: null, events: [] }

  const events = rows.map(mapMemoryRow)
  return { anchor: events[0], events }
}
```

**注**：`anchor` 是 `events[0]`（时间最早），`events` 包含 anchor 本身——与 spec 场景 US2.2（"anchor 等于该条记忆，events 也包含该条记忆"）一致。

### Quickstart Validation

完成实现后，跑以下验证场景：

**场景 V1 — 正常返回**
```typescript
await workspace.writeMemory({ type: 'episodic', content: 'e1', sessionId: 'sess-A' })
await workspace.writeMemory({ type: 'episodic', content: 'e2', sessionId: 'sess-A' })
const ctx = await workspace.getSessionContext('sess-A')
// ctx.events.length === 2
// ctx.anchor.content === 'e1'
// ctx.events[0].content === 'e1', ctx.events[1].content === 'e2'
```

**场景 V2 — 空 session**
```typescript
const ctx = await workspace.getSessionContext('no-such-session')
// ctx.anchor === null, ctx.events.length === 0
```

**场景 V3 — 跨 session 隔离**
```typescript
await workspace.writeMemory({ type: 'episodic', content: 'other', sessionId: 'sess-B' })
const ctx = await workspace.getSessionContext('sess-A')
// ctx.events every item has sessionId === 'sess-A'
```

**场景 V4 — 软删除过滤**
```typescript
const m = await workspace.writeMemory({ type: 'episodic', content: 'deleted', sessionId: 'sess-C' })
await workspace.invalidateMemory(m.id)
const ctx = await workspace.getSessionContext('sess-C')
// ctx.anchor === null, ctx.events.length === 0
```

**场景 V5 — 非 episodic 过滤**
```typescript
await workspace.writeMemory({ type: 'working', content: 'wm', sessionId: 'sess-D' })
const ctx = await workspace.getSessionContext('sess-D')
// ctx.anchor === null, ctx.events.length === 0
```

## Complexity Tracking

*无 Constitution 违规，跳过。*
