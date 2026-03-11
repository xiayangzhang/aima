import { describe, expect, mock, test } from 'bun:test'
import { HippocampusConsolidation, computeNewImportance } from '../../../src/hippocampus/index'

const defaultConfig = {
  convergencePositiveThreshold: 0.6,
  convergenceNegativeThreshold: 0.6,
  convergenceStep: 0.05,
}

// ── computeNewImportance (pure function) ──────────────────────────────────────

describe('computeNewImportance', () => {
  test('high positive ratio → importance increases by step', () => {
    const result = computeNewImportance(
      0.5,
      { positive: 4, negative: 1, neutral: 0 },
      defaultConfig,
    )
    expect(result).toBeCloseTo(0.55, 5)
  })

  test('high negative ratio → importance decreases by step', () => {
    const result = computeNewImportance(
      0.5,
      { positive: 1, negative: 4, neutral: 0 },
      defaultConfig,
    )
    expect(result).toBeCloseTo(0.45, 5)
  })

  test('neither threshold met → no change', () => {
    // pos ratio = 0.3, neg ratio = 0.3 — both below 0.6
    const result = computeNewImportance(
      0.5,
      { positive: 3, negative: 3, neutral: 4 },
      defaultConfig,
    )
    expect(result).toBeCloseTo(0.5, 5)
  })

  test('at floor (0.0) + high negative ratio → clamped to 0.0', () => {
    const result = computeNewImportance(
      0.0,
      { positive: 0, negative: 5, neutral: 0 },
      defaultConfig,
    )
    expect(result).toBe(0.0)
  })

  test('at ceiling (1.0) + high positive ratio → clamped to 1.0', () => {
    const result = computeNewImportance(
      1.0,
      { positive: 5, negative: 0, neutral: 0 },
      defaultConfig,
    )
    expect(result).toBe(1.0)
  })

  test('all zero outcomes → returns current unchanged', () => {
    const result = computeNewImportance(
      0.7,
      { positive: 0, negative: 0, neutral: 0 },
      defaultConfig,
    )
    expect(result).toBe(0.7)
  })

  test('custom step size applied correctly', () => {
    const result = computeNewImportance(
      0.5,
      { positive: 4, negative: 1, neutral: 0 },
      { ...defaultConfig, convergenceStep: 0.1 },
    )
    expect(result).toBeCloseTo(0.6, 5)
  })

  test('positive wins over negative check when positive threshold is met first', () => {
    // pos ratio = 0.7 > 0.6, neg ratio = 0.3 < 0.6 → positive wins
    const result = computeNewImportance(
      0.5,
      { positive: 7, negative: 3, neutral: 0 },
      defaultConfig,
    )
    expect(result).toBeCloseTo(0.55, 5)
  })
})

// ── runOutcomesConverge ───────────────────────────────────────────────────────

describe('runOutcomesConverge', () => {
  test('calls updateMemoryImportanceAndResetOutcomes for each non-zero entry', async () => {
    const updateSpy = mock(() => Promise.resolve())
    const workspace = {
      getMemoriesWithNonZeroOutcomes: mock(() =>
        Promise.resolve([
          {
            id: 'mem-1',
            baseImportance: 0.5,
            usageOutcomes: { positive: 4, negative: 1, neutral: 0 },
          },
          {
            id: 'mem-2',
            baseImportance: 0.6,
            usageOutcomes: { positive: 1, negative: 4, neutral: 0 },
          },
        ]),
      ),
      updateMemoryImportanceAndResetOutcomes: updateSpy,
    }
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    await (c as never as { runOutcomesConverge: () => Promise<void> }).runOutcomesConverge()

    expect(updateSpy).toHaveBeenCalledTimes(2)
    // mem-1: pos ratio = 4/5 = 0.8 > 0.6 → +0.05 → 0.55
    expect(updateSpy.mock.calls[0]?.[0]).toBe('mem-1')
    expect(updateSpy.mock.calls[0]?.[1]).toBeCloseTo(0.55, 5)
    // mem-2: neg ratio = 4/5 = 0.8 > 0.6 → -0.05 → 0.55
    expect(updateSpy.mock.calls[1]?.[0]).toBe('mem-2')
    expect(updateSpy.mock.calls[1]?.[1]).toBeCloseTo(0.55, 5)
  })

  test('empty result → no updates called', async () => {
    const updateSpy = mock(() => Promise.resolve())
    const workspace = {
      getMemoriesWithNonZeroOutcomes: mock(() => Promise.resolve([])),
      updateMemoryImportanceAndResetOutcomes: updateSpy,
    }
    const c = new HippocampusConsolidation(workspace as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    await (c as never as { runOutcomesConverge: () => Promise<void> }).runOutcomesConverge()

    expect(updateSpy).not.toHaveBeenCalled()
  })
})

// ── runExpiryCleanup ──────────────────────────────────────────────────────────

describe('runExpiryCleanup', () => {
  test('calls forgetExpiredMemories with a Date instance', async () => {
    const forgetSpy = mock(() => Promise.resolve(3))
    const c = new HippocampusConsolidation({ forgetExpiredMemories: forgetSpy } as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })

    await (c as never as { runExpiryCleanup: () => Promise<void> }).runExpiryCleanup()

    expect(forgetSpy).toHaveBeenCalledTimes(1)
    expect(forgetSpy.mock.calls[0]?.[0]).toBeInstanceOf(Date)
  })
})

// ── runConsolidation ordering ─────────────────────────────────────────────────

describe('runConsolidation ordering', () => {
  test('step 2 (replay) is NOT called when step 1 (refine) throws', async () => {
    const replaySpy = mock(() => Promise.resolve())
    const c = new HippocampusConsolidation({} as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })
    ;(c as never as { runSegmentRefine: () => Promise<void> }).runSegmentRefine = mock(() =>
      Promise.reject(new Error('step 1 failed')),
    )
    ;(c as never as { runSequenceReplay: () => Promise<void> }).runSequenceReplay = replaySpy
    ;(c as never as { runOutcomesConverge: () => Promise<void> }).runOutcomesConverge = mock(() =>
      Promise.resolve(),
    )
    ;(c as never as { runExpiryCleanup: () => Promise<void> }).runExpiryCleanup = mock(() =>
      Promise.resolve(),
    )

    await expect(c.runConsolidation()).rejects.toThrow('step 1 failed')
    expect(replaySpy).not.toHaveBeenCalled()
  })

  test('step 4 (cleanup) is NOT called when step 3 (converge) throws', async () => {
    const cleanupSpy = mock(() => Promise.resolve())
    const c = new HippocampusConsolidation({} as never, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })
    ;(c as never as { runSegmentRefine: () => Promise<void> }).runSegmentRefine = mock(() =>
      Promise.resolve(),
    )
    ;(c as never as { runSequenceReplay: () => Promise<void> }).runSequenceReplay = mock(() =>
      Promise.resolve(),
    )
    ;(c as never as { runOutcomesConverge: () => Promise<void> }).runOutcomesConverge = mock(() =>
      Promise.reject(new Error('step 3 failed')),
    )
    ;(c as never as { runExpiryCleanup: () => Promise<void> }).runExpiryCleanup = cleanupSpy

    await expect(c.runConsolidation()).rejects.toThrow('step 3 failed')
    expect(cleanupSpy).not.toHaveBeenCalled()
  })
})
