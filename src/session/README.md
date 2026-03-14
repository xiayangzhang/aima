# src/session

High-level session API. Primary entry point for external consumers. Drop-in compatible with pi-coding-agent's `createAgentSession()` interaction model.

## Exports

- `createAIMASession(options)` — async factory, returns `AIMASession`
- `AIMASession` — session class
- `CreateAIMASessionOptions` — config interface
- `PromptResult` — `{ threadId, reply, finalState, slots }`
- `AIMASessionEvent` / `AIMASessionEventListener` — typed event stream

## AIMASession Methods

| Method | Behaviour |
|--------|-----------|
| `prompt(text)` | Fire-and-forget. Creates Thread, triggers Limbic, returns `threadId` immediately. |
| `promptAndWait(text)` | Blocks until thread reaches `complete` or `interrupted`. Returns `PromptResult`. |
| `continue(text)` | Fire-and-forget continue on `_currentThreadId`. |
| `continueAndWait(text)` | Blocking continue. |
| `steer(text)` | Calls `instance.injectToThread(threadId, 'amygdala_interrupt', text)` on all adapters. No-op if no active thread. |
| `followUp(text)` | Appends to `_followUpQueue`. Consumed after current thread completes. |
| `newThread()` | Calls `instance.resetBrainSessions()` (no threadId arg = reset all). Clears `_currentThreadId` and `_followUpQueue`. Does NOT touch DB records. |
| `abort()` | Calls `resetBrainSessions()`, clears state. |
| `subscribe(fn)` | Returns unsubscribe fn. Listener errors are swallowed. |
| `getThread/getSlots/getSlot` | Workspace queries. Default to `_currentThreadId`. |
| `reloadIdentity()` | Delegates to `instance.reloadIdentity()`. |
| `dispose()` | Calls `instance.stop()`, clears listeners. |

## Internal State

- `_currentThreadId` — set by `prompt()`, cleared by `newThread()` / `abort()`
- `_isProcessing` — true while a thread is running
- `_followUpQueue` — string[], consumed in `_onThreadEnd()`
- `_waiters` — `Map<threadId, { resolve, reply, state }>` — resolves `promptAndWait` / `continueAndWait`
- `_eventBusUnsub` — unsubscribes from the process-level EventBus singleton on `dispose()`

## Event Bridge

Subscribes to `getEventBus()` (process-level singleton). Maps raw `BrainEvent` types to `AIMASessionEvent`:

| BrainEvent | AIMASessionEvent |
|------------|-----------------|
| `brain.activate` | `brain_start` |
| `brain.complete` | `brain_end` |
| `thread.reply` | `reply` (also captured into `_waiters[threadId].reply`) |
| `thread.complete` | `thread_end` → resolves waiter |
| `thread.interrupted` | `thread_end` → resolves waiter |
| `tool.pre_use` | `tool_start` |
| `tool.post_use` | `tool_end` |

Only events for cognitive brains (`limbic` / `cortex` / `brainstem`) are forwarded.

## newThread() vs pi-coding-agent newSession()

`newThread()` resets LLM conversation history only. DB records (Thread, Slot, Memory) are unchanged. The agent retains all accumulated knowledge — only the in-memory adapter session state is wiped.

## Dependencies

- `src/instance.ts` — wraps `AIMAInstance`
- `src/eventbus/` — subscribes to singleton bus
- `src/types/` — `Thread`, `Slot`, `ThreadState`, `CognitiveBrainType`
