import { describe, expect, test } from 'bun:test'
import type { BrainEvent } from '../../src/adapters/index'
import { BrainEventBus, getEventBus } from '../../src/eventbus/index'

describe('BrainEventBus', () => {
  test('emit returns a well-formed BrainEvent', () => {
    const bus = new BrainEventBus()
    const event = bus.emit({
      event_type: 'test.event',
      level: 'INFO',
      brain: 'cortex',
      thread_id: 'thread-1',
      payload: { foo: 'bar' },
    })

    expect(event.event_id).toBeString()
    expect(event.event_type).toBe('test.event')
    expect(event.level).toBe('INFO')
    expect(event.brain).toBe('cortex')
    expect(event.thread_id).toBe('thread-1')
    expect(event.session_id).toBeNull()
    expect(event.causation_id).toBeNull()
    expect(event.schema_version).toBe('1.0')
    expect(event.payload).toEqual({ foo: 'bar' })
    expect(event.occurred_at).toBeInstanceOf(Date)
  })

  test('subscribe receives all emitted events', () => {
    const bus = new BrainEventBus()
    const received: BrainEvent[] = []
    const unsub = bus.subscribe((e) => received.push(e))

    bus.emit({ event_type: 'a', level: 'DEBUG', brain: 'limbic' })
    bus.emit({ event_type: 'b', level: 'ALERT', brain: 'brainstem' })

    expect(received).toHaveLength(2)
    unsub()

    bus.emit({ event_type: 'c', level: 'INFO', brain: 'cortex' })
    expect(received).toHaveLength(2) // unsubscribed, no new events
  })

  test('subscribeLevel filters by minimum level', () => {
    const bus = new BrainEventBus()
    const received: BrainEvent[] = []
    const unsub = bus.subscribeLevel('COMPLIANCE', (e) => received.push(e))

    bus.emit({ event_type: 'trace', level: 'TRACE', brain: 'limbic' })
    bus.emit({ event_type: 'debug', level: 'DEBUG', brain: 'limbic' })
    bus.emit({ event_type: 'info', level: 'INFO', brain: 'limbic' })
    bus.emit({ event_type: 'compliance', level: 'COMPLIANCE', brain: 'limbic' })
    bus.emit({ event_type: 'alert', level: 'ALERT', brain: 'limbic' })

    expect(received).toHaveLength(2)
    expect(received[0].event_type).toBe('compliance')
    expect(received[1].event_type).toBe('alert')
    unsub()
  })

  test('subscribeBrain filters by brain', () => {
    const bus = new BrainEventBus()
    const received: BrainEvent[] = []
    const unsub = bus.subscribeBrain('cortex', (e) => received.push(e))

    bus.emit({ event_type: 'a', level: 'INFO', brain: 'limbic' })
    bus.emit({ event_type: 'b', level: 'INFO', brain: 'cortex' })
    bus.emit({ event_type: 'c', level: 'INFO', brain: 'brainstem' })

    expect(received).toHaveLength(1)
    expect(received[0].brain).toBe('cortex')
    unsub()
  })
})

describe('getEventBus', () => {
  test('returns the same instance on repeated calls', () => {
    const a = getEventBus()
    const b = getEventBus()
    expect(a).toBe(b)
  })
})
