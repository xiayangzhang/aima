---
work_package_id: WP01
title: Wire clearWorkingMemory into ThreadRunner and add unit tests
lane: "doing"
dependencies: []
subtasks: [T001, T002, T003]
assignee: ""
agent: "claude"
shell_pid: "37605"
review_status: ""
reviewed_by: ""
history:
  - timestamp: "2026-03-13T00:00:00Z"
    lane: "planned"
    agent: "system"
    action: "Prompt generated via spec-kitty agent feature finalize-tasks"
---

# Work Package Prompt: WP01 — Wire clearWorkingMemory into ThreadRunner and Add Unit Tests

## Goal

`CognitiveWorkspace.clearWorkingMemory(threadId)` exists but `ThreadRunner` never calls it. When a thread reaches `complete` or `interrupted` state, add a fire-and-forget call to `clearWorkingMemory` at both termination points. Add four unit tests covering the completion, interrupted, DEFER/waiting, and failure-swallowed scenarios.

## Implementation Command

```bash
spec-kitty agent workflow implement --agent <your-name>
```

No dependencies — implement directly on the feature branch.

## Context

### Key Files

- **Modified**: `src/runner/index.ts` — add 2 lines at the two terminal paths (lines ~148–165)
- **Modified**: `tests/unit/thread-runner.test.ts` — append 4 tests to the `'ThreadRunner routing — extended'` describe block

### The Gap

`src/runner/index.ts` has two terminal paths that currently do NOT call `clearWorkingMemory`:

**Path 1 — Normal completion** (`next === null`, line ~148):
```typescript
if (next === null || next === undefined) {
  await this.workspace.updateThreadState(threadId, 'complete')
  // ← missing: this.workspace.clearWorkingMemory(threadId).catch(() => {})
  this.workspace.notifyThreadComplete(threadId)
  return
}
```

**Path 2 — Illegal transition** (`!isLegalTransition`, line ~155):
```typescript
if (!isLegalTransition(currentBrain, next)) {
  await this.workspace.updateThreadState(threadId, 'interrupted')
  // ← missing: this.workspace.clearWorkingMemory(threadId).catch(() => {})
  this.eventBus.emit({ event_type: 'thread.interrupted', ... })
  return
}
```

**Path 3 — DEFER** (`next === 'self'`, line ~169) — `handleDefer` sets state to `waiting`. This path must NOT get `clearWorkingMemory` — the thread will resume from `waiting`.

### Fire-and-Forget Contract

`.catch(() => {})` is mandatory. Working memory cleanup is DB housekeeping. If it fails, the thread completion signal must still fire normally. Never `await` the `clearWorkingMemory` call.

### Test Mock Pattern

Existing tests in `tests/unit/thread-runner.test.ts` use this pattern (copy it exactly):

```typescript
const workspace = new CognitiveWorkspace(mockDb)
// patch methods directly:
workspace.getThread = async () => thread
workspace.getSlotsByThread = async () => slots
workspace.updateThreadState = async (_id, state) => { thread.state = state }
workspace.getActiveThreads = async () => []
workspace.searchMemory = async () => []
// add for these tests:
workspace.clearWorkingMemory = async (_tid) => { clearCalled.push(_tid) }
```

Then trigger with `workspace.notifySlotDone('thread-1', brain, 'done')` and wait with `await new Promise((r) => setTimeout(r, 50))`.

The existing `patchWorkspace` helper in the `'ThreadRunner routing — extended'` describe block does NOT include `clearWorkingMemory` — either extend calls to it with a direct assignment after calling `patchWorkspace`, or write the full patch inline for these tests.

## T001 — Completion path

**File**: `src/runner/index.ts`

Find (around line 148):
```typescript
if (next === null || next === undefined) {
  await this.workspace.updateThreadState(threadId, 'complete')
  this.workspace.notifyThreadComplete(threadId)
  return
}
```

Replace with:
```typescript
if (next === null || next === undefined) {
  await this.workspace.updateThreadState(threadId, 'complete')
  this.workspace.clearWorkingMemory(threadId).catch(() => {})
  this.workspace.notifyThreadComplete(threadId)
  return
}
```

## T002 — Interrupted path

**File**: `src/runner/index.ts`

Find (around line 155):
```typescript
if (!isLegalTransition(currentBrain, next)) {
  await this.workspace.updateThreadState(threadId, 'interrupted')
  this.eventBus.emit({
    event_type: 'thread.interrupted',
    level: 'ALERT',
    brain: currentBrain,
    thread_id: threadId,
    session_id: null,
    payload: { reason: 'illegal_transition', from: currentBrain, to: next },
  })
  return
}
```

Replace with:
```typescript
if (!isLegalTransition(currentBrain, next)) {
  await this.workspace.updateThreadState(threadId, 'interrupted')
  this.workspace.clearWorkingMemory(threadId).catch(() => {})
  this.eventBus.emit({
    event_type: 'thread.interrupted',
    level: 'ALERT',
    brain: currentBrain,
    thread_id: threadId,
    session_id: null,
    payload: { reason: 'illegal_transition', from: currentBrain, to: next },
  })
  return
}
```

## T003 — Unit tests

**File**: `tests/unit/thread-runner.test.ts`

Append the following four tests inside the `describe('ThreadRunner routing — extended', () => {` block, before the closing `})`:

### Test V1 — clearWorkingMemory called on normal completion

```typescript
test('next=null → clearWorkingMemory called with threadId on complete', async () => {
  const workspace = new CognitiveWorkspace(mockDb)
  const eventBus = new BrainEventBus()
  const thread = makeThread()
  const clearCalled: string[] = []

  workspace.getThread = async () => thread
  workspace.getSlotsByThread = async () => [makeSlot('limbic', {})]
  workspace.updateThreadState = async (_id, state) => { thread.state = state }
  workspace.getActiveThreads = async () => []
  workspace.searchMemory = async () => []
  workspace.clearWorkingMemory = async (tid) => { clearCalled.push(tid) }

  const adapters = new Map<CognitiveBrainType, BrainAdapter>()
  const runner = makeRunner(adapters, workspace, eventBus)
  await runner.start()

  workspace.notifySlotDone('thread-1', 'limbic', 'done')
  await new Promise((r) => setTimeout(r, 50))

  expect(thread.state).toBe('complete')
  expect(clearCalled).toEqual(['thread-1'])
  runner.stop()
})
```

### Test V2 — clearWorkingMemory called on interrupted

```typescript
test('illegal transition → clearWorkingMemory called with threadId on interrupted', async () => {
  const workspace = new CognitiveWorkspace(mockDb)
  const eventBus = new BrainEventBus()
  const thread = makeThread()
  const clearCalled: string[] = []

  workspace.getThread = async () => thread
  workspace.getSlotsByThread = async () => [makeSlot('cortex', { next: 'self' })]
  workspace.updateThreadState = async (_id, state) => { thread.state = state }
  workspace.getActiveThreads = async () => []
  workspace.searchMemory = async () => []
  workspace.clearWorkingMemory = async (tid) => { clearCalled.push(tid) }

  const adapters = new Map<CognitiveBrainType, BrainAdapter>()
  const runner = makeRunner(adapters, workspace, eventBus)
  await runner.start()

  workspace.notifySlotDone('thread-1', 'cortex', 'done')
  await new Promise((r) => setTimeout(r, 50))

  expect(thread.state).toBe('interrupted')
  expect(clearCalled).toEqual(['thread-1'])
  runner.stop()
})
```

### Test V3 — clearWorkingMemory NOT called on DEFER/waiting

```typescript
test('DEFER (next=self from limbic) → clearWorkingMemory NOT called', async () => {
  const workspace = new CognitiveWorkspace(mockDb)
  const eventBus = new BrainEventBus()
  const thread = makeThread()
  const clearCalled: string[] = []

  workspace.getThread = async () => thread
  workspace.getSlotsByThread = async () => [makeSlot('limbic', { next: 'self', timeout_ms: 5000 })]
  workspace.updateThreadState = async (_id, state) => { thread.state = state }
  workspace.getActiveThreads = async () => []
  workspace.searchMemory = async () => []
  workspace.clearWorkingMemory = async (tid) => { clearCalled.push(tid) }
  workspace.writePending = async (params) => ({
    id: 'p1',
    targetBrain: 'limbic',
    note: '',
    threadId: params.threadId ?? null,
    triggerAt: new Date(),
    expiresAt: new Date(),
    baseImportance: 0.5,
    addedAt: new Date(),
  })

  const adapters = new Map<CognitiveBrainType, BrainAdapter>()
  const runner = makeRunner(adapters, workspace, eventBus)
  await runner.start()

  workspace.notifySlotDone('thread-1', 'limbic', 'done')
  await new Promise((r) => setTimeout(r, 50))

  expect(thread.state).toBe('waiting')
  expect(clearCalled).toHaveLength(0)
  runner.stop()
})
```

### Test V4 — clearWorkingMemory failure is swallowed

```typescript
test('clearWorkingMemory throws → error swallowed, thread completes normally', async () => {
  const workspace = new CognitiveWorkspace(mockDb)
  const eventBus = new BrainEventBus()
  const thread = makeThread()

  workspace.getThread = async () => thread
  workspace.getSlotsByThread = async () => [makeSlot('limbic', {})]
  workspace.updateThreadState = async (_id, state) => { thread.state = state }
  workspace.getActiveThreads = async () => []
  workspace.searchMemory = async () => []
  workspace.clearWorkingMemory = async () => { throw new Error('db error') }

  const adapters = new Map<CognitiveBrainType, BrainAdapter>()
  const runner = makeRunner(adapters, workspace, eventBus)
  await runner.start()

  // Should not throw
  workspace.notifySlotDone('thread-1', 'limbic', 'done')
  await new Promise((r) => setTimeout(r, 50))

  expect(thread.state).toBe('complete')
  runner.stop()
})
```

## Done Criteria

- [ ] T001: `clearWorkingMemory` called (fire-and-forget) after `updateThreadState('complete')`
- [ ] T002: `clearWorkingMemory` called (fire-and-forget) after `updateThreadState('interrupted')`
- [ ] `handleDefer` path unchanged — no `clearWorkingMemory` call added there
- [ ] T003 V1–V4: all four tests pass
- [ ] All existing tests in the suite still pass (zero regression)
- [ ] `bun run typecheck` zero errors
- [ ] `biome check` passes

## Activity Log

- 2026-03-13T05:39:06Z – unknown – shell_pid=33946 – lane=for_review – 2 fire-and-forget calls added at terminal paths. 4 unit tests (A-D) all pass. 445 total unit tests, 0 regressions. typecheck clean, biome clean.
- 2026-03-13T05:39:10Z – claude – shell_pid=37605 – lane=doing – Started review via workflow command
