import { afterAll, beforeAll, expect, test } from 'vitest'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import { createTestDb } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'

describeWithDb('Pending observations (integration)', () => {
  let testDb: ReturnType<typeof createTestDb>
  let ws: CognitiveWorkspace

  beforeAll(() => {
    testDb = createTestDb()
    ws = new CognitiveWorkspace(testDb.db, { pendingCapacity: 5 })
  })

  afterAll(async () => {
    await testDb.client.end()
  })

  test('writePending creates and retrieves observation', async () => {
    const pending = await ws.writePending({
      targetBrain: 'limbic',
      note: 'test observation — will be cleaned up',
      expiresAt: new Date(Date.now() + 60_000),
    })

    try {
      expect(pending.id).toBeTypeOf('string')
      expect(pending.targetBrain).toBe('limbic')
      expect(pending.baseImportance).toBe(0.5)
      expect(pending.triggerAt).toBeNull()

      const all = await ws.getPendingObservations()
      expect(all.some((p) => p.id === pending.id)).toBe(true)
    } finally {
      await ws.removePending(pending.id)
    }
  })

  test('capacity eviction: lowest-importance evicted when at capacity', async () => {
    const expiresAt = new Date(Date.now() + 60_000)
    const written: string[] = []

    try {
      for (let i = 0; i < 5; i++) {
        const p = await ws.writePending({
          targetBrain: 'cortex',
          note: `eviction-test-${i}`,
          expiresAt,
          baseImportance: (i + 1) * 0.1,
        })
        written.push(p.id)
      }

      const high = await ws.writePending({
        targetBrain: 'cortex',
        note: 'eviction-test-high',
        expiresAt,
        baseImportance: 0.9,
      })
      written.push(high.id)

      const all = await ws.getPendingObservations()
      const ours = all.filter((p) => p.note.startsWith('eviction-test-'))

      expect(ours.length).toBeLessThanOrEqual(5)
      expect(ours.map((p) => p.id)).not.toContain(written[0])
      expect(ours.map((p) => p.id)).toContain(high.id)
    } finally {
      for (const id of written) {
        await ws.removePending(id).catch(() => {})
      }
    }
  })

  test('concurrent writes respect capacity (advisory lock prevents race)', async () => {
    const expiresAt = new Date(Date.now() + 60_000)
    const capacity = 5
    const concurrentWs = new CognitiveWorkspace(testDb.db, { pendingCapacity: capacity })

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        concurrentWs.writePending({
          targetBrain: 'dmn',
          note: `concurrent-lock-test-${i}`,
          expiresAt,
          baseImportance: Math.random(),
        }),
      ),
    )

    try {
      const all = await concurrentWs.getPendingObservations()
      const ours = all.filter((p) => p.note.startsWith('concurrent-lock-test-'))
      expect(ours.length).toBeLessThanOrEqual(capacity)
    } finally {
      for (const r of results) {
        await concurrentWs.removePending(r.id).catch(() => {})
      }
    }
  })

  test('removeExpiredPending cleans up expired records', async () => {
    const past = new Date(Date.now() - 1_000)

    const expired = await ws.writePending({
      targetBrain: 'brainstem',
      note: 'expired-pending-test',
      expiresAt: past,
    })

    await ws.removeExpiredPending(new Date())

    const all = await ws.getPendingObservations()
    expect(all.map((p) => p.id)).not.toContain(expired.id)
  })

  test('removePending deletes by id', async () => {
    const p = await ws.writePending({
      targetBrain: 'amygdala',
      note: 'remove-by-id-test',
      expiresAt: new Date(Date.now() + 60_000),
    })

    await ws.removePending(p.id)

    const all = await ws.getPendingObservations()
    expect(all.map((x) => x.id)).not.toContain(p.id)
  })
})
