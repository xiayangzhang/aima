---
work_package_id: WP01
title: reopenThread + AIMAInstance.continue()
lane: "for_review"
dependencies: []
subtasks:
- T001
- T002
- T003
phase: Phase 1 - Implementation
assignee: ''
agent: "claude-sonnet-4-6"
shell_pid: "16620"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-12T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP01 – reopenThread + AIMAInstance.continue()

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

新增两个方法实现多轮对话续接：

1. `CognitiveWorkspace.reopenThread(id, trigger)` — 原子写入，状态校验
2. `AIMAInstance.continue(threadId, input)` — 复用 `receive()` 的完整路由路径

**Success Criteria**:
- `continue()` 调用后，`brainSessions.get('limbic:threadId')` 仍存在（session 历史不丢失）
- `complete` 和 `interrupted` 状态的 Thread 可被 `continue()` 重新激活
- `active` 或 `waiting` 状态调用 `continue()` 时抛出明确错误
- Thread 不存在时抛出 `Thread not found`
- `continue()` 后 `thread.trigger` 等于新 content
- `receive()` 零 regression
- ≥6 新测试全绿，`bun run typecheck` 零错误，`biome check` 通过

---

## Context

**Repository**: `/Volumes/leoyun/aima/`
**Implementation command**: `spec-kitty implement WP01`

**现有相关代码**：

`src/workspace/index.ts:231` — 现有 `updateThreadState()`（只更新 state，不更新 trigger）：
```typescript
async updateThreadState(id: string, state: ThreadState): Promise<void> {
  await this.db.update(threads).set({ state, updatedAt: new Date() }).where(eq(threads.id, id))
}
```

`src/instance.ts:200` — 现有 `receive()` 完整实现（`continue()` 复用此路径）：
```typescript
async receive(input: { content: string; channel?: string; externalId?: string }): Promise<{ threadId: string }> {
  // identity lazy init...
  const thread = await this.workspace.createThread({
    initiatedBy: 'external',
    ...(input.channel !== undefined ? { sourceChannel: input.channel } : {}),
    ...(input.externalId !== undefined ? { trigger: input.externalId } : {}),
  })
  await this.threadRunner.trigger('limbic', thread.id)
  await this.workspace.waitForComplete(thread.id)
  return { threadId: thread.id }
}
```

**文件结构**：
```
src/
├── workspace/index.ts   ← T001: 新增 reopenThread()
└── instance.ts          ← T002: 新增 continue()

tests/
└── unit/aima-instance.test.ts    ← T003: 新增测试
```

---

## Subtask Guidance

### T001: `CognitiveWorkspace.reopenThread()`

**文件**: `src/workspace/index.ts`（在 `updateThreadState()` 之后添加）

**实现**：

```typescript
/**
 * Reopen a completed or interrupted Thread for continuation.
 * Atomically resets state to 'active' and updates the trigger to the new content.
 *
 * @throws {Error} if Thread does not exist
 * @throws {Error} if Thread is in 'active' or 'waiting' state (concurrent protection)
 */
async reopenThread(id: string, trigger: string): Promise<void> {
  const thread = await this.getThread(id)
  if (!thread) throw new Error(`Thread not found: ${id}`)
  if (thread.state === 'active' || thread.state === 'waiting') {
    throw new Error(`Cannot reopen Thread in state '${thread.state}': ${id}`)
  }
  await this.db
    .update(threads)
    .set({ state: 'active', trigger, updatedAt: new Date() })
    .where(eq(threads.id, id))
}
```

**注意**：
- `threads` 表的 `trigger` 列的 Drizzle 类型是 `text`（nullable），`string` 赋值没问题
- 检查 `src/schema/threads.ts` 确认列名（可能是 `trigger` 或其他）
- `getThread()` + `update()` 不是原子的——在生产并发场景有 TOCTOU 窗口，但对当前 AIMA 的单进程 ThreadRunner 模型已足够；不需要加分布式锁

---

### T002: `AIMAInstance.continue()`

**文件**: `src/instance.ts`（在 `receive()` 之后添加）

**实现**：

```typescript
/**
 * Continue an existing Thread with new input.
 * Reuses the existing Limbic session (conversation history preserved).
 *
 * Supported Thread states: 'complete', 'interrupted'.
 * Call receive() to start a new Thread instead.
 *
 * @throws {Error} if Thread does not exist
 * @throws {Error} if Thread is in 'active' or 'waiting' state
 */
async continue(
  threadId: string,
  input: {
    content: string
    channel?: string
    externalId?: string
  },
): Promise<{ threadId: string }> {
  // Identity lazy init (same as receive())
  if (this.identityLoader) {
    if (this.identityCache === null || this._config.reloadOnRun) {
      this.identityCache = await this.identityLoader.load()
      this.threadRunner.updateAssemblerConfig(this.buildAssemblerConfig())
    }
  }

  // Reopen Thread with new trigger
  await this.workspace.reopenThread(threadId, input.content)

  // Same routing path as receive()
  await this.threadRunner.trigger('limbic', threadId)
  await this.workspace.waitForComplete(threadId)

  return { threadId }
}
```

**关键点**：
- identity lazy init 代码与 `receive()` 完全相同，直接复制——不抽象为私有方法（过度工程，两处就够了）
- `input.channel` 和 `input.externalId` 在当前实现中不被使用（Thread 已存在，不需要重新设置这些字段）。保留参数是为了 API 形状与 `receive()` 一致，未来可扩展
- `brainSessions` Map 不需要任何操作——`limbic:threadId` key 仍在 Map 中，`trigger()` 调用时会找到 existing session 并续接

---

### T003: 测试（≥6 个）

**文件**: `tests/unit/aima-instance.test.ts`（新增，或在现有文件中添加 describe block）

**需要的测试**：

**测试 1**: `complete` 状态 Thread 可被 `continue()` 重新激活
```typescript
// 创建 mock Thread，状态为 complete
// 调用 continue()，验证 workspace.reopenThread() 被调用
// 验证 threadRunner.trigger('limbic', threadId) 被调用
```

**测试 2**: `interrupted` 状态 Thread 可被 `continue()`
```typescript
// 同上，state = 'interrupted'
```

**测试 3**: `active` 状态 Thread 调用 `continue()` 时抛出
```typescript
// mock Thread state = 'active'
// expect(continue()).rejects.toThrow("Cannot reopen Thread in state 'active'")
```

**测试 4**: Thread 不存在时抛出 `Thread not found`
```typescript
// mock getThread() 返回 null
// expect(continue()).rejects.toThrow('Thread not found')
```

**测试 5**: `continue()` 后 `thread.trigger` 更新为新 content
```typescript
// 验证 workspace.reopenThread() 被调用时第二个参数是 input.content
```

**测试 6**: Limbic session 未被重置（session key 仍在 brainSessions Map）
```typescript
// 这个测试验证 continue() 不会调用 brainSessions.delete() 或 clear()
// 由于 brainSessions 是 ThreadRunner 私有，通过验证 adapter.run() 被调用时
// 没有 initialPrompt（表示续接已有 session，不是新建）来间接验证
// OR: 直接 spy ThreadRunner.trigger() 确认不清除 brainSessions
```

**Mock 策略**：
- mock `CognitiveWorkspace`：`getThread()`、`reopenThread()`、`waitForComplete()`
- mock `ThreadRunner`：spy `trigger()` 验证调用
- 不需要真实数据库（单元测试）
- 参考现有 `tests/unit/aima-instance.test.ts` 中的 mock 模式

**集成测试**（可选，若时间允许）：
- `AIMA_TEST_DATABASE_URL` 环境下验证 `reopenThread()` 真实 DB 写入
- 验证 `thread.trigger` 在 DB 中更新

---

## Definition of Done

- [ ] T001: `CognitiveWorkspace.reopenThread()` 实现，带状态校验和 JSDoc
- [ ] T002: `AIMAInstance.continue()` 实现，identity lazy-init 逻辑同 `receive()`
- [ ] T003: ≥6 测试全绿
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] 现有 357 个测试零 regression

---

## Risks & Notes

- **`trigger` 列名**：实现前确认 `src/schema/threads.ts` 中 `trigger` 列的 Drizzle 列名（避免 runtime 错误）
- **`waitForComplete` 行为**：`waitForComplete()` 在 Thread 已经是 `complete/interrupted` 时立即 resolve（见 workspace/index.ts:192），`reopenThread()` 后 Thread 变为 `active`，所以 `waitForComplete()` 会正常等待新一轮完成
- **`input.channel/externalId` 静默忽略**：目前不写回 Thread，可在注释中说明是未来扩展点

---

## Reviewer Guidance

**Review focus**:
1. `reopenThread()` 状态校验是否正确（拒绝 `active/waiting`，接受 `complete/interrupted`）
2. `continue()` 是否有 identity lazy-init（与 `receive()` 一致）
3. `brainSessions` Map 是否完好保留（session 历史不丢失）
4. 测试 6 是否真正验证了 session 续接（不是新建）
5. `receive()` 现有测试是否仍全部通过

## Activity Log

- 2026-03-11T23:40:43Z – claude-sonnet-4-6 – shell_pid=16620 – lane=doing – Started implementation via workflow command
- 2026-03-11T23:42:34Z – claude-sonnet-4-6 – shell_pid=16620 – lane=for_review – Ready for review: reopenThread() in CognitiveWorkspace with state validation, continue() in AIMAInstance reusing receive() routing path, 9 unit tests all passing (346 total, zero regressions), typecheck clean, biome clean
