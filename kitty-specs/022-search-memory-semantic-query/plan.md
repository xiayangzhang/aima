# Implementation Plan: searchMemory Semantic Query Upgrade

**Branch**: `022-search-memory-semantic-query` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

## Summary

Add `query?: string` to `MemorySearchFilters` and upgrade `searchMemory()` to use the
vector-first + ILIKE-fallback pattern already established by `findSimilarSituations()` and
`getProcedure()`. All existing structured filters continue to apply as WHERE conditions.

## Technical Context

**Language/Version**: TypeScript 5.x (Node 22)
**Primary Dependencies**: Drizzle ORM, drizzle-orm/sql/functions (cosineDistance), postgres.js
**Storage**: PostgreSQL — `memories` table with `embedding vector(1536)` and HNSW index
**Testing**: Bun test + mock DB (following `embedding-search.test.ts` pattern)
**Target Platform**: Node.js server (AKS)
**Constraints**: Must not break any existing caller of `searchMemory()`

## Project Structure

```
src/
├── types/index.ts           — add query?: string to MemorySearchFilters
└── workspace/index.ts       — upgrade searchMemory() with vector + ILIKE logic

tests/unit/workspace/
└── search-memory.test.ts    — new, V1–V6 coverage
```

## Implementation Notes

### T001 — MemorySearchFilters change (src/types/index.ts)

Add one field to the existing interface:

```typescript
export interface MemorySearchFilters {
  type?: MemoryType
  tags?: string[]
  entityId?: string
  segmentId?: string
  excludeInvalid?: boolean
  limit?: number
  createdAfter?: Date
  query?: string   // ← new: text search; vector when embedding configured, ILIKE fallback
}
```

### T002 — searchMemory() upgrade (src/workspace/index.ts)

The current implementation (lines 433–471) builds `conditions[]`, runs a single `select`, and
returns results ordered by `baseImportance DESC`. The upgrade wraps query-aware logic around that
core, following the exact pattern from `findSimilarSituations()` (lines 650–725).

**Pseudocode:**

```typescript
async searchMemory(filters: MemorySearchFilters): Promise<MemoryEntry[]> {
  const conditions: SQL[] = []

  // ... existing filter conditions (type, tags, entityId, segmentId, forgotten, excludeInvalid, createdAfter) ...

  const lim = filters.limit ?? 20

  // ── Vector path ──────────────────────────────────────────────────────────
  if (filters.query != null && this.options.embedding != null) {
    try {
      const queryEmbedding = await generateEmbedding(filters.query, this.options.embedding)

      const rows = await this.db
        .select()
        .from(memories)
        .where(
          and(
            ...conditions,
            isNotNull(memories.embedding),
          ),
        )
        .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
        .limit(lim)

      if (rows.length > 0) {
        return rows.map(mapMemoryRow)
      }
      // zero results → fall through to ILIKE
    } catch {
      // generateEmbedding failed → fall through to ILIKE
    }
  }

  // ── ILIKE fallback (or no-query path) ─────────────────────────────────────
  if (filters.query != null) {
    conditions.push(ilike(memories.content, `%${filters.query}%`))
  }

  const rows = await this.db
    .select()
    .from(memories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(memories.baseImportance))
    .limit(lim)

  return rows.map(mapMemoryRow)
}
```

Key details:
- `isNotNull(memories.embedding)` guard ensures only embedded rows enter cosine ranking.
- All structured filter conditions are reused in the vector WHERE clause — they are built before
  the query branch and shared.
- The `limit` extraction is moved before the vector branch so it can be reused.
- The `and(...conditions)` guard requires at least one condition; the `forgotten = false` push
  ensures `conditions` is never empty.
- Imports already present: `ilike`, `isNotNull`, `asc`, `desc`, `and`, `cosineDistance`,
  `generateEmbedding`.

### T003 — Unit tests (tests/unit/workspace/search-memory.test.ts)

Follow `embedding-search.test.ts` mock pattern exactly:

1. Mock `generateEmbedding` before importing workspace (Bun module mock hoisting).
2. Use `makeSelectDB` helper that returns controlled rows on `.select().from().where().orderBy().limit()`.
3. Each test scenario:

| Test | Setup | Assert |
|------|-------|--------|
| V1 — vector path used | embedding config, `selectRows = [row]` | `generateEmbedding` called once, row returned |
| V2 — vector empty → ILIKE | embedding config, vector returns `[]`, ILIKE returns `[row]` | `generateEmbedding` called once, ILIKE row returned |
| V3 — no embedding config → ILIKE | no embedding config, ILIKE returns `[row]` | `generateEmbedding` NOT called, row returned |
| V4 — no query → unchanged | no query | `generateEmbedding` NOT called, existing filter logic runs |
| V5 — vector throws → ILIKE | `generateEmbedding` throws, ILIKE returns `[row]` | row returned, no error thrown |
| V6 — query + type + tags | embedding config, type='semantic', tags=['policy'], vector returns `[row]` | `generateEmbedding` called once, row returned |

The mock DB for V2 needs two select calls: first returns `[]` (vector path), second returns `[row]`
(ILIKE path). Use a call-index counter in the mock (same approach as `makeSelectRoundRobin` in
`embedding-search.test.ts`).

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `and(...conditions)` breaks if conditions is empty | Very low | `forgotten = false` is always pushed unconditionally |
| Mock DB chain depth mismatch (select/from/where/orderBy/limit) | Low | Copy chain from `embedding-search.test.ts` exactly |
| V2 test mock call ordering | Low | Use `callIndex` counter pattern from `makeSelectRoundRobin` |
