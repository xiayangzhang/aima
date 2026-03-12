# Feature 021 — Hippocampus Segment Retrieval

## Status: draft

## Background

Hippocampus consolidation (DMN) needs to replay episodic memories in segment order to identify
cross-segment patterns. The current consolidation loop processes memories one at a time; the
planned segment-based replay approach requires two retrieval primitives:

1. Given a segment ID, fetch the full ordered event sequence for that segment.
2. Given a time range, discover which segments exist and rank them by priority (importance × recency).

The `memories` table already has `segment_id text` and `segment_seq integer` columns.
`CognitiveWorkspace` already implements both methods. This feature adds them to the
`ICognitiveWorkspace` interface so they become part of the public contract and are available
to any workspace consumer (consolidation, tests, future adapters).

## User Stories

### US-1 — Get segment sequence

As Hippocampus consolidation,
I want to call `getSegmentSequence(segmentId)` and receive all episodic memories for that segment
ordered by `segment_seq ASC`,
so that I can replay the event sequence for pattern extraction.

**Acceptance criteria:**
- Returns only episodic memories with the matching `segment_id`.
- Excludes soft-deleted (`t_invalid IS NOT NULL`) and forgotten (`forgotten = true`) entries.
- Orders results by `segment_seq ASC NULLS LAST`, then `created_at ASC` as tiebreaker.
- Returns an empty array when no matching memories exist.

### US-2 — Discover segments in a time range

As Hippocampus consolidation,
I want to call `getSegmentsByTimeRange({ from, to })` and receive a ranked list of segments,
so that I can prioritise which segments to replay during a consolidation cycle.

**Acceptance criteria:**
- Returns one entry per distinct `segment_id` where at least one episodic memory has
  `created_at >= from AND created_at < to` and is active (not soft-deleted, not forgotten).
- Each entry contains: `segmentId`, `eventCount`, `avgImportance`, `maxCreatedAt`.
- Default ordering: `avgImportance DESC`, then `maxCreatedAt DESC`.
- Returns an empty array when no segments exist in the range.

## Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | `ICognitiveWorkspace` MUST declare `getSegmentSequence(segmentId: string): Promise<MemoryEntry[]>` |
| FR-2 | `ICognitiveWorkspace` MUST declare `getSegmentsByTimeRange(range: { from: Date; to: Date }): Promise<Array<{ segmentId: string; eventCount: number; avgImportance: number; maxCreatedAt: Date }>>` |
| FR-3 | `CognitiveWorkspace` implementation of `getSegmentSequence` MUST apply the `activeMemory()` filter and order by `segment_seq ASC, created_at ASC` |
| FR-4 | `CognitiveWorkspace` implementation of `getSegmentsByTimeRange` MUST group by `segment_id`, aggregate count/avg/max, filter to episodic active memories in `[from, to)`, and order by `avgImportance DESC, maxCreatedAt DESC` |

## Out of Scope

- Changes to Hippocampus consolidation logic (separate feature).
- Vector/semantic similarity on segment content.
- Pagination of results.

## Success Criteria

- `ICognitiveWorkspace` interface updated with both method signatures — no compilation errors.
- `CognitiveWorkspace` already implements both methods; verify signatures match the interface.
- Unit tests V1–V5 pass (see quickstart.md).
- No regression in existing workspace tests.
