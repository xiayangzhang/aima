# Quickstart: Hippocampus Segment Retrieval

## V1 — getSegmentSequence returns ordered events

**Setup**: Insert 3 episodic memories for segment `seg-abc` with `segmentSeq` 2, 0, 1.

**Action**: Call `workspace.getSegmentSequence('seg-abc')`.

**Expected**: Returns all 3 entries in order `segmentSeq` 0, 1, 2.

---

## V2 — getSegmentSequence excludes soft-deleted entries

**Setup**: Insert 3 episodic memories for segment `seg-def`. Soft-delete one by setting `t_invalid`.

**Action**: Call `workspace.getSegmentSequence('seg-def')`.

**Expected**: Returns only the 2 active entries.

---

## V3 — getSegmentSequence returns empty array for unknown segment

**Setup**: No memories exist for segment `seg-unknown`.

**Action**: Call `workspace.getSegmentSequence('seg-unknown')`.

**Expected**: Returns `[]`.

---

## V4 — getSegmentsByTimeRange returns ranked segments

**Setup**: Insert episodic memories for two segments within a time range:
- `seg-high`: 3 events, avgImportance ~0.9
- `seg-low`: 3 events, avgImportance ~0.3

**Action**: Call `workspace.getSegmentsByTimeRange({ from: rangeStart, to: rangeEnd })`.

**Expected**:
- Returns 2 entries.
- `seg-high` comes first (higher avgImportance).
- Each entry has correct `eventCount`, `avgImportance`, `maxCreatedAt`.

---

## V5 — getSegmentsByTimeRange excludes memories outside range

**Setup**: Insert episodic memories for `seg-outside` with `created_at` before `from`.
Insert memories for `seg-inside` within `[from, to)`.

**Action**: Call `workspace.getSegmentsByTimeRange({ from, to })`.

**Expected**: Only `seg-inside` appears in the result; `seg-outside` is absent.
