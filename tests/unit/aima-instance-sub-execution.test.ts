import { describe, expect, test } from 'bun:test'
import type { BrainEvent } from '../../src/adapters/index'
import { getEventBus } from '../../src/eventbus/index'
import { AIMAInstance } from '../../src/instance'

// Regex for UUID v4 format
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const BASE_CONFIG = {
  databaseUrl: 'postgresql://localhost/test',
  adapter: 'claude-sdk' as const,
  apiKey: 'sk-test-unit',
}

describe('AIMAInstance — spawnSubExecution', () => {
  test('executionSessionId is a valid UUID', async () => {
    const instance = new AIMAInstance({
      ...BASE_CONFIG,
      _subQueryFn: async () => 'mock result',
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit testing
    const result = await (instance as any).spawnSubExecution({ taskDescription: 'test task' })

    expect(UUID_RE.test(result.executionSessionId)).toBe(true)
    expect(result.result).toBe('mock result')
  })

  test('uses params.model when provided (highest priority)', async () => {
    let capturedModel: string | undefined

    const instance = new AIMAInstance({
      ...BASE_CONFIG,
      executionModel: 'claude-opus-4-6',
      _subQueryFn: async (_prompt, model) => {
        capturedModel = model
        return 'result'
      },
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method
    await (instance as any).spawnSubExecution({
      taskDescription: 'task',
      model: 'claude-haiku-4-5-20251001',
    })

    expect(capturedModel).toBe('claude-haiku-4-5-20251001')
  })

  test('uses executionModel config when params.model absent', async () => {
    let capturedModel: string | undefined

    const instance = new AIMAInstance({
      ...BASE_CONFIG,
      executionModel: 'claude-opus-4-6',
      _subQueryFn: async (_prompt, model) => {
        capturedModel = model
        return 'result'
      },
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method
    await (instance as any).spawnSubExecution({ taskDescription: 'task' })

    expect(capturedModel).toBe('claude-opus-4-6')
  })

  test('falls back to claude-sonnet-4-6 when neither model param nor executionModel set', async () => {
    let capturedModel: string | undefined

    const instance = new AIMAInstance({
      ...BASE_CONFIG,
      _subQueryFn: async (_prompt, model) => {
        capturedModel = model
        return 'result'
      },
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method
    await (instance as any).spawnSubExecution({ taskDescription: 'task' })

    expect(capturedModel).toBe('claude-sonnet-4-6')
  })

  test('emits brain.activate and brain.complete events with isSubExecution: true', async () => {
    const eventBus = getEventBus()
    const events: BrainEvent[] = []
    const unsub = eventBus.subscribe((e) => events.push(e))

    const instance = new AIMAInstance({
      ...BASE_CONFIG,
      _subQueryFn: async () => 'result',
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method
    await (instance as any).spawnSubExecution({ taskDescription: 'emit test' })

    unsub()

    const activateEvt = events.find(
      (e) => e.event_type === 'brain.activate' && e.brain === 'brainstem',
    )
    const completeEvt = events.find(
      (e) => e.event_type === 'brain.complete' && e.brain === 'brainstem',
    )

    expect(activateEvt).toBeDefined()
    expect(activateEvt?.payload.isSubExecution).toBe(true)

    expect(completeEvt).toBeDefined()
    expect(completeEvt?.payload.isSubExecution).toBe(true)
    expect(typeof completeEvt?.payload.executionSessionId).toBe('string')
  })

  test('sub-execution session_id differs from main brainstem session key format', async () => {
    const eventBus = getEventBus()
    const events: BrainEvent[] = []
    const unsub = eventBus.subscribe((e) => events.push(e))

    const instance = new AIMAInstance({
      ...BASE_CONFIG,
      _subQueryFn: async () => 'result',
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method
    const result = await (instance as any).spawnSubExecution({ taskDescription: 'isolation test' })

    unsub()

    const activateEvt = events.find(
      (e) => e.event_type === 'brain.activate' && e.brain === 'brainstem',
    )

    // Sub-execution session_id must be a UUID, NOT `brainstem:${threadId}` format
    expect(activateEvt?.session_id).toBe(result.executionSessionId)
    expect(activateEvt?.session_id).not.toContain('brainstem:')
    expect(UUID_RE.test(activateEvt?.session_id ?? '')).toBe(true)
  })
})
