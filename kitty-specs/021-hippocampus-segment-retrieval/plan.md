# Implementation Plan: Hippocampus Segment Retrieval

**Branch**: `021-hippocampus-segment-retrieval` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

## Summary

Add `getSegmentSequence()` and `getSegmentsByTimeRange()` to the `ICognitiveWorkspace` interface.
Both methods are already implemented in `CognitiveWorkspace`; this feature exposes them as part of
the public contract so all workspace consumers (consolidation, tests, adapters) can depend on them.

## Technical Context

**Language/Version**: TypeScript 5.x (Node 22)
**Primary Dependencies**: Drizzle ORM, postgres.js
**Storage**: PostgreSQL — `memories` table with `segment_id text`, `segment_seq integer` columns
**Testing**: Vitest with in-memory postgres (pg-mem or test container per existing pattern)
**Target Platform**: Node.js server (AKS)
**Performance Goals**: Both queries use existing `idx_memories_segment_id` index; no new indexes needed
**Constraints**: Must not break existing `ICognitiveWorkspace` consumers

## Project Structure

```
src/
├── types/index.ts           — ICognitiveWorkspace interface (add two method signatures)
└── workspace/index.ts       — CognitiveWorkspace implementation (already done; verify signatures)

src/tests/ or tests/
└── workspace/               — unit tests for both new methods (V1–V5)
```

## Implementation Notes

### getSegmentSequence

Already implemented in `CognitiveWorkspace` (lines 531–538 of `src/workspace/index.ts`):

```typescript
async getSegmentSequence(segmentId: string): Promise<MemoryEntry[]> {
  const rows = await this.db
    .select()
    .from(memories)
    .where(and(eq(memories.segmentId, segmentId), activeMemory()))
    .orderBy(asc(memories.segmentSeq), asc(memories.createdAt))
  return rows.map(mapMemoryRow)
}
```

The `activeMemory()` helper applies `t_invalid IS NULL AND forgotten = false`.
`asc(memories.segmentSeq)` naturally places NULLs last in ascending order in PostgreSQL.

### getSegmentsByTimeRange

Already implemented in `CognitiveWorkspace` (lines 494–528 of `src/workspace/index.ts`):

```typescript
async getSegmentsByTimeRange(range: { from: Date; to: Date }): Promise<
  { segmentId: string; eventCount: number; avgImportance: number; maxCreatedAt: Date }[]
> {
  const rows = await this.db
    .select({
      segmentId: memories.segmentId,
      eventCount: count(memories.id),
      avgImportance: avg(memories.baseImportance),
      maxCreatedAt: max(memories.createdAt),
    })
    .from(memories)
    .where(
      and(
        eq(memories.type, 'episodic'),
        isNotNull(memories.segmentId),
        activeMemory(),
        gte(memories.createdAt, range.from),
        lt(memories.createdAt, range.to),
      ),
    )
    .groupBy(memories.segmentId)
  return rows
    .filter((r) => r.segmentId !== null)
    .map((r) => ({
      segmentId: r.segmentId as string,
      eventCount: Number(r.eventCount),
      avgImportance: Number(r.avgImportance ?? 0.5),
      maxCreatedAt: r.maxCreatedAt ?? new Date(),
    }))
}
```

Note: The implementation uses Drizzle's native `count()`, `avg()`, `max()` aggregates — no raw
`sql` template needed. The `[from, to)` range is half-open: `gte(from)` + `lt(to)`.

The return type uses `maxCreatedAt` (not `latestAt`). The interface declaration must match.

### Interface change

Add to the `// ── DMN Segment Tracking` section of `ICognitiveWorkspace` in `src/types/index.ts`:

```typescript
getSegmentSequence(segmentId: string): Promise<MemoryEntry[]>
getSegmentsByTimeRange(
  range: { from: Date; to: Date }
): Promise<Array<{ segmentId: string; eventCount: number; avgImportance: number; maxCreatedAt: Date }>>
```

No changes to `CognitiveWorkspace` implementation required — signatures already match.
