# Implementation Plan: Working Memory Auto-Cleanup on Thread Completion

**Branch**: `027-working-memory-auto-cleanup` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

## Summary

Add two fire-and-forget `clearWorkingMemory(threadId).catch(() => {})` calls to `ThreadRunner.route()` — one at the normal completion path (`next === null`) and one at the illegal-transition interrupted path. Add four unit tests to the existing runner test file.

## Technical Context

**Language/Version**: TypeScript 5.x
**Modified file**: `src/runner/index.ts` — two surgical additions (~4 lines)
**Test file**: `tests/unit/thread-runner.test.ts` — four new test cases appended to `'ThreadRunner routing — extended'`
**Testing**: Bun test
**Constraint**: Fire-and-forget — `clearWorkingMemory` failure must never propagate

## Current State (the gap)

`src/runner/index.ts`, lines 147–166:

```typescript
// No next → thread ends
if (next === null || next === undefined) {
  await this.workspace.updateThreadState(threadId, 'complete')
  this.workspace.notifyThreadComplete(threadId)
  return  // ← clearWorkingMemory never called
}

// Validate legal transition
if (!isLegalTransition(currentBrain, next)) {
  await this.workspace.updateThreadState(threadId, 'interrupted')
  this.eventBus.emit({ event_type: 'thread.interrupted', ... })
  return  // ← clearWorkingMemory never called
}
```

The `handleDefer` path (line 169–172, sets state to `waiting`) must NOT be touched.

## Changes

### `src/runner/index.ts`

**Completion path** — insert after `updateThreadState` and before `notifyThreadComplete`:
```typescript
// No next → thread ends
if (next === null || next === undefined) {
  await this.workspace.updateThreadState(threadId, 'complete')
  this.workspace.clearWorkingMemory(threadId).catch(() => {})  // fire-and-forget
  this.workspace.notifyThreadComplete(threadId)
  return
}
```

**Interrupted path** — insert after `updateThreadState` and before `eventBus.emit`:
```typescript
if (!isLegalTransition(currentBrain, next)) {
  await this.workspace.updateThreadState(threadId, 'interrupted')
  this.workspace.clearWorkingMemory(threadId).catch(() => {})  // fire-and-forget
  this.eventBus.emit({ event_type: 'thread.interrupted', ... })
  return
}
```

Total diff: +2 lines of production code.

### `tests/unit/thread-runner.test.ts`

Four new tests appended inside `describe('ThreadRunner routing — extended', ...)`:

| Test ID | Scenario | Assert |
|---------|----------|--------|
| T027-V1 | `next=null` → complete | `clearWorkingMemory` called once with `'thread-1'` |
| T027-V2 | `cortex next: self` → interrupted | `clearWorkingMemory` called once with `'thread-1'` |
| T027-V3 | `limbic next: self` (DEFER → waiting) | `clearWorkingMemory` never called |
| T027-V4 | `next=null`, `clearWorkingMemory` throws | no error thrown, `thread.state === 'complete'` |

**Mock pattern** (consistent with existing tests in the same file):
```typescript
let clearCalled: string[] = []
workspace.clearWorkingMemory = async (tid) => { clearCalled.push(tid) }
// or for throw test:
workspace.clearWorkingMemory = async () => { throw new Error('db error') }
```

The tests use `patchWorkspace()` helper already defined in the describe block, extending it with `clearWorkingMemory` assignment as needed.

## Estimated Size

- `src/runner/index.ts`: +2 lines
- `tests/unit/thread-runner.test.ts`: ~80 lines (4 tests × ~20 lines each)
- Total: ~82 lines
