import { describe, expect, mock, test } from 'bun:test'
import { AIMAInstance } from '../../src/instance'
import type { Thread } from '../../src/types/index'

// Helper to extract the adapters map from a constructed AIMAInstance.
// Uses cast to access private members — acceptable in unit tests.
function getAdapters(instance: AIMAInstance): Map<string, { config: Record<string, unknown> }> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
  return (instance as unknown as Record<string, any>).threadRunner.adapters
}

// Helper to extract the workspace options from a constructed AIMAInstance.
function getWorkspaceOptions(instance: AIMAInstance): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
  return (instance as unknown as Record<string, any>).workspace.options
}

// Helper to extract the amygdala config from a constructed AIMAInstance.
function getAmygdalaConfig(instance: AIMAInstance): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
  return (instance as unknown as Record<string, any>).amygdala.config
}

describe('AIMAInstance', () => {
  test('can be constructed without errors (no DB connection used at construction)', () => {
    // Construction is synchronous; postgres() is lazy (no connection until first query)
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })
    expect(instance).toBeDefined()
    // Cleanup: stop without starting (should not throw)
    // Note: pgClient.end() is safe to call even if never connected
  })

  test('throws for unknown adapter type', () => {
    expect(() => {
      new AIMAInstance({
        databaseUrl: 'postgresql://localhost/test',
        adapter: 'unknown' as 'pi-agent',
      })
    }).toThrow('Unknown adapter type')
  })
})

// ─── Per-brain adapter instance tests ──────────────────────────────────────────

describe('AIMAInstance — per-brain adapter instances (claude-sdk)', () => {
  test('limbic uses haiku default when brainModels omitted', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })
    const adapters = getAdapters(instance)
    expect(adapters.get('limbic')?.config.model).toBe('claude-haiku-4-5-20251001')
  })

  test('cortex uses sonnet default when brainModels omitted', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })
    const adapters = getAdapters(instance)
    expect(adapters.get('cortex')?.config.model).toBe('claude-sonnet-4-6')
  })

  test('brainstem uses sonnet default when brainModels omitted', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })
    const adapters = getAdapters(instance)
    expect(adapters.get('brainstem')?.config.model).toBe('claude-sonnet-4-6')
  })

  test('limbic respects brainModels override', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
      brainModels: { limbic: 'claude-opus-4-6' },
    })
    const adapters = getAdapters(instance)
    expect(adapters.get('limbic')?.config.model).toBe('claude-opus-4-6')
    // cortex and brainstem still use defaults
    expect(adapters.get('cortex')?.config.model).toBe('claude-sonnet-4-6')
    expect(adapters.get('brainstem')?.config.model).toBe('claude-sonnet-4-6')
  })

  test('all three brains are independent adapter instances', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })
    const adapters = getAdapters(instance)
    const limbic = adapters.get('limbic')
    const cortex = adapters.get('cortex')
    const brainstem = adapters.get('brainstem')
    expect(limbic).not.toBe(cortex)
    expect(cortex).not.toBe(brainstem)
    expect(limbic).not.toBe(brainstem)
  })
})

describe('AIMAInstance — per-brain adapter instances (pi-agent)', () => {
  test('limbic uses haiku default when brainModels omitted', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'pi-agent',
    })
    const adapters = getAdapters(instance)
    expect(adapters.get('limbic')?.config.modelId).toBe('claude-haiku-4-5-20251001')
  })

  test('cortex uses sonnet default when brainModels omitted', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'pi-agent',
    })
    const adapters = getAdapters(instance)
    expect(adapters.get('cortex')?.config.modelId).toBe('claude-sonnet-4-6')
  })

  test('brainstem uses sonnet default when brainModels omitted', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'pi-agent',
    })
    const adapters = getAdapters(instance)
    expect(adapters.get('brainstem')?.config.modelId).toBe('claude-sonnet-4-6')
  })

  test('all three brains are independent adapter instances', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'pi-agent',
    })
    const adapters = getAdapters(instance)
    expect(adapters.get('limbic')).not.toBe(adapters.get('cortex'))
    expect(adapters.get('cortex')).not.toBe(adapters.get('brainstem'))
    expect(adapters.get('limbic')).not.toBe(adapters.get('brainstem'))
  })

  test('cortex respects brainModels override', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'pi-agent',
      brainModels: { cortex: 'claude-opus-4-6' },
    })
    const adapters = getAdapters(instance)
    expect(adapters.get('limbic')?.config.modelId).toBe('claude-haiku-4-5-20251001')
    expect(adapters.get('cortex')?.config.modelId).toBe('claude-opus-4-6')
    expect(adapters.get('brainstem')?.config.modelId).toBe('claude-sonnet-4-6')
  })
})

// ─── T028: embedding and amygdala config wiring ────────────────────────────────

describe('AIMAInstance — embedding config wiring (T028-A)', () => {
  test('no embedding config → workspace options has no embedding field', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })
    const opts = getWorkspaceOptions(instance)
    expect(opts.embedding).toBeUndefined()
  })

  test('embedding config passed through → workspace options contains embedding', () => {
    const embeddingConfig = { apiKey: 'sk-test', model: 'text-embedding-3-small' }
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
      embedding: embeddingConfig,
    })
    const opts = getWorkspaceOptions(instance)
    expect(opts.embedding).toEqual(embeddingConfig)
  })
})

describe('AIMAInstance — amygdala config wiring (T028-B)', () => {
  test('no amygdala config → amygdala config has no llm or haiku_enabled', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })
    const cfg = getAmygdalaConfig(instance)
    expect(cfg.llm).toBeUndefined()
    expect(cfg.haiku_enabled).toBeUndefined()
    expect(cfg.riskLevels).toBeUndefined()
  })

  test('amygdala.llm and haiku_enabled passed through to Amygdala config', () => {
    const llmConfig = { apiKey: 'sk-ant-test', model: 'claude-haiku-4-5-20251001' }
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
      amygdala: { llm: llmConfig, haiku_enabled: true },
    })
    const cfg = getAmygdalaConfig(instance)
    expect(cfg.llm).toEqual(llmConfig)
    expect(cfg.haiku_enabled).toBe(true)
  })

  test('amygdala.riskLevels passed through to Amygdala config', () => {
    const riskLevels = { my_tool: 'high' as const }
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
      amygdala: { riskLevels },
    })
    const cfg = getAmygdalaConfig(instance)
    expect(cfg.riskLevels).toEqual(riskLevels)
  })

  test('amygdala.haiku_enabled: false is passed through (not omitted)', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
      amygdala: { haiku_enabled: false },
    })
    const cfg = getAmygdalaConfig(instance)
    expect(cfg.haiku_enabled).toBe(false)
  })
})

// ─── receive() trigger wiring tests (T029-A, T029-B) ─────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
type AnyRecord = Record<string, any>

function getWorkspace(instance: AIMAInstance): AnyRecord {
  return (instance as unknown as AnyRecord).workspace
}

function getThreadRunner(instance: AIMAInstance): AnyRecord {
  return (instance as unknown as AnyRecord).threadRunner
}

function makeCompletedThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-recv',
    state: 'active',
    initiatedBy: 'external',
    trigger: null,
    sourceChannel: null,
    entityId: null,
    goal: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('AIMAInstance.receive() — trigger wiring (T029)', () => {
  test('T029-A: receive() stores content as thread trigger, not externalId', async () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })
    const workspace = getWorkspace(instance)
    const runner = getThreadRunner(instance)

    let capturedArgs: Record<string, unknown> | null = null
    const returnedThread = makeCompletedThread({ id: 'thread-recv', trigger: 'approve the budget' })
    workspace.createThread = mock(async (args: Record<string, unknown>) => {
      capturedArgs = args
      return returnedThread
    })
    workspace.waitForComplete = mock(async () => {})
    runner.trigger = mock(async () => {})

    await instance.receive({ content: 'approve the budget', externalId: 'msg-123' })

    expect(capturedArgs).not.toBeNull()
    expect(capturedArgs?.trigger).toBe('approve the budget')
    expect(Object.keys(capturedArgs ?? {})).not.toContain('externalId')
  })

  test('T029-B: receive() stores content as trigger when no externalId', async () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })
    const workspace = getWorkspace(instance)
    const runner = getThreadRunner(instance)

    let capturedArgs: Record<string, unknown> | null = null
    const returnedThread = makeCompletedThread({ id: 'thread-recv', trigger: 'hello' })
    workspace.createThread = mock(async (args: Record<string, unknown>) => {
      capturedArgs = args
      return returnedThread
    })
    workspace.waitForComplete = mock(async () => {})
    runner.trigger = mock(async () => {})

    await instance.receive({ content: 'hello' })

    expect(capturedArgs).not.toBeNull()
    expect(capturedArgs?.trigger).toBe('hello')
  })
})
