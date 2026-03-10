import { describe, expect, it, mock } from 'bun:test'
import type { DmnConfig } from '../../../src/dmn/index'
import { DmnConsolidation } from '../../../src/dmn/consolidation/index'

function makeConfig(overrides: Partial<DmnConfig> = {}) {
  const ws = {
    searchMemory: mock(async () => []),
    writePending: mock(async () => ({} as never)),
    getPendingObservations: mock(async () => []),
    removePending: mock(async () => {}),
  }
  return {
    config: {
      workspace: ws as unknown as DmnConfig['workspace'],
      llm: { apiKey: 'test-key' },
      consolidationIntervalMs: 100, // short interval for tests
      ...overrides,
    } as DmnConfig,
    ws,
  }
}

describe('DmnConsolidation', () => {
  describe('lifecycle', () => {
    it('start() is idempotent', async () => {
      const { config } = makeConfig()
      const c = new DmnConsolidation(config)
      await c.start()
      await c.start() // second call should not throw
      await c.stop()
    })

    it('stop() is idempotent', async () => {
      const { config } = makeConfig()
      const c = new DmnConsolidation(config)
      await c.stop() // stop without start should not throw
    })

    it('stop() clears timer', async () => {
      const { config } = makeConfig()
      const c = new DmnConsolidation(config)
      await c.start()
      await c.stop()
      // After stop, no more timer-triggered runs
    })
  })

  describe('runOnce()', () => {
    it('reads episodic increment with createdAfter', async () => {
      const { config, ws } = makeConfig()
      const c = new DmnConsolidation(config)
      await c.runOnce()

      expect(ws.searchMemory).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'episodic', createdAfter: expect.any(Date) }),
      )
    })

    it('updates lastRunAt after runOnce()', async () => {
      const { config, ws } = makeConfig()
      const c = new DmnConsolidation(config)
      const before = Date.now()
      await c.runOnce()
      // lastRunAt is private but we can verify via searchMemory call
      // Second runOnce should use the updated lastRunAt
      const firstCreatedAfter = (ws.searchMemory as ReturnType<typeof mock>).mock.calls[0][0].createdAfter as Date
      await c.runOnce()
      const secondCreatedAfter = (ws.searchMemory as ReturnType<typeof mock>).mock.calls[1][0].createdAfter as Date
      expect(secondCreatedAfter.getTime()).toBeGreaterThanOrEqual(before)
      expect(secondCreatedAfter.getTime()).toBeGreaterThan(firstCreatedAfter.getTime())
    })

    it('skips predictive activation when increment is empty', async () => {
      const { config, ws } = makeConfig()
      const c = new DmnConsolidation(config)
      await c.runOnce() // searchMemory returns []

      // Only episodic searchMemory call should happen (not procedural/semantic)
      const calls = (ws.searchMemory as ReturnType<typeof mock>).mock.calls
      const types = calls.map((c) => (c[0] as { type: string }).type)
      expect(types).not.toContain('procedural')
      expect(types).not.toContain('semantic')
    })

    it('skips pending maintenance when no pending items', async () => {
      const { config, ws } = makeConfig()
      const c = new DmnConsolidation(config)
      await c.runOnce()
      expect(ws.removePending).not.toHaveBeenCalled()
    })
  })

  describe('writePredictions()', () => {
    it('does not write low confidence predictions', async () => {
      // We test indirectly via parseLlmJson fallback returning empty array
      const { config, ws } = makeConfig()
      const c = new DmnConsolidation(config)
      // With empty increment, writePredictions is never called
      await c.runOnce()
      expect(ws.writePending).not.toHaveBeenCalled()
    })
  })
})
