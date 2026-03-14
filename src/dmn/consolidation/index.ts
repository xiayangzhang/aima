import { callLlm, parseLlmJson } from '../../llm'
import type { MemoryEntry } from '../../types/index'
import type { DmnConfig } from '../index'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PredictionResult {
  target_brain: 'limbic' | 'cortex' | 'brainstem'
  note: string
  trigger_at_hours: number
  confidence: 'high' | 'medium' | 'low'
}

// ─── DmnConsolidation ─────────────────────────────────────────────────────────

export class DmnConsolidation {
  private timer: ReturnType<typeof setInterval> | undefined = undefined
  private running = false
  private lastRunAt: Date
  private currentRun: Promise<void> | undefined = undefined

  constructor(private readonly config: DmnConfig) {
    // On first run, backtrack one interval to avoid missing events after restart
    const intervalMs = config.consolidationIntervalMs ?? 30 * 60 * 1000
    this.lastRunAt = new Date(Date.now() - intervalMs)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    const intervalMs = this.config.consolidationIntervalMs ?? 30 * 60 * 1000

    this.timer = setInterval(() => {
      if (this.currentRun) return // skip if previous run still in progress
      this.currentRun = this.runOnce()
        .catch((err) => {
          this.config.eventBus?.emit({
            event_type: 'dmn.consolidation_error',
            level: 'ALERT',
            brain: 'dmn',
            payload: { error: String(err) },
          })
        })
        .finally(() => {
          this.currentRun = undefined
        })
    }, intervalMs)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    clearInterval(this.timer)
    this.timer = undefined
    // Wait for current batch to finish, up to 30 seconds
    if (this.currentRun) {
      await Promise.race([this.currentRun, new Promise<void>((r) => setTimeout(r, 30_000))])
    }
  }

  async runOnce(): Promise<void> {
    const runStart = new Date()

    const increment = await this.readEpisodicIncrement()

    // Three responsibilities run concurrently; allSettled so one failure doesn't block others
    await Promise.allSettled([
      this.runPredictiveActivation(increment),
      this.runPendingMaintenance(increment),
      this.runImplicitClustering(),
    ])

    this.lastRunAt = runStart
  }

  // ── Increment read ─────────────────────────────────────────────────────────

  private async readEpisodicIncrement(): Promise<MemoryEntry[]> {
    return await this.config.workspace.searchMemory({
      type: 'episodic',
      createdAfter: this.lastRunAt,
      excludeInvalid: true,
      limit: 500,
    })
  }

  // ── Responsibility 1: Predictive activation ────────────────────────────────

  private async runPredictiveActivation(increment: MemoryEntry[]): Promise<void> {
    if (increment.length === 0) return

    const [procedural, semantic] = await Promise.all([
      this.config.workspace.searchMemory({ type: 'procedural', excludeInvalid: true, limit: 20 }),
      this.config.workspace.searchMemory({ type: 'semantic', excludeInvalid: true, limit: 20 }),
    ])

    const prompt = buildPredictivePrompt(increment, procedural, semantic)
    const response = await callLlm(prompt, this.config.llm, { maxTokens: 1024 })

    const predictions = parseLlmJson<PredictionResult[]>(response, [])
    await this.writePredictions(predictions)
  }

  private async writePredictions(predictions: PredictionResult[]): Promise<void> {
    for (const pred of predictions) {
      if (pred.confidence === 'low') continue

      const triggerAt = new Date(Date.now() + pred.trigger_at_hours * 60 * 60 * 1000)
      await this.config.workspace.writePending({
        targetBrain: pred.target_brain,
        note: `[DMN Prediction] ${pred.note}`,
        triggerAt,
        expiresAt: new Date(triggerAt.getTime() + 7 * 24 * 60 * 60 * 1000),
        baseImportance: pred.confidence === 'high' ? 0.7 : 0.5,
      })
    }
  }

  // ── Responsibility 2: Pending maintenance ─────────────────────────────────

  private async runPendingMaintenance(increment: MemoryEntry[]): Promise<void> {
    const pendingItems = await this.config.workspace.getPendingObservations()
    if (pendingItems.length === 0) return

    const prompt = buildPendingMaintenancePrompt(increment, pendingItems)
    const response = await callLlm(prompt, this.config.llm, { maxTokens: 1024 })
    const decisions = parseLlmJson<Array<{ action: string; updated_note: string | null }>>(
      response,
      pendingItems.map(() => ({ action: 'keep', updated_note: null })),
    )

    for (let i = 0; i < pendingItems.length; i++) {
      const item = pendingItems[i]
      const decision = decisions[i]
      if (!item || !decision) continue

      if (decision.action === 'remove') {
        await this.config.workspace.removePending(item.id)
      } else if (decision.action === 'update' && decision.updated_note) {
        await this.config.workspace.removePending(item.id)
        await this.config.workspace.writePending({
          targetBrain: item.targetBrain,
          note: decision.updated_note,
          triggerAt: item.triggerAt,
          expiresAt: item.expiresAt,
          baseImportance: item.baseImportance,
        })
      }
      // 'keep' → no-op
    }
  }

  // ── Responsibility 3: Implicit clustering ────────────────────────────────

  protected async runImplicitClustering(): Promise<void> {
    const provisional = await this.config.workspace.searchMemory({
      type: 'implicit',
      tags: ['provisional'],
      excludeInvalid: true,
      createdAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      limit: 100,
    })

    if (provisional.length < 2) return

    await this.clusterAndMerge(provisional)
  }

  private async clusterAndMerge(entries: MemoryEntry[]): Promise<void> {
    const batch = entries.slice(0, 20)

    const prompt = `You are clustering implicit memory entries to merge semantically similar ones.

Memory entries:
${batch.map((e, i) => `[${i}] id="${e.id}" content="${e.content.slice(0, 200)}" tags=[${e.tags?.join(',')}]`).join('\n')}

Identify groups of semantically similar entries that should be merged into one.
Two entries are similar if they describe the same risk pattern or behavior pattern.

Respond with JSON:
{
  "clusters": [
    {
      "indices": [0, 2, 5],
      "canonical_content": "merged description of the pattern",
      "merged_tags": ["tag1", "tag2"]
    }
  ]
}

Only include clusters with 2+ entries. Entries not in any cluster should not appear.`

    const response = await callLlm(prompt, this.config.llm, { maxTokens: 1024 })
    const result = parseLlmJson<{
      clusters: Array<{ indices: number[]; canonical_content: string; merged_tags: string[] }>
    }>(response, { clusters: [] })

    for (const cluster of result.clusters) {
      if (cluster.indices.length < 2) continue
      const toMerge = cluster.indices
        .filter((i) => i >= 0 && i < batch.length)
        .map((i) => batch[i])
        .filter((e): e is MemoryEntry => e !== undefined)

      await this.mergeCluster(toMerge, cluster.canonical_content, cluster.merged_tags)
    }
  }

  private async mergeCluster(
    entries: MemoryEntry[],
    canonicalContent: string,
    mergedTags: string[],
  ): Promise<void> {
    const workspace = this.config.workspace

    // Idempotency: skip if all entries are already invalid (merged in a previous run)
    const allInvalid = entries.every((e) => e.tInvalid !== null)
    if (allInvalid) return

    const maxImportance = Math.max(...entries.map((e) => e.baseImportance ?? 0.5))

    // Write canonical record
    await workspace.writeMemory({
      type: 'implicit',
      content: canonicalContent,
      tags: [...new Set([...mergedTags, 'canonical'])],
      baseImportance: Math.min(1.0, maxImportance),
    })

    // Soft-delete all provisional entries
    for (const entry of entries) {
      if (entry.tInvalid === null) {
        await workspace.invalidateMemory(entry.id)
      }
    }
  }
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildPredictivePrompt(
  episodic: MemoryEntry[],
  procedural: MemoryEntry[],
  semantic: MemoryEntry[],
): string {
  return `You are analyzing recent activity patterns to predict future tasks.

Recent events (episodic, last ${episodic.length} entries):
${episodic
  .slice(-10)
  .map((e) => e.content)
  .join('\n')}

Known procedures (procedural memory):
${procedural
  .slice(0, 5)
  .map((e) => `- ${e.content.slice(0, 150)}`)
  .join('\n')}

Domain knowledge (semantic memory):
${semantic
  .slice(0, 5)
  .map((e) => `- ${e.content.slice(0, 150)}`)
  .join('\n')}

Based on these patterns, identify upcoming tasks that should be scheduled.
Only predict tasks with clear, specific triggers from the patterns above.

Respond with a JSON array (empty array if no predictions):
[
  {
    "target_brain": "limbic" | "cortex" | "brainstem",
    "note": "specific task description with context",
    "trigger_at_hours": number,
    "confidence": "high" | "medium" | "low"
  }
]

Only include "high" or "medium" confidence predictions.`
}

function buildPendingMaintenancePrompt(
  increment: MemoryEntry[],
  pendingItems: Array<{ targetBrain: string; note: string; addedAt: Date }>,
): string {
  return `You are reviewing scheduled pending tasks to determine if they are still relevant.

Recent activity (last ${Math.min(increment.length, 10)} events):
${increment
  .slice(-10)
  .map((e) => e.content)
  .join('\n')}

Pending tasks to evaluate:
${pendingItems
  .map((p, i) => `[${i}] target=${p.targetBrain} note="${p.note}" added=${p.addedAt.toISOString()}`)
  .join('\n')}

For each pending task, decide: remove (completed/no longer relevant), keep (still valid), or update (note needs revision).

Respond with JSON array with one entry per pending task in the same order:
[
  {
    "action": "remove" | "keep" | "update",
    "updated_note": string | null
  }
]`
}
