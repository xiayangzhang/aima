import { callLlm, parseLlmJson } from '../llm'
import type { LlmConfig } from '../llm'
import type { CognitiveWorkspace } from '../workspace/index'

export interface HippocampusConfig {
  llm: LlmConfig
  /** Query window for segment refine and replay (default: 7 days) */
  lookbackDays?: number
  /** Top-K segments for sequence replay (default: 5) */
  replayTopK?: number
  /** Positive outcome ratio threshold for convergence (default: 0.6) */
  convergencePositiveThreshold?: number
  /** Negative outcome ratio threshold for convergence (default: 0.6) */
  convergenceNegativeThreshold?: number
  /** base_importance adjustment step (default: 0.05) */
  convergenceStep?: number
  /** Stale memory cleanup: last_accessed_at older than N days (default: 180) */
  staleAccessDays?: number
  /** Daily trigger time "HH:MM" (default: "03:00") */
  runAt?: string
}

export class HippocampusConsolidation {
  private readonly workspace: CognitiveWorkspace
  private readonly config: Required<HippocampusConfig>
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private currentRun: Promise<void> | null = null

  constructor(workspace: CognitiveWorkspace, config: HippocampusConfig) {
    this.workspace = workspace
    this.config = {
      llm: config.llm,
      lookbackDays: config.lookbackDays ?? 7,
      replayTopK: config.replayTopK ?? 5,
      convergencePositiveThreshold: config.convergencePositiveThreshold ?? 0.6,
      convergenceNegativeThreshold: config.convergenceNegativeThreshold ?? 0.6,
      convergenceStep: config.convergenceStep ?? 0.05,
      staleAccessDays: config.staleAccessDays ?? 180,
      runAt: config.runAt ?? '03:00',
    }
  }

  async runConsolidation(): Promise<void> {
    console.log('[Hippocampus] Starting consolidation run')
    await this.runSegmentRefine()
    await this.runSequenceReplay()
    await this.runOutcomesConverge()
    await this.runExpiryCleanup()
    console.log('[Hippocampus] Consolidation run complete')
  }

  // Step 1: Segment refinement — merge adjacent episodic segments that belong together
  private async runSegmentRefine(): Promise<void> {
    const now = new Date()
    const from = new Date(now.getTime() - this.config.lookbackDays * 24 * 60 * 60 * 1000)
    const segments = await this.workspace.getSegmentsByTimeRange({ from, to: now })

    // Sort by maxCreatedAt ascending to form adjacent pairs
    segments.sort((a, b) => a.maxCreatedAt.getTime() - b.maxCreatedAt.getTime())

    // Cap at 50 pairs to bound LLM call count
    const pairs: [
      { segmentId: string; eventCount: number; avgImportance: number },
      { segmentId: string; eventCount: number; avgImportance: number },
    ][] = []
    for (let i = 0; i < segments.length - 1 && pairs.length < 50; i++) {
      const segA = segments[i]
      const segB = segments[i + 1]
      if (segA && segB) pairs.push([segA, segB])
    }

    // Track merged source segments for idempotency within this run
    const mergedSegmentIds = new Set<string>()

    for (const [segA, segB] of pairs) {
      if (mergedSegmentIds.has(segA.segmentId) || mergedSegmentIds.has(segB.segmentId)) continue
      try {
        await this.tryMergeSegments(segA, segB, mergedSegmentIds)
      } catch (err) {
        console.warn(
          `[Hippocampus] Segment merge failed for ${segA.segmentId}+${segB.segmentId}:`,
          err,
        )
      }
    }

    console.log(`[Hippocampus] Segment refine complete. Pairs checked: ${pairs.length}`)
  }

  private async tryMergeSegments(
    segA: { segmentId: string; eventCount: number; avgImportance: number },
    segB: { segmentId: string; eventCount: number; avgImportance: number },
    mergedSet: Set<string>,
  ): Promise<void> {
    // Sample up to 3 events from each segment as context
    const seqA = (await this.workspace.getSegmentSequence(segA.segmentId)).slice(0, 3)
    const seqB = (await this.workspace.getSegmentSequence(segB.segmentId)).slice(0, 3)

    const contextA = seqA.map((e) => `- ${e.content.slice(0, 200)}`).join('\n')
    const contextB = seqB.map((e) => `- ${e.content.slice(0, 200)}`).join('\n')

    const prompt = `You are analyzing two event segments from an AI cognitive system to determine if they belong to the same continuous logical flow.

Segment A (${segA.eventCount} events, avg importance ${segA.avgImportance.toFixed(2)}):
${contextA}

Segment B (${segB.eventCount} events, avg importance ${segB.avgImportance.toFixed(2)}):
${contextB}

Do these two segments represent a single continuous logical episode that was incorrectly split?
Consider: same entities, continuous reasoning chain, same goal/task, directly related cause-and-effect.

Respond with JSON only:
{"merge": true/false, "reason": "one sentence explanation"}`

    const response = await callLlm(prompt, this.config.llm, { maxTokens: 256 })
    const result = parseLlmJson<{ merge: boolean; reason: string }>(response, {
      merge: false,
      reason: 'parse failed',
    })

    if (result.merge) {
      console.log(
        `[Hippocampus] Merging segments ${segB.segmentId} → ${segA.segmentId}: ${result.reason}`,
      )
      await this.executeMerge(segA.segmentId, segB.segmentId)
      mergedSet.add(segB.segmentId)
    }
  }

  private async executeMerge(targetSegmentId: string, sourceSegmentId: string): Promise<void> {
    // Find current length of target segment to determine new seq numbers
    const targetSeq = await this.workspace.getSegmentSequence(targetSegmentId)
    const offset = targetSeq.length

    // Re-number source records and re-assign to target segment
    const sourceSeq = await this.workspace.getSegmentSequence(sourceSegmentId)
    for (let i = 0; i < sourceSeq.length; i++) {
      const entry = sourceSeq[i]
      if (entry) {
        await this.workspace.updateMemorySegment(entry.id, targetSegmentId, offset + i)
      }
    }
  }

  // Step 2: Sequence replay — extract reusable knowledge from top-K segments
  private async runSequenceReplay(): Promise<void> {
    const now = new Date()
    const from = new Date(now.getTime() - this.config.lookbackDays * 24 * 60 * 60 * 1000)
    const segments = await this.workspace.getSegmentsByTimeRange({ from, to: now })

    // Sort by importance DESC, then recency DESC
    segments.sort((a, b) => {
      const importanceDiff = b.avgImportance - a.avgImportance
      if (Math.abs(importanceDiff) > 0.01) return importanceDiff
      return b.maxCreatedAt.getTime() - a.maxCreatedAt.getTime()
    })

    const topK = segments.slice(0, this.config.replayTopK)
    console.log(
      `[Hippocampus] Sequence replay: ${topK.length}/${segments.length} segments selected`,
    )

    for (const segment of topK) {
      try {
        await this.replaySegment(segment)
      } catch (err) {
        console.warn(`[Hippocampus] Replay failed for segment ${segment.segmentId}:`, err)
      }
    }
  }

  private async replaySegment(segment: {
    segmentId: string
    eventCount: number
    avgImportance: number
  }): Promise<void> {
    const events = await this.workspace.getSegmentSequence(segment.segmentId)

    if (events.length < 2) {
      console.log(`[Hippocampus] Skip segment ${segment.segmentId}: only ${events.length} event(s)`)
      return
    }

    const eventSummary = events.map((e, i) => `[${i + 1}] ${e.content.slice(0, 300)}`).join('\n\n')

    const prompt = `You are analyzing a sequence of cognitive events from an AI agent to extract reusable knowledge.

Segment ID: ${segment.segmentId}
Events (${events.length} total, importance: ${segment.avgImportance.toFixed(2)}):

${eventSummary}

Extract reusable knowledge from this event sequence. Return JSON only:
{
  "semantic": [
    {"content": "factual statement about the world or entities", "entityId": "entity-name-or-null", "tags": ["tag1"]}
  ],
  "procedural": [
    {"content": "step-by-step procedure for a task type", "tags": ["tag1", "tag2"]}
  ],
  "implicit": [
    {"content": "behavioral pattern or risk pattern to watch for", "tags": ["risk", "pattern"]}
  ]
}

Rules:
- semantic: facts, relationships, entity attributes that are generally true
- procedural: repeatable task procedures with clear steps
- implicit: behavioral tendencies, risk patterns, warning signs
- Omit arrays that have no entries (return empty array [])
- Keep content concise but specific (under 500 chars each)
- Use null for entityId if the fact is not entity-specific`

    const response = await callLlm(prompt, this.config.llm, { maxTokens: 2048 })
    await this.processReplayResult(response, segment.segmentId, segment.avgImportance)
  }

  private async processReplayResult(
    llmResponse: string,
    segmentId: string,
    avgImportance: number,
  ): Promise<void> {
    const parsed = parseLlmJson<{
      semantic?: { content: string; entityId: string | null; tags: string[] }[]
      procedural?: { content: string; tags: string[] }[]
      implicit?: { content: string; tags: string[] }[]
    }>(llmResponse, {})

    for (const item of parsed.semantic ?? []) {
      if (!item.content?.trim()) continue
      await this.writeWithSupersedes('semantic', item.content, {
        segmentId,
        ...(item.entityId ? { entityId: item.entityId } : {}),
        tags: ['replay', segmentId, ...(item.tags ?? [])],
        baseImportance: Math.min(avgImportance + 0.05, 1.0),
      })
    }

    for (const item of parsed.procedural ?? []) {
      if (!item.content?.trim()) continue
      await this.writeWithSupersedes('procedural', item.content, {
        segmentId,
        tags: ['replay', segmentId, ...(item.tags ?? [])],
        baseImportance: avgImportance,
      })
    }

    for (const item of parsed.implicit ?? []) {
      if (!item.content?.trim()) continue
      await this.writeWithSupersedes('implicit', item.content, {
        segmentId,
        tags: ['replay', segmentId, ...(item.tags ?? [])],
        baseImportance: Math.max(avgImportance * 0.8, 0.3),
      })
    }
  }

  private async writeWithSupersedes(
    type: 'semantic' | 'procedural' | 'implicit',
    content: string,
    params: {
      segmentId: string
      entityId?: string
      tags: string[]
      baseImportance: number
    },
  ): Promise<void> {
    // Find an existing memory of the same type written for this segment
    const existing = await this.workspace.searchMemory({
      type,
      tags: ['replay', params.segmentId],
      limit: 1,
    })

    // writeMemory atomically invalidates the old record when supersedesId is provided
    const supersedesId = existing[0]?.id

    await this.workspace.writeMemory({
      type,
      content,
      ...(params.entityId ? { entityId: params.entityId } : {}),
      tags: params.tags,
      baseImportance: params.baseImportance,
      ...(supersedesId ? { supersedesId } : {}),
    })
  }

  // Step 3 (WP04 implementation)
  private async runOutcomesConverge(): Promise<void> {
    // stub
  }

  // Step 4 (WP04 implementation)
  private async runExpiryCleanup(): Promise<void> {
    // stub
  }

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
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 60_000))
      await Promise.race([this.currentRun, timeout])
    }
    console.log('[Hippocampus] Scheduler stopped')
  }

  private scheduleNext(): void {
    if (!this.running) return
    const now = new Date()
    const parts = this.config.runAt.split(':').map(Number)
    const h = parts[0] ?? 0
    const m = parts[1] ?? 0
    const next = new Date(now)
    next.setHours(h, m, 0, 0)
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
}
