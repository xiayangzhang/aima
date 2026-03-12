# Feature Specification: Working Memory Auto-Cleanup on Thread Completion

**Feature**: 027-working-memory-auto-cleanup
**Status**: draft
**Created**: 2026-03-13
**Depends on**: Feature 001 (workspace schema — `clearWorkingMemory` already implemented)

---

## Overview

`CognitiveWorkspace.clearWorkingMemory(threadId)` exists and is tested, but `ThreadRunner` never calls it. When a thread reaches `complete` or `interrupted` state, the working memories bound to that thread persist in the DB indefinitely. This feature wires the call in the two termination paths inside `src/runner/index.ts`.

The behavior is already documented in `docs/02-memory-architecture.md`:
> "Thread Runner 在 Thread 状态变为 `complete` 时调用 Encoding 的 `clearWorkingMemory(thread_id)` 批量清除"

---

## Actors

- **ThreadRunner**: drives the routing loop; calls `workspace.updateThreadState` at both termination points
- **CognitiveWorkspace**: provides `clearWorkingMemory(threadId)` — physical DELETE of all `type='working' AND thread_id=$threadId` records

---

## Problem Statement

### P1: Working memory leaks on thread completion

`src/runner/index.ts` has two termination paths that set the thread to a terminal state and return:

1. **Normal completion** (`next === null`): `updateThreadState(threadId, 'complete')` → return
2. **Illegal transition** (`!isLegalTransition`): `updateThreadState(threadId, 'interrupted')` → return

Neither path calls `clearWorkingMemory`. Working memories written during a thread's lifetime (type `working`) accumulate in the DB. Over many threads this creates unbounded row growth and stale working context that may be inadvertently returned in future `searchMemory` calls.

### P2: DEFER/waiting path must NOT clear

The `handleDefer` path sets thread state to `waiting` — the thread will resume. Calling `clearWorkingMemory` here would destroy working context that the Limbic brain wrote before deferring, causing information loss on resume.

---

## Functional Requirements

### FR-01: Clear on normal completion

After `await this.workspace.updateThreadState(threadId, 'complete')`, call:

```typescript
this.workspace.clearWorkingMemory(threadId).catch(() => {})
```

**Fire-and-forget**: cleanup failure must not affect the thread completion flow or bubble up to callers.

**Acceptance criteria**:
- After `next === null`, `clearWorkingMemory` is called with the correct `threadId`
- `notifyThreadComplete` still fires after the `updateThreadState` call (existing behavior unchanged)
- If `clearWorkingMemory` throws, no error propagates

### FR-02: Clear on interrupted state

After `await this.workspace.updateThreadState(threadId, 'interrupted')`, call:

```typescript
this.workspace.clearWorkingMemory(threadId).catch(() => {})
```

Same fire-and-forget contract as FR-01.

**Acceptance criteria**:
- After illegal transition detection, `clearWorkingMemory` is called with the correct `threadId`
- `thread.interrupted` event is still emitted (existing behavior unchanged)
- If `clearWorkingMemory` throws, no error propagates

### FR-03: Do NOT clear on DEFER/waiting

`handleDefer` sets state to `waiting`. No call to `clearWorkingMemory` is added here.

**Acceptance criteria**:
- `next === 'self'` (DEFER) path: `clearWorkingMemory` is never called

---

## User Scenarios & Testing

### Scenario A: Thread completes normally

1. Limbic sets `next: null` in output
2. `route()` calls `updateThreadState(threadId, 'complete')`
3. `clearWorkingMemory(threadId)` fires (fire-and-forget)
4. `notifyThreadComplete(threadId)` fires

**Test**: mock `clearWorkingMemory`, trigger with `next=null` slot, assert `clearWorkingMemory` called once with `'thread-1'`.

### Scenario B: Thread interrupted by illegal transition

1. Cortex sets `next: 'self'` (illegal for cortex per legal transition table)
2. `route()` calls `updateThreadState(threadId, 'interrupted')`
3. `clearWorkingMemory(threadId)` fires (fire-and-forget)
4. `thread.interrupted` event emitted

**Test**: mock `clearWorkingMemory`, trigger with `cortex next: self` slot, assert `clearWorkingMemory` called once.

### Scenario C: Thread defers — no cleanup

1. Limbic sets `next: 'self'` (legal DEFER)
2. `handleDefer` sets state to `waiting`
3. `clearWorkingMemory` is NOT called

**Test**: mock `clearWorkingMemory`, trigger DEFER slot, assert `clearWorkingMemory` never called.

### Scenario D: Cleanup failure is swallowed

1. Thread completes normally
2. `clearWorkingMemory` rejects with an error
3. No error propagates; thread completion proceeds normally

**Test**: mock `clearWorkingMemory` to `async () => { throw new Error('db error') }`, assert no throw from `route()`.

---

## Key Entities

- **`src/runner/index.ts`**: two fire-and-forget `.catch(() => {})` calls added at terminal paths
- **`CognitiveWorkspace.clearWorkingMemory`**: already implemented in Feature 001, no changes needed
- **`tests/unit/thread-runner.test.ts`**: four new test cases added to the existing `'ThreadRunner routing — extended'` describe block

---

## Assumptions

- `clearWorkingMemory` is already correctly implemented (Feature 001, integration-tested)
- Fire-and-forget is the right contract: thread completion is a user-visible event; DB cleanup is housekeeping that should not block or fail the completion signal
- The `waiting` state is not terminal — thread will resume via `routePending()`
- No new files are needed — changes are surgical additions to existing files

---

## Success Criteria

1. `clearWorkingMemory` called on `complete` path
2. `clearWorkingMemory` called on `interrupted` path
3. `clearWorkingMemory` NOT called on `waiting`/DEFER path
4. Cleanup failure does not propagate
5. All existing tests continue to pass (zero regression)
6. `bun run typecheck` passes, `biome check` passes
7. Four new unit tests, all green

---

## Out of Scope

- Clearing working memory on `waiting` threads after timeout expiry (complex, deferred)
- Modifying `clearWorkingMemory` implementation in workspace
- Clearing other memory types on thread completion
