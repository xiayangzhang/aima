import { describe, expect, mock, test } from 'bun:test'
import { getEventBus } from '../../src/eventbus/index'
import { AIMAInstance } from '../../src/instance'

// biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
type AnyInstance = Record<string, any>

function makeInstance(overrides: Record<string, unknown> = {}): AIMAInstance {
  return new AIMAInstance({
    databaseUrl: 'postgresql://localhost/test',
    adapter: 'claude-sdk',
    ...overrides,
  })
}

describe('spawnSubExecution — _subQueryFn escape hatch', () => {
  test('T1: _subQueryFn is called with taskDescription and resolved model', async () => {
    const queryFn = mock(() => Promise.resolve('test result'))
    const instance = makeInstance({ _subQueryFn: queryFn })

    const result = await (instance as unknown as AnyInstance).spawnSubExecution({
      taskDescription: 'do something',
    })

    expect(queryFn).toHaveBeenCalledWith('do something', expect.any(String))
    expect(result.result).toBe('test result')
  })

  test('T2: brain.activate and brain.complete events are emitted', async () => {
    const eventBus = getEventBus()
    const emittedEvents: unknown[] = []
    const unsub = eventBus.subscribe((e) => emittedEvents.push(e))

    const queryFn = mock(() => Promise.resolve('ok'))
    const instance = makeInstance({ _subQueryFn: queryFn })

    await (instance as unknown as AnyInstance).spawnSubExecution({ taskDescription: 'task' })

    unsub()

    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        event_type: 'brain.activate',
        payload: expect.objectContaining({ isSubExecution: true }),
      }),
    )
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        event_type: 'brain.complete',
        payload: expect.objectContaining({ isSubExecution: true }),
      }),
    )
  })

  test('T3: return value contains executionSessionId (UUID) and result string', async () => {
    const queryFn = mock(() => Promise.resolve('some output'))
    const instance = makeInstance({
      _subQueryFn: queryFn,
      executionModel: 'claude-haiku-4-5-20251001',
    })

    const result = await (instance as unknown as AnyInstance).spawnSubExecution({
      taskDescription: 'task',
      model: 'claude-haiku-4-5-20251001',
    })

    expect(result.executionSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(typeof result.result).toBe('string')
    expect(result.result).toBe('some output')
  })

  test('T4: executionModel config is passed to queryFn as model', async () => {
    const queryFn = mock(() => Promise.resolve('ok'))
    const instance = makeInstance({
      _subQueryFn: queryFn,
      executionModel: 'claude-opus-4-6',
    })

    await (instance as unknown as AnyInstance).spawnSubExecution({ taskDescription: 'task' })

    expect(queryFn).toHaveBeenCalledWith('task', 'claude-opus-4-6')
  })

  test('T5: model param overrides executionModel config', async () => {
    const queryFn = mock(() => Promise.resolve('ok'))
    const instance = makeInstance({
      _subQueryFn: queryFn,
      executionModel: 'claude-opus-4-6',
    })

    await (instance as unknown as AnyInstance).spawnSubExecution({
      taskDescription: 'task',
      model: 'claude-haiku-4-5-20251001',
    })

    expect(queryFn).toHaveBeenCalledWith('task', 'claude-haiku-4-5-20251001')
  })
})
