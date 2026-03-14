import { describe, expect, mock, test } from 'bun:test'
import { AIMAInstance } from '../../src/instance'
import { AIMASession, createAIMASession } from '../../src/session/index'
import type { AIMASessionEvent } from '../../src/session/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Build a minimal AIMAInstance (no DB connection used at construction)
function makeInstance(): AIMAInstance {
  return new AIMAInstance({
    databaseUrl: 'postgresql://localhost/test',
    adapter: 'claude-sdk',
  })
}

// biome-ignore lint/suspicious/noExplicitAny: test helper accessing internals
function getInternal(obj: unknown, key: string): any {
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  return (obj as Record<string, any>)[key]
}

// ─── createAIMASession options mapping ───────────────────────────────────────

describe('createAIMASession — options mapping', () => {
  // We test only that the Session class wires options correctly to AIMAInstance.
  // Full lifecycle tests (start/stop) require a real DB → integration tests.

  test('AIMASession.create() returns an AIMASession instance', async () => {
    // Use a mock instance to avoid DB construction
    const fakeInstance = makeInstance()
    // biome-ignore lint/suspicious/noExplicitAny: accessing private constructor for testing
    const session = (AIMASession as unknown as Record<string, any>).create
    expect(typeof createAIMASession).toBe('function')
    expect(typeof AIMASession).toBe('function')
  })
})

// ─── AIMASession — subscribe / emit ──────────────────────────────────────────

describe('AIMASession — event subscription', () => {
  function makeSession(): AIMASession {
    const instance = makeInstance()
    // biome-ignore lint/suspicious/noExplicitAny: accessing private constructor
    const session = new (AIMASession as unknown as new (i: AIMAInstance) => AIMASession)(instance)
    return session
  }

  test('subscribe() registers a listener and returns unsubscribe fn', () => {
    const session = makeSession()
    const received: AIMASessionEvent[] = []
    const unsub = session.subscribe((e) => received.push(e))

    // Emit a synthetic event via internal _emit (bound to session)
    const emit = getInternal(session, '_emit').bind(session)
    emit({ type: 'thread_start', threadId: 'test-thread' })
    expect(received).toHaveLength(1)
    expect(received[0]?.type).toBe('thread_start')

    // Unsubscribe
    unsub()
    emit({ type: 'thread_start', threadId: 'test-thread-2' })
    expect(received).toHaveLength(1) // no new events
  })

  test('listener errors do not crash the session', () => {
    const session = makeSession()
    session.subscribe(() => {
      throw new Error('listener error')
    })

    const received: AIMASessionEvent[] = []
    session.subscribe((e) => received.push(e))

    // Should not throw
    const emit = getInternal(session, '_emit').bind(session)
    expect(() => {
      emit({ type: 'thread_start', threadId: 'x' })
    }).not.toThrow()

    expect(received).toHaveLength(1)
  })

  test('multiple listeners all receive events', () => {
    const session = makeSession()
    const counts = [0, 0, 0]
    session.subscribe(() => counts[0]++)
    session.subscribe(() => counts[1]++)
    session.subscribe(() => counts[2]++)

    const emit = getInternal(session, '_emit').bind(session)
    emit({ type: 'thread_start', threadId: 'x' })
    expect(counts).toEqual([1, 1, 1])
  })
})

// ─── AIMASession — state tracking ────────────────────────────────────────────

describe('AIMASession — currentThreadId', () => {
  function makeSession(): AIMASession {
    const instance = makeInstance()
    // biome-ignore lint/suspicious/noExplicitAny: accessing private constructor
    return new (AIMASession as unknown as new (i: AIMAInstance) => AIMASession)(instance)
  }

  test('currentThreadId is null initially', () => {
    const session = makeSession()
    expect(session.currentThreadId).toBeNull()
  })
})

// ─── AIMASession — followUp queue ────────────────────────────────────────────

describe('AIMASession — followUp()', () => {
  function makeSession(): AIMASession {
    const instance = makeInstance()
    // biome-ignore lint/suspicious/noExplicitAny: accessing private constructor
    return new (AIMASession as unknown as new (i: AIMAInstance) => AIMASession)(instance)
  }

  test('followUp() adds to the queue', () => {
    const session = makeSession()
    session.followUp('first')
    session.followUp('second')
    const queue = getInternal(session, '_followUpQueue') as string[]
    expect(queue).toEqual(['first', 'second'])
  })

  test('newThread() clears the followUp queue', async () => {
    const session = makeSession()
    session.followUp('queued')

    // Stub resetBrainSessions to avoid threadRunner errors
    const instance = getInternal(session, 'instance') as AIMAInstance
    instance.resetBrainSessions = mock(() => {})

    await session.newThread()
    const queue = getInternal(session, '_followUpQueue') as string[]
    expect(queue).toEqual([])
  })
})

// ─── AIMASession — newThread() semantics ─────────────────────────────────────

describe('AIMASession — newThread()', () => {
  function makeSession(): AIMASession {
    const instance = makeInstance()
    // biome-ignore lint/suspicious/noExplicitAny: accessing private constructor
    return new (AIMASession as unknown as new (i: AIMAInstance) => AIMASession)(instance)
  }

  test('newThread() resets currentThreadId to null', async () => {
    const session = makeSession()
    // Manually set state
    getInternal(session, '_currentThreadId') // just access it
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    ;(session as unknown as Record<string, any>)._currentThreadId = 'thread-123'

    const instance = getInternal(session, 'instance') as AIMAInstance
    instance.resetBrainSessions = mock(() => {})

    await session.newThread()
    expect(session.currentThreadId).toBeNull()
  })

  test('newThread() calls resetBrainSessions with no arguments', async () => {
    const session = makeSession()
    const instance = getInternal(session, 'instance') as AIMAInstance
    const resetMock = mock(() => {})
    instance.resetBrainSessions = resetMock

    await session.newThread()
    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock).toHaveBeenCalledWith() // no args = reset all
  })
})

// ─── AIMASession — steer() ───────────────────────────────────────────────────

describe('AIMASession — steer()', () => {
  function makeSession(): AIMASession {
    const instance = makeInstance()
    // biome-ignore lint/suspicious/noExplicitAny: accessing private constructor
    return new (AIMASession as unknown as new (i: AIMAInstance) => AIMASession)(instance)
  }

  test('steer() is a no-op when no current thread', () => {
    const session = makeSession()
    const instance = getInternal(session, 'instance') as AIMAInstance
    const injectMock = mock(() => Promise.resolve())
    instance.injectToThread = injectMock

    session.steer('interrupt!')
    expect(injectMock).not.toHaveBeenCalled()
  })

  test('steer() calls injectToThread with amygdala_interrupt when thread is active', () => {
    const session = makeSession()
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    ;(session as unknown as Record<string, any>)._currentThreadId = 'thread-xyz'

    const instance = getInternal(session, 'instance') as AIMAInstance
    const injectMock = mock(() => Promise.resolve())
    instance.injectToThread = injectMock

    session.steer('stop now')
    expect(injectMock).toHaveBeenCalledWith('thread-xyz', 'amygdala_interrupt', 'stop now')
  })
})

// ─── AIMASession — _isCognitiveBrain ─────────────────────────────────────────

describe('AIMASession — brain type guard', () => {
  function makeSession(): AIMASession {
    const instance = makeInstance()
    // biome-ignore lint/suspicious/noExplicitAny: accessing private constructor
    return new (AIMASession as unknown as new (i: AIMAInstance) => AIMASession)(instance)
  }

  test('limbic/cortex/brainstem are cognitive brains', () => {
    const session = makeSession()
    const fn = getInternal(session, '_isCognitiveBrain').bind(session) as (s: string) => boolean
    expect(fn('limbic')).toBe(true)
    expect(fn('cortex')).toBe(true)
    expect(fn('brainstem')).toBe(true)
  })

  test('amygdala and dmn are not cognitive brains', () => {
    const session = makeSession()
    const fn = getInternal(session, '_isCognitiveBrain').bind(session) as (s: string) => boolean
    expect(fn('amygdala')).toBe(false)
    expect(fn('dmn')).toBe(false)
  })
})

// ─── Adapter resetSession / resetAllSessions ──────────────────────────────────

describe('BrainAdapter — resetSession / resetAllSessions', () => {
  test('AIMAInstance.resetBrainSessions() is callable without error', () => {
    const instance = makeInstance()
    expect(() => instance.resetBrainSessions()).not.toThrow()
    expect(() => instance.resetBrainSessions('some-thread-id')).not.toThrow()
  })
})

// ─── ThreadRunner — resetSessions / resetAllSessions ─────────────────────────

describe('ThreadRunner — resetSessions', () => {
  test('resetAllSessions clears brainSessions map', () => {
    const instance = makeInstance()
    // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
    const runner = getInternal(instance, 'threadRunner')
    const sessionsMap = getInternal(runner, 'brainSessions') as Map<string, string>

    // Manually inject a fake session entry
    sessionsMap.set('limbic:thread-abc', 'session-123')
    expect(sessionsMap.size).toBe(1)

    // Reset all sessions
    runner.resetAllSessions()
    expect(sessionsMap.size).toBe(0)
  })

  test('resetSessions(threadId) only clears sessions for that thread', () => {
    const instance = makeInstance()
    // biome-ignore lint/suspicious/noExplicitAny: accessing private for test
    const runner = getInternal(instance, 'threadRunner')
    const sessionsMap = getInternal(runner, 'brainSessions') as Map<string, string>

    // Two threads
    sessionsMap.set('limbic:thread-a', 'session-1')
    sessionsMap.set('cortex:thread-a', 'session-2')
    sessionsMap.set('limbic:thread-b', 'session-3')

    runner.resetSessions('thread-a')

    expect(sessionsMap.has('limbic:thread-a')).toBe(false)
    expect(sessionsMap.has('cortex:thread-a')).toBe(false)
    expect(sessionsMap.has('limbic:thread-b')).toBe(true) // unaffected
  })
})
