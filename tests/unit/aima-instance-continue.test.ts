import { describe, expect, mock, spyOn, test } from 'bun:test'
import { AIMAInstance } from '../../src/instance'
import type { Thread } from '../../src/types/index'

// biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
type AnyRecord = Record<string, any>

function getWorkspace(instance: AIMAInstance): AnyRecord {
  return (instance as unknown as AnyRecord).workspace
}

function getThreadRunner(instance: AIMAInstance): AnyRecord {
  return (instance as unknown as AnyRecord).threadRunner
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'test-thread-id',
    state: 'complete',
    initiatedBy: 'external',
    trigger: 'original trigger',
    sourceChannel: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeInstance() {
  return new AIMAInstance({
    databaseUrl: 'postgresql://localhost/test',
    adapter: 'claude-sdk',
  })
}

describe('AIMAInstance.continue()', () => {
  test('T001: complete state Thread can be continued — reopenThread + trigger called', async () => {
    const instance = makeInstance()
    const workspace = getWorkspace(instance)
    const runner = getThreadRunner(instance)

    const thread = makeThread({ state: 'complete' })
    workspace.reopenThread = mock(async () => {})
    workspace.waitForComplete = mock(async () => {})
    runner.trigger = mock(async () => {})

    // Patch getThread to simulate reopenThread's internal check
    workspace.getThread = mock(async () => thread)

    await instance.continue('test-thread-id', { content: 'follow-up question' })

    expect(workspace.reopenThread).toHaveBeenCalledWith('test-thread-id', 'follow-up question')
    expect(runner.trigger).toHaveBeenCalledWith('limbic', 'test-thread-id')
    expect(workspace.waitForComplete).toHaveBeenCalledWith('test-thread-id')
  })

  test('T002: interrupted state Thread can be continued', async () => {
    const instance = makeInstance()
    const workspace = getWorkspace(instance)
    const runner = getThreadRunner(instance)

    const thread = makeThread({ state: 'interrupted' })
    workspace.getThread = mock(async () => thread)
    workspace.reopenThread = mock(async () => {})
    workspace.waitForComplete = mock(async () => {})
    runner.trigger = mock(async () => {})

    await instance.continue('test-thread-id', { content: 'continue after interrupt' })

    expect(workspace.reopenThread).toHaveBeenCalledWith(
      'test-thread-id',
      'continue after interrupt',
    )
    expect(runner.trigger).toHaveBeenCalledWith('limbic', 'test-thread-id')
  })

  test('T003: active state Thread throws — cannot reopen', async () => {
    const instance = makeInstance()
    const workspace = getWorkspace(instance)

    workspace.getThread = mock(async () => makeThread({ state: 'active' }))
    workspace.reopenThread = async (id: string, _trigger: string) => {
      const t = await workspace.getThread(id)
      if (t?.state === 'active' || t?.state === 'waiting') {
        throw new Error(`Cannot reopen Thread in state '${t.state}': ${id}`)
      }
    }
    workspace.waitForComplete = mock(async () => {})

    await expect(instance.continue('test-thread-id', { content: 'should fail' })).rejects.toThrow(
      "Cannot reopen Thread in state 'active'",
    )
  })

  test('T004: Thread not found throws', async () => {
    const instance = makeInstance()
    const workspace = getWorkspace(instance)

    workspace.getThread = mock(async () => null)
    workspace.reopenThread = async (id: string) => {
      const t = await workspace.getThread(id)
      if (!t) throw new Error(`Thread not found: ${id}`)
    }
    workspace.waitForComplete = mock(async () => {})

    await expect(instance.continue('nonexistent-id', { content: 'hello' })).rejects.toThrow(
      'Thread not found',
    )
  })

  test('T005: continue() passes input.content as trigger to reopenThread', async () => {
    const instance = makeInstance()
    const workspace = getWorkspace(instance)
    const runner = getThreadRunner(instance)

    workspace.getThread = mock(async () => makeThread({ state: 'complete' }))
    workspace.reopenThread = mock(async () => {})
    workspace.waitForComplete = mock(async () => {})
    runner.trigger = mock(async () => {})

    const newContent = 'What is the capital of France?'
    await instance.continue('test-thread-id', { content: newContent })

    // Verify the exact content is passed as trigger
    const calls = (workspace.reopenThread as ReturnType<typeof mock>).mock.calls
    expect(calls[0][1]).toBe(newContent)
  })

  test('T006: continue() returns the same threadId — no new thread created', async () => {
    const instance = makeInstance()
    const workspace = getWorkspace(instance)
    const runner = getThreadRunner(instance)

    workspace.getThread = mock(async () => makeThread({ state: 'complete' }))
    workspace.reopenThread = mock(async () => {})
    workspace.waitForComplete = mock(async () => {})
    runner.trigger = mock(async () => {})

    // Ensure createThread is NOT called (no new thread created)
    const createThreadSpy = spyOn(workspace, 'createThread')

    const result = await instance.continue('test-thread-id', { content: 'next message' })

    expect(result.threadId).toBe('test-thread-id')
    expect(createThreadSpy).not.toHaveBeenCalled()
  })

  test('T007: waiting state Thread throws — cannot reopen', async () => {
    const instance = makeInstance()
    const workspace = getWorkspace(instance)

    workspace.getThread = mock(async () => makeThread({ state: 'waiting' }))
    workspace.reopenThread = async (id: string, _trigger: string) => {
      const t = await workspace.getThread(id)
      if (t?.state === 'active' || t?.state === 'waiting') {
        throw new Error(`Cannot reopen Thread in state '${t.state}': ${id}`)
      }
    }
    workspace.waitForComplete = mock(async () => {})

    await expect(instance.continue('test-thread-id', { content: 'should fail' })).rejects.toThrow(
      "Cannot reopen Thread in state 'waiting'",
    )
  })
})

describe('CognitiveWorkspace.reopenThread() — unit via workspace directly', () => {
  // These tests use the real reopenThread logic via a stub workspace approach
  // by constructing instance and replacing db calls at workspace level.
  // Full DB integration is covered in tests/integration/

  test('reopenThread rejects active state', async () => {
    const instance = makeInstance()
    const workspace = getWorkspace(instance)

    // Simulate the real reopenThread logic with a fake DB
    const fakeDb = {
      update: () => ({ set: () => ({ where: async () => {} }) }),
    }
    workspace.db = fakeDb
    workspace.getThread = mock(async () => makeThread({ state: 'active' }))

    await expect(workspace.reopenThread('id', 'new trigger')).rejects.toThrow(
      "Cannot reopen Thread in state 'active'",
    )
  })

  test('reopenThread rejects when Thread not found', async () => {
    const instance = makeInstance()
    const workspace = getWorkspace(instance)

    workspace.getThread = mock(async () => null)

    await expect(workspace.reopenThread('missing-id', 'trigger')).rejects.toThrow(
      'Thread not found: missing-id',
    )
  })
})
