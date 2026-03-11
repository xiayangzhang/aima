---
work_package_id: WP02
title: Block 4 Contextual Hints
lane: "for_review"
dependencies: []
subtasks:
- T004
- T005
- T006
- T007
- T008
phase: Phase 1 - Core Fixes
assignee: ''
agent: "claude-sonnet-4-6"
shell_pid: "13123"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-11T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP02 – Block 4 Contextual Hints

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

修改 `src/runner/index.ts`，在 `activateBrain()` 中传入 `AssembleBlock4Opts`，激活脑区专属记忆检索路径（`assembleContext()` 中的 Block 4）。新增私有方法 `buildBlock4Opts()` 提取 hint 来源。

**Success Criteria**:
- `assembleContext()` 调用时正确传入 `opts`（不再是 undefined）
- cortex 激活时 `opts.situation = thread.trigger`（trigger 非空时）
- brainstem 激活时优先使用 cortex slot output 的 `task_type`，否则 fallback 到 `thread.trigger`
- limbic 激活时 `opts.situation = thread.trigger`（trigger 非空时）
- 所有字段均可选——无合适 hint 时不传 opts（返回 undefined，Block 4 自然 fallback）
- 现有测试零 regression；新增 ≥6 测试全绿
- `bun run typecheck` 零错误，`biome check` 通过

---

## Context

**Repository**: `/Volumes/leoyun/aima/`
**Implementation command**: `spec-kitty implement WP02` (no dependencies — can run in parallel with WP01)

**当前问题**（`src/runner/index.ts:178-184`）：

```typescript
const { systemPrompt, injectedMemoryIds } = await assembleContext(
  brain,
  this.workspace,
  threadId,
  this.assemblerConfig,
  this.cachedBlock12[brain],
  // opts 未传！Block 4 永远走 generic fallback
)
```

`assembleContext()` 的第 6 个参数（`opts?: AssembleBlock4Opts`）始终为 undefined，导致 Block 4 的脑区专属检索路径（`findSimilarSituations`、`getProcedure`、`getEntityContext`）永远不被调用。

**关键类型**（`src/context/index.ts`）：
```typescript
export interface AssembleBlock4Opts {
  entityId?: string   // limbic: entity context retrieval
  taskType?: string   // brainstem: procedure lookup
  situation?: string  // cortex: situation matching
}
```

**Thread 数据结构**（`src/workspace/index.ts` 或 `src/schema/`）：
- `thread.trigger` — 用户原始输入/触发内容（可能为 null）
- `slot.output` — 脑区的结构化输出（JSON object，字段由各脑区自定义）

**文件结构**：
```
src/
└── runner/index.ts    ← 唯一需要修改的文件
tests/
└── unit/
    └── thread-runner.test.ts    ← 新增/扩展测试
```

---

## Subtask Guidance

### T004: 修改 `activateBrain()` 接受 opts 参数

**文件**: `src/runner/index.ts`（第 171 行附近）

**修改**：`activateBrain()` 签名增加可选 `opts` 参数，并传入 `assembleContext()`：

```typescript
private async activateBrain(
  brain: CognitiveBrainType,
  threadId: string,
  opts?: AssembleBlock4Opts,  // 新增
): Promise<void> {
  const adapter = this.adapters.get(brain)
  if (!adapter) throw new Error(`No adapter registered for brain: ${brain}`)

  const sessionKey = `${brain}:${threadId}`
  const existingSessionId = this.brainSessions.get(sessionKey)

  const { systemPrompt, injectedMemoryIds } = await assembleContext(
    brain,
    this.workspace,
    threadId,
    this.assemblerConfig,
    this.cachedBlock12[brain],
    opts,  // 传入！
  )
  // ... rest unchanged
}
```

**Import 检查**：确认 `AssembleBlock4Opts` 已从 `'../context/index'` 导入（如未导入则添加）。

---

### T005: 新增 `buildBlock4Opts()` 私有方法

**文件**: `src/runner/index.ts`（在 `activateBrain` 附近新增）

**实现**：

```typescript
/**
 * Build AssembleBlock4Opts from thread trigger and prior slot outputs.
 * Returns undefined if no meaningful hints are available.
 */
private buildBlock4Opts(
  brain: CognitiveBrainType,
  thread: { trigger: string | null },
  slotMap: Record<string, { output: Record<string, unknown> | null } | undefined>,
): AssembleBlock4Opts | undefined {
  if (brain === 'limbic') {
    if (!thread.trigger) return undefined
    return { situation: thread.trigger }
  }

  if (brain === 'cortex') {
    if (!thread.trigger) return undefined
    return { situation: thread.trigger }
  }

  if (brain === 'brainstem') {
    const cortexOutput = slotMap.cortex?.output
    const taskType = cortexOutput?.task_type as string | undefined
    // Prefer structured task_type from cortex slot, fall back to trigger
    const hint = taskType ?? thread.trigger ?? undefined
    if (!hint) return undefined
    return { taskType: hint }
  }

  return undefined
}
```

**注意事项**：
- `thread.trigger` 类型：查看 `src/schema/` 或 `src/workspace/` 确认实际类型（可能是 `string | null`）
- `slotMap` 类型：从 `route()` 方法的 `slotMap` 构建方式推断（第 103 行附近）
- `cortexOutput?.task_type`：用 `as string | undefined` 做类型断言（cortex 输出是 JSON，无静态类型）

---

### T006: 修改 `route()` 中对 `activateBrain()` 的调用

**文件**: `src/runner/index.ts`（第 156 行附近）

**当前**：
```typescript
await this.activateBrain(nextBrain, threadId)
```

**修改**：在 `route()` 循环内，每次调用 `activateBrain` 前构建 opts：

```typescript
// Build Block 4 hints from current thread state
const opts = this.buildBlock4Opts(nextBrain, thread, slotMap)
await this.activateBrain(nextBrain, threadId, opts)
```

`thread` 和 `slotMap` 已在循环内获取（第 99-103 行），直接复用。

---

### T007: 修改 `trigger()` 方法

**文件**: `src/runner/index.ts`（第 167-169 行附近）

**当前**：
```typescript
async trigger(brain: CognitiveBrainType, threadId: string): Promise<void> {
  await this.activateBrain(brain, threadId)
}
```

`trigger()` 是 AIMAInstance 调用的入口（首次激活 limbic）。需要从 workspace 获取 thread 和 slotMap 来构建 opts。

**修改**：

```typescript
async trigger(brain: CognitiveBrainType, threadId: string): Promise<void> {
  const thread = await this.workspace.getThread(threadId)
  if (!thread) throw new Error(`Thread not found: ${threadId}`)

  const slots = await this.workspace.getSlotsByThread(threadId)
  const slotMap = Object.fromEntries(slots.map((s) => [s.brain, s]))

  const opts = this.buildBlock4Opts(brain, thread, slotMap)
  await this.activateBrain(brain, threadId, opts)
}
```

> 注意：`trigger()` 触发时 slotMap 通常为空（首次激活），`buildBlock4Opts` 对 limbic 只需要 `thread.trigger`，所以这是正确的。

---

### T008: 新增单元测试

**文件**: `tests/unit/thread-runner.test.ts`（新建或扩展）

**测试目标**：验证 `buildBlock4Opts()` 逻辑和 `activateBrain()` 正确传入 opts。

**需要的测试（≥6 个）**：

**测试 1**: limbic + trigger 存在 → opts = `{ situation: trigger }`
```typescript
// buildBlock4Opts('limbic', { trigger: 'test input' }, {})
// → { situation: 'test input' }
```

**测试 2**: limbic + trigger 为 null → opts = undefined
```typescript
// buildBlock4Opts('limbic', { trigger: null }, {})
// → undefined
```

**测试 3**: cortex + trigger 存在 → opts = `{ situation: trigger }`
```typescript
// buildBlock4Opts('cortex', { trigger: 'test' }, {})
// → { situation: 'test' }
```

**测试 4**: brainstem + cortex slot 有 task_type → opts = `{ taskType: 'document_prep' }`
```typescript
// buildBlock4Opts('brainstem',
//   { trigger: 'user input' },
//   { cortex: { output: { task_type: 'document_prep' } } }
// )
// → { taskType: 'document_prep' }  (优先 cortex output)
```

**测试 5**: brainstem + cortex slot 无 task_type → fallback 到 trigger
```typescript
// buildBlock4Opts('brainstem',
//   { trigger: 'user input' },
//   { cortex: { output: {} } }
// )
// → { taskType: 'user input' }  (fallback)
```

**测试 6**: brainstem + 无 cortex slot 且无 trigger → opts = undefined
```typescript
// buildBlock4Opts('brainstem', { trigger: null }, {})
// → undefined
```

**Mock 策略**：`buildBlock4Opts` 是私有方法，通过间接测试验证（观察 `assembleContext` mock 的调用参数）。或者将其提取为模块内 helper 函数（更易测试），但设计上保持私有更合适。

**推荐**：在测试中 spy/mock `assembleContext`，验证调用时的第 6 个参数（opts）是否符合预期。

---

## Definition of Done

- [ ] T004: `activateBrain()` 签名增加 `opts?: AssembleBlock4Opts`，传入 `assembleContext()`
- [ ] T005: `buildBlock4Opts()` 私有方法实现，逻辑正确（limbic/cortex 用 trigger，brainstem 优先 cortex task_type）
- [ ] T006: `route()` 中每次调用 `activateBrain()` 时传入 opts
- [ ] T007: `trigger()` 获取 thread/slotMap 并构建 opts，传入 `activateBrain()`
- [ ] T008: ≥6 新测试全绿，验证各脑区 opts 提取逻辑
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] 现有测试零 regression

---

## Risks & Notes

- **Thread.trigger 类型**：实现前确认 `thread.trigger` 的实际 TypeScript 类型（`string | null`？`string | undefined`？）。从 `src/schema/threads.ts` 或 `src/workspace/index.ts` 中查找。
- **slotMap 类型**：`slotMap` 的 value 包含 `output: Record<string, unknown> | null`，使用 optional chaining 安全读取。
- **并行安全**：`buildBlock4Opts` 是纯函数（无副作用），不影响并发路由安全性。
- **WP01 并行**：WP01 和 WP02 修改不同文件（instance.ts vs runner/index.ts），可并行实现。

---

## Reviewer Guidance

**Review focus**:
1. `assembleContext()` 调用是否传入了 opts（不再是 undefined）
2. `buildBlock4Opts()` 的三个脑区逻辑是否正确（尤其是 brainstem 的优先级）
3. `trigger()` 方法是否正确获取 thread 和 slotMap
4. 无合适 hint 时是否返回 undefined（不强制传入 empty opts）
5. 测试是否覆盖了 fallback 路径（无 trigger、无 cortex output 等边界情况）

## Activity Log

- 2026-03-11T13:07:12Z – claude-sonnet-4-6 – shell_pid=13123 – lane=doing – Started implementation via workflow command
- 2026-03-11T13:10:27Z – claude-sonnet-4-6 – shell_pid=13123 – lane=for_review – Ready for review: buildBlock4Opts() adds brain-specific Block 4 hints. limbic/cortex→situation from trigger, brainstem→taskType from cortex output or fallback to trigger. activateBrain() and trigger() both pass opts to assembleContext(). 7 new tests, 326 unit tests pass, typecheck clean.
