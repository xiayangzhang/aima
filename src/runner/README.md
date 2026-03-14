# src/runner

`ThreadRunner` — the cognitive routing state machine. Receives slot-done notifications from the workspace and drives brain activations iteratively until a thread reaches a terminal state.

## Key Methods

- `start()` — subscribes to workspace slot/thread events, runs `recoverInFlightThreads()`
- `stop()` — unsubscribes all listeners
- `trigger(brain, threadId)` — external entry point (called by `AIMAInstance.receive()`); activates a brain outside the routing loop
- `updateAssemblerConfig(config)` — rebuilds Block 1+2 cache; called after identity reload
- `resetSessions(threadId)` — clears brain sessions for one thread in both `brainSessions` map and adapter
- `resetAllSessions()` — clears all sessions across all brains

## Routing Loop

`route(event)` is called on every `slot_change` notification with `slotStatus === 'done'`. It:

1. Checks `processingThreads` to prevent re-entrancy — skips if already routing this thread
2. Reads current thread state and slot outputs from workspace
3. Reads `output.next` from the completed brain's slot
4. Validates against the legal transition table
5. If `next === null` → marks thread complete, clears working memory, notifies workspace
6. If `next === 'self'` → DEFER (Limbic only): writes to `pending_observations`, sets thread to `waiting`
7. Otherwise → passes handoff to next brain's input slot, activates next brain
8. Loops back to step 2 with `currentBrain = nextBrain`

The loop is **iterative, not recursive** — `activateBrain()` fires `notifySlotDone()` internally, but the re-entrancy guard drops those nested calls. The outer loop handles them in the next iteration.

## Legal Transitions

```
limbic    → cortex | brainstem | self | null
cortex    → limbic | brainstem | null
brainstem → limbic | cortex | null
```

Illegal transitions set thread state to `interrupted` and emit `thread.interrupted` ALERT.

## Session Management

`brainSessions: Map<string, string>` stores `${brain}:${threadId}` → `sessionId`. An entry present = subsequent activation (no `initialPrompt` sent to adapter). An entry absent = first activation (`initialPrompt` = `thread.trigger`).

## Block Caching

`cachedBlock12` holds pre-assembled Block 1+2 strings per brain. Built at construction and on `updateAssemblerConfig()`. Must be byte-identical across activations for prompt cache hits.

## Crash Recovery

`recoverInFlightThreads()` on `start()`:
- Active threads with no done slots → re-activate Limbic
- Active threads with done slots → re-route from last done slot
- Waiting threads with no live pending observation → interrupt (stuck)

## Dependencies

- `src/adapters/` — `BrainAdapter` per brain
- `src/context/` — `assembleBlock12`, `assembleContext`
- `src/workspace/` — slot/thread read/write/notification
- `src/eventbus/` — emits `brain.activate`, `brain.complete`, `thread.complete`, `thread.interrupted`
