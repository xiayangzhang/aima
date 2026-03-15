import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { BrainEvent, EventLevel } from '../adapters/index'
import type { BrainType } from '../types/index'

// ─── BrainEventBus ────────────────────────────────────────────────────────────

type EmitParams = {
  event_type: string
  level: EventLevel
  brain: BrainType
  thread_id?: string | null
  session_id?: string | null
  causation_id?: string | null
  payload?: Record<string, unknown>
}

export class BrainEventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  emit(params: EmitParams): BrainEvent {
    const event: BrainEvent = {
      event_id: randomUUID(),
      event_type: params.event_type,
      level: params.level,
      occurred_at: new Date(),
      brain: params.brain,
      thread_id: params.thread_id ?? null,
      session_id: params.session_id ?? null,
      causation_id: params.causation_id ?? null,
      schema_version: '1.1',
      payload: params.payload ?? {},
    }
    this.emitter.emit('event', event)
    this.emitter.emit(`level:${event.level}`, event)
    this.emitter.emit(`brain:${event.brain}`, event)
    return event
  }

  // Subscribe to all events; returns unsubscribe function
  subscribe(handler: (event: BrainEvent) => void): () => void {
    this.emitter.on('event', handler)
    return () => {
      this.emitter.off('event', handler)
    }
  }

  // Subscribe to events at or above a minimum level
  subscribeLevel(minLevel: EventLevel, handler: (event: BrainEvent) => void): () => void {
    const levels: EventLevel[] = ['TRACE', 'DEBUG', 'INFO', 'COMPLIANCE', 'ALERT']
    const minIdx = levels.indexOf(minLevel)
    const relevant = new Set(levels.slice(minIdx))
    const wrapped = (event: BrainEvent) => {
      if (relevant.has(event.level)) handler(event)
    }
    this.emitter.on('event', wrapped)
    return () => {
      this.emitter.off('event', wrapped)
    }
  }

  // Subscribe to events from a specific brain
  subscribeBrain(brain: BrainType, handler: (event: BrainEvent) => void): () => void {
    this.emitter.on(`brain:${brain}`, handler)
    return () => {
      this.emitter.off(`brain:${brain}`, handler)
    }
  }
}

// ─── Process-level singleton ──────────────────────────────────────────────────

let _bus: BrainEventBus | null = null

export function getEventBus(): BrainEventBus {
  if (!_bus) _bus = new BrainEventBus()
  return _bus
}
