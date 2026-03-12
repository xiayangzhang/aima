# Feature Specification: Thread Entity ID for Limbic Block 4

**Feature**: 026-thread-entity-id-limbic-block4
**Status**: Draft
**Created**: 2026-03-13
**Depends on**: Feature 001 (workspace schema), Feature 008 (Block 4 hints), Feature 020 (getEntityContext depth)

---

## Overview

`Thread` 当前没有 `entityId` 字段。`buildBlock4Opts` 在 Limbic 路径只传 `{ situation: thread.trigger }`，导致 `assembleBlock4` 里的 `getEntityContext()` 分支永远无法到达——Limbic 始终走通用 `searchMemory()` fallback，而不是实体感知的深度检索。

本 Feature 在 `threads` 表添加 `entity_id` 列，透传到 `buildBlock4Opts`，让 Limbic 能走正确的 `getEntityContext()` 路径。

---

## Problem Statement

### P1：Limbic 的实体感知检索路径永远被绕过

`src/context/index.ts`（Block 4 assembly）：
```typescript
if (brain === 'limbic') {
  if (opts?.entityId) {
    results = await workspace.getEntityContext(opts.entityId, { limit: 10 }) // ← 永远不执行
  } else {
    // Fallback: 通用 searchMemory —— 始终走这里
  }
}
```

`src/runner/index.ts`（`buildBlock4Opts`）：
```typescript
if (brain === 'limbic' || brain === 'cortex') {
  if (!thread.trigger) return undefined
  return { situation: thread.trigger }  // ← entityId 从未传入
}
```

根本原因：`Thread` 接口没有 `entityId`，`buildBlock4Opts` 的 `Pick<Thread, 'trigger'>` 签名也看不到它。

### P2：Feature 020 的 getEntityContext 深度支持无法被触发

Feature 020 为 `getEntityContext()` 添加了递归深度参数，专门为 Limbic 的实体感知检索服务。没有 Thread.entityId 这个入口，Feature 020 的工作对 Limbic 毫无意义。

---

## Functional Requirements

### FR-01：Thread.entityId 字段

`Thread` 接口新增可选字段：
```typescript
entityId: string | null  // null = 无关联实体（默认）
```

`CreateThreadParams` 新增可选参数：
```typescript
entityId?: string
```

**验收条件**：
- `createThread({ entityId: 'user:alex', initiatedBy: 'external' })` 返回 `Thread`，`entityId === 'user:alex'`
- `createThread({ initiatedBy: 'external' })` 返回 `Thread`，`entityId === null`
- DB 写入正确：`SELECT entity_id FROM threads WHERE id = ?` 返回对应值

### FR-02：buildBlock4Opts 使用 entityId

`buildBlock4Opts` 对 Limbic 的逻辑变更：

```typescript
// 当前
if (brain === 'limbic' || brain === 'cortex') {
  if (!thread.trigger) return undefined
  return { situation: thread.trigger }
}

// 变更后
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

**验收条件**：
- Thread 有 `entityId` 时，Limbic 的 Block 4 opts = `{ entityId: 'user:alex' }`
- Thread 无 `entityId`（null）但有 `trigger` 时，Limbic fallback 到 `{ situation: thread.trigger }`
- Cortex 路径不变
- `buildBlock4Opts` 的 `Pick<Thread, 'trigger'>` 类型签名扩展为包含 `entityId`

### FR-03：数据库迁移

新增迁移文件 `drizzle/migrations/0005_thread_entity_id.sql`：
- `ALTER TABLE threads ADD COLUMN IF NOT EXISTS entity_id text`
- 无 NOT NULL 约束（nullable，现有行自动为 NULL）
- 与现有迁移风格一致（IF NOT EXISTS，无 transaction wrapper）

---

## User Scenarios & Testing

### 场景 A：实体感知 Limbic 激活

1. 上层应用调用 `aima.receive({ content: '...' })`，创建 Thread 时传 `entityId: 'contact:zhang-wei'`
2. Limbic 激活时，`buildBlock4Opts` 返回 `{ entityId: 'contact:zhang-wei' }`
3. `assembleBlock4` 调用 `getEntityContext('contact:zhang-wei', { limit: 10 })`
4. Limbic 拿到与该联系人相关的深度记忆，而非通用检索结果

**测试验证**：mock `workspace.getEntityContext`，验证 Limbic 激活时被调用，`searchMemory` 未被调用。

### 场景 B：无 entityId 的 Thread，fallback 行为不变

1. `createThread({ trigger: '...', initiatedBy: '...' })` — 不传 entityId
2. `buildBlock4Opts` 返回 `{ situation: thread.trigger }`
3. Block 4 走 `searchMemory` fallback（原有行为完整保留）

**测试验证**：entityId=null 时 `buildBlock4Opts` 结果与 Feature 008 行为一致。

### 场景 C：Cortex 路径不受影响

1. Thread 有 `entityId`
2. Cortex 激活时，`buildBlock4Opts` 仍然返回 `{ situation: thread.trigger }`（Cortex 不用 entityId）

---

## Key Entities

- **`threads` 表**: 新增 `entity_id text` 列
- **`Thread` 接口**: 新增 `entityId: string | null`
- **`CreateThreadParams`**: 新增 `entityId?: string`
- **`mapThreadRow()`**: 映射 `row.entityId → thread.entityId`
- **`createThread()`**: 插入时传 `entityId: params.entityId ?? null`
- **`buildBlock4Opts()`**: 扩展 Pick 类型，Limbic 分支优先使用 entityId

---

## Assumptions

- `entityId` 格式由上层应用决定（`'user:alex'`、`'contact:zhang-wei'` 等），AIMA 不做格式校验
- 迁移号为 `0005`（当前最新为 `0004_vector_embedding.sql`）
- Feature 020 的 `getEntityContext` 深度参数保持默认值（`limit: 10`），本 Feature 不改 context assembly 逻辑
- Cortex 的 `findSimilarSituations` 路径不受影响

---

## Success Criteria

1. `createThread({ entityId })` 正确持久化到 DB
2. `buildBlock4Opts` 对有 entityId 的 Limbic Thread 返回 `{ entityId }`
3. Block 4 assembly 对 entityId hint 调用 `getEntityContext`（不调用 `searchMemory`）
4. Cortex 和无 entityId 的 Limbic 零 regression
5. `bun run typecheck` 零错误，`biome check` 通过
6. 新增测试 ≥6 个

---

## Out of Scope

- `receive()` 和 `continue()` 的公共 API 添加 `entityId` 参数（上层应用自行调用 `createThread` 或本 Feature 作为基础；公共 API 扩展是独立 Feature）
- `entityId` 格式验证
- 多 entityId 支持（一个 Thread 关联多个实体）
