---
work_package_id: "WP03"
subtasks:
  - "T013"
  - "T014"
  - "T015"
  - "T016"
  - "T017"
title: "DMN Reactive Updates"
phase: "Phase 2 - Core Logic"
lane: "done"
assignee: ""
agent: "claude-wp03"
shell_pid: "48454"
review_status: "approved"
reviewed_by: "XIAYANG ZHANG"
dependencies: ["WP01"]
history:
  - timestamp: "2026-03-12T10:23:39Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
---

# Work Package Prompt: WP03 — DMN Reactive Updates

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` field. If `has_feedback`, scroll to Review Feedback section.
- **Mark as acknowledged**: Update `review_status: acknowledged` when you begin addressing feedback.

---

## Review Feedback

*[Empty initially — reviewers populate if work is returned.]*

---

## Objectives & Success Criteria

Update `src/dmn/reactive/index.ts` — 4 specific locations that reference the old `mode`/`intent` output fields — and migrate all DMN test fixtures to new `BrainOutput` format. After this WP:

- DMN Reactive no longer references `output.mode` or `output.intent` anywhere
- All DMN unit and integration tests pass with new mock output format
- DEFER detection correctly triggers on `output.next === 'self'`
- Segment boundary logic uses `output.next` and `output.reply` (not `mode`)

**To implement this WP**:
```bash
spec-kitty implement WP03 --base WP01
```
*(Can run in parallel with WP02 — different files, no overlap)*

## Context & Constraints

- **Depends on**: WP01 (needs `BrainOutput` type), independent of WP02
- **Spec**: `kitty-specs/013-brain-output-model-migration/spec.md`
- **Plan**: `kitty-specs/013-brain-output-model-migration/plan.md` — see "DMN Reactive 变更" section
- **Source file**: `src/dmn/reactive/index.ts`
- **Test files affected** (5 files):
  - `tests/unit/dmn/helpers.ts`
  - `tests/unit/dmn/dmn-reactive.test.ts`
  - `tests/unit/dmn/dmn-reactive-brain-complete.test.ts`
  - `tests/unit/dmn/dmn-comprehensive.test.ts`
  - `tests/integration/dmn/dmn.test.ts`

### Mode/Intent → Next/Reply mapping (for test fixtures)

| Old mock output | New mock output |
|---|---|
| `{ mode: 'RESPOND' }` | `{ reply: 'text' }` |
| `{ mode: 'DEFER', timeout_ms: N, defer_reason: 'reason' }` | `{ next: 'self', timeout_ms: N, defer_reason: 'reason' }` |
| `{ mode: 'ROUTE', needs_analysis: true }` | `{ next: 'cortex', needs_analysis: true }` |
| `{ mode: 'EXECUTE' }` | `{ next: 'brainstem' }` |

## Subtasks & Detailed Guidance

### Subtask T013 — `handleEvent`: DEFER detection fix

**Purpose**: The DEFER detection in `handleEvent` currently checks `payload.output?.mode === 'DEFER'`. Update to `payload.output?.next === 'self'`.

**Location**: `src/dmn/reactive/index.ts`, `handleEvent` method, lines ~105-112.

**Steps**:

1. Find the DEFER detection block:
   ```typescript
   // Responsibility 6: DEFER scheduling (limbic slot.done with output.mode=DEFER)
   if (
     event_type === 'slot.done' &&
     brain === 'limbic' &&
     (payload.output as Record<string, unknown> | undefined)?.mode === 'DEFER'
   ) {
     await this.handleDefer(event)
   }
   ```

2. Change to:
   ```typescript
   // Responsibility 6: DEFER scheduling (limbic slot.done with output.next=self)
   if (
     event_type === 'slot.done' &&
     brain === 'limbic' &&
     (payload.output as Record<string, unknown> | undefined)?.next === 'self'
   ) {
     await this.handleDefer(event)
   }
   ```

**Files**: `src/dmn/reactive/index.ts`

**Notes**: The `handleDefer` method itself reads `output.timeout_ms` and `output.defer_reason` from the output object — these are not `mode`/`intent` and don't need changing. Only the detection trigger changes.

---

### Subtask T014 — `shouldStartNewSegment`: Update mode references

**Purpose**: Two places in `shouldStartNewSegment` reference `output.mode`. Update to use `output.next` and `output.reply`.

**Location**: `src/dmn/reactive/index.ts`, `shouldStartNewSegment` method, lines ~186-203.

**Steps**:

1. Find line ~195:
   ```typescript
   if (output?.mode === 'ROUTE' && output.needs_analysis) return true
   ```
   Change to:
   ```typescript
   if (output?.next === 'cortex' && output.needs_analysis) return true
   ```

2. Find lines ~198-200:
   ```typescript
   if (output?.mode === 'RESPOND' && segState && segState.nextSeq > 5) {
     return await this.isTopicSwitch(event)
   }
   ```
   Change to:
   ```typescript
   // Respond = has reply and no further routing (thread ends)
   if (output?.reply != null && !output?.next && segState && segState.nextSeq > 5) {
     return await this.isTopicSwitch(event)
   }
   ```

**Files**: `src/dmn/reactive/index.ts`

**Notes**: The semantic meaning: "RESPOND" = brain replied to user AND thread ends. The new check `output?.reply != null && !output?.next` captures exactly this: there's a reply AND no further routing (so the thread is ending after this turn).

---

### Subtask T015 — `evaluateOutcome`: Update mode references

**Purpose**: `evaluateOutcome` uses `output.mode` to judge positive/negative memory usage feedback. Update to `output.next`/`output.reply`.

**Location**: `src/dmn/reactive/index.ts`, `evaluateOutcome` method, lines ~255-264.

**Steps**:

1. Find:
   ```typescript
   if (output?.mode === 'RESPOND') return 'positive'
   if (output?.mode === 'EXECUTE') return 'positive'
   ```

2. Change to:
   ```typescript
   // Positive: brain produced a user-visible reply OR triggered execution
   if (output?.reply != null) return 'positive'
   if (output?.next === 'brainstem') return 'positive'
   ```

**Files**: `src/dmn/reactive/index.ts`

**Notes**: The logic is equivalent — "RESPOND" meant the brain replied to the user (now: `reply != null`), and "EXECUTE" meant the brain triggered Brainstem (now: `next === 'brainstem'`).

---

### Subtask T016 — `buildEpisodicContent`: Replace `mode`/`intent` serialization

**Purpose**: `buildEpisodicContent` serializes `mode` and `intent` into the episodic memory record. Update to serialize `next` and `hasReply`.

**Location**: `src/dmn/reactive/index.ts`, `buildEpisodicContent` method, lines ~230-243.

**Steps**:

1. Find:
   ```typescript
   return JSON.stringify({
     brain,
     threadId: thread_id,
     status: outputSlot?.status,
     mode: output?.mode,
     intent: output?.intent,
     stopReason: payload.stopReason,
     timestamp: new Date().toISOString(),
   })
   ```

2. Change to:
   ```typescript
   return JSON.stringify({
     brain,
     threadId: thread_id,
     status: outputSlot?.status,
     next: (output as Record<string, unknown> | undefined)?.next,
     hasReply: (output as Record<string, unknown> | undefined)?.reply != null,
     stopReason: payload.stopReason,
     timestamp: new Date().toISOString(),
   })
   ```

**Files**: `src/dmn/reactive/index.ts`

**Notes**: The cast to `Record<string, unknown>` is intentional — `output` arrives as `unknown` from the event payload. The `output` local variable in `buildEpisodicContent` is already cast as `Record<string, unknown> | undefined` (check the existing code). Adjust the cast accordingly.

---

### Subtask T017 — Update all DMN test files (5 files)

**Purpose**: Migrate all DMN test mock outputs from old `mode`/`intent` format to new `BrainOutput` format.

**Steps for each file**:

#### `tests/unit/dmn/helpers.ts`

```bash
grep -n "mode\|intent" tests/unit/dmn/helpers.ts
```

- Find `outputSlot: { status: 'done', output: { mode: 'RESPOND' } }` (~line 322)
- Change to `outputSlot: { status: 'done', output: { reply: 'mock response' } }`

#### `tests/unit/dmn/dmn-reactive-brain-complete.test.ts`

```bash
grep -n "mode\|intent" tests/unit/dmn/dmn-reactive-brain-complete.test.ts
```

- All `{ mode: 'RESPOND' }` output fixtures → `{ reply: 'text' }`
- Check if there are any `mode: 'EXECUTE'` or `intent` fixtures and update accordingly

#### `tests/unit/dmn/dmn-reactive.test.ts`

```bash
grep -n "mode\|intent" tests/unit/dmn/dmn-reactive.test.ts
```

- Find test at ~line 169: `'slot.done limbic with mode=DEFER → writes pending with correct triggerAt'`
  - Change test description to: `'slot.done limbic with next=self → writes pending with correct triggerAt'`
  - Change fixture at ~line 181: `payload: { output: { mode: 'DEFER', timeout_ms: 5000, defer_reason: 'waiting for user' } }`
  - To: `payload: { output: { next: 'self', timeout_ms: 5000, defer_reason: 'waiting for user' } }`

#### `tests/unit/dmn/dmn-comprehensive.test.ts`

```bash
grep -n "mode\|intent" tests/unit/dmn/dmn-comprehensive.test.ts
```

- Multiple `mode: 'DEFER'` fixtures (lines ~193, ~219, ~239, ~257) → change to `next: 'self'`
- Update test description strings that mention `mode=DEFER`

#### `tests/integration/dmn/dmn.test.ts`

```bash
grep -n "mode\|intent" tests/integration/dmn/dmn.test.ts
```

- Apply same substitutions: `mode: 'RESPOND'` → `reply: 'text'`, `mode: 'DEFER'` → `next: 'self'`, etc.

**After updating all 5 files, run**:
```bash
cd /Volumes/leoyun/aima && bun test tests/unit/dmn/ tests/integration/dmn/
```

**Files**:
- `tests/unit/dmn/helpers.ts`
- `tests/unit/dmn/dmn-reactive.test.ts`
- `tests/unit/dmn/dmn-reactive-brain-complete.test.ts`
- `tests/unit/dmn/dmn-comprehensive.test.ts`
- `tests/integration/dmn/dmn.test.ts`

**Edge Cases**:
- Some test description strings contain `mode=DEFER` — update those to `next=self` for consistency.
- If `isTopicSwitch` tests use `{ mode: 'RESPOND' }` output → change to `{ reply: 'text' }`.
- If any fixture uses `{ mode: 'NO_REPLY' }` → change to `{}` (empty output = no reply, no routing).

---

## Risks & Mitigations

- **DmnReactive has its own `handleDefer`**: Note that `DmnReactive.handleDefer` (Responsibility 6) is SEPARATE from the DEFER handling in `runner/index.ts`. The DMN handles DEFER for episodic/pending scheduling purposes (writing the pending observation). The runner handles DEFER for state management. Both need updating but separately in WP02 and WP03 respectively.
- **`shouldStartNewSegment` semantic check**: The new check `output?.reply != null && !output?.next` is slightly different semantically from `mode === 'RESPOND'`. In the old model, `RESPOND` explicitly meant "reply + end". In the new model, we check that there's a reply AND no forward routing. Confirm this is the right boundary condition for segment breaks.

## Definition of Done Checklist

- [ ] `grep -n "mode === \|intent === \|\.mode\b\|\.intent\b" src/dmn/reactive/index.ts` → 0 matches (except comments)
- [ ] T013-T016 all 4 source changes applied
- [ ] `bun test tests/unit/dmn/` → all pass
- [ ] `bun test tests/integration/dmn/` → all pass
- [ ] `grep -rn "mode: 'DEFER'\|mode: 'RESPOND'\|mode: 'EXECUTE'\|intent: 'both'" tests/unit/dmn/ tests/integration/dmn/` → 0 matches

## Review Guidance

- Verify T013 change: DEFER detection now triggers on `next === 'self'` not `mode === 'DEFER'`
- Verify T014 change: segment break logic semantics are preserved (ROUTE→cortex, RESPOND→reply+end)
- Verify T015 change: memory outcome `positive` still fires on reply or brainstem routing
- Verify T016 change: episodic content records `next` and `hasReply` instead of `mode`/`intent`
- Verify all 5 test files have 0 `mode: 'DEFER'` or `intent` references in fixtures

## Activity Log

- 2026-03-12T10:23:39Z – system – lane=planned – Prompt created.
- 2026-03-12T11:21:10Z – claude-wp03 – shell_pid=48454 – lane=doing – Started implementation via workflow command
- 2026-03-12T11:24:14Z – claude-wp03 – shell_pid=48454 – lane=for_review – All 4 source changes (T013-T016) applied in src/dmn/reactive/index.ts. All 5 DMN test files migrated to BrainOutput format (T017). 489 tests pass, 2 pre-existing failures unchanged.
- 2026-03-12T11:28:22Z – claude-wp03 – shell_pid=48454 – lane=done – Review passed: all 4 T013-T016 checks confirmed (next/reply/hasReply fields, no mode/intent refs). T017 test fixtures clean. 489 pass / 2 fail (both pre-existing known failures).
