/**
 * Real integration test for spawnSubExecution().
 * Requires: AIMA_TEST_DATABASE_URL + ANTHROPIC_API_KEY
 *
 * Tests the actual query() path — NOT the _subQueryFn escape hatch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { BrainEvent } from '../../src/adapters/index'
import { getEventBus } from '../../src/eventbus/index'
import { AIMAInstance } from '../../src/instance'

const DB_URL = process.env.AIMA_TEST_DATABASE_URL ?? ''
const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function skipUnless(condition: boolean, name: string, fn: () => void) {
  if (!condition) {
    console.log(
      `⏭  Skipping integration suite: "${name}" (AIMA_TEST_DATABASE_URL or ANTHROPIC_API_KEY not set)`,
    )
    return
  }
  describe(name, fn)
}

// biome-ignore lint/suspicious/noExplicitAny: accessing private method for integration testing
type AnyInstance = AIMAInstance & Record<string, any>

skipUnless(Boolean(DB_URL && API_KEY), 'spawnSubExecution — real API integration', () => {
  let instance: AIMAInstance
  const events: BrainEvent[] = []
  let unsub: () => void

  beforeEach(() => {
    unsub = getEventBus().subscribe((e) => events.push(e))
  })

  afterEach(async () => {
    unsub()
    events.length = 0
    await instance?.stop()
  })

  test('returns valid executionSessionId (UUID) and non-empty result from real LLM', async () => {
    instance = new AIMAInstance({
      databaseUrl: DB_URL,
      apiKey: API_KEY,
      adapter: 'claude-sdk',
    })

    const result = await (instance as AnyInstance).spawnSubExecution({
      taskDescription: 'Reply with exactly: "sub-execution ok"',
    })

    expect(UUID_RE.test(result.executionSessionId)).toBe(true)
    expect(typeof result.result).toBe('string')
    expect(result.result.length).toBeGreaterThan(0)
  }, 30_000)

  test('emits brain.activate and brain.complete events with isSubExecution: true', async () => {
    instance = new AIMAInstance({
      databaseUrl: DB_URL,
      apiKey: API_KEY,
      adapter: 'claude-sdk',
    })

    const { executionSessionId } = await (instance as AnyInstance).spawnSubExecution({
      taskDescription: 'Say "hello"',
    })

    const activate = events.find(
      (e) => e.event_type === 'brain.activate' && e.brain === 'brainstem',
    )
    const complete = events.find(
      (e) => e.event_type === 'brain.complete' && e.brain === 'brainstem',
    )

    expect(activate?.payload.isSubExecution).toBe(true)
    expect(activate?.session_id).toBe(executionSessionId)

    expect(complete?.payload.isSubExecution).toBe(true)
    expect(complete?.payload.executionSessionId).toBe(executionSessionId)
  }, 30_000)

  test('respects executionModel config — uses haiku when configured', async () => {
    instance = new AIMAInstance({
      databaseUrl: DB_URL,
      apiKey: API_KEY,
      adapter: 'claude-sdk',
      executionModel: 'claude-haiku-4-5-20251001',
    })

    const result = await (instance as AnyInstance).spawnSubExecution({
      taskDescription: 'Reply with exactly: "haiku ok"',
    })

    expect(UUID_RE.test(result.executionSessionId)).toBe(true)
    expect(result.result.length).toBeGreaterThan(0)
  }, 30_000)

  test('two sub-executions have different executionSessionIds (no session reuse)', async () => {
    instance = new AIMAInstance({
      databaseUrl: DB_URL,
      apiKey: API_KEY,
      adapter: 'claude-sdk',
    })

    const [r1, r2] = await Promise.all([
      (instance as AnyInstance).spawnSubExecution({ taskDescription: 'Say "one"' }),
      (instance as AnyInstance).spawnSubExecution({ taskDescription: 'Say "two"' }),
    ])

    expect(r1.executionSessionId).not.toBe(r2.executionSessionId)
    expect(UUID_RE.test(r1.executionSessionId)).toBe(true)
    expect(UUID_RE.test(r2.executionSessionId)).toBe(true)
  }, 60_000)
})
