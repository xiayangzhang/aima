---
work_package_id: WP01
title: callLlm 迁移 + 基础设施 + CognitiveWorkspace 扩展
lane: "doing"
dependencies: []
subtasks: [T001, T002, T003, T004, T005, T006, T007]
agent: "claude"
assignee: "claude"
shell_pid: "66121"
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP01 — callLlm 迁移 + 基础设施 + CognitiveWorkspace 扩展

## 目标

为 Hippocampus Consolidation 建立所有基础：
1. 将 `callLlm` 从 `src/dmn/llm.ts` 提取为共享工具 `src/llm.ts`
2. 创建 `HippocampusConsolidation` 类骨架 + 调度器
3. 扩展 `CognitiveWorkspace` 6 个新方法
4. 集成到 `AIMAInstance`，更新 `src/index.ts` 导出

## 上下文

- **新建文件**：`src/llm.ts`、`src/hippocampus/index.ts`
- **删除文件**：`src/dmn/llm.ts`（内容已迁移）
- **修改文件**：`src/dmn/index.ts`、`src/dmn/reactive/index.ts`、`src/dmn/consolidation/index.ts`（更新 import 路径）；`src/workspace/index.ts`（追加 6 个方法）；`src/instance.ts`（enableHippocampus）；`src/index.ts`（导出）
- 架构参考：`docs/01-agent-architecture.md` §八（Hippocampus）；`docs/02-memory-architecture.md` §七（Consolidation）
- DMN 已有 `callLlm` 实现在 `src/dmn/llm.ts`，类型名为 `DmnLlmConfig`，迁移时改名为 `LlmConfig`

## 实现指导

### T001 — callLlm + parseLlmJson 迁移至 src/llm.ts

**文件**：`src/llm.ts`（新建）

```typescript
import Anthropic from '@anthropic-ai/sdk'

export interface LlmConfig {
  apiKey?: string       // 未设置时从 process.env.ANTHROPIC_API_KEY 读取
  model?: string        // 默认 'claude-haiku-4-5-20251001'
  maxTokens?: number    // 默认 1024
}

export async function callLlm(
  prompt: string,
  config: LlmConfig,
  opts?: { maxTokens?: number }
): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey ?? process.env['ANTHROPIC_API_KEY'] })
  const response = await client.messages.create({
    model: config.model ?? 'claude-haiku-4-5-20251001',
    max_tokens: opts?.maxTokens ?? config.maxTokens ?? 1024,
    messages: [{ role: 'user', content: prompt }],
  })
  const block = response.content[0]
  if (block?.type !== 'text') throw new Error('Unexpected LLM response type')
  return block.text
}

export function parseLlmJson<T>(text: string, fallback: T): T {
  try {
    // 提取 JSON block（支持 ```json ... ``` 包裹和裸 JSON）
    const match = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (!match?.[1] && !match?.[0]) return fallback
    return JSON.parse(match[1] ?? match[0]) as T
  } catch {
    return fallback
  }
}
```

**更新 DMN import 路径**（三个文件）：
- `src/dmn/index.ts`：将 `import type { DmnLlmConfig } from './llm'` → `import type { LlmConfig } from '../llm'`，将所有 `DmnLlmConfig` 引用改为 `LlmConfig`
- `src/dmn/reactive/index.ts`：同上，路径 `'../../llm'`
- `src/dmn/consolidation/index.ts`：同上，路径 `'../../llm'`

**删除** `src/dmn/llm.ts`。

**验证**：`bun run typecheck` 通过，DMN 所有引用无报错。

---

### T002 — HippocampusConfig 类型 + 类骨架

**文件**：`src/hippocampus/index.ts`（新建）

```typescript
import type { CognitiveWorkspace } from '../workspace/index'
import type { LlmConfig } from '../llm'
import { callLlm, parseLlmJson } from '../llm'

export interface HippocampusConfig {
  llm: LlmConfig
  lookbackDays?: number                    // 段精修/回放的查询窗口（默认 7）
  replayTopK?: number                      // 序列回放 top-K 段（默认 5）
  convergencePositiveThreshold?: number    // positive 比例阈值（默认 0.6）
  convergenceNegativeThreshold?: number    // negative 比例阈值（默认 0.6）
  convergenceStep?: number                 // base_importance 调整步长（默认 0.05）
  staleAccessDays?: number                 // 候选清理：last_accessed_at 超 N 天（默认 180）
  runAt?: string                           // 每日触发时间 "HH:MM"（默认 "03:00"）
}

export class HippocampusConsolidation {
  private workspace: CognitiveWorkspace
  private config: Required<HippocampusConfig>
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private currentRun: Promise<void> | null = null

  constructor(workspace: CognitiveWorkspace, config: HippocampusConfig) {
    this.workspace = workspace
    this.config = {
      lookbackDays: 7,
      replayTopK: 5,
      convergencePositiveThreshold: 0.6,
      convergenceNegativeThreshold: 0.6,
      convergenceStep: 0.05,
      staleAccessDays: 180,
      runAt: '03:00',
      ...config,
    }
  }

  async runConsolidation(): Promise<void> {
    console.log('[Hippocampus] Starting consolidation run')
    await this.runSegmentRefine()    // 步骤 1
    await this.runSequenceReplay()   // 步骤 2（依赖步骤 1 精修结果）
    await this.runOutcomesConverge() // 步骤 3
    await this.runExpiryCleanup()    // 步骤 4
    console.log('[Hippocampus] Consolidation run complete')
  }

  // 步骤 1（WP02 实现）
  private async runSegmentRefine(): Promise<void> { /* stub */ }

  // 步骤 2（WP03 实现）
  private async runSequenceReplay(): Promise<void> { /* stub */ }

  // 步骤 3（WP04 实现）
  private async runOutcomesConverge(): Promise<void> { /* stub */ }

  // 步骤 4（WP04 实现）
  private async runExpiryCleanup(): Promise<void> { /* stub */ }
}
```

---

### T003 — 调度器：start() + stop()

在 `HippocampusConsolidation` 类中追加：

```typescript
start(): void {
  if (this.running) return
  this.running = true
  this.scheduleNext()
  console.log(`[Hippocampus] Scheduler started, runAt=${this.config.runAt}`)
}

async stop(): Promise<void> {
  this.running = false
  if (this.timer) {
    clearTimeout(this.timer)
    this.timer = null
  }
  if (this.currentRun) {
    // 等待当前任务完成，最长 60s
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 60_000))
    await Promise.race([this.currentRun, timeout])
  }
  console.log('[Hippocampus] Scheduler stopped')
}

private scheduleNext(): void {
  if (!this.running) return
  const now = new Date()
  const [h, m] = this.config.runAt.split(':').map(Number)
  const next = new Date(now)
  next.setHours(h!, m!, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  const delay = next.getTime() - now.getTime()
  this.timer = setTimeout(() => {
    if (!this.running) return
    this.currentRun = this.runConsolidation().finally(() => {
      this.currentRun = null
      this.scheduleNext()
    })
  }, delay)
}
```

**重入保护**：`currentRun` 非 null 时 `scheduleNext` 的 callback 在 `finally` 之后才触发，保证同时最多一个 runConsolidation 在执行。

---

### T004 — CognitiveWorkspace 扩展：getSegmentsByTimeRange + getSegmentSequence

**文件**：`src/workspace/index.ts`（追加，不改动已有方法）

```typescript
import { sql, and, eq, gte, lt, isNotNull, asc, desc, avg, count, max } from 'drizzle-orm'

/** 按时间范围查询 episodic 段摘要（Hippocampus 段精修和序列回放的数据源） */
async getSegmentsByTimeRange(range: { from: Date; to: Date }): Promise<{
  segmentId: string
  eventCount: number
  avgImportance: number
  maxCreatedAt: Date
}[]> {
  const rows = await this.db
    .select({
      segmentId: memories.segmentId,
      eventCount: count(memories.id),
      avgImportance: avg(memories.baseImportance),
      maxCreatedAt: max(memories.createdAt),
    })
    .from(memories)
    .where(
      and(
        eq(memories.type, 'episodic'),
        isNotNull(memories.segmentId),
        eq(memories.forgotten, false),
        gte(memories.createdAt, range.from),
        lt(memories.createdAt, range.to),
      )
    )
    .groupBy(memories.segmentId)
  return rows
    .filter(r => r.segmentId !== null)
    .map(r => ({
      segmentId: r.segmentId!,
      eventCount: Number(r.eventCount),
      avgImportance: Number(r.avgImportance ?? 0.5),
      maxCreatedAt: r.maxCreatedAt ?? new Date(),
    }))
}

/** 获取某段的完整事件序列（按 segment_seq ASC 排序） */
async getSegmentSequence(segmentId: string): Promise<MemoryEntry[]> {
  const rows = await this.db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.segmentId, segmentId),
        eq(memories.forgotten, false),
      )
    )
    .orderBy(asc(memories.segmentSeq), asc(memories.createdAt))
  return rows.map(mapMemoryRow)
}
```

---

### T005 — CognitiveWorkspace 扩展：updateMemorySegment

```typescript
/** 更新记忆条目的 segmentId 和 segmentSeq（段精修合并使用） */
async updateMemorySegment(memoryId: string, newSegmentId: string, newSegmentSeq: number): Promise<void> {
  await this.db
    .update(memories)
    .set({ segmentId: newSegmentId, segmentSeq: newSegmentSeq, updatedAt: new Date() })
    .where(eq(memories.id, memoryId))
}
```

---

### T006 — CognitiveWorkspace 扩展：getMemoriesWithNonZeroOutcomes + updateMemoryImportanceAndResetOutcomes

```typescript
/** 批量读取 usage_outcomes 非零的记忆（收敛步骤数据源） */
async getMemoriesWithNonZeroOutcomes(): Promise<MemoryEntry[]> {
  const rows = await this.db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.forgotten, false),
        sql`(
          (${memories.usageOutcomes}->>'positive')::int +
          (${memories.usageOutcomes}->>'negative')::int
        ) > 0`
      )
    )
  return rows.map(mapMemoryRow)
}

/** 更新 base_importance 并重置 usage_outcomes 为 {0,0,0}（收敛后调用） */
async updateMemoryImportanceAndResetOutcomes(id: string, newBaseImportance: number): Promise<void> {
  await this.db
    .update(memories)
    .set({
      baseImportance: newBaseImportance,
      usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
      updatedAt: new Date(),
    })
    .where(eq(memories.id, id))
}
```

---

### T007 — forgetExpiredMemories + AIMAInstance 集成 + 导出

**CognitiveWorkspace 追加**：

```typescript
/** 软删除过期记忆：expiresAt < now AND pinned=false AND forgotten=false */
async forgetExpiredMemories(now: Date): Promise<number> {
  const result = await this.db
    .update(memories)
    .set({ forgotten: true, updatedAt: new Date() })
    .where(
      and(
        eq(memories.forgotten, false),
        eq(memories.pinned, false),
        lt(memories.expiresAt, now),
        isNotNull(memories.expiresAt),
      )
    )
  return result.rowCount ?? 0
}
```

**AIMAInstance 集成**（`src/instance.ts`）：

```typescript
// 在 AIMAInstanceConfig 中追加
enableHippocampus?: boolean
hippocampus?: HippocampusConfig

// 在 AIMAInstance 构造函数中：
if (config.enableHippocampus && config.hippocampus) {
  this.hippocampusConsolidation = new HippocampusConsolidation(this.workspace, config.hippocampus)
}

// 在 start() 中：
this.hippocampusConsolidation?.start()

// 在 stop() 中：
await this.hippocampusConsolidation?.stop()
```

**src/index.ts 导出**（追加，不改动已有导出）：

```typescript
export { HippocampusConsolidation } from './hippocampus/index'
export type { HippocampusConfig } from './hippocampus/index'
export type { LlmConfig } from './llm'
```

## Definition of Done

- [ ] T001: `src/llm.ts` 存在，`LlmConfig`/`callLlm`/`parseLlmJson` 已定义；`src/dmn/llm.ts` 已删除；DMN 三个文件 import 路径已更新
- [ ] T002: `src/hippocampus/index.ts` 存在，`HippocampusConfig` + `HippocampusConsolidation` 类（含 stub 步骤）已定义
- [ ] T003: `start()` / `stop()` / `scheduleNext()` 已实现，stop() 最长等待 60s
- [ ] T004: `getSegmentsByTimeRange` + `getSegmentSequence` 已实现，SQL 正确
- [ ] T005: `updateMemorySegment` 已实现
- [ ] T006: `getMemoriesWithNonZeroOutcomes` + `updateMemoryImportanceAndResetOutcomes` 已实现
- [ ] T007: `forgetExpiredMemories` 已实现；AIMAInstance 支持 `enableHippocampus`；`src/index.ts` 导出正确
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
spec-kitty agent tasks move-task WP01 --to for_review --note "Ready: <summary>"
```

## Activity Log

- 2026-03-11T01:25:30Z – claude-sonnet-4-6 – shell_pid=93501 – lane=doing – Started implementation via workflow command
- 2026-03-11T01:33:38Z – claude-sonnet-4-6 – shell_pid=93501 – lane=for_review – Ready for review: callLlm migrated to src/llm.ts (LlmConfig), DmnLlmConfig kept as alias, HippocampusConsolidation class with daily scheduler, 6 new CognitiveWorkspace methods, AIMAInstance integration, exports updated. typecheck and biome both pass.
- 2026-03-11T02:45:35Z – claude – shell_pid=66121 – lane=doing – Started review via workflow command
