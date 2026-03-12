# Feature 020 — Entity Context Retrieval

## Status
draft

## Background

Limbic is the entity-centric brain in AIMA — it tracks people, projects, and concepts that the
agent interacts with over time. The architecture doc defines a dedicated retrieval operation:

> Limbic 实体中心——"关于这个人/项目我知道什么？" → `getEntityContext(entityId, depth)`

Currently `ICognitiveWorkspace` has a stub `getEntityContext(entityId, opts?)` that only accepts
`types` and `limit` filters. It has no `depth` parameter, so it cannot expand to related entities.

The `memories` table already has `entity_id` (indexed), and `writeMemory` already accepts
`entityId`. The missing piece is the `depth` dimension: a single-hop "star topology" expansion
that lets Limbic answer "what do I know about X, and about the things X is related to?"

## User Stories

### US-1 — Depth-1 anchor lookup
As Limbic, when I need to recall everything about a specific entity (e.g. `person:alice`),
I call `getEntityContext("person:alice")` and receive all active, non-forgotten memories
for that entity, ordered by importance then recency, up to the default limit of 10.

### US-2 — Depth-2 related-entity expansion
As Limbic, when I need broader context around an entity, I call
`getEntityContext("person:alice", { depth: 2 })` and additionally receive memories for
entities that Alice is semantically linked to (via `related_to` semantic memories), up to
5 related entities, 3 memories each.

### US-3 — Types filter
As Limbic, I can restrict results to specific memory types, e.g.
`getEntityContext("project:aima", { types: ["semantic", "procedural"] })`, so irrelevant
episodic noise is excluded.

### US-4 — Depth > 2 is rejected
As an API consumer, if I accidentally pass `depth: 3`, the call clamps to depth 2 (or throws).
This prevents unbounded graph traversal.

### US-5 — Empty result
As Limbic, when no memories exist for an entity, I receive an empty array without error.

## Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | Add `depth?: number` to `getEntityContext` opts in `ICognitiveWorkspace` |
| FR-2 | depth=1 (default): return active memories where `entity_id = entityId`, ordered `base_importance DESC, created_at DESC`, limit `opts.limit ?? 10` |
| FR-3 | depth=2: additionally expand to related entities — find semantic memories for the anchor where content JSON contains `related_to` key, extract `related_entity_id`, fetch up to 5 related entities × 3 memories each |
| FR-4 | Apply `opts.types` filter (if provided) to both anchor and related-entity queries |
| FR-5 | depth > 2 must be clamped to 2 (or throw `RangeError`) — document the chosen behaviour in code |
| FR-6 | All returned memories must satisfy `activeMemory()`: `t_invalid IS NULL` AND `forgotten = false` |
| FR-7 | `writeMemory` already accepts `entityId` — no change needed |

## Success Criteria

- [ ] `ICognitiveWorkspace.getEntityContext` signature includes `depth?: number`
- [ ] depth=1 returns anchor memories only, correct ordering
- [ ] depth=2 returns anchor + related-entity memories (star topology, ≤ 5 related entities)
- [ ] types filter correctly restricts results
- [ ] depth > 2 is handled (clamped or error)
- [ ] Empty entity → empty array, no exception
- [ ] All five V1-V5 scenarios pass as unit tests
- [ ] No regression in existing `searchMemory` / `findSimilarSituations` behaviour

## Assumptions

- Related-entity expansion uses semantic memories whose `content` is valid JSON containing a
  `related_to` key with a `related_entity_id` field. If content is not valid JSON or the key
  is absent, the row is silently skipped.
- The cap of 5 related entities and 3 memories-per-related-entity is a hardcoded policy limit
  (not configurable in opts), to bound query cost.
- `depth` defaults to 1. Passing `depth: 0` is treated as depth=1 (minimum useful depth).
- The feature does NOT add pgvector similarity — that is Feature 017. This feature is purely
  relational (entity_id equality + JSON content parse).
