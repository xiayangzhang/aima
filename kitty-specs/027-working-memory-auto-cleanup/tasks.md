# Tasks: Feature 027 — Working Memory Auto-Cleanup on Thread Completion

## WP01 — Wire clearWorkingMemory into ThreadRunner and add unit tests

**Lane**: planned
**Depends on**: none

| ID   | Task | Details |
|------|------|---------|
| T001 | Add `clearWorkingMemory` call to the completion path in `src/runner/index.ts` | In `route()`, after `await this.workspace.updateThreadState(threadId, 'complete')` and before `this.workspace.notifyThreadComplete(threadId)`, insert: `this.workspace.clearWorkingMemory(threadId).catch(() => {})`. This is fire-and-forget — the `.catch(() => {})` ensures cleanup failure never propagates. Do NOT touch the `handleDefer` path (sets state to `waiting`, not terminal). |
| T002 | Add `clearWorkingMemory` call to the interrupted path in `src/runner/index.ts` | In `route()`, after `await this.workspace.updateThreadState(threadId, 'interrupted')` and before `this.eventBus.emit({ event_type: 'thread.interrupted', ... })`, insert: `this.workspace.clearWorkingMemory(threadId).catch(() => {})`. Same fire-and-forget contract as T001. |
| T003 | Write four unit tests in `tests/unit/thread-runner.test.ts` | Append four tests to the existing `describe('ThreadRunner routing — extended', ...)` block. (1) `next=null` complete path: patch `workspace.clearWorkingMemory` to record calls; fire `notifySlotDone` with a slot that has no `next`; assert `clearWorkingMemory` was called with `'thread-1'`. (2) Interrupted path: patch same mock; use `makeSlot('cortex', { next: 'self' })` (illegal for cortex); assert `clearWorkingMemory` called with `'thread-1'`. (3) DEFER/waiting path: patch `workspace.clearWorkingMemory` to record calls; use `makeSlot('limbic', { next: 'self', timeout_ms: 5000 })` (legal DEFER); also patch `workspace.writePending`; assert `clearWorkingMemory` was NOT called. (4) Failure swallowed: patch `workspace.clearWorkingMemory = async () => { throw new Error('db error') }`; use `next=null` slot; wrap in `expect(async () => { workspace.notifySlotDone(...); await wait(50) }).not.toThrow()` and assert `thread.state === 'complete'`. All four tests follow the same `patchWorkspace` + `workspace.notifySlotDone` + `await new Promise((r) => setTimeout(r, 50))` pattern as existing tests in the file. |

**Done criteria**: `bun run typecheck` passes with zero errors, `biome check` passes, all four new tests green, no regressions in existing test suite.
