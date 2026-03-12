---
work_package_id: WP01
title: Input Content Delivery Fix
lane: "planned"
dependencies: []
subtasks:
- T001
- T002
- T003
- T004
phase: Phase 1
assignee: ''
agent: ''
shell_pid: ''
review_status: ''
history:
- timestamp: '2026-03-13T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt created.
---

# Work Package Prompt: WP01 — Input Content Delivery Fix

## Objectives & Success Criteria

修复三个文件的 content delivery 缺口，使外部输入能真正到达 Limbic 的 LLM 调用和 Block 3 上下文：

- `receive()` 存储 `input.content`（不是 `externalId`）作为 `thread.trigger`
- `activateBrain()` 新会话使用 `thread.trigger` 作为 `initialPrompt`
- `assembleBlock3()` 在 Block 3 中显示 `trigger`
- 单元测试 T029-A 到 T029-G 全部通过

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/029-receive-input-content-delivery/spec.md`
- **Plan**: `kitty-specs/029-receive-input-content-delivery/plan.md`
- **Target files**:
  - `src/instance.ts` (修改 `receive()`)
  - `src/runner/index.ts` (修改 `activateBrain()` 及 3 个调用点)
  - `src/context/index.ts` (修改 `assembleBlock3()`)
- **No schema changes** — `Thread.trigger: string | null` 已存在
- **Constraint**: `continue()` 行为不变（已正确）；`routePending()` 不传 `triggerContent`

---

## Subtask Details

### T001 — 修复 `receive()` 存储 `input.content`

**Purpose**: `receive()` 当前把 `input.externalId` 存为 `thread.trigger`，导致 Block 4 语义检索和 `initialPrompt` 全部拿到错误值。

**步骤**:

找到 `src/instance.ts` 的 `receive()` 方法（约 226 行），修改 `createThread` 调用：

```typescript
// 修改前（约 239-243 行）：
const thread = await this.workspace.createThread({
  initiatedBy: 'external',
  ...(input.channel !== undefined ? { sourceChannel: input.channel } : {}),
  ...(input.externalId !== undefined ? { trigger: input.externalId } : {}),
})

// 修改后：
const thread = await this.workspace.createThread({
  initiatedBy: 'external',
  trigger: input.content,
  ...(input.channel !== undefined ? { sourceChannel: input.channel } : {}),
})
```

`input.externalId` 保留在接口定义中（不删除参数），但不再传给 `createThread`。

**Files**: `src/instance.ts`

**Validation**:
- [ ] `createThread` 调用包含 `trigger: input.content`
- [ ] 不再传 `externalId` 给 `createThread`
- [ ] `input.externalId` 字段仍在接口定义中（向后兼容）
- [ ] `continue()` 不变

---

### T002 — 升级 `activateBrain()` 传递 `triggerContent`

**Purpose**: 新 brain session 的 `initialPrompt` 当前是硬编码 placeholder，导致 Limbic 第一次 LLM 调用看不到任何实际内容。

**步骤**:

1. 找到 `src/runner/index.ts` 的 `activateBrain()` 私有方法（约 221 行），添加可选参数：

```typescript
private async activateBrain(
  brain: CognitiveBrainType,
  threadId: string,
  opts?: AssembleBlock4Opts,
  triggerContent?: string,      // ← 新增
): Promise<void> {
```

2. 修改 `initialPrompt` 逻辑（约 250-252 行）：

```typescript
const params: BrainRunParams = existingSessionId
  ? { brain, threadId, systemPrompt }
  : { brain, threadId, systemPrompt, initialPrompt: triggerContent ?? `Thread ${threadId} — activate ${brain}` }
```

3. 更新 **3 个调用点**，传入 `thread.trigger ?? undefined`：

**调用点 A — `trigger()` 方法（约 218 行）**：
```typescript
// 修改前：
await this.activateBrain(brain, threadId, opts)

// 修改后：
await this.activateBrain(brain, threadId, opts, thread.trigger ?? undefined)
```

注：`trigger()` 方法中 `thread` 已在第 211 行通过 `getThread(threadId)` 获取。

**调用点 B — Route 循环（约 183 行）**：
```typescript
// 修改前：
await this.activateBrain(nextBrain, threadId, opts)

// 修改后：
await this.activateBrain(nextBrain, threadId, opts, thread.trigger ?? undefined)
```

注：`thread` 已在循环开头第 125 行获取。

**调用点 C — `recoverInFlightThreads()` 中的 Limbic 恢复（约 337 行）**：
```typescript
// 修改前：
await this.activateBrain('limbic', thread.id)

// 修改后：
await this.activateBrain('limbic', thread.id, undefined, thread.trigger ?? undefined)
```

注：`thread` 已在 `for` 循环中可用。

**不修改的调用点** — `routePending()` 约 322 行：
```typescript
await this.activateBrain(item.targetBrain as CognitiveBrainType, targetThreadId)
// 不添加 triggerContent 参数 — DMN scheduled threads 不传用户内容
```

**Files**: `src/runner/index.ts`

**Validation**:
- [ ] `activateBrain` 签名有第 4 个可选参数 `triggerContent?: string`
- [ ] `initialPrompt` 使用 `triggerContent ?? \`Thread...\``
- [ ] `trigger()` 调用传 `thread.trigger ?? undefined`
- [ ] Route 循环调用传 `thread.trigger ?? undefined`
- [ ] `recoverInFlightThreads()` 调用传 `thread.trigger ?? undefined`
- [ ] `routePending()` 调用不变（无第 4 参数）

---

### T003 — 在 `assembleBlock3()` 中显示 `trigger`

**Purpose**: 即使 `initialPrompt` 正确了，Brain 在系统 prompt 层也应该能看到当前 thread 的 trigger，尤其是 re-activation 场景。

**步骤**:

找到 `src/context/index.ts` 的 `assembleBlock3()` 函数（约 84-93 行），在 `thread_state` 行之后添加 `trigger` 行：

```typescript
return [
  '## Current Context',
  `- local_time: ${localTime}`,
  `- timezone: ${timezone}`,
  `- thread_id: ${threadId}`,
  `- thread_state: ${thread?.state ?? 'unknown'}`,
  ...(thread?.trigger ? [`- trigger: ${thread.trigger}`] : []),  // ← 新增
  '',
  '## Workspace Slots',
  slotsText || '  (no slots yet)',
].join('\n')
```

只在 `thread.trigger` 为非空字符串时输出，避免 DMN/scheduled threads 产生噪音。

**Files**: `src/context/index.ts`

**Validation**:
- [ ] Block 3 输出包含 `- trigger: <内容>` 当 `thread.trigger` 非空
- [ ] Block 3 不含 `trigger:` 行当 `thread.trigger` 为 null/undefined

---

### T004 — 单元测试 T029-A 到 T029-G

**Purpose**: 覆盖三处修改的关键行为，并防止回归。

**测试文件说明**:
- T029-A/B：在 `tests/unit/` 下新建或找到 `instance.test.ts`（若无则新建）
- T029-C/D/E：追加到 `tests/unit/thread-runner.test.ts` 的现有测试套件
- T029-F/G：在 `tests/unit/context.test.ts` 或新建 `tests/unit/context-block3.test.ts`

**T029-A — `receive()` 存储 content，不存 externalId**:
```typescript
test('receive() stores content as thread trigger', async () => {
  let capturedArgs: Record<string, unknown> | null = null
  const mockWorkspace = makeMockWorkspace({
    createThread: async (args) => {
      capturedArgs = args
      return makeThread({ id: 'thread-1', trigger: args.trigger as string })
    },
  })
  const instance = makeTestInstance(mockWorkspace)
  await instance.receive({ content: 'approve the budget', externalId: 'msg-123' })

  expect(capturedArgs?.trigger).toBe('approve the budget')
  expect(capturedArgs).not.toHaveProperty('externalId')
})
```

**T029-B — `receive()` 无 externalId 时仍存 content**:
```typescript
test('receive() stores content as trigger when no externalId', async () => {
  // Similar to T029-A without externalId in input
  // Assert createThread called with trigger: 'hello'
})
```

**T029-C — 新 session 使用 triggerContent 作为 initialPrompt**:

在 `tests/unit/thread-runner.test.ts` 的 mock 模式中：
```typescript
test('activateBrain uses triggerContent as initialPrompt for new session', async () => {
  const runArgs: BrainRunParams[] = []
  const adapter = { run: async (p: BrainRunParams) => { runArgs.push(p); return { sessionId: 's1', stopReason: 'done' } } }
  const runner = makeTestRunner({ adapters: { limbic: adapter } })

  // trigger() path — thread with trigger
  const thread = makeThread({ id: 'thread-1', trigger: 'approve the budget' })
  mockWorkspace.getThread = async () => thread

  await runner.trigger('limbic', 'thread-1')

  expect(runArgs[0]?.initialPrompt).toBe('approve the budget')
})
```

**T029-D — 无 triggerContent 时使用 placeholder**:
```typescript
test('activateBrain uses placeholder when triggerContent is undefined', async () => {
  // thread with trigger: null
  // Assert initialPrompt starts with 'Thread thread-1 — activate'
})
```

**T029-E — 已有 session 不传 initialPrompt**:
```typescript
test('activateBrain skips initialPrompt for existing session', async () => {
  // Pre-register sessionId in brainSessions map
  // Assert run() called without initialPrompt property
})
```

**T029-F — Block 3 显示 trigger**:
```typescript
test('assembleBlock3 includes trigger when set', async () => {
  const result = await assembleBlock3('limbic', mockWorkspace('approve the budget'), 'thread-1', 'UTC')
  expect(result).toContain('- trigger: approve the budget')
})
```

**T029-G — Block 3 无 trigger 行当 null**:
```typescript
test('assembleBlock3 omits trigger when null', async () => {
  const result = await assembleBlock3('limbic', mockWorkspace(null), 'thread-1', 'UTC')
  expect(result).not.toContain('trigger:')
})
```

**Files**:
- `tests/unit/instance.test.ts`（新建或已有）
- `tests/unit/thread-runner.test.ts`（追加）
- `tests/unit/context.test.ts` 或 `tests/unit/context-block3.test.ts`

**Validation**:
- [ ] T029-A 到 T029-G 全部存在
- [ ] `bun test` 全绿
- [ ] 现有测试无回归

---

## Definition of Done

- [ ] T001: `receive()` 存 `input.content` 为 trigger，`externalId` 不传给 `createThread`
- [ ] T002: `activateBrain()` 第 4 参数 `triggerContent?`，3 个调用点已更新
- [ ] T003: Block 3 含 `trigger` 行（非空时）
- [ ] T004: T029-A 到 T029-G 全部通过
- [ ] `bun run typecheck` 通过
- [ ] `biome check` 通过
- [ ] `bun test` 全量零新增 failure

## Risks

- `activateBrain()` 有 4 个调用点，`routePending()` 不传 triggerContent — 需仔细确认只更新正确的 3 个
- 若现有 `thread-runner.test.ts` 中有直接构造 `activateBrain` 调用的 private 方法测试，需同步更新签名（但通常通过 `trigger()` 公开方法测试）
- Block 3 中的 trigger 可能很长（未来可能需要截断）——本期不处理，Out of Scope

## Reviewer Guidance

- 验证 `receive()` 的 `externalId` 字段仍保留在接口（向后兼容，不破坏现有调用方）
- 验证 `routePending()` 的 `activateBrain` 调用**未添加** `triggerContent` 参数
- 验证 Block 3 `trigger` 行只在非空时出现（`thread?.trigger ? [...]  : []` 模式）
- 运行 `bun test` 确认零回归

## Activity Log

- 2026-03-13T00:00:00Z – system – lane=planned – Prompt created.
