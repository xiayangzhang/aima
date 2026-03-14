# src/dmn

Default Mode Network — background reflection layer. Conceptually one brain area, engineered as two independent running units.

## DmnService

Wrapper that starts/stops both units together.

- `start()` — starts Reactive worker and Consolidation scheduler
- `stop()` — stops both

## DmnReactive (`src/dmn/reactive/`)

Event-driven observation capture. Subscribes to the EventBus and writes `pending_observations` for events that warrant cross-thread attention. Runs in near-real-time alongside active brain processing.

- Listens for `thread.complete`, `brain.complete`, and other INFO/ALERT events
- For notable events: calls `workspace.writePending()` to schedule a DMN consolidation pass
- Has direct DB read access to observe cross-thread patterns (unlike active brains which are thread-scoped)
- Does NOT have a persistent LLM session — any LLM calls are one-off, no conversation history

## DmnConsolidation (`src/dmn/consolidation/`)

Background batch processor. Runs on a configurable interval (`consolidationIntervalMs`). Processes pending observations, performs memory refinement, and writes back to workspace.

- Reads pending observations from workspace
- May call LLM once per consolidation run to synthesize patterns
- Writes new memories (semantic, episodic, procedural) based on observations
- Deletes processed pending observations

## Eventual Consistency

Reactive captures events promptly. Consolidation converges them on a schedule. The two units are loosely coupled — Reactive writes pending observations, Consolidation reads and acts on them. Final consistency, not strong consistency.

## Config

```typescript
interface DmnConfig {
  workspace: CognitiveWorkspace
  eventBus: BrainEventBus
  llm: DmnLlmConfig
  consolidationIntervalMs?: number  // default 60_000
  maxRetries?: number
}
```

## Dependencies

- `src/workspace/` — pending observations, memory write
- `src/eventbus/` — Reactive subscribes to all events
- `src/llm/` — Consolidation LLM calls
