# Feature Specification: Thread Continue (Multi-Turn Dialog)

**Feature**: 010-thread-continue-multi-turn
**Status**: Draft
**Created**: 2026-03-12
**Depends on**: Feature 002 (Brain Runtime)

---

## Overview

AIMA 当前只有 `receive()`——每次调用创建新 Thread。真实对话是多轮的：用户发第二条消息时，应用层（secondfirst/AIMA-CLAW）需要将其路由到已有 Thread，而不是开启全新认知链路。

`continue(threadId, content)` 实现这个能力：向已有 Thread 注入新内容，将 Thread 状态重置为 active，重新激活 Limbic。Limbic 的 session 历史在 `brainSessions` Map 中完好保留（`limbic:${threadId}` key 不变），Limbic 天然记得上下文，无需任何额外机制。

---

## Problem Statement

### P1：`AIMAInstance` 无法续接已有 Thread

```typescript
// 当前——每次都是新 Thread，对话历史断裂
const { threadId } = await aima.receive({ content: '帮我准备明天的会议材料' })
// 用户追问：
await aima.receive({ content: '加上财务数据' })  // ← 新 Thread，Limbic 不记得第一条消息
```

上层必须靠自己维护对话连续性（无能为力，session 在 AIMA 内部）。

### P2：Thread 状态机没有"重新开放"路径

`complete` 状态的 Thread 无法被二次激活。现实中对话不会因为 AIMA 完成一次路由就"结束"——用户随时可能追问。

---

## Functional Requirements

### FR-01：`AIMAInstance.continue()` API

```typescript
aima.continue(threadId: string, input: {
  content: string
  channel?: string
  externalId?: string
}): Promise<{ threadId: string }>
```

行为：
1. 验证 Thread 存在（不存在则抛出明确错误）
2. 将 Thread 状态重置为 `active`（接受 `complete` 或 `interrupted` 当前状态）
3. 更新 `thread.trigger` 为新内容（Block 4 hints 使用最新 trigger）
4. 重新激活 Limbic（与 `receive()` 的 `threadRunner.trigger('limbic', threadId)` 相同调用路径）
5. 等待 Thread 再次完成
6. 返回 `{ threadId }`（与 `receive()` 相同形状）

**验收条件**：
- 同一 `threadId` 的多次 `continue()` 调用，Limbic session 历史完整保留（对话连续）
- `complete` 状态 Thread 可被 `continue()` 重新激活
- `interrupted` 状态 Thread 可被 `continue()` 重新激活
- Thread 不存在时抛出明确错误（不静默失败）

### FR-02：`thread.trigger` 随 `continue()` 更新

`continue()` 调用时，`thread.trigger` 更新为最新内容。

原因：`trigger` 是 Block 4 hints 的来源（Feature 008 已实现），若不更新则 Block 4 永远使用首次激活的 trigger，导致记忆检索偏移。

**验收条件**：
- `continue()` 后，`workspace.getThread(threadId).trigger` 等于最新 `content`
- 下一轮 Limbic 激活时，Block 4 opts 使用更新后的 trigger

### FR-03：向后兼容 `receive()`

`receive()` 行为完全不变。`continue()` 是独立新方法，不修改现有代码路径。

---

## User Scenarios & Testing

### 场景 A：两轮对话，Limbic 记得上下文

1. `receive({ content: '帮我准备明天的会议材料' })` → threadId = T1
2. 用户追问：`continue(T1, { content: '加上财务数据' })`
3. Limbic 在 T1 的 session 中有完整历史，直接理解"加上"指的是之前的材料

**测试验证**：mock Limbic session，验证 `continue()` 调用时 session key `limbic:T1` 已存在（不创建新 session）。

### 场景 B：`complete` 状态 Thread 可被续接

1. `receive()` 完成，Thread 状态 = `complete`
2. `continue(threadId, { content: '...' })` → Thread 状态回到 `active`，Limbic 重新激活
3. 完成后 Thread 再次变 `complete`

### 场景 C：Thread 不存在时明确报错

1. `continue('nonexistent-id', { content: '...' })` → 抛出 `Error: Thread not found: nonexistent-id`

### 场景 D：AIMA-CLAW / secondfirst 集成

应用层维护 `userId → threadId` 映射。同一对话窗口内，新消息调用 `continue()`；新对话调用 `receive()`。AIMA 不参与这个决策。

---

## Key Entities

- **`AIMAInstance.continue()`**：新公共方法，与 `receive()` 相同返回形状
- **Thread 状态重置**：`complete/interrupted → active`（Workspace 层负责）
- **`thread.trigger` 更新**：Workspace 层新增 `updateThreadTrigger()` 或扩展现有更新方法

---

## Assumptions

- **"哪条消息属于哪个 Thread"是应用层决策**，AIMA 不做任何推断
- `brainSessions` Map 在进程存活期间保留 session 历史；进程重启后 session 丢失（已有 crash recovery 机制处理，重启后 Limbic 从空 session 开始，但 Thread/Slot 持久化完整）
- `continue()` 不支持 `waiting` 状态的 Thread（等待中的 Thread 由 DMN 的 pending 机制处理）
- 并发保护：同一 Thread 的 `continue()` 和正在进行的路由循环不应并发，由 `processingThreads` Set 保护（ThreadRunner 已有）

---

## Success Criteria

1. `continue()` API 可用，行为与 `receive()` 一致（除 Thread 创建外）
2. Limbic session 历史在同一 Thread 的多次 `continue()` 间保留
3. `trigger` 更新后 Block 4 hints 使用最新内容
4. Thread 不存在时抛出明确错误
5. `receive()` 零 regression
6. `bun run typecheck` 零错误，`biome check` 通过
7. 新增测试 ≥6 个

---

## Out of Scope

- `waiting` 状态 Thread 的 `continue()`（DMN pending 机制已处理）
- 多消息批量注入（一次 `continue()` 只注入一条）
- 跨进程 session 历史持久化（进程重启后 session 丢失是已知限制）
