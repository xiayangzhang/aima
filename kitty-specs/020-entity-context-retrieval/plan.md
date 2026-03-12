# Feature 020 — Implementation Plan

## Summary

Extend `getEntityContext` with a `depth` parameter to support star-topology entity expansion.
The method already exists in both `ICognitiveWorkspace` and `CognitiveWorkspace` with `types`
and `limit` opts. This feature adds the `depth` dimension.

## Scope Delta (what changes)

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `depth?: number` to `getEntityContext` opts in `ICognitiveWorkspace` |
| `src/workspace/index.ts` | Extend `CognitiveWorkspace.getEntityContext` with depth=2 expansion logic |
| `src/workspace/index.test.ts` (or new test file) | Unit tests V1-V5 |

`writeMemory` already accepts `entityId` — no change needed there.

## Implementation Sketch

### Step 1 — Update interface signature (`src/types/index.ts`)

```typescript
getEntityContext(
  entityId: string,
  opts?: {
    depth?: number      // default 1, clamped to max 2
    types?: MemoryType[]
    limit?: number      // default 10
  }
): Promise<MemoryEntry[]>
```

### Step 2 — Implement depth=1 (already mostly done, just add depth handling)

The existing implementation is correct for depth=1. Wrap it and add depth guard:

```typescript
async getEntityContext(entityId: string, opts?: { depth?: number; types?: MemoryType[]; limit?: number }): Promise<MemoryEntry[]> {
  const depth = Math.min(opts?.depth ?? 1, 2)   // clamp to max 2; treat 0 as 1

  // depth=1 query (anchor only)
  const anchorRows = await this._fetchEntityMemories(entityId, opts?.types, opts?.limit ?? 10)

  if (depth < 2) return anchorRows

  // depth=2: find related entities from anchor's semantic memories
  const relatedEntityIds = extractRelatedEntityIds(anchorRows, 5)  // max 5 related
  if (relatedEntityIds.length === 0) return anchorRows

  const relatedResults = await Promise.all(
    relatedEntityIds.map(relId => this._fetchEntityMemories(relId, opts?.types, 3))
  )

  return [...anchorRows, ...relatedResults.flat()]
}
```

### Step 3 — Helper: `_fetchEntityMemories(entityId, types?, limit)`

Extract the existing query into a private helper so it can be called for both anchor and
related entities:

```typescript
private async _fetchEntityMemories(
  entityId: string,
  types?: MemoryType[],
  limit = 10,
): Promise<MemoryEntry[]> {
  const conditions = [
    eq(memories.entityId, entityId),
    eq(memories.forgotten, false),
    isNull(memories.tInvalid),
  ]
  if (types && types.length > 0) {
    conditions.push(inArray(memories.type, types))
  }
  const rows = await this.db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.baseImportance), desc(memories.createdAt))
    .limit(limit)
  return rows.map(mapMemoryRow)
}
```

Note: existing implementation uses `desc(memories.lastAccessedAt)` as secondary sort; change to
`desc(memories.createdAt)` for consistency with spec. Both are acceptable — implementer may keep
`lastAccessedAt` if preferred.

### Step 4 — Helper: `extractRelatedEntityIds(memories, maxRelated)`

Parse anchor semantic memories to find `related_to` links:

```typescript
function extractRelatedEntityIds(entries: MemoryEntry[], maxRelated: number): string[] {
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.type !== 'semantic') continue
    try {
      const parsed = JSON.parse(entry.content)
      if (parsed && typeof parsed.related_to === 'object' && parsed.related_to.related_entity_id) {
        ids.push(parsed.related_to.related_entity_id as string)
      }
    } catch {
      // not JSON — skip silently
    }
    if (ids.length >= maxRelated) break
  }
  return [...new Set(ids)]  // deduplicate
}
```

Alternative: also accept `related_entity_id` as a top-level key. Implementation may support
both patterns. Whichever pattern is chosen, document it clearly in code comments.

### Step 5 — Unit tests (`src/workspace/index.test.ts`)

Five scenarios (V1–V5), using an in-memory postgres (pg-mem or real test DB per existing test
setup). See quickstart.md for scenarios.

## Non-Goals

- No pgvector expansion (that is Feature 017)
- No recursive depth (max 2 is enforced by clamp)
- No change to `searchMemory` signature
- No migration needed (schema unchanged)

## Risk: existing `getEntityContext` callers

The existing method signature in `ICognitiveWorkspace` does NOT have `depth`. Any callers that
destructure opts would be unaffected (new optional field). Zero breaking changes.
