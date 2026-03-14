# src/workspace

`CognitiveWorkspace` — PostgreSQL DAO layer plus in-memory signal and notification systems. Implements `ICognitiveWorkspace` (defined in `src/types/`).

## Thread Operations

- `createThread(params)` — inserts row, returns `Thread`
- `getThread(id)` — returns `Thread | null`
- `updateThreadState(id, state)` — sets state column
- `reopenThread(id, trigger)` — sets state = `'active'`, updates trigger text
- `getActiveThreads()` — state = `'active'` only
- `getWaitingThreads()` — state = `'waiting'`

## Slot Operations

- `writeSlot(threadId, brain, data)` — upsert by (threadId, brain)
- `readSlot(threadId, brain)` — returns `Slot | null`
- `getSlotsByThread(threadId)` — returns all slots for a thread

## Memory Operations

- `writeMemory(params)` — insert; if `supersedesId` set, invalidates old record atomically in a transaction
- `searchMemory(filters)` — vector cosine search (pgvector) or ILIKE fallback; respects `activeMemory()` filter
- `markMemoryUsed(ids, outcome)` — increments usage_outcomes counter
- `clearWorkingMemory(threadId)` — deletes working memories for a thread on completion
- `invalidateMemory(id)` — sets `tInvalid = now()`
- `getEntityContext(entityId, opts)` — semantic memories for entity + related entities (depth 1–2)
- `findSimilarSituations(situation, opts)` — returns `{ episodes, procedures, facts }`
- `getProcedure(taskType, opts)` — procedural memories matching taskType tag
- `getByTags(tags, timeRange, limit)` — AND match: entry must have ALL specified tags

## Active Memory Filter

`activeMemory()` = `tInvalid IS NULL AND forgotten = false`. Every query over the memories table must apply this filter. Two soft-delete paths:
- `tInvalid` — set by supersession or explicit invalidation
- `forgotten` — set by Hippocampus expiry cleanup

## Signal System (in-memory, not persisted)

Keyed by `${type}:${threadId}`. FIFO queue per key.

- `pushSignal(signal)` — appends to queue
- `popSignal(type, threadId)` — removes and returns head, or `undefined`
- `hasSignal(type, threadId)` — non-destructive check

Used for `amygdala_interrupt` and `dmn_correction` delivery between adapter activations.

## Notification System (in-memory EventEmitter)

- `notifySlotDone(threadId, brain, slotStatus)` → triggers `ThreadRunner.route()`
- `notifyThreadComplete(threadId)` → resolves `waitForComplete()` promises
- `onSlotChange(handler)` → returns unsubscribe fn
- `onThreadComplete(handler)` → returns unsubscribe fn
- `waitForComplete(threadId)` → Promise; checks current state first, then waits for notification

## Dependencies

- `src/schema/` — Drizzle table definitions
- `src/types/` — all entity types and interfaces
- `src/adapters/` — `BrainSignal`, `BrainSignalType`
- `src/embedding/` — `generateEmbedding` for pgvector search
