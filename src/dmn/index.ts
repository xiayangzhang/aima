import type { BrainEventBus } from '../eventbus/index'
import { getEventBus } from '../eventbus/index'
import type { CognitiveWorkspace } from '../workspace/index'
import { DmnConsolidation } from './consolidation/index'
import type { SignalRule } from './reactive/index'
import { DmnReactive } from './reactive/index'

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface DmnLlmConfig {
  /** If not set, reads from process.env.ANTHROPIC_API_KEY */
  apiKey?: string
  /** Default: 'claude-haiku-4-5-20251001' */
  model?: string
  /** For Consolidation cross-process analysis. Default: 'claude-sonnet-4-6' */
  complexModel?: string
  /** Default: 512 (Reactive) / 1024 (Consolidation) */
  maxTokens?: number
}

export interface DmnConfig {
  workspace: CognitiveWorkspace
  /** If not set, uses getEventBus() singleton */
  eventBus?: BrainEventBus
  llm: DmnLlmConfig
  /** Default: 30 * 60 * 1000 (30 minutes) */
  consolidationIntervalMs?: number
  /** Max error recovery retries. Default: 3 */
  maxRetries?: number
  /** Retroaction window: read last N events. Default: 20 */
  retroactionWindowSize?: number
  /** Custom signal capture rules. Defaults to built-in rules. */
  signalRules?: SignalRule[]
}

// ─── DmnService ───────────────────────────────────────────────────────────────

export class DmnService {
  private reactive: DmnReactive
  private consolidation: DmnConsolidation
  private running = false

  constructor(private config: DmnConfig) {
    const eventBus = config.eventBus ?? getEventBus()
    this.reactive = new DmnReactive({ ...config, eventBus })
    this.consolidation = new DmnConsolidation(config)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.reactive.start()
    await this.consolidation.start()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    await this.reactive.stop()
    await this.consolidation.stop()
  }

  /** Immediately trigger one Consolidation cycle (for testing / manual use) */
  async runConsolidationNow(): Promise<void> {
    await this.consolidation.runOnce()
  }
}

export function createDmnService(config: DmnConfig): DmnService {
  return new DmnService(config)
}
