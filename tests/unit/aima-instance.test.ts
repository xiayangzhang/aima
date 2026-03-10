import { describe, expect, test } from 'bun:test'
import { AIMAInstance } from '../../src/instance'

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
