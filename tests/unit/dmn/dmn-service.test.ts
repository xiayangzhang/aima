import { describe, expect, it } from 'bun:test'
import { DmnService, createDmnService } from '../../../src/dmn/index'
import { parseLlmJson } from '../../../src/llm'

// Minimal mock workspace and eventBus stubs
const mockWorkspace = {
  searchMemory: async () => [],
  writePending: async () => ({} as never),
  getPendingObservations: async () => [],
  removePending: async () => {},
  invalidateMemory: async () => {},
  getLatestSegmentStates: async () => new Map(),
} as unknown as Parameters<typeof createDmnService>[0]['workspace']

const mockEventBus = {
  subscribe: () => () => {},
  emit: () => ({} as never),
} as unknown as NonNullable<Parameters<typeof createDmnService>[0]['eventBus']>

const baseConfig = {
  workspace: mockWorkspace,
  eventBus: mockEventBus,
  llm: { apiKey: 'test-key' },
}

describe('DmnService', () => {
  it('createDmnService returns a DmnService instance', () => {
    const service = createDmnService(baseConfig)
    expect(service).toBeInstanceOf(DmnService)
  })

  it('start() is idempotent — second call is a no-op', async () => {
    const service = new DmnService(baseConfig)
    await service.start()
    await service.start() // should not throw
  })

  it('stop() is idempotent — second call is a no-op', async () => {
    const service = new DmnService(baseConfig)
    await service.start()
    await service.stop()
    await service.stop() // should not throw
  })

  it('runConsolidationNow() resolves without error', async () => {
    const service = new DmnService(baseConfig)
    await expect(service.runConsolidationNow()).resolves.toBeUndefined()
  })
})

describe('parseLlmJson', () => {
  it('parses plain JSON', () => {
    const result = parseLlmJson<{ ok: boolean }>('{"ok":true}', { ok: false })
    expect(result.ok).toBe(true)
  })

  it('extracts JSON from markdown code block', () => {
    const text = '```json\n{"value":42}\n```'
    const result = parseLlmJson<{ value: number }>(text, { value: 0 })
    expect(result.value).toBe(42)
  })

  it('returns fallback on invalid JSON', () => {
    const result = parseLlmJson<{ x: number }>('not json at all', { x: -1 })
    expect(result.x).toBe(-1)
  })
})
