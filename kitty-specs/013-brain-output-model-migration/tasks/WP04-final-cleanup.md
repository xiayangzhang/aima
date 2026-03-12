---
work_package_id: WP04
title: Final Cleanup + Validation
lane: planned
dependencies:
- WP02
subtasks:
- T018
- T019
- T020
phase: Phase 3 - Polish
assignee: ''
agent: ''
shell_pid: ''
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-12T10:23:39Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP04 — Final Cleanup + Validation

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` field. If `has_feedback`, scroll to Review Feedback section.
- **Mark as acknowledged**: Update `review_status: acknowledged` when you begin addressing feedback.

---

## Review Feedback

*[Empty initially — reviewers populate if work is returned.]*

---

## Objectives & Success Criteria

Confirm zero residual `mode`/`intent` enum references across the entire codebase, achieve 407/407 test pass, and update documentation. After this WP:

- `bun test` outputs exactly 407 passing, 0 failing
- `grep -rn "mode === '\|intent === '\|type Intent\b\|type ComplexityHint" src/` returns 0 matches
- `docs/v2/01-framework.md` P1-C warning is marked as resolved
- Feature 013 is ready for `spec-kitty accept`

**To implement this WP**:
```bash
spec-kitty implement WP04 --base WP02
```
*(WP03 must also be merged before WP04 — ensure both WP02 and WP03 are done)*

## Context & Constraints

- **Depends on**: WP02 AND WP03 both complete
- **Spec**: `kitty-specs/013-brain-output-model-migration/spec.md` — SC-003/SC-004/SC-005
- **Quickstart**: `kitty-specs/013-brain-output-model-migration/quickstart.md` — DoD checklist is the acceptance gate

## Subtasks & Detailed Guidance

### Subtask T018 — Global grep zero-residual check + fix

**Purpose**: Confirm no stray `mode`/`intent` enum references survive anywhere in `src/` after WP01-WP03.

**Steps**:

1. Run the following grep commands from `/Volumes/leoyun/aima/`:

   ```bash
   # Old mode enum comparisons
   grep -rn "mode === 'RESPOND'\|mode === 'NO_REPLY'\|mode === 'ROUTE'\|mode === 'EXECUTE'\|mode === 'DEFER'" src/

   # Old intent enum comparisons
   grep -rn "intent === 'communicate'\|intent === 'execute'\|intent === 'both'" src/

   # Old type definitions
   grep -rn "type Intent\b\|type ComplexityHint\b" src/

   # Old field accesses on output (might be lurking in comments or string literals)
   grep -rn "output\.mode\b\|output\.intent\b" src/

   # Old slot field accesses
   grep -rn "slot\.intent\b\|slot\.complexityHint\b\|\.complexityHint\b" src/

   # Database column references
   grep -rn "intent:\|complexity_hint:" src/schema/
   grep -rn "\.intent\b\|\.complexityHint\b" src/workspace/
   ```

2. For each match found:
   - If in a comment: update the comment text to reflect new terminology
   - If in code: apply the same substitutions as WP02/WP03

3. Also run in tests:
   ```bash
   grep -rn "mode: 'RESPOND'\|mode: 'EXECUTE'\|mode: 'ROUTE'\|mode: 'DEFER'\|mode: 'NO_REPLY'" tests/
   grep -rn "intent: 'both'\|intent: 'communicate'\|intent: 'execute'" tests/
   ```

4. Fix any remaining occurrences before moving to T019.

**Expected result**: All grep commands return 0 matches.

---

### Subtask T019 — Run `bun test` full suite (407/407)

**Purpose**: Final confirmation that all 407 tests pass and no regressions were introduced.

**Steps**:

1. Run the full test suite:
   ```bash
   cd /Volumes/leoyun/aima && bun test 2>&1 | tail -20
   ```

2. If any tests fail:
   - Note the failing test name and file
   - Trace back: is the failure in a mock fixture using old `mode`/`intent`? → apply substitution
   - Is the failure in a type error? → check if T001 types are correctly referenced
   - Is the failure in DMN segment logic? → check T014 semantic equivalence

3. Repeat until output shows:
   ```
   407 pass
   0 fail
   ```

4. Also run the DoD verification commands from `quickstart.md`:
   ```bash
   # Zero residual checks (should all return 0 lines):
   grep -r "mode === 'RESPOND'" src/
   grep -r "type Intent" src/
   grep -r "intent === 'both'" src/

   # Migration exists:
   ls drizzle/migrations/ | grep 0002

   # No intent=both logic in runner:
   grep -n "intent.*both\|intent=both" src/runner/index.ts
   ```

**Files**: No source changes expected in T019 — only test fixes if needed.

---

### Subtask T020 — Update `docs/v2/01-framework.md` — mark P1-C as resolved

**Purpose**: The v2 framework doc has a prominent ⚠️ warning about the P1-C output model limitation. Feature 013 fixes this — mark it resolved.

**Steps**:

1. Open `docs/v2/01-framework.md`
2. Find the P1-C warning (search for `P1-C` or `⚠️`). It reads something like:
   ```
   ⚠️ **P1-C**: 当前输出模型使用 mode/intent 枚举，无法同时表达 reply+next，
   Brainstem 无法自主路由回 Limbic。详见 Feature 013。
   ```
3. Update to mark as resolved:
   ```
   ✅ **已修复 (Feature 013)**: 输出模型已迁移到 `{next?, reply?, handoff?}` 三字段解耦结构。
   `next` 是路由目标，`reply` 是对外输出，`handoff` 是脑间上下文，三者完全独立可任意组合。
   Brainstem 可通过 `next: 'limbic'` 自主路由回 Limbic。
   ```
4. Additionally, update the Thread Runner section in `docs/v2/01-framework.md` (if it describes `mode`/`intent` in the routing algorithm) to document the new `BrainOutput` reading logic.

**Files**:
- `docs/v2/01-framework.md`

**Notes**: This is a documentation-only change. Keep the change minimal — just resolve the warning and update any routing algorithm description that still references `mode`/`intent`.

---

## Risks & Mitigations

- **T019 unexpected failures**: Most likely causes are (a) a test helper in a non-DMN/runner test file that constructs `{ mode: ... }` output, or (b) a TypeScript type error that only surfaces at runtime due to type cast. For (a), grep the test output for the failing file and apply the fixture substitution. For (b), run `bun tsc --noEmit` to catch compile errors first.

## Definition of Done Checklist

- [ ] All grep zero-residual commands return 0 matches (T018)
- [ ] `bun test` outputs 407/407 pass, 0 fail (T019)
- [ ] `docs/v2/01-framework.md` P1-C warning replaced with ✅ resolved note (T020)
- [ ] `quickstart.md` DoD checklist fully satisfied
- [ ] Feature 013 is ready for `spec-kitty accept`

## Review Guidance

- Run all the grep checks from T018 yourself and confirm 0 matches
- Run `bun test` and verify 407 pass
- Check `docs/v2/01-framework.md` diff — confirm P1-C is resolved, no new content introduced
- Confirm the migration file exists in `drizzle/migrations/`

## Activity Log

- 2026-03-12T10:23:39Z – system – lane=planned – Prompt created.
