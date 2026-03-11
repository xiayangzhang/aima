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

  // Step 1 (WP02 implementation)
  private async runSegmentRefine(): Promise<void> {
    // stub
  }

  // Step 2 (WP03 implementation)
  private async runSequenceReplay(): Promise<void> {
    // stub
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
