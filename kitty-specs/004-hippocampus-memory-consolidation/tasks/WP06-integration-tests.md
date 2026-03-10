---
work_package_id: WP06
title: 集成测试
lane: planned
dependencies: []
subtasks: [T028, T029, T030, T031, T032, T033]
assignee: claude
agent: claude
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP06 — 集成测试

## 目标

Vitest 集成测试，真实 DB（`AIMA_TEST_DATABASE_URL=postgresql://aima:aima@localhost:5434/aima_test`），验证 Hippocampus Consolidation 四步流程在真实 PostgreSQL 上的 DB 状态变更。

## 上下文

- **新建文件**：`tests/integration/hippocampus/consolidation.test.ts`
- **配置**：复用 `vitest.integration.config.ts`（与 Feature 003 相同）
- **LLM**：集成测试中使用 callLlm mock（注入），不依赖 ANTHROPIC_API_KEY
- **运行命令**：`AIMA_TEST_DATABASE_URL=postgresql://aima:aima@localhost:5434/aima_test npx vitest run --config vitest.integration.config.ts tests/integration/hippocampus/`
- 参考：Feature 003 集成测试 `tests/integration/dmn/dmn.test.ts` 的 helper 结构

## 实现指导

### T028 — 集成测试 helper + seeder

```typescript
// tests/integration/hippocampus/consolidation.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { memories } from '../../../src/schema/memories'
import { eq, and } from 'drizzle-orm'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import { HippocampusConsolidation } from '../../../src/hippocampus/index'
import * as llmModule from '../../../src/llm'
import { vi } from 'vitest'

const TEST_DB_URL = process.env['AIMA_TEST_DATABASE_URL']!
const pool = new Pool({ connectionString: TEST_DB_URL })
const db = drizzle(pool)

// Helper: create workspace instance using test DB
function createTestWorkspace() {
  return new CognitiveWorkspace(TEST_DB_URL)
}

// Helper: seed episodic records for a segment
async function seedSegment(
  workspace: CognitiveWorkspace,
  segmentId: string,
  eventContents: string[],
  baseImportance = 0.7,
): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < eventContents.length; i++) {
    const entry = await workspace.writeMemory({
      type: 'episodic',
      content: eventContents[i]!,
      segmentId,
      segmentSeq: i,
      baseImportance,
      tags: ['test'],
    })
    ids.push(entry.id)
  }
  return ids
}

// Helper: cleanup test memories by tag
async function cleanupTestMemories() {
  await db.delete(memories).where(eq(memories.tags, ['test'] as any))
}

// Mock callLlm to avoid real API calls
function mockCallLlm(returnValue: string) {
  vi.spyOn(llmModule, 'callLlm').mockResolvedValue(returnValue)
}

function restoreCallLlm() {
  vi.restoreAllMocks()
}
```

---

### T029 — 集成测试：段精修（真实 DB segment_id 更新）

```typescript
describe('Segment refinement integration', () => {
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeEach(async () => {
    workspace = createTestWorkspace()
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      lookbackDays: 7,
    })
    mockCallLlm(JSON.stringify({ merge: true, reason: 'same continuous task' }))
  })

  afterEach(async () => {
    await cleanupTestMemories()
    restoreCallLlm()
  })

  test('merge=true → source segment entries get target segmentId in DB', async () => {
    // Seed segment A (older) and segment B (newer)
    const segAIds = await seedSegment(workspace, 'seg-int-a', ['Event A1', 'Event A2'])
    const segBIds = await seedSegment(workspace, 'seg-int-b', ['Event B1', 'Event B2'])

    await (consolidation as any).runSegmentRefine()

    // Verify: seg-b entries now have seg-int-a as segmentId
    for (const id of segBIds) {
      const [row] = await db.select({ segmentId: memories.segmentId })
        .from(memories).where(eq(memories.id, id))
      expect(row?.segmentId).toBe('seg-int-a')
    }

    // Verify: seg-a entries unchanged
    for (const id of segAIds) {
      const [row] = await db.select({ segmentId: memories.segmentId })
        .from(memories).where(eq(memories.id, id))
      expect(row?.segmentId).toBe('seg-int-a')
    }
  })
})
```

---

### T030 — 集成测试：序列回放写入（真实 DB 新记忆创建）

```typescript
describe('Sequence replay integration', () => {
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeEach(async () => {
    workspace = createTestWorkspace()
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      lookbackDays: 7,
      replayTopK: 1,
    })
    mockCallLlm(JSON.stringify({
      semantic: [{ content: 'Integration test semantic fact', entityId: 'test-entity', tags: ['integration'] }],
      procedural: [{ content: 'Integration test procedure step', tags: ['integration'] }],
      implicit: [],
    }))
  })

  afterEach(async () => {
    await cleanupTestMemories()
    restoreCallLlm()
  })

  test('replay writes semantic and procedural entries to DB', async () => {
    // Seed segment with 3 events (> 2 threshold)
    await seedSegment(workspace, 'seg-replay-test', [
      'Event 1: Meeting started',
      'Event 2: Action items discussed',
      'Event 3: Follow-up scheduled',
    ], 0.8)

    // Record memory count before
    const beforeCount = (await workspace.searchMemory({ query: 'Integration test', limit: 10 })).length

    await (consolidation as any).runSequenceReplay()

    // Verify new memories written
    const semantic = await workspace.searchMemory({ type: 'semantic', query: 'Integration test semantic', limit: 5 })
    const procedural = await workspace.searchMemory({ type: 'procedural', query: 'Integration test procedure', limit: 5 })

    expect(semantic.length).toBeGreaterThan(0)
    expect(semantic[0]?.sourceBrain).toBe('hippocampus')
    expect(procedural.length).toBeGreaterThan(0)
    expect(procedural[0]?.sourceBrain).toBe('hippocampus')
  })
})
```

---

### T031 — 集成测试：usage_outcomes 收敛（真实 DB base_importance 调整）

```typescript
describe('Usage outcomes convergence integration', () => {
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeEach(async () => {
    workspace = createTestWorkspace()
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      convergencePositiveThreshold: 0.6,
      convergenceStep: 0.05,
    })
  })

  afterEach(cleanupTestMemories)

  test('positive feedback → base_importance increases, outcomes reset to zero', async () => {
    // Write memory with positive-heavy outcomes
    const entry = await workspace.writeMemory({
      type: 'semantic',
      content: 'Convergence test memory',
      baseImportance: 0.5,
      tags: ['test'],
      usageOutcomes: { positive: 4, negative: 1, neutral: 0 },
    })

    await (consolidation as any).runOutcomesConverge()

    // Verify DB
    const [row] = await db.select({
      baseImportance: memories.baseImportance,
      usageOutcomes: memories.usageOutcomes,
    }).from(memories).where(eq(memories.id, entry.id))

    expect(row?.baseImportance).toBeCloseTo(0.55, 4)
    const outcomes = row?.usageOutcomes as { positive: number; negative: number; neutral: number }
    expect(outcomes.positive).toBe(0)
    expect(outcomes.negative).toBe(0)
    expect(outcomes.neutral).toBe(0)
  })
})
```

---

### T032 — 集成测试：过期清理（forgotten=true，pinned 免疫）

```typescript
describe('Expiry cleanup integration', () => {
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeEach(async () => {
    workspace = createTestWorkspace()
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
    })
  })

  afterEach(cleanupTestMemories)

  test('expired non-pinned → forgotten=true; pinned → forgotten=false', async () => {
    const pastDate = new Date(Date.now() - 1000)  // already expired

    // 2 expired, not pinned
    const expired1 = await workspace.writeMemory({
      type: 'semantic', content: 'Expired 1', tags: ['test'],
      expiresAt: pastDate, pinned: false,
    })
    const expired2 = await workspace.writeMemory({
      type: 'semantic', content: 'Expired 2', tags: ['test'],
      expiresAt: pastDate, pinned: false,
    })

    // 1 expired but pinned
    const pinnedExpired = await workspace.writeMemory({
      type: 'semantic', content: 'Pinned expired', tags: ['test'],
      expiresAt: pastDate, pinned: true,
    })

    await (consolidation as any).runExpiryCleanup()

    const [r1] = await db.select({ forgotten: memories.forgotten }).from(memories).where(eq(memories.id, expired1.id))
    const [r2] = await db.select({ forgotten: memories.forgotten }).from(memories).where(eq(memories.id, expired2.id))
    const [rp] = await db.select({ forgotten: memories.forgotten }).from(memories).where(eq(memories.id, pinnedExpired.id))

    expect(r1?.forgotten).toBe(true)
    expect(r2?.forgotten).toBe(true)
    expect(rp?.forgotten).toBe(false)  // pinned → not forgotten
  })
})
```

---

### T033 — 集成测试：全流程顺序约束

```typescript
describe('Full consolidation run integration', () => {
  let workspace: CognitiveWorkspace
  let consolidation: HippocampusConsolidation

  beforeEach(async () => {
    workspace = createTestWorkspace()
    consolidation = new HippocampusConsolidation(workspace, {
      llm: { model: 'claude-haiku-4-5-20251001' },
      lookbackDays: 7,
      replayTopK: 1,
    })
    // mock callLlm for both refinement and replay
    mockCallLlm(JSON.stringify({
      merge: false,
      reason: 'different topics',
      semantic: [],
      procedural: [],
      implicit: [],
    }))
  })

  afterEach(async () => {
    await cleanupTestMemories()
    restoreCallLlm()
  })

  test('full runConsolidation completes all 4 steps without error', async () => {
    // Seed minimal data for each step to process
    await seedSegment(workspace, 'seg-full-test', ['Event 1', 'Event 2'])

    // Should complete without throwing
    await expect(consolidation.runConsolidation()).resolves.toBeUndefined()
  })

  test('step 1 DB error → step 2 not executed (ordering constraint)', async () => {
    // Force step 1 to throw by corrupting workspace method
    const originalRefine = (consolidation as any).runSegmentRefine
    ;(consolidation as any).runSegmentRefine = vi.fn().mockRejectedValue(new Error('DB error in step 1'))
    const replaySpy = vi.fn().mockResolvedValue(undefined)
    ;(consolidation as any).runSequenceReplay = replaySpy

    await expect(consolidation.runConsolidation()).rejects.toThrow('DB error in step 1')
    expect(replaySpy).not.toHaveBeenCalled()
  })
})
```

## Definition of Done

- [ ] T028: 测试 helper（createTestWorkspace, seedSegment, cleanupTestMemories, mockCallLlm）就绪
- [ ] T029: 段精修集成测试：source segment DB 中 segment_id 更新为 target
- [ ] T030: 序列回放集成测试：semantic + procedural 记忆写入 DB，sourceBrain='hippocampus'
- [ ] T031: 收敛集成测试：DB 中 base_importance 调整，usage_outcomes 重置为 {0,0,0}
- [ ] T032: 过期清理集成测试：expired+non-pinned → forgotten=true；pinned → forgotten=false
- [ ] T033: 全流程集成测试：runConsolidation 完成；step 1 失败时 step 2 未执行
- [ ] `AIMA_TEST_DATABASE_URL=postgresql://aima:aima@localhost:5434/aima_test npx vitest run --config vitest.integration.config.ts tests/integration/hippocampus/` 全通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
spec-kitty agent tasks move-task WP06 --to for_review --note "Ready: <summary>"
```
