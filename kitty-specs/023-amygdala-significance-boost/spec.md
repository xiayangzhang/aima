# Feature 023 — Amygdala Significance Boost → DMN Episodic Encoding

## Status: draft

## Background

When Amygdala makes a significant decision (block or escalate), that experience should
be encoded into episodic memory with elevated importance. This makes risk-related events
more salient: they are retrieved more easily during future Hippocampus replay and surface
as stronger priors when similar tools appear again.

The existing `amygdala.interrupt` event already carries `tool`, `decision`, and `reason`.
DMN Reactive already supports a `significance_boost` field on `brain.complete` events
(lines 152–183 of `src/dmn/reactive/index.ts`), using it to set a higher `base_importance`
and write a `significance_mark` episodic record. The missing piece is:

1. Amygdala emitting `significance_boost` inside its `amygdala.interrupt` event payload.
2. DMN Reactive listening for `amygdala.interrupt` events and writing an episodic memory
   using that boost value, parallel to how it handles `brain.complete`.

## User Stories

### US-1 — Amygdala emits significance_boost

As DMN Reactive,
I want every `amygdala.interrupt` event to carry a `significance_boost` field,
so that I can set the correct `baseImportance` when writing the episodic memory.

**Acceptance criteria:**
- `amygdala.interrupt` payload contains `significance_boost: 0.4` when decision is `block`.
- `amygdala.interrupt` payload contains `significance_boost: 0.2` when decision is `escalate`.
- (Implicit: `allow` decisions do not trigger `amygdala.interrupt` events — unchanged behaviour.)

### US-2 — DMN Reactive encodes amygdala interrupts as episodic memories

As Hippocampus replay,
I want `amygdala.interrupt` events to be encoded as episodic memories with boosted importance,
so that risk-associated tool encounters surface more strongly during future consolidation.

**Acceptance criteria:**
- DMN Reactive writes an episodic memory on every `amygdala.interrupt` ALERT event.
- `baseImportance = Math.min(1.0, 0.5 + significance_boost)` — same formula as `brain.complete` path.
- If `significance_boost` is absent or 0 (not expected in practice but for safety), use default
  `baseImportance = 0.5`.
- The episodic memory is tagged with `['amygdala_interrupt', decision, toolName, 'thread:<id>']`.
- If the event has a `thread_id`, the memory is written with `threadId` set.
- A `significance_mark` record is also written (same pattern as lines 167–183 of `src/dmn/reactive/index.ts`)
  because `significance_boost > 0` is always true for interrupt events.

## Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | `Amygdala.startListening()` MUST include `significance_boost: 0.4` in `amygdala.interrupt` payload for `block` decisions |
| FR-2 | `Amygdala.startListening()` MUST include `significance_boost: 0.2` in `amygdala.interrupt` payload for `escalate` decisions |
| FR-3 | `DmnReactive.handleEvent()` MUST route `amygdala.interrupt` ALERT events to a new handler that writes episodic memory |
| FR-4 | Episodic `baseImportance` formula: `Math.min(1.0, 0.5 + significance_boost)` |
| FR-5 | A `significance_mark` episodic record MUST be written for every `amygdala.interrupt` (boost always > 0 for interrupt events) |
| FR-6 | Backwards-compatible: if `significance_boost` is absent, episodic write still proceeds with `baseImportance = 0.5` |

## Out of Scope

- Changing `Amygdala.check()` — `check()` does not emit events and that stays unchanged.
- Changing how `brain.complete` significance boost works — already implemented.
- Segment assignment for amygdala interrupt events — these are cross-thread signals, not
  part of a brain's execution segment sequence. No `segmentId` / `segmentSeq` needed.
- Adding significance boost to allow decisions — allow events are not emitted.

## Success Criteria

- `amygdala.test.ts`: new tests confirm `significance_boost` is present in emitted event payload.
- `dmn-reactive*.test.ts`: new tests confirm episodic + significance_mark written on interrupt.
- `bun tsc --noEmit` passes with zero errors.
- Existing test suite has zero regressions.
