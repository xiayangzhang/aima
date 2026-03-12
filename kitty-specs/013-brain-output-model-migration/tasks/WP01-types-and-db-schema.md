---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
  - "T003"
  - "T004"
  - "T005"
title: "Types + DB Schema Foundation"
phase: "Phase 1 - Foundation"
lane: "done"
assignee: ""
agent: "claude"
shell_pid: "36896"
review_status: "approved"
reviewed_by: "XIAYANG ZHANG"
dependencies: []
history:
  - timestamp: "2026-03-12T10:23:39Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
---

# Work Package Prompt: WP01 — Types + DB Schema Foundation

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` field. If `has_feedback`, scroll to Review Feedback section.
- **Mark as acknowledged**: Update `review_status: acknowledged` when you begin addressing feedback.

---

## Review Feedback

*[Empty initially — reviewers populate if work is returned.]*

---

## Objectives & Success Criteria

Establish the **TypeScript type foundation** and **database schema cleanup** for Feature 013. After this WP:

- `BrainOutput` interface exists in `src/types/index.ts`
- `Intent` and `ComplexityHint` types are deleted
- `Slot.intent` and `Slot.complexityHint` fields are gone
- `WriteSlotParams.intent` and `WriteSlotParams.complexityHint` are gone
- DB migration `0002_remove_slot_intent_columns.sql` exists and runs cleanly
- `bun test` passes (type compile errors in WP02/WP03 scoped files are expected — but this WP's scope must pass)

**To implement this WP**:
```bash
spec-kitty implement WP01
```

## Context & Constraints

- **Spec**: `kitty-specs/013-brain-output-model-migration/spec.md`
- **Plan**: `kitty-specs/013-brain-output-model-migration/plan.md` — see Migration Design section
- **Data Model**: `kitty-specs/013-brain-output-model-migration/data-model.md` — authoritative type definitions
- **Repo root**: `/Volumes/leoyun/aima/`
- **Key insight**: Adapters return `output: {}` and brains write via `workspace_write_slot` MCP tool. No adapter output schema changes needed. This WP is purely type/schema cleanup.
- **407 tests must pass** throughout. WP01 changes will cause TypeScript errors in runner and DMN tests — acceptable as those are fixed in WP02/WP03. Focus on making workspace tests pass.

## Subtasks & Detailed Guidance

### Subtask T001 — Add BrainOutput + Remove Intent/ComplexityHint in `src/types/index.ts`

**Purpose**: Establish the new unified output structure and remove the old mutually-exclusive enum types.

**Steps**:

1. **Add `BrainOutput` interface** after the `ThreadState`/`SlotStatus` section:
   ```typescript
   /**
    * Unified brain output structure. Three independent optional fields:
    * - next:    routing target; null/undefined = thread ends
    * - reply:   outbound message to human; undefined = no reply this turn
    * - handoff: inter-brain context passed to the next brain's input; undefined = none
    */
   export interface BrainOutput {
     next?: CognitiveBrainType | 'self' | null
     reply?: string
     handoff?: string
   }
   ```

2. **Delete** the following type declarations entirely:
   ```typescript
   // DELETE THIS:
   export type Intent = 'communicate' | 'execute' | 'both'
   // DELETE THIS:
   export type ComplexityHint = 'simple' | 'complex'
   ```

3. **Update `Slot` interface** — remove `intent` and `complexityHint` fields:
   ```typescript
   export interface Slot {
     id: string
     threadId: string
     brain: BrainType
     status: SlotStatus
     input: unknown | null
     output: unknown | null
     executionSessionId: string | null  // Brainstem only (keep)
     createdAt: Date
     updatedAt: Date
   }
   ```

4. **Update `WriteSlotParams` interface** — remove `intent` and `complexityHint` fields:
   ```typescript
   export interface WriteSlotParams {
     status?: SlotStatus
     input?: unknown
     output?: unknown
     executionSessionId?: string | null
   }
   ```

**Files**:
- `src/types/index.ts`

**Validation**:
- `grep -n "Intent\|ComplexityHint" src/types/index.ts` — should return 0 matches
- `grep -n "BrainOutput" src/types/index.ts` — should return the new interface

**Edge Cases**:
- `'self'` is a valid `next` value (DEFER case) but is NOT in `CognitiveBrainType`. The union `CognitiveBrainType | 'self' | null` handles this.

---

### Subtask T002 — Remove `intent`/`complexityHint` columns from `src/schema/slots.ts`

**Purpose**: Remove the now-redundant DB columns from the Drizzle schema definition.

**Steps**:

1. Open `src/schema/slots.ts`
2. Delete these two lines from the `slots` table definition:
   ```typescript
   intent: text('intent'), // 'communicate' | 'execute' | 'both', Cortex only
   complexityHint: text('complexity_hint'), // 'simple' | 'complex', Cortex only
   ```
3. Remove any unused imports if `text` is now unused (check — `text` is also used for `executionSessionId`, so keep it)

**Files**:
- `src/schema/slots.ts`

**Validation**:
- `grep -n "intent\|complexityHint\|complexity_hint" src/schema/slots.ts` → 0 matches

---

### Subtask T003 — Create Drizzle migration `drizzle/migrations/0002_remove_slot_intent_columns.sql`

**Purpose**: Remove the `intent` and `complexity_hint` columns from the live `slots` table.

**Steps**:

1. Check the existing migration to understand naming convention:
   ```bash
   ls drizzle/migrations/
   ```
2. Create `drizzle/migrations/0002_remove_slot_intent_columns.sql`:
   ```sql
   ALTER TABLE slots DROP COLUMN IF EXISTS intent;
   ALTER TABLE slots DROP COLUMN IF EXISTS complexity_hint;
   ```
3. Also check if there's a `drizzle/migrations/meta/` directory with snapshot files — if yes, run:
   ```bash
   cd /Volumes/leoyun/aima && bun drizzle-kit generate 2>&1 | head -10
   ```
   If `drizzle-kit generate` creates a different migration filename, use that instead and delete the manually created file.

**Files**:
- `drizzle/migrations/0002_remove_slot_intent_columns.sql` (new)

**Notes**:
- Use `IF EXISTS` to make the migration idempotent (safe to re-run).
- If the project uses `drizzle-kit generate` to auto-generate migration files, run that command instead of manually creating the SQL.

---

### Subtask T004 — Sync `src/workspace/index.ts` with `WriteSlotParams` changes

**Purpose**: Remove all reads/writes of `intent`/`complexityHint` from the workspace implementation.

**Steps**:

1. Open `src/workspace/index.ts` and search for `intent` and `complexityHint`:
   ```bash
   grep -n "intent\|complexityHint\|complexity_hint" src/workspace/index.ts
   ```
2. In the `writeSlot` implementation, remove any lines that read `data.intent`, `data.complexityHint` or pass them to Drizzle update/insert.
3. In any slot row → `Slot` type mapper function, remove `intent` and `complexityHint` field mappings.
4. Check the `ICognitiveWorkspace` interface definition if it's in workspace/index.ts — the `WriteSlotParams` change in T001 already handles the interface.

**Files**:
- `src/workspace/index.ts`

**Validation**:
- `grep -n "intent\|complexityHint\|complexity_hint" src/workspace/index.ts` → 0 matches (except comments if any)
- `bun tsc --noEmit` should show 0 errors in this file after T001-T004

---

### Subtask T005 — Update `tests/unit/workspace/thread-slot.test.ts`

**Purpose**: Remove test assertions for the now-deleted `intent`/`complexityHint` Slot fields.

**Steps**:

1. Open `tests/unit/workspace/thread-slot.test.ts`
2. Find the test around line 268: `const row = makeSlotRow({ intent: 'execute', complexityHint: 'complex' })`
3. Change it to not pass `intent`/`complexityHint` to `makeSlotRow`. If `makeSlotRow` accepts these as typed parameters, update `makeSlotRow`'s type signature too.
4. Remove assertions like `expect(slot.intent).toBe('execute')` and `expect(slot.complexityHint).toBe('complex')`
5. Run the specific test file to verify:
   ```bash
   cd /Volumes/leoyun/aima && bun test tests/unit/workspace/thread-slot.test.ts
   ```

**Files**:
- `tests/unit/workspace/thread-slot.test.ts`

**Validation**:
- `grep -n "\.intent\b\|complexityHint\|complexity_hint" tests/unit/workspace/thread-slot.test.ts` → 0 matches
- Test file passes: `bun test tests/unit/workspace/thread-slot.test.ts`

---

## Risks & Mitigations

- **Type errors cascade**: After T001, TypeScript will show errors in `runner/index.ts` and `dmn/reactive/index.ts`. This is **expected** — they're fixed in WP02/WP03. Focus on making this WP's own files compile cleanly.
- **Migration naming**: Different projects use different naming conventions for Drizzle migrations. Check existing migration filenames before creating T003.
- **`text` import**: Ensure `text` from drizzle-orm is still used after removing the two columns (it's used for `executionSessionId`). Don't accidentally break the import.

## Definition of Done Checklist

- [ ] T001: `BrainOutput` interface in `src/types/index.ts`, `Intent`/`ComplexityHint` deleted
- [ ] T002: `intent`/`complexityHint` columns removed from `src/schema/slots.ts`
- [ ] T003: Migration SQL file exists in `drizzle/migrations/`
- [ ] T004: `src/workspace/index.ts` has no `intent`/`complexityHint` references
- [ ] T005: `tests/unit/workspace/thread-slot.test.ts` passes cleanly
- [ ] `grep -rn "type Intent\|type ComplexityHint" src/` → 0 matches
- [ ] `grep -rn "\.intent\b\|\.complexityHint\b" src/workspace/` → 0 matches

## Review Guidance

- Verify `BrainOutput` matches the definition in `data-model.md` exactly (especially `'self'` in the union)
- Verify `Slot` interface no longer has `intent`/`complexityHint` fields
- Verify migration SQL uses `IF EXISTS`
- Verify no TypeScript import for `Intent` or `ComplexityHint` remains anywhere in `src/`

## Activity Log

- 2026-03-12T10:23:39Z – system – lane=planned – Prompt created.
- 2026-03-12T10:57:38Z – claude – shell_pid=22367 – lane=doing – Started implementation via workflow command
- 2026-03-12T11:00:11Z – claude – shell_pid=22367 – lane=for_review – Ready for review: BrainOutput interface added, Intent/ComplexityHint removed from types+schema+workspace+tests. 403 unit tests pass, 0 fail. Migration 0002 generated via drizzle-kit.
- 2026-03-12T11:09:54Z – claude – shell_pid=36896 – lane=doing – Started review via workflow command
- 2026-03-12T11:13:50Z – claude – shell_pid=36896 – lane=done – Review passed: BrainOutput matches data-model.md exactly. Intent/ComplexityHint removed from types+schema+workspace+index.ts (found+fixed missing src/index.ts cleanup during review). Migration 0002 generated via drizzle-kit. 489/491 pass with real DB; 2 failures are pre-existing on main (getActiveThreads integration + Feature007 ScenarioC), unrelated to WP01.
