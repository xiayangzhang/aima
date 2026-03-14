# src/types

Canonical type definitions for all AIMA modules. All other modules import from here — types are never re-defined elsewhere.

## Primitive Types

```typescript
type BrainType = 'limbic' | 'cortex' | 'brainstem' | 'amygdala' | 'dmn'
type CognitiveBrainType = 'limbic' | 'cortex' | 'brainstem'  // only these run via BrainAdapter
type ThreadState = 'active' | 'waiting' | 'complete' | 'interrupted'
type SlotStatus = 'pending' | 'running' | 'done' | 'error'
type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'working' | 'implicit'
type UsageOutcome = 'positive' | 'negative' | 'neutral'
```

## Entity Types

- `Thread` — `{ id, state, sourceChannel, initiatedBy, trigger, entityId, goal, createdAt, updatedAt }`
- `Slot` — `{ id, threadId, brain, status, input, output, executionSessionId, createdAt, updatedAt }`
- `MemoryEntry` — full memory record including `tInvalid`, `forgotten`, `usageOutcomes`, `baseImportance`
- `PendingObservation` — scheduled DMN work item, may reference a `threadId` for DEFER recovery

## BrainOutput

Unified output structure written by brains to their slot:

```typescript
interface BrainOutput {
  next?: CognitiveBrainType | 'self' | null  // routing target; null = thread ends
  reply?: string                              // outbound message to human
  handoff?: string                            // context passed to next brain's input
}
```

`next: 'self'` = DEFER (Limbic only). `next: null | undefined` = thread complete.

## ICognitiveWorkspace

Full interface for `CognitiveWorkspace`. Defines the contract that `src/workspace/` implements and test mocks must satisfy.

## Input Types

- `CreateThreadParams` — `{ trigger?, entityId?, initiatedBy, sourceChannel?, goal? }`
- `WriteSlotParams` — `{ status?, input?, output?, executionSessionId? }`
- `CreateMemoryParams` — all fields for `writeMemory()`
- `MemorySearchFilters` — all filter options for `searchMemory()`
- `CreatePendingParams` — for `writePending()`

## Dependency Rule

`src/types/` has no imports from other `src/` modules. It is the dependency root — all other modules may import from here, never the reverse.
