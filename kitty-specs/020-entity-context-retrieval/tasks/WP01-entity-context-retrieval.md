---
wp: WP01
feature: 020-entity-context-retrieval
lane: todo
depends_on: []
---

# WP01 — Entity Context Retrieval Implementation

## Objective

Extend `getEntityContext` with `depth` support (depth=1 anchor lookup + depth=2 star-topology
related-entity expansion). The method already exists; this WP adds the `depth` dimension.

## Pre-conditions

- Feature 001 (workspace schema) merged — `memories.entity_id` column and index exist ✅
- Feature 005 (brain-specific retrieval) merged — `getEntityContext` stub exists ✅
- No schema migration needed

## Tasks

### T001 — Update ICognitiveWorkspace interface
**File**: `src/types/index.ts`
**Change**: Add `depth?: number` to `getEntityContext` opts

Current signature (line 174-177):
```typescript
getEntityContext(
  entityId: string,
  opts?: { types?: MemoryType[]; limit?: number },
): Promise<MemoryEntry[]>
```

New signature:
```typescript
getEntityContext(
  entityId: string,
  opts?: {
    depth?: number      // default 1, clamped to max 2
    types?: MemoryType[]
    limit?: number      // default 10
  },
): Promise<MemoryEntry[]>
```

**Acceptance**: TypeScript compiles without errors; no existing callers break (new field is optional).

---

### T002 — Implement depth=1 + depth=2 in CognitiveWorkspace
**File**: `src/workspace/index.ts`

**Steps**:

1. Extract the existing query body into a private helper `_fetchEntityMemories(entityId, types?, limit)`:
   - Conditions: `eq(memories.entityId, entityId)`, `activeMemory()` (i.e., `isNull(memories.tInvalid)` + `eq(memories.forgotten, false)`)
   - If `types` provided and non-empty: `inArray(memories.type, types)`
   - Order: `desc(memories.baseImportance)`, `desc(memories.createdAt)`
   - Limit: `limit` parameter

2. Update `getEntityContext` to:
   - Read `depth = Math.min(opts?.depth ?? 1, 2)` (clamp; treat 0 same as 1)
   - Call `_fetchEntityMemories(entityId, opts?.types, opts?.limit ?? 10)` → anchorRows
   - If `depth < 2`: return anchorRows
   - If `depth === 2`:
     - Extract related entity IDs from anchorRows: filter `type === 'semantic'`, parse content as JSON, extract `related_to.related_entity_id` (skip if parse fails or key absent), deduplicate, cap at 5
     - For each related entity ID: call `_fetchEntityMemories(relatedId, opts?.types, 3)`
     - Return `[...anchorRows, ...relatedResults.flat()]`

3. Add module-level pure function `extractRelatedEntityIds(entries: MemoryEntry[], max: number): string[]` (see plan.md for sketch)

**Acceptance**:
- Existing `getEntityContext` callers (depth=1 default) return same results as before
- depth=2 correctly appends related-entity memories
- depth=3 is silently clamped to 2

---

### T003 — Unit tests V1–V5
**File**: `src/workspace/index.test.ts` (add to existing test file) or new file `src/workspace/entity-context.test.ts`

Implement all 5 scenarios from `quickstart.md`:

| Scenario | Assertion |
|----------|-----------|
| V1 — depth=1 anchor | Returns only anchor entity memories, correct count and order |
| V2 — depth=2 expansion | Returns anchor + related-entity memories (capped at 3 per related entity) |
| V3 — types filter | Filters by specified types only |
| V4 — depth > 2 clamped | depth=3 behaves as depth=2 (or throws RangeError — match implementation) |
| V5 — empty result | Returns [] for unknown entity |

Use the same test DB setup pattern as existing tests in the file.

**Acceptance**: All 5 scenarios pass; `pnpm test` green.

## Post-conditions

- `getEntityContext` signature in `ICognitiveWorkspace` includes `depth?: number`
- `CognitiveWorkspace` handles depth=1 and depth=2
- All V1–V5 unit tests pass
- No regression in `searchMemory`, `findSimilarSituations`, `getProcedure`
