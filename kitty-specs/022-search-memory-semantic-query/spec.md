# Feature 022 — searchMemory Semantic Query Upgrade

## Status: merged

## Background

`searchMemory()` is the generic memory lookup API on `ICognitiveWorkspace`. It supports structured
filters (type, tags, entityId, segmentId, excludeInvalid, createdAfter, limit) but has no
text-based search capability. Any caller that wants to search by content must use the specialized
`findSimilarSituations()` or `getProcedure()` methods, which are purpose-built for specific use
cases and do not accept the full filter set.

The vector search infrastructure is already in place: `memories.embedding` is a `vector(1536)` column
with an HNSW index, `generateEmbedding()` exists in `src/embedding.ts`, and the pattern for
vector-first + ILIKE fallback is established in `findSimilarSituations()` and `getProcedure()`.
This feature threads that same pattern through `searchMemory()` via an optional `query` field.

## User Stories

### US-1 — Semantic query on generic search

As any brain or caller,
I want to call `searchMemory({ query: 'some text', type: 'semantic', tags: ['policy'] })` and
receive results ranked by semantic similarity to the query string,
so that I can retrieve relevant memories without knowing which specialised method to call.

**Acceptance criteria:**
- When `query` is provided and `embedding` config is present, results are ordered by cosine distance.
- All other filters (type, tags, entityId, segmentId, excludeInvalid, createdAfter, limit) remain
  active as WHERE conditions.
- Only memories that have an `embedding` value are included in the vector result set.
- If vector search returns results, they are returned immediately.

### US-2 — ILIKE fallback when embedding is not configured

As a caller running without an embedding provider,
I want `searchMemory({ query: 'some text' })` to fall back to ILIKE content matching,
so that text search works even in environments without an embedding API.

**Acceptance criteria:**
- When `query` is provided and `embedding` config is absent, ILIKE is used.
- When vector search returns zero results, ILIKE fallback is used.
- When `generateEmbedding()` throws, ILIKE fallback is used silently (no error propagation).

### US-3 — No regression when query is absent

As any existing caller,
I want `searchMemory()` calls without a `query` field to behave exactly as before,
so that existing code is unaffected by this change.

**Acceptance criteria:**
- `searchMemory({})` and `searchMemory({ type: 'semantic' })` etc. behave identically to current.
- `generateEmbedding()` is never called when `query` is undefined.

## Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | `MemorySearchFilters` MUST add `query?: string` field |
| FR-2 | `searchMemory()` MUST use vector path when `query` is defined AND `embedding` config is set |
| FR-3 | Vector path MUST apply all other filters as WHERE conditions (not just embedding ordering) |
| FR-4 | Vector path MUST include `isNotNull(memories.embedding)` guard |
| FR-5 | Vector path MUST fall through to ILIKE when it returns zero results |
| FR-6 | Vector path MUST fall through to ILIKE when `generateEmbedding()` throws |
| FR-7 | ILIKE fallback MUST add `ilike(memories.content, '%query%')` to existing WHERE conditions |
| FR-8 | When `query` is undefined, behavior MUST be identical to current implementation |

## Out of Scope

- Changes to `findSimilarSituations()` or `getProcedure()`.
- Pagination of results beyond the existing `limit` field.
- Score/distance value in the returned `MemoryEntry` objects.
- Adding `query` to `ICognitiveWorkspace.searchMemory()` return type.

## Success Criteria

- `MemorySearchFilters` interface updated with `query?: string` — no compilation errors.
- `searchMemory()` upgraded with vector + ILIKE logic following the established pattern.
- Unit tests V1–V6 pass (see WP01).
- Zero regression in existing `searchMemory` tests.
- `bun tsc --noEmit` exits cleanly.
