# Feature 020 — Quickstart Scenarios (V1–V5)

These scenarios drive the unit tests in T003.

---

## V1 — Depth-1 anchor lookup (happy path)

**Setup**: 3 semantic + 2 episodic memories for entity `person:alice`, 2 memories for
unrelated entity `person:bob`.

**Call**: `ws.getEntityContext("person:alice")`

**Expected**:
- Returns exactly 5 entries (all Alice's memories)
- No Bob memories in results
- Ordered by `base_importance DESC`, then `created_at DESC`
- All entries have `entityId === "person:alice"`
- All entries have `tInvalid === null` and `forgotten === false`

---

## V2 — Depth-2 related-entity expansion

**Setup**:
- Anchor entity `person:alice` has 2 memories
- One of Alice's semantic memories has content:
  ```json
  {"related_to": {"related_entity_id": "project:aima"}}
  ```
- Entity `project:aima` has 4 memories (3 should be returned per-related-entity limit)

**Call**: `ws.getEntityContext("person:alice", { depth: 2 })`

**Expected**:
- Returns 2 (Alice anchor) + 3 (project:aima capped at 3) = 5 entries
- All returned entries are active (not forgotten, not invalid)
- The `project:aima` memories have `entityId === "project:aima"`

---

## V3 — Types filter

**Setup**: Entity `project:aima` has 2 semantic + 2 episodic + 1 procedural memories.

**Call**: `ws.getEntityContext("project:aima", { types: ["semantic", "procedural"] })`

**Expected**:
- Returns exactly 3 entries (2 semantic + 1 procedural)
- No episodic entries in results

---

## V4 — Depth > 2 clamped

**Call**: `ws.getEntityContext("person:alice", { depth: 3 })`

**Expected**:
- Does NOT throw (or alternatively: throws `RangeError` — document chosen behavior)
- If clamped: behaves identically to `depth: 2`
- If throws: throws with a clear message about max depth

*(Implementation note: clamping is preferred for resilience. Document the choice.)*

---

## V5 — Empty result

**Setup**: No memories exist for entity `person:nobody`.

**Call**: `ws.getEntityContext("person:nobody")`

**Expected**:
- Returns `[]` (empty array)
- No exception thrown

---

## V6 (bonus) — Limit opt

**Setup**: Entity `person:alice` has 15 active memories.

**Call**: `ws.getEntityContext("person:alice", { limit: 5 })`

**Expected**:
- Returns exactly 5 entries (top 5 by importance)
