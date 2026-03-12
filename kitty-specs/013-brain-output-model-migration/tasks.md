---
description: "Work package task list for Feature 013 — Brain Output Model Migration"
---

# Work Packages: Brain Output Model Migration

**Inputs**: Design documents from `/kitty-specs/013-brain-output-model-migration/`
**Prerequisites**: spec.md ✓, plan.md ✓, data-model.md ✓, quickstart.md ✓
**Tests**: 407 existing tests must pass throughout; update test fixtures alongside source changes.

**Key Insight**: The `workspace_write_slot` MCP tool accepts `output: Record<string, unknown>` — there is **no schema-level enforcement** of `mode`/`intent` in the adapters. The adapters simply return `output: {}` and the LLM writes via the MCP tool. Therefore: (1) no adapter output schema files need updating, (2) the migration is entirely in TypeScript types, Thread Runner logic, DMN Reactive, DB schema, and test fixtures.

---

## Work Package WP01: Types + DB Schema Foundation (Priority: P1) 🎯 MVP Start

**Goal**: Establish the `BrainOutput` type, remove `Intent`/`ComplexityHint`, delete `intent`/`complexity_hint` DB columns, and sync `Workspace`. This is the unblocking foundation for WP02 and WP03.
**Independent Test**: `bun test` passes; `slots` table migration runs; `Slot.intent` TypeScript error no longer exists.
**Prompt**: `tasks/WP01-types-and-db-schema.md`

### Included Subtasks
- [x] T001 Add `BrainOutput` interface + remove `Intent`/`ComplexityHint` types in `src/types/index.ts`
- [x] T002 Remove `intent`/`complexityHint` columns from `src/schema/slots.ts`
- [x] T003 Create Drizzle migration `drizzle/migrations/0002_remove_slot_intent_columns.sql`
- [x] T004 Sync `src/workspace/index.ts` — remove `intent`/`complexityHint` from `WriteSlotParams` reads/writes
- [x] T005 Update `tests/unit/workspace/thread-slot.test.ts` — remove `intent`/`complexityHint` assertions

### Implementation Notes
- Sequence: T001 → T002 → T003 → T004 → T005 (sequential; each builds on type changes).
- T001 is the critical unlock: once `BrainOutput` exists and old types are gone, TypeScript compiler will surface all downstream breakage points.
- T005 test update: change `makeSlotRow({ intent: 'execute', complexityHint: 'complex' })` calls and `expect(slot.intent).toBe('execute')` assertions to not reference those fields.

### Parallel Opportunities
- T002+T003 can be written in parallel once T001 is done (they're independent files).

### Dependencies
- None (starting package).

### Risks & Mitigations
- TypeScript compile errors will cascade after T001; this is expected and intentional — they guide what to fix in WP02/WP03.
- Migration must be idempotent: use `DROP COLUMN IF EXISTS`.

---

## Work Package WP02: Thread Runner Core Rewrite (Priority: P1)

**Goal**: Completely rewrite `src/runner/index.ts` routing logic to read `BrainOutput.next`/`reply`/`handoff` instead of `mode`/`intent`. Add `reply` event emission, `handoff` passing, and legal transition validation. Update all Thread Runner tests.
**Independent Test**: `tests/unit/thread-runner.test.ts` and `tests/integration/brain-runtime/thread-lifecycle.test.ts` pass with new BrainOutput mock formats.
**Prompt**: `tasks/WP02-thread-runner-rewrite.md`

### Included Subtasks
- [x] T006 Rewrite Limbic routing branch (`mode` series → `BrainOutput.next`)
- [x] T007 Rewrite Cortex routing branch (`intent` enum → `BrainOutput.next`), remove `intent=both` hardcode
- [x] T008 Rewrite Brainstem routing branch (remove `cortexOutput.intent` dependency, read `BrainOutput.next`)
- [x] T009 Implement `reply` event emission (`eventBus.emit({ event_type: 'thread.reply', ... })`)
- [x] T010 Implement `handoff` passing (write to next brain's input slot before `activateBrain()`)
- [ ] T011 Implement legal transition validation (`isLegalTransition` → `updateThreadState('interrupted')`)
- [ ] T012 Update `tests/unit/thread-runner.test.ts` + `tests/integration/brain-runtime/thread-lifecycle.test.ts` mock output format

### Implementation Notes
- T006/T007/T008 all modify the same `route()` method in sequence; implement together to avoid partial states.
- New routing skeleton (replaces existing `while (this.running)` body):
  ```typescript
  const output = slotMap[currentBrain]?.output as BrainOutput | null
  if (output?.reply) {
    this.eventBus.emit({ event_type: 'thread.reply', level: 'INFO', brain: currentBrain,
      thread_id: threadId, payload: { reply: output.reply } })
  }
  const next = output?.next ?? null
  if (next === null || next === undefined) { await complete(); return }
  if (next === 'self') { await handleDefer(output, threadId); return }
  if (!isLegalTransition(currentBrain, next)) { await interrupt(); return }
  if (output?.handoff) {
    await this.workspace.writeSlot(threadId, next, { input: { handoff: output.handoff } })
  }
  nextBrain = next
  ```
- T009: `thread.reply` event carries `{ threadId, reply: string }` in payload; upper apps listen to this.
- T010: handoff written to `input` field of next brain's slot before activation.
- T011: define `isLegalTransition` as a pure function outside the class for testability.
- T012: replace all `{ mode: 'RESPOND' }` → `{ reply: 'text' }`, `{ mode: 'ROUTE' }` → `{ next: 'cortex' }`, etc. in test fixtures.

### Parallel Opportunities
- T009/T010/T011 are independent additions to the runner; T006-T008 must be sequential.
- T012 can begin once the new routing API is defined.

### Dependencies
- Depends on WP01.

### Risks & Mitigations
- The `intent=both` three-step route is removed entirely; tests that relied on it must be refactored to use explicit `next` fields.
- `handleDefer()` extracts existing DEFER logic from the Limbic branch into a shared helper; keep it DRY.

---

## Work Package WP03: DMN Reactive Updates (Priority: P1) — Parallel with WP02

**Goal**: Update `src/dmn/reactive/index.ts` — 4 specific locations that reference `mode`/`intent` — and update all DMN test fixtures from old output format to new BrainOutput format.
**Independent Test**: DMN unit tests (`dmn-reactive.test.ts`, `dmn-reactive-brain-complete.test.ts`, `dmn-comprehensive.test.ts`) + `tests/integration/dmn/dmn.test.ts` pass.
**Prompt**: `tasks/WP03-dmn-reactive-updates.md`

### Included Subtasks
- [ ] T013 `handleEvent` DEFER detection: `output?.mode === 'DEFER'` → `output?.next === 'self'`
- [ ] T014 `shouldStartNewSegment`: `output?.mode === 'ROUTE'` → `output?.next === 'cortex'`; `output?.mode === 'RESPOND'` → `output?.reply != null && !output?.next`
- [ ] T015 `evaluateOutcome`: `output?.mode === 'RESPOND'` → `output?.reply != null`; `output?.mode === 'EXECUTE'` → `output?.next === 'brainstem'`
- [ ] T016 `buildEpisodicContent`: replace `mode`/`intent` fields with `next`/`hasReply` in serialized content
- [ ] T017 Update all DMN test files (`helpers.ts` + 4 test files) — change mock output from `{ mode: '...' }` to `{ next: '...', reply: '...' }`

### Implementation Notes
- All 4 source changes (T013-T016) are in `src/dmn/reactive/index.ts` — do them in one pass.
- T013 exact change (line ~109): `(payload.output as Record<string, unknown> | undefined)?.mode === 'DEFER'` → `?.next === 'self'`
- T014 exact changes (lines ~195, ~199): see plan.md mapping table.
- T015 exact change (lines ~261-262): `output?.mode === 'RESPOND'` → `output?.reply != null`; `output?.mode === 'EXECUTE'` → `output?.next === 'brainstem'`
- T016: `buildEpisodicContent` currently serializes `mode: output?.mode, intent: output?.intent` — change to `next: output?.next, hasReply: output?.reply != null`
- T017: affected files:
  - `tests/unit/dmn/helpers.ts` — `outputSlot: { output: { mode: 'RESPOND' } }` → `{ output: { reply: 'text' } }`
  - `tests/unit/dmn/dmn-reactive.test.ts` — `mode: 'DEFER'` → `next: 'self'`
  - `tests/unit/dmn/dmn-reactive-brain-complete.test.ts` — `mode: 'RESPOND'` refs
  - `tests/unit/dmn/dmn-comprehensive.test.ts` — multiple `mode: 'DEFER'` fixtures
  - `tests/integration/dmn/dmn.test.ts` — integration fixtures

### Parallel Opportunities
- T013-T016 are all in one file; do in a single edit pass.
- T017 can be done in parallel with T013-T016 (different files).

### Dependencies
- Depends on WP01 (needs `BrainOutput` type to be defined).
- **Can run in parallel with WP02** (different files; no overlap).

### Risks & Mitigations
- `handleDefer` in DmnReactive (Responsibility 6) also reads `output` — it currently uses `output?.mode` in its logic block header check but the actual implementation only reads `timeout_ms`/`defer_reason`, so only the detection check needs updating.
- The `handleDefer` in `runner/index.ts` and `handleDefer` in `dmn/reactive/index.ts` are separate — both need updating but in separate WPs (runner in WP02, DMN in WP03).

---

## Work Package WP04: Final Cleanup + Validation (Priority: P1)

**Goal**: Run global grep to confirm zero `mode`/`intent` enum residuals, fix any straggler references, run full 407-test suite, and mark the P1-C doc warning as resolved.
**Independent Test**: `bun test` outputs 407/407 pass; `grep -r "mode === " src/` returns 0 matches; `grep -r "type Intent" src/` returns 0 matches.
**Prompt**: `tasks/WP04-final-cleanup.md`

### Included Subtasks
- [ ] T018 Global grep zero-residual check — `grep -rn "mode === '\|intent === '\|type Intent\|type ComplexityHint" src/` → fix any remaining references
- [ ] T019 Run `bun test` full suite and achieve 407/407 — fix any remaining test breakage
- [ ] T020 Update `docs/v2/01-framework.md` — mark P1-C ⚠️ warning as fixed; update v2 doc to reference new BrainOutput structure

### Implementation Notes
- T018 should also check `src/schema/slots.ts` for residual `intent`/`complexity_hint` references.
- T019: all known test files are updated in WP01-WP03; T019 is the final confirmation pass.
- T020: the ⚠️ warning in `docs/v2/01-framework.md` reads "⚠️ P1-C: output model uses mode enum, reply+next concurrent not possible" — change to note it's resolved in Feature 013.

### Parallel Opportunities
- T020 can begin in parallel with T018/T019.

### Dependencies
- Depends on WP02 and WP03.

### Risks & Mitigations
- If T019 reveals failures, they likely come from a missed mock fixture — trace test name → fixture → update.

---

## Dependency & Execution Summary

```
WP01 (Types + DB)
  └─→ WP02 (Thread Runner) ─┐
  └─→ WP03 (DMN Reactive)  ─┤
                              └─→ WP04 (Final Cleanup)
```

- **WP02 and WP03 are parallel** — different file sets, no overlap.
- **MVP Scope**: WP01 + WP02 = core routing migration working; WP03 + WP04 complete it.
- **Sequence**: WP01 → [WP02 ‖ WP03] → WP04

---

## Subtask Index

| Subtask | Summary | WP | Priority | Parallel? |
|---------|---------|-----|----------|-----------|
| T001 | Add BrainOutput, remove Intent/ComplexityHint in types/index.ts | WP01 | P1 | No |
| T002 | Remove intent/complexityHint from schema/slots.ts | WP01 | P1 | After T001 |
| T003 | Create Drizzle migration 0002 | WP01 | P1 | With T002 |
| T004 | Sync workspace.ts WriteSlotParams | WP01 | P1 | After T001 |
| T005 | Update thread-slot.test.ts | WP01 | P1 | After T004 |
| T006 | Rewrite Limbic routing branch | WP02 | P1 | No |
| T007 | Rewrite Cortex routing branch, remove intent=both | WP02 | P1 | After T006 |
| T008 | Rewrite Brainstem routing branch | WP02 | P1 | After T007 |
| T009 | Add reply event emission | WP02 | P1 | With T006+ |
| T010 | Add handoff passing | WP02 | P1 | With T006+ |
| T011 | Add legal transition validation | WP02 | P1 | With T006+ |
| T012 | Update thread-runner.test.ts + lifecycle test | WP02 | P1 | With T006+ |
| T013 | DMN handleEvent DEFER detection fix | WP03 | P1 | Yes |
| T014 | DMN shouldStartNewSegment mode refs | WP03 | P1 | Yes |
| T015 | DMN evaluateOutcome mode refs | WP03 | P1 | Yes |
| T016 | DMN buildEpisodicContent mode/intent → next/reply | WP03 | P1 | Yes |
| T017 | Update all DMN test files | WP03 | P1 | With T013+ |
| T018 | Global grep zero-residual + fix | WP04 | P1 | No |
| T019 | bun test 407/407 final confirmation | WP04 | P1 | After T018 |
| T020 | Update docs/v2/01-framework.md P1-C marker | WP04 | P1 | With T018 |
