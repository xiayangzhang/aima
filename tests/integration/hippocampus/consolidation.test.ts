import { arrayContains, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { HippocampusConsolidation } from '../../../src/hippocampus/index'
import * as llmModule from '../../../src/llm'
import { memories } from '../../../src/schema/memories'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import type { DrizzleDB } from '../../../src/workspace/index'
import { createTestDb } from '../helpers/db'
import { describeWithDb } from '../helpers/skip'

// Wipe all episodic memories so getSegmentsByTimeRange only sees our test data.
// Safe: integration tests run against an isolated test DB (AIMA_TEST_DATABASE_URL).
async function wipeEpisodicMemories(db: DrizzleDB) {
  await db.delete(memories).where(eq(memories.type, 'episodic'))
}

// ─── Private method access helpers ───────────────────────────────────────────

type WithRunSegmentRefine = { runSegmentRefine: () => Promise<void> }
type WithRunSequenceReplay = { runSequenceReplay: () => Promise<void> }
type WithRunOutcomesConverge = { runOutcomesConverge: () => Promise<void> }
type WithRunExpiryCleanup = { runExpiryCleanup: () => Promise<void> }

// ─── Helpers (T028) ───────────────────────────────────────────────────────────

const TEST_TAG = 'hippocampus-integration-test'

async function seedSegment(
  workspace: CognitiveWorkspace,
  segmentId: string,
  eventContents: string[],
  baseImportance = 0.7,
): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < eventContents.length; i++) {
    const content = eventContents[i] ?? ''
    const entry = await workspace.writeMemory({
      type: 'episodic',
      content,
      segmentId,
      segmentSeq: i,
      baseImportance,
      tags: [TEST_TAG],
    })
    ids.push(entry.id)
  }
  return ids
}

async function cleanupTestData(db: DrizzleDB) {
  await db.delete(memories).where(arrayContains(memories.tags, [TEST_TAG]))
}

// ─── T029: Segment refinement ─────────────────────────────────────────────────

describeWithDb('Hippocampus integration — segment refinement (T029)', () => {
  let db: DrizzleDB
  let client: { end: () => Promise<void> }
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeAll(() => {
    const result = createTestDb()
    db = result.db
    client = result.client
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    // Wipe all episodic data so getSegmentsByTimeRange only sees our test segments
    await wipeEpisodicMemories(db)
    workspace = new CognitiveWorkspace(db)
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      lookbackDays: 7,
    })
    vi.spyOn(llmModule, 'callLlm').mockResolvedValue(
      JSON.stringify({ merge: true, reason: 'same continuous task' }),
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupTestData(db)
  })

  test('merge=true → source segment entries get target segmentId in DB', async () => {
    const ts = Date.now()
    const segAId = `seg-int-a-${ts}`
    const segBId = `seg-int-b-${ts}`

    const segAIds = await seedSegment(workspace, segAId, [
      'Event A1: started task',
      'Event A2: processing',
    ])
    const segBIds = await seedSegment(workspace, segBId, [
      'Event B1: continued',
      'Event B2: complete',
    ])

    await (consolidation as never as WithRunSegmentRefine).runSegmentRefine()

    // Implementation sorts by maxCreatedAt ASC: segA (older) → segB (newer)
    // pair = [segA, segB] → executeMerge(segA, segB) → segB entries reassigned to segA
    const seqA = await workspace.getSegmentSequence(segAId)
    const seqB = await workspace.getSegmentSequence(segBId)

    const allAIds = seqA.map((m) => m.id)
    expect(allAIds).toContain(segAIds[0])
    expect(allAIds).toContain(segAIds[1])
    expect(allAIds).toContain(segBIds[0])
    expect(allAIds).toContain(segBIds[1])
    expect(seqB.length).toBe(0)
  })

  test('merge=false → segment_ids remain unchanged', async () => {
    vi.restoreAllMocks()
    vi.spyOn(llmModule, 'callLlm').mockResolvedValue(
      JSON.stringify({ merge: false, reason: 'different topics' }),
    )

    const ts = Date.now()
    const segAId = `seg-nomerge-a-${ts}`
    const segBId = `seg-nomerge-b-${ts}`

    const segAIds = await seedSegment(workspace, segAId, ['Event A1', 'Event A2'])
    const segBIds = await seedSegment(workspace, segBId, ['Event B1', 'Event B2'])

    await (consolidation as never as WithRunSegmentRefine).runSegmentRefine()

    const seqA = await workspace.getSegmentSequence(segAId)
    const seqB = await workspace.getSegmentSequence(segBId)

    expect(seqA.map((m) => m.id)).toContain(segAIds[0])
    expect(seqA.map((m) => m.id)).toContain(segAIds[1])
    expect(seqB.map((m) => m.id)).toContain(segBIds[0])
    expect(seqB.map((m) => m.id)).toContain(segBIds[1])
  })
})

// ─── T030: Sequence replay ─────────────────────────────────────────────────────

describeWithDb('Hippocampus integration — sequence replay (T030)', () => {
  let db: DrizzleDB
  let client: { end: () => Promise<void> }
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeAll(() => {
    const result = createTestDb()
    db = result.db
    client = result.client
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    // Wipe episodic data so getSegmentsByTimeRange only selects our seeded segments
    await wipeEpisodicMemories(db)
    workspace = new CognitiveWorkspace(db)
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      lookbackDays: 7,
      replayTopK: 1,
    })
    vi.spyOn(llmModule, 'callLlm').mockResolvedValue(
      JSON.stringify({
        semantic: [
          {
            content: 'Integration test semantic fact: tasks complete faster with clear goals',
            entityId: null,
            tags: ['integration'],
          },
        ],
        procedural: [
          {
            content: 'Integration test procedure: break tasks into milestones',
            tags: ['integration'],
          },
        ],
        implicit: [],
      }),
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupTestData(db)
    await db.delete(memories).where(arrayContains(memories.tags, ['replay']))
  })

  test('replay writes semantic and procedural entries to DB', async () => {
    const ts = Date.now()
    const segId = `seg-replay-${ts}`

    // ≥2 events required (implementation skips segments with <2 events)
    await seedSegment(
      workspace,
      segId,
      [
        'Event 1: Meeting started',
        'Event 2: Action items discussed',
        'Event 3: Follow-up scheduled',
      ],
      0.8,
    )

    await (consolidation as never as WithRunSequenceReplay).runSequenceReplay()

    const semantic = await workspace.searchMemory({
      type: 'semantic',
      tags: ['replay', segId],
      limit: 5,
    })
    expect(semantic.length).toBeGreaterThan(0)
    expect(semantic[0]?.content).toContain('Integration test semantic fact')

    const procedural = await workspace.searchMemory({
      type: 'procedural',
      tags: ['replay', segId],
      limit: 5,
    })
    expect(procedural.length).toBeGreaterThan(0)
    expect(procedural[0]?.content).toContain('Integration test procedure')
  })

  test('segment with <2 events is skipped', async () => {
    const ts = Date.now()
    const segId = `seg-single-${ts}`

    await seedSegment(workspace, segId, ['Lone event'], 0.9)

    await (consolidation as never as WithRunSequenceReplay).runSequenceReplay()

    const result = await workspace.searchMemory({
      type: 'semantic',
      tags: ['replay', segId],
      limit: 5,
    })
    expect(result.length).toBe(0)
  })
})

// ─── T031: Usage outcomes convergence ─────────────────────────────────────────

describeWithDb('Hippocampus integration — usage outcomes convergence (T031)', () => {
  let db: DrizzleDB
  let client: { end: () => Promise<void> }
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeAll(() => {
    const result = createTestDb()
    db = result.db
    client = result.client
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(() => {
    workspace = new CognitiveWorkspace(db)
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      convergencePositiveThreshold: 0.6,
      convergenceStep: 0.05,
    })
  })

  afterEach(async () => {
    await cleanupTestData(db)
  })

  test('positive feedback → base_importance increases, outcomes reset to {0,0,0}', async () => {
    const entry = await workspace.writeMemory({
      type: 'semantic',
      content: 'Convergence test memory: positive feedback',
      baseImportance: 0.5,
      tags: [TEST_TAG],
    })

    // 4 positive, 1 negative → posRatio = 0.8 > 0.6 threshold → +0.05
    await workspace.markMemoryUsed([entry.id], 'positive')
    await workspace.markMemoryUsed([entry.id], 'positive')
    await workspace.markMemoryUsed([entry.id], 'positive')
    await workspace.markMemoryUsed([entry.id], 'positive')
    await workspace.markMemoryUsed([entry.id], 'negative')

    await (consolidation as never as WithRunOutcomesConverge).runOutcomesConverge()

    // Outcomes reset → entry no longer in non-zero list
    const nonZero = await workspace.getMemoriesWithNonZeroOutcomes()
    expect(nonZero.find((m) => m.id === entry.id)).toBeUndefined()

    const [row] = await db
      .select({ baseImportance: memories.baseImportance, usageOutcomes: memories.usageOutcomes })
      .from(memories)
      .where(eq(memories.id, entry.id))

    expect(row?.baseImportance).toBeCloseTo(0.55, 4)
    const outcomes = row?.usageOutcomes as { positive: number; negative: number; neutral: number }
    expect(outcomes.positive).toBe(0)
    expect(outcomes.negative).toBe(0)
    expect(outcomes.neutral).toBe(0)
  })

  test('negative feedback → base_importance decreases', async () => {
    const entry = await workspace.writeMemory({
      type: 'semantic',
      content: 'Convergence test memory: negative feedback',
      baseImportance: 0.5,
      tags: [TEST_TAG],
    })

    // 1 positive, 4 negative → negRatio = 0.8 > 0.6 → -0.05
    await workspace.markMemoryUsed([entry.id], 'negative')
    await workspace.markMemoryUsed([entry.id], 'negative')
    await workspace.markMemoryUsed([entry.id], 'negative')
    await workspace.markMemoryUsed([entry.id], 'negative')
    await workspace.markMemoryUsed([entry.id], 'positive')

    await (consolidation as never as WithRunOutcomesConverge).runOutcomesConverge()

    const [row] = await db
      .select({ baseImportance: memories.baseImportance })
      .from(memories)
      .where(eq(memories.id, entry.id))

    expect(row?.baseImportance).toBeCloseTo(0.45, 4)
  })
})

// ─── T032: Expiry cleanup ──────────────────────────────────────────────────────

describeWithDb('Hippocampus integration — expiry cleanup (T032)', () => {
  let db: DrizzleDB
  let client: { end: () => Promise<void> }
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeAll(() => {
    const result = createTestDb()
    db = result.db
    client = result.client
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(() => {
    workspace = new CognitiveWorkspace(db)
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })
  })

  afterEach(async () => {
    await cleanupTestData(db)
  })

  test('expired non-pinned → forgotten=true; pinned → forgotten=false', async () => {
    const pastDate = new Date(Date.now() - 1000)

    const expired1 = await workspace.writeMemory({
      type: 'semantic',
      content: 'Expired memory 1',
      tags: [TEST_TAG],
      expiresAt: pastDate,
      pinned: false,
    })
    const expired2 = await workspace.writeMemory({
      type: 'semantic',
      content: 'Expired memory 2',
      tags: [TEST_TAG],
      expiresAt: pastDate,
      pinned: false,
    })
    const pinnedExpired = await workspace.writeMemory({
      type: 'semantic',
      content: 'Pinned expired memory',
      tags: [TEST_TAG],
      expiresAt: pastDate,
      pinned: true,
    })

    await (consolidation as never as WithRunExpiryCleanup).runExpiryCleanup()

    const [r1] = await db
      .select({ forgotten: memories.forgotten })
      .from(memories)
      .where(eq(memories.id, expired1.id))
    const [r2] = await db
      .select({ forgotten: memories.forgotten })
      .from(memories)
      .where(eq(memories.id, expired2.id))
    const [rp] = await db
      .select({ forgotten: memories.forgotten })
      .from(memories)
      .where(eq(memories.id, pinnedExpired.id))

    expect(r1?.forgotten).toBe(true)
    expect(r2?.forgotten).toBe(true)
    expect(rp?.forgotten).toBe(false) // pinned → never forgotten
  })

  test('non-expired memories are not touched', async () => {
    const futureDate = new Date(Date.now() + 60_000)

    const notExpired = await workspace.writeMemory({
      type: 'semantic',
      content: 'Not yet expired memory',
      tags: [TEST_TAG],
      expiresAt: futureDate,
      pinned: false,
    })

    await (consolidation as never as WithRunExpiryCleanup).runExpiryCleanup()

    const [row] = await db
      .select({ forgotten: memories.forgotten })
      .from(memories)
      .where(eq(memories.id, notExpired.id))
    expect(row?.forgotten).toBe(false)
  })
})

// ─── T033: Full consolidation run ─────────────────────────────────────────────

describeWithDb('Hippocampus integration — full consolidation run (T033)', () => {
  let db: DrizzleDB
  let client: { end: () => Promise<void> }
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeAll(() => {
    const result = createTestDb()
    db = result.db
    client = result.client
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await wipeEpisodicMemories(db)
    workspace = new CognitiveWorkspace(db)
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      lookbackDays: 7,
      replayTopK: 1,
    })
    vi.spyOn(llmModule, 'callLlm').mockResolvedValue(
      JSON.stringify({
        merge: false,
        reason: 'different topics',
        semantic: [],
        procedural: [],
        implicit: [],
      }),
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanupTestData(db)
    await db.delete(memories).where(arrayContains(memories.tags, ['replay']))
  })

  test('full runConsolidation completes all 4 steps without error', async () => {
    const ts = Date.now()
    await seedSegment(workspace, `seg-full-${ts}`, ['Event 1', 'Event 2'])

    await expect(consolidation.runConsolidation()).resolves.toBeUndefined()
  })

  test('step 1 throws → step 2 not executed (ordering constraint)', async () => {
    ;(consolidation as never as WithRunSegmentRefine).runSegmentRefine = vi
      .fn()
      .mockRejectedValue(new Error('DB error in step 1'))
    const replaySpy = vi.fn().mockResolvedValue(undefined)
    ;(consolidation as never as WithRunSequenceReplay).runSequenceReplay = replaySpy

    await expect(consolidation.runConsolidation()).rejects.toThrow('DB error in step 1')
    expect(replaySpy).not.toHaveBeenCalled()
  })

  test('step 2 throws → step 3 not executed (ordering constraint)', async () => {
    ;(consolidation as never as WithRunSegmentRefine).runSegmentRefine = vi
      .fn()
      .mockResolvedValue(undefined)
    ;(consolidation as never as WithRunSequenceReplay).runSequenceReplay = vi
      .fn()
      .mockRejectedValue(new Error('DB error in step 2'))
    const convergeSpy = vi.fn().mockResolvedValue(undefined)
    ;(consolidation as never as WithRunOutcomesConverge).runOutcomesConverge = convergeSpy

    await expect(consolidation.runConsolidation()).rejects.toThrow('DB error in step 2')
    expect(convergeSpy).not.toHaveBeenCalled()
  })
})
