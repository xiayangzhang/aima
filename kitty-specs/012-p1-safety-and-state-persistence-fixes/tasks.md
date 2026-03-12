# Work Packages: P1 Safety & State Persistence Fixes

**Inputs**: `kitty-specs/012-p1-safety-and-state-persistence-fixes/`
**Spec**: spec.md | **Plan**: plan.md | **Data Model**: data-model.md

---

## Work Package WP01: P1 Bug Trio Fix (Priority: P1)

**Goal**: Fix three interconnected P1-level bugs: DEFER state not persisted to DB, BrainSignal not thread-scoped, and DMN segment tracking lost on process restart.
**Independent Test**: `bun test` — 404 pass / 0 fail

### Included Subtasks
- [x] FR-001 DEFER → `waiting` state persisted in threads table
- [x] FR-002 `getActiveThreads()` returns only `active` threads (not `waiting`)
- [x] FR-003 `BrainSignal.threadId` required field added; all callers updated
- [x] FR-004 Signal storage keyed by `type:threadId`; `inject()` filters by thread
- [x] FR-005 `DmnReactive.start()` calls `restoreSegmentTracking()` from DB
- [x] FR-006 `getLatestSegmentStates()` added to workspace and ICognitiveWorkspace
- [x] FR-007 Schema migration: `thread_id uuid` column on `pending_observations`
- [x] Unit tests updated and 3 new tests added for fixes 1 and 3

### Implementation Notes
- All three fixes landed in a single commit on branch `012-p1-safety-state-fixes`
- Migration: `drizzle/migrations/0001_goofy_iron_man.sql`
- `routePending()` resumes original thread (not creates new) when `pending.threadId` is set

### Dependencies
- none
