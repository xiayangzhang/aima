# src/hippocampus

`HippocampusConsolidation` — scheduled memory consolidation service. Runs four steps in sequence on a configurable schedule.

## Consolidation Steps

1. **Segment refine** — merges adjacent episodic memory entries within the same segment into a coherent summary. Reduces fragmentation from high-frequency episodic writes.

2. **Sequence replay** — regenerates procedural memories from recent episodic sequences. Extracts "how to do X" from "what happened when doing X".

3. **Outcomes converge** — adjusts `baseImportance` scores based on `usage_outcomes` ratios (positive / negative / neutral). Memories with consistently negative outcomes decay; positive ones strengthen.

4. **Expiry cleanup** — soft-deletes memories where `last_accessed_at` exceeds the configured TTL. Sets `forgotten = true` rather than hard-deleting.

## `computeNewImportance(current, outcomes)`

Pure function. Takes current importance (0.0–1.0) and outcome counts, returns adjusted importance. Exported for testing and external use.

## Config

```typescript
interface HippocampusConfig {
  llm: LlmConfig                 // for sequence replay (LLM generates procedural text)
  runAt?: string                 // HH:MM in agent timezone, default '02:00'
  segmentTtlDays?: number        // episodic segment expiry
  memoryTtlDays?: number         // general memory expiry
}
```

## Lifecycle

- `start()` — schedules daily run at `runAt` time
- `stop()` — cancels scheduler
- `runConsolidation()` — can be called manually; runs all four steps sequentially

## Dependencies

- `src/workspace/` — memory read/write for all four steps
- `src/llm/` — LLM call in sequence replay step
