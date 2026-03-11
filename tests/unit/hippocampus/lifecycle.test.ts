import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { HippocampusConsolidation } from '../../../src/hippocampus/index'

describe('HippocampusConsolidation lifecycle', () => {
  let consolidation: HippocampusConsolidation

  beforeEach(() => {
    consolidation = new HippocampusConsolidation({} as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      runAt: '23:59', // triggers tomorrow, won't fire during tests
    })
  })

  test('running flag is false before start()', () => {
    expect((consolidation as never as { running: boolean }).running).toBe(false)
  })

  test('start() sets running=true', async () => {
    consolidation.start()
    expect((consolidation as never as { running: boolean }).running).toBe(true)
    await consolidation.stop()
  })

  test('stop() sets running=false and clears timer', async () => {
    consolidation.start()
    await consolidation.stop()
    expect((consolidation as never as { running: boolean }).running).toBe(false)
    expect((consolidation as never as { timer: unknown }).timer).toBeNull()
  })

  test('stop() is idempotent (no error on double stop)', async () => {
    consolidation.start()
    await consolidation.stop()
    await expect(consolidation.stop()).resolves.toBeUndefined()
  })

  test('start() is idempotent (no double scheduling)', async () => {
    consolidation.start()
    const timer1 = (consolidation as never as { timer: unknown }).timer
    consolidation.start() // second call — no-op
    const timer2 = (consolidation as never as { timer: unknown }).timer
    expect(timer1).toBe(timer2)
    await consolidation.stop()
  })

  test('stop() waits for currentRun to complete', async () => {
    let resolveRun!: () => void
    const slowRun = new Promise<void>((resolve) => {
      resolveRun = resolve
    })
    ;(consolidation as never as { currentRun: Promise<void> | null }).currentRun = slowRun
    ;(consolidation as never as { running: boolean }).running = true

    const stopPromise = consolidation.stop()
    resolveRun()
    await stopPromise
    expect((consolidation as never as { running: boolean }).running).toBe(false)
  })

  test('runConsolidation calls all four steps in order', async () => {
    const calls: string[] = []
    ;(consolidation as never as { runSegmentRefine: () => Promise<void> }).runSegmentRefine = mock(
      async () => {
        calls.push('refine')
      },
    )
    ;(consolidation as never as { runSequenceReplay: () => Promise<void> }).runSequenceReplay =
      mock(async () => {
        calls.push('replay')
      })
    ;(consolidation as never as { runOutcomesConverge: () => Promise<void> }).runOutcomesConverge =
      mock(async () => {
        calls.push('converge')
      })
    ;(consolidation as never as { runExpiryCleanup: () => Promise<void> }).runExpiryCleanup = mock(
      async () => {
        calls.push('cleanup')
      },
    )

    await consolidation.runConsolidation()
    expect(calls).toEqual(['refine', 'replay', 'converge', 'cleanup'])
  })
})
