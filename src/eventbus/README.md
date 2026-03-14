# src/eventbus

`BrainEventBus` — process-level typed event bus. Single source of truth for all observable activity in an AIMA process.

## Singleton

```typescript
getEventBus(): BrainEventBus
```

Returns the process-level singleton. All modules that emit or subscribe use this function. Do not instantiate `BrainEventBus` directly in application code.

## Emit

```typescript
bus.emit({
  event_type: string    // e.g. 'brain.activate', 'tool.pre_use', 'thread.complete'
  level: EventLevel     // 'TRACE' | 'DEBUG' | 'INFO' | 'COMPLIANCE' | 'ALERT'
  brain: BrainType
  thread_id?: string | null
  session_id?: string | null
  causation_id?: string | null
  payload?: Record<string, unknown>
})
```

Returns the full `BrainEvent` with auto-generated `event_id`, `occurred_at`, and `schema_version: '1.0'`.

## Subscribe

- `subscribe(handler)` → unsubscribe fn — all events
- `subscribeLevel(minLevel, handler)` → unsubscribe fn — events at or above level
- `subscribeBrain(brain, handler)` → unsubscribe fn — events from a specific brain

All return an unsubscribe function. Call it to stop receiving events.

## Standard Event Types

| event_type | Emitter | Description |
|------------|---------|-------------|
| `brain.activate` | ThreadRunner | Brain activation starts |
| `brain.complete` | ThreadRunner | Brain activation ends |
| `brain.loop_end` | Adapters | LLM turn ends (pi-agent) |
| `thread.complete` | ThreadRunner | Thread reached terminal state |
| `thread.interrupted` | ThreadRunner | Thread aborted (illegal transition or signal) |
| `thread.reply` | ThreadRunner | Brain emitted a reply text |
| `tool.pre_use` | Adapters / Extension | Tool about to execute |
| `tool.post_use` | Adapters / Extension | Tool finished |
| `tool.blocked` | Amygdala / Extension | Tool vetoed by Amygdala |
| `tool.escalation` | Amygdala | Tool flagged for review |

## BrainEvent Structure

```typescript
interface BrainEvent {
  event_id: string          // UUID
  event_type: string
  level: EventLevel
  occurred_at: Date
  brain: BrainType
  thread_id: string | null
  session_id: string | null
  causation_id: string | null   // null = chain origin
  schema_version: string        // '1.0'
  payload: Record<string, unknown>
}
```

## Dependencies

- `src/adapters/` — `BrainEvent`, `EventLevel` types defined here (imported by eventbus)
- `src/types/` — `BrainType`
