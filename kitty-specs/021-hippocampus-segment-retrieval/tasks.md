# Tasks: Feature 021 — Hippocampus Segment Retrieval

## WP01 — Add segment retrieval to ICognitiveWorkspace

**Lane**: todo
**Depends on**: none

| ID   | Task | Details |
|------|------|---------|
| T001 | Add `getSegmentSequence` and `getSegmentsByTimeRange` to `ICognitiveWorkspace` | Edit `src/types/index.ts`: add both method signatures under the `// ── DMN Segment Tracking` section. Return type for `getSegmentsByTimeRange` uses `maxCreatedAt: Date` (matching implementation). |
| T002 | Verify `CognitiveWorkspace` satisfies updated interface | Run `tsc --noEmit`. Both methods are already implemented in `src/workspace/index.ts`; no code changes expected — just confirm no type errors. |
| T003 | Unit tests V1–V5 for both methods | Create `tests/unit/workspace/segment-retrieval.test.ts` using the existing workspace test helpers (pg-mem or test DB setup pattern from adjacent test files). Cover scenarios V1–V5 from quickstart.md. |

**Done criteria**: `tsc --noEmit` passes, all V1–V5 tests green, no regression in existing workspace tests.
