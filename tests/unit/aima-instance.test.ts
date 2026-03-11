import { describe, expect, test } from 'bun:test'
import { AIMAInstance } from '../../src/instance'

// Helper to extract the adapters map from a constructed AIMAInstance.
// Uses cast to access private members — acceptable in unit tests.
function getAdapters(instance: AIMAInstance): Map<string, { config: Record<string, unknown> }> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
  return (instance as unknown as Record<string, any>).threadRunner.adapters
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
