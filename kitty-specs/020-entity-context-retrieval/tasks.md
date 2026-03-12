# Feature 020 — Tasks

## WP01 — Entity Context Retrieval Implementation

**lane**: todo
**depends_on**: []

| Task | Description | Est |
|------|-------------|-----|
| T001 | Add `depth?: number` to `getEntityContext` opts in `ICognitiveWorkspace` (`src/types/index.ts`) | XS |
| T002 | Implement `getEntityContext` depth=1 + depth=2 expansion in `CognitiveWorkspace` (`src/workspace/index.ts`) | S |
| T003 | Unit tests V1–V5 (depth=1 anchor, depth=2 expansion, types filter, depth>2 clamp, empty result) | S |

Notes:
- T004 (entityId in writeMemory) is **skipped** — `CreateMemoryParams` already has `entityId?: string` and `writeMemory` already uses it.
- Tasks are sequentially dependent: T001 → T002 → T003.
