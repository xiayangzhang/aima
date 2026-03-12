---
work_package_id: "WP02"
subtasks:
  - "T006"
  - "T007"
  - "T008"
  - "T009"
  - "T010"
  - "T011"
  - "T012"
title: "Thread Runner Core Rewrite"
phase: "Phase 2 - Core Logic"
lane: "done"
assignee: "claude"
agent: "claudewp02"
shell_pid: "42470"
review_status: "approved"
reviewed_by: "XIAYANG ZHANG"
dependencies: ["WP01"]
history:
  - timestamp: "2026-03-12T10:23:39Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
  - timestamp: "2026-03-12T11:20:28Z"
    lane: "for_review"
    agent: "claudewp02"
    shell_pid: "42470"
    action: "All T006-T012 done. 494/496 tests pass (2 pre-existing). isLegalTransition, thread.reply, handoff passing implemented."
  - timestamp: "2026-03-12T11:26:27Z"
    lane: "done"
    agent: "reviewwp02"
    shell_pid: ""
    action: "Review passed: transition table correct, reply before routing, handoff before activate, no mode/intent refs, 494 pass."
---

# Work Package Prompt: WP02 — Thread Runner Core Rewrite

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` field. If `has_feedback`, scroll to Review Feedback section.
- **Mark as acknowledged**: Update `review_status: acknowledged` when you begin addressing feedback.

---

## Review Feedback

*[Empty initially — reviewers populate if work is returned.]*

---

## Objectives & Success Criteria

Completely rewrite `src/runner/index.ts` routing logic. After this WP:

- `route()` reads `BrainOutput.next`/`reply`/`handoff` — no `mode`/`intent` strings remain
- `thread.reply` event emitted when `output.reply` is present
- `handoff` content written to next brain's input slot before activation
- Illegal `next` values cause Thread to enter `interrupted` state
- `intent=both` three-step hardcode is gone
- All Thread Runner tests pass with new BrainOutput mock format

**To implement this WP**:
```bash
spec-kitty implement WP02 --base WP01
```

## Context & Constraints

- **Depends on**: WP01 (needs `BrainOutput` type)
- **Spec**: `kitty-specs/013-brain-output-model-migration/spec.md`
- **Plan**: `kitty-specs/013-brain-output-model-migration/plan.md` — see Root Cause Analysis + Migration Design sections
- **Data Model**: `kitty-specs/013-brain-output-model-migration/data-model.md` — see "Thread Runner 新路由逻辑" and legal transition table
- **Current code**: `src/runner/index.ts` — the `route()` method (lines 86-175) is the primary target
- **Test files**: `tests/unit/thread-runner.test.ts` (499 lines) + `tests/integration/brain-runtime/thread-lifecycle.test.ts` (181 lines)

### Legal Transition Table (from plan.md)

| currentBrain | Legal `next` values | Illegal → `interrupted` |
|---|---|---|
| `limbic` | `'cortex'`, `'brainstem'`, `'self'`, `null` | `'limbic'` |
| `cortex` | `'limbic'`, `'brainstem'`, `null` | `'cortex'`, `'self'` |
| `brainstem` | `'limbic'`, `'cortex'`, `null` | `'brainstem'`, `'self'` |

### Old → New Mapping (for test fixtures)

| Old output | New output |
|---|---|
| `{ mode: 'RESPOND', reply: 'text' }` | `{ reply: 'text' }` |
| `{ mode: 'NO_REPLY' }` | `{}` |
| `{ mode: 'ROUTE' }` | `{ next: 'cortex' }` |
| `{ mode: 'EXECUTE' }` | `{ next: 'brainstem' }` |
| `{ mode: 'DEFER', timeout_ms: N }` | `{ next: 'self', timeout_ms: N }` |
| `{ intent: 'communicate' }` | `{ next: 'limbic' }` |
| `{ intent: 'execute' }` | `{ next: 'brainstem' }` |
| `{ intent: 'both', reply: 'text' }` | `{ next: 'brainstem', reply: 'text' }` |
| Brainstem → notify user | `{ next: 'limbic', handoff: 'result summary' }` |
| Brainstem → silent end | `{ next: null }` or `{}` |

## Subtasks & Detailed Guidance

### Subtask T006 — Rewrite Limbic routing branch

**Purpose**: Replace `mode` enum routing with `BrainOutput.next` universal routing for Limbic outputs.

**Location**: `src/runner/index.ts`, inside the `route()` method, the `if (currentBrain === 'limbic')` block (lines ~117-142).

**Steps**:

1. Remove the old block:
   ```typescript
   // DELETE:
   if (currentBrain === 'limbic') {
     const output = slotMap.limbic?.output as Record<string, unknown> | null
     const mode = output?.mode as string | undefined
     if (mode === 'RESPOND' || mode === 'NO_REPLY') { ... }
     if (mode === 'ROUTE') { nextBrain = 'cortex' }
     else if (mode === 'EXECUTE') { nextBrain = 'brainstem' }
     else if (mode === 'DEFER') { ... }
   }
   ```

2. The new universal routing logic (T006-T008 all replace the entire brain-specific blocks with one unified block). After completing T007 and T008 too, the routing block becomes:
   ```typescript
   const output = (slotMap[currentBrain]?.output ?? null) as BrainOutput | null

   // Handle reply (before routing)
   if (output?.reply) {
     this.eventBus.emit({
       event_type: 'thread.reply',
       level: 'INFO',
       brain: currentBrain,
       thread_id: threadId,
       session_id: null,
       payload: { reply: output.reply, threadId },
     })
   }

   const next = output?.next ?? null

   // No next → thread ends
   if (next === null || next === undefined) {
     await this.workspace.updateThreadState(threadId, 'complete')
     this.workspace.notifyThreadComplete(threadId)
     return
   }

   // DEFER (self-routing)
   if (next === 'self') {
     await this.handleDefer(output, threadId)
     return
   }

   // Validate legal transition
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

   // Pass handoff to next brain's input
   if (output?.handoff) {
     await this.workspace.writeSlot(threadId, next as CognitiveBrainType, {
       input: { handoff: output.handoff },
     })
   }

   nextBrain = next as CognitiveBrainType
   ```

**Notes**: Implement T006, T007, T008 together — they all replace different `currentBrain` branches with this single unified approach. The routing no longer has per-brain branches; it's universal.

---

### Subtask T007 — Rewrite Cortex routing branch + remove `intent=both`

**Purpose**: Replace `intent` enum routing with universal `BrainOutput.next`. Remove the `intent=both` hardcoded three-step routing entirely.

**Location**: `src/runner/index.ts`, the `else if (currentBrain === 'cortex')` block (lines ~143-154).

**Steps**:

1. Delete the old `cortex` block entirely:
   ```typescript
   // DELETE:
   } else if (currentBrain === 'cortex') {
     const output = slotMap.cortex?.output as Record<string, unknown> | null
     const intent = output?.intent as string | undefined
     if (intent === 'communicate') { nextBrain = 'limbic' }
     else if (intent === 'execute') { nextBrain = 'brainstem' }
     else if (intent === 'both') { nextBrain = 'limbic' }
   }
   ```

2. This block is replaced by the universal routing logic from T006. There are **no special Cortex-only cases** in the new model — Cortex simply sets `next: 'limbic'` or `next: 'brainstem'` in its output, and the universal routing handles it.

3. The `intent=both` three-step path (Cortex → Limbic → Brainstem → Limbic) is gone. If Cortex wants to both reply and execute, it sets `next: 'brainstem'` and `reply: 'text'`. Brainstem then sets `next: 'limbic'` in its own output if it needs to notify.

---

### Subtask T008 — Rewrite Brainstem routing branch

**Purpose**: Remove the `cortexOutput.intent === 'both'` hardcoded back-routing. Brainstem now decides itself whether to route back to Limbic via `BrainOutput.next`.

**Location**: `src/runner/index.ts`, the `else if (currentBrain === 'brainstem')` block (lines ~155-164).

**Steps**:

1. Delete the old `brainstem` block entirely:
   ```typescript
   // DELETE:
   } else if (currentBrain === 'brainstem') {
     const cortexOutput = slotMap.cortex?.output as Record<string, unknown> | null
     if (cortexOutput?.intent === 'both') {
       nextBrain = 'limbic'
     } else {
       await this.workspace.updateThreadState(threadId, 'complete')
       this.workspace.notifyThreadComplete(threadId)
       return
     }
   }
   ```

2. This block is replaced by the universal routing logic from T006. Brainstem outputs `{ next: 'limbic', handoff: '...' }` to notify the user, or `{ next: null }` / `{}` to end silently.

3. After T006+T007+T008, the entire `if (currentBrain === 'limbic') ... else if (currentBrain === 'cortex') ... else if (currentBrain === 'brainstem')` structure is **completely removed** and replaced by the single universal block.

---

### Subtask T009 — Implement `reply` event emission

**Purpose**: Add the `thread.reply` eventBus event so upper applications can forward the reply to the user.

**Location**: Already included in the universal routing block from T006. Verify it's correctly placed **before** the routing decision (so reply is sent even if `next` is null).

**Steps**:

1. Confirm the `thread.reply` emit in the universal block fires when `output?.reply` is truthy.
2. Confirm the event payload includes `{ reply: string, threadId: string }`.
3. Confirm this happens BEFORE checking `next` — i.e., a brain can reply AND end the thread in one turn.

**Validation**:
- In `thread-runner.test.ts`, add/update a test: when Limbic output has `{ reply: 'Hello' }`, `eventBus.emit` is called with `event_type: 'thread.reply'`.

---

### Subtask T010 — Implement `handoff` passing

**Purpose**: When `output.handoff` is present, write it to the next brain's input slot before activation.

**Location**: Already included in the universal routing block from T006. Verify the `writeSlot` call is correct.

**Steps**:

1. Confirm the `writeSlot` call in the universal block:
   ```typescript
   if (output?.handoff) {
     await this.workspace.writeSlot(threadId, next as CognitiveBrainType, {
       input: { handoff: output.handoff },
     })
   }
   ```
2. This call happens BEFORE `activateBrain(next, threadId, opts)`.
3. The next brain's context assembly (Block 3/4) reads slot input — the `handoff` field will be visible in the system prompt.

**Validation**:
- In tests, when Brainstem outputs `{ next: 'limbic', handoff: 'task done' }`, verify `writeSlot` is called with `{ input: { handoff: 'task done' } }` for the `limbic` brain.

---

### Subtask T011 — Implement legal transition validation

**Purpose**: Extract the `isLegalTransition` function and ensure illegal routing ends the thread with `interrupted` state.

**Steps**:

1. Add a pure function **outside the class** (top of file, after imports):
   ```typescript
   const LEGAL_TRANSITIONS: Record<CognitiveBrainType, Set<CognitiveBrainType | 'self' | null>> = {
     limbic: new Set(['cortex', 'brainstem', 'self', null]),
     cortex: new Set(['limbic', 'brainstem', null]),
     brainstem: new Set(['limbic', 'cortex', null]),
   }

   function isLegalTransition(
     from: CognitiveBrainType,
     to: CognitiveBrainType | 'self' | null | undefined,
   ): boolean {
     if (to === undefined) return true // undefined = null = thread ends (legal)
     return LEGAL_TRANSITIONS[from]?.has(to) ?? false
   }
   ```

2. Confirm the `if (!isLegalTransition(currentBrain, next))` check in the universal routing block emits a `thread.interrupted` ALERT event AND calls `updateThreadState('interrupted')`.

**Validation**:
- Test: Cortex outputs `{ next: 'self' }` → Thread enters `interrupted` state.
- Test: Cortex outputs `{ next: 'cortex' }` → Thread enters `interrupted` state (self-loop illegal for Cortex).

---

### Subtask T012 — Update thread-runner.test.ts + thread-lifecycle.test.ts

**Purpose**: Migrate all 499 lines of `thread-runner.test.ts` and 181 lines of `thread-lifecycle.test.ts` from old `mode`/`intent` mock outputs to new `BrainOutput` format.

**Steps**:

1. Open `tests/unit/thread-runner.test.ts`. Find every occurrence of:
   - `{ mode: 'RESPOND' }` → `{ reply: 'mock-reply' }` (or just `{ reply: 'text' }` if no specific reply needed)
   - `{ mode: 'NO_REPLY' }` → `{}`
   - `{ mode: 'ROUTE' }` → `{ next: 'cortex' }`
   - `{ mode: 'EXECUTE' }` → `{ next: 'brainstem' }`
   - `{ mode: 'DEFER', timeout_ms: N }` → `{ next: 'self', timeout_ms: N }`
   - `{ intent: 'communicate' }` → `{ next: 'limbic' }`
   - `{ intent: 'execute' }` → `{ next: 'brainstem' }`
   - `{ intent: 'both' }` → `{ next: 'brainstem' }` (and if the test also expects Limbic to fire after, re-evaluate the test flow — it now requires Brainstem to output `{ next: 'limbic' }`)
   - `.intent` field accesses on slot → remove

2. Update the `callBuildBlock4Opts` helper call at line ~461 that passes `{ intent: 'execute' }` — change to not pass intent.

3. Find test assertions about `cortexOutput?.intent === 'both'` → remove or refactor.

4. For the `intent=both` test (T050 in the file: "cortex intent=both → limbic adapter called"):
   - This test must be rewritten to use the new two-step mechanism: Cortex outputs `{ next: 'brainstem', reply: 'Starting execution...' }`, then Brainstem outputs `{ next: 'limbic', handoff: 'done' }`, and Limbic fires.
   - Or alternatively, simplify: just test Cortex `{ next: 'brainstem' }` routes to Brainstem (the Brainstem → Limbic routing is tested separately).

5. Open `tests/integration/brain-runtime/thread-lifecycle.test.ts`. Apply the same substitutions:
   - `{ mode: 'RESPOND', content: '...' }` → `{ reply: '...' }`
   - `{ mode: 'ROUTE' }` → `{ next: 'cortex' }`
   - `{ intent: 'communicate' }` → `{ next: 'limbic' }`

6. Run tests:
   ```bash
   cd /Volumes/leoyun/aima && bun test tests/unit/thread-runner.test.ts tests/integration/brain-runtime/thread-lifecycle.test.ts
   ```

**Files**:
- `tests/unit/thread-runner.test.ts`
- `tests/integration/brain-runtime/thread-lifecycle.test.ts`

**Edge Cases**:
- Some test helpers (`makeSlot`, `patchWorkspace`) may have typed parameters that reference old modes — update those helper signatures too.
- The `buildBlock4Opts` test at line ~461 passes a `cortexOutput` with `{ intent: 'execute' }` to test Brainstem context assembly. After migration, `buildBlock4Opts` should read `next` not `intent` from cortex output. Update both the test and the implementation if needed.

---

### Subtask T006-T011 also requires: Extract `handleDefer` as private method

**Purpose**: The DEFER logic was inline in the Limbic branch. Extract it to a `private handleDefer` method.

```typescript
private async handleDefer(output: BrainOutput | null, threadId: string): Promise<void> {
  const timeoutMs = (output as Record<string, unknown> | null)?.timeout_ms as number ?? 60_000
  const triggerAt = new Date(Date.now() + timeoutMs)
  await this.workspace.updateThreadState(threadId, 'waiting')
  await this.workspace.writePending({
    targetBrain: 'limbic',
    threadId,
    note: 'DEFER timeout — re-activate Limbic with channel downgrade',
    triggerAt,
    expiresAt: new Date(triggerAt.getTime() + 7 * 24 * 60 * 60 * 1000),
  })
}
```

Note: `timeout_ms` is not part of the `BrainOutput` interface (it's an extra field brains can include in the output object). Cast to `Record<string, unknown>` to access it.

---

## Risks & Mitigations

- **`intent=both` test rewrite**: The test "cortex intent=both → limbic adapter called" (T050) requires the most thought. The new model doesn't have a single Cortex output that triggers three hops. Rewrite as: Cortex → Brainstem (one test), Brainstem → Limbic (separate test). Both behaviors are now independently verifiable.
- **`buildBlock4Opts` for Brainstem**: Currently reads `cortexOutput?.task_type` and `cortexOutput?.intent`. After migration, `intent` is gone. The Block 4 assembly for Brainstem should only use `cortexOutput?.task_type` and `thread.trigger`. Update `buildBlock4Opts` in `runner/index.ts` (lines ~256-264) to remove the `intent` access.
- **`session_id` in events**: Keep `session_id: null` for the new `thread.reply` event (it's a routing event, not a brain session event).

## Definition of Done Checklist

- [ ] `src/runner/index.ts` has no `mode ===` or `intent ===` string comparisons
- [ ] `isLegalTransition` function exists and is tested
- [ ] `thread.reply` event emitted when `output.reply` present
- [ ] `handoff` passed to next brain's input slot
- [ ] `intent=both` three-step hardcode is gone
- [ ] `bun test tests/unit/thread-runner.test.ts` → all pass
- [ ] `bun test tests/integration/brain-runtime/thread-lifecycle.test.ts` → all pass
- [ ] `grep -n "intent === \|mode === " src/runner/index.ts` → 0 matches

## Review Guidance

- Verify `isLegalTransition` matches the legal transition table in `data-model.md` exactly
- Verify `thread.reply` fires BEFORE routing check (brain can reply and end thread)
- Verify `handoff` write happens BEFORE `activateBrain()` call
- Verify the DEFER path still writes `threadId` to `writePending` (Feature 012 fix must remain intact)
- Verify no `intent=both` logic survives anywhere in runner
- Check that `buildBlock4Opts` for Brainstem no longer reads `cortexOutput.intent`

## Activity Log

- 2026-03-12T10:23:39Z – system – lane=planned – Prompt created.
- 2026-03-12T11:14:25Z – claudewp02 – shell_pid=42470 – lane=doing – Started implementation via workflow command
- 2026-03-12T11:20:28Z – claudewp02 – shell_pid=42470 – lane=for_review – All T006-T012 done. 494/496 tests pass (2 pre-existing failures). No mode/intent comparisons remain in runner. isLegalTransition implemented. thread.reply events emitted. handoff passing. intent=both hardcode removed. T013-T017 belong to WP03.
- 2026-03-12T11:26:27Z – claudewp02 – shell_pid=42470 – lane=done – Review passed: isLegalTransition is a pure standalone function; transition table matches spec exactly (limbic: cortex/brainstem/self/null, cortex: limbic/brainstem/null, brainstem: limbic/cortex/null); reply emitted before next routing; handoff written via writeSlot before activateBrain; no intent/mode references anywhere in runner; DEFER (next=self) preserved and only legal for limbic; runner test fixtures use BrainOutput model (next/reply/handoff) with zero old mode/intent patterns; no any types in runner; 494 pass, 2 pre-known failures only
