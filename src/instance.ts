import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { ClaudeAgentSDKAdapter } from './adapters/claude-sdk/index'
import type { BrainAdapter } from './adapters/index'
import { PiCodingAgentAdapter } from './adapters/pi-agent/index'
import { Amygdala } from './amygdala/index'
import type { BrainIdentity, ContextAssemblerConfig } from './context/index'
import type { DmnConfig } from './dmn/index'
import { DmnService } from './dmn/index'
import { getEventBus } from './eventbus/index'
import type { BrainEventBus } from './eventbus/index'
import { ThreadRunner } from './runner/index'
import * as schema from './schema/index'
import type { CognitiveBrainType } from './types/index'
import { CognitiveWorkspace } from './workspace/index'

// ─── Config ───────────────────────────────────────────────────────────────────

export type AdapterType = 'pi-agent' | 'claude-sdk'

export interface AIMAInstanceConfig {
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var if omitted. */
  apiKey?: string
  /** Which adapter implementation to use for brain execution. */
  adapter: AdapterType
  /** PostgreSQL connection string. */
  databaseUrl: string
  /** Optional timezone string, e.g. 'Asia/Shanghai'. Defaults to 'UTC'. */
  timezone?: string
  /** Optional skill index text (static, injected into Block 1/2). */
  skillIndex?: string
  /** Per-brain identity overrides. Defaults to minimal identity strings. */
  identities?: Partial<Record<CognitiveBrainType, BrainIdentity>>
  /** Per-brain model overrides. */
  brainModels?: {
    limbic?: string
    cortex?: string
    brainstem?: string
  }
  /** Enable DMN (Default Mode Network). Defaults to false. */
  enableDmn?: boolean
  /** DMN configuration overrides. Requires enableDmn: true. */
  dmnConfig?: Partial<Pick<DmnConfig, 'consolidationIntervalMs' | 'maxRetries' | 'llm'>>
}

// ─── AIMAInstance ─────────────────────────────────────────────────────────────

/**
 * Top-level cognitive agent entry point.
 *
 * Assembles all Feature 002 components (Workspace, EventBus, Amygdala, Adapters,
 * ThreadRunner) and exposes a simple receive() / start() / stop() API.
 *
 * Usage:
 *   const aima = await createAIMAInstance({ databaseUrl: '...', adapter: 'claude-sdk' })
 *   const { threadId } = await aima.receive({ content: 'Hello' })
 *   await aima.stop()
 */
export class AIMAInstance {
  private readonly workspace: CognitiveWorkspace
  private readonly eventBus: BrainEventBus
  private readonly threadRunner: ThreadRunner
  private pgClient: ReturnType<typeof postgres> | null = null
  private dmnService?: DmnService

  constructor(config: AIMAInstanceConfig) {
    // Database
    const pgClient = postgres(config.databaseUrl)
    this.pgClient = pgClient
    const db = drizzle(pgClient, { schema })
    this.workspace = new CognitiveWorkspace(db)

    // Process-level singleton EventBus
    this.eventBus = getEventBus()

    // Amygdala (default rules)
    const amygdala = new Amygdala({}, this.workspace, this.eventBus)

    // Adapters
    const adapters = this.buildAdapters(config, amygdala)

    // ContextAssembler config
    const assemblerConfig = buildAssemblerConfig(config)

    // ThreadRunner
    this.threadRunner = new ThreadRunner({
      workspace: this.workspace,
      eventBus: this.eventBus,
      adapters,
      assemblerConfig,
    })

    // DMN (optional)
    if (config.enableDmn) {
      const resolvedApiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY
      this.dmnService = new DmnService({
        workspace: this.workspace,
        eventBus: this.eventBus,
        llm: {
          ...(resolvedApiKey !== undefined ? { apiKey: resolvedApiKey } : {}),
          ...config.dmnConfig?.llm,
        },
        ...config.dmnConfig,
      })
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.threadRunner.start()
    if (this.dmnService) {
      await this.dmnService.start()
    }
  }

  async stop(): Promise<void> {
    if (this.dmnService) {
      await this.dmnService.stop()
    }
    this.threadRunner.stop()
    await this.pgClient?.end()
    this.pgClient = null
  }

  // ── Input ────────────────────────────────────────────────────────────────────

  /**
   * Receive an external input and process it through the cognitive loop.
   * Creates a new Thread, activates Limbic, and awaits completion.
   *
   * @returns The threadId of the created thread.
   */
  async receive(input: {
    content: string
    channel?: string
    externalId?: string
  }): Promise<{ threadId: string }> {
    const thread = await this.workspace.createThread({
      initiatedBy: 'external',
      ...(input.channel !== undefined ? { sourceChannel: input.channel } : {}),
      ...(input.externalId !== undefined ? { trigger: input.externalId } : {}),
    })

    // Activate Limbic — the entry point for all external input
    await this.threadRunner.trigger('limbic', thread.id)

    // Wait for the Thread to reach complete state
    await this.workspace.waitForComplete(thread.id)

    return { threadId: thread.id }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private buildAdapters(
    config: AIMAInstanceConfig,
    amygdala: Amygdala,
  ): Map<CognitiveBrainType, BrainAdapter> {
    const apiKeyFn = () => config.apiKey ?? process.env.ANTHROPIC_API_KEY

    const shared = {
      workspace: this.workspace,
      eventBus: this.eventBus,
      amygdala,
    }

    const adapters = new Map<CognitiveBrainType, BrainAdapter>()

    if (config.adapter === 'pi-agent') {
      // All cognitive brains share one PiCodingAgentAdapter instance
      // (session isolation is handled by `${brain}:${threadId}` keys internally)
      const limbicModel = config.brainModels?.limbic ?? 'claude-sonnet-4-6'
      const adapter = new PiCodingAgentAdapter({
        ...shared,
        modelId: limbicModel,
        getApiKey: apiKeyFn,
      })
      adapters.set('limbic', adapter)
      adapters.set('cortex', adapter)
      adapters.set('brainstem', adapter)
      return adapters
    }

    if (config.adapter === 'claude-sdk') {
      const limbicModel = config.brainModels?.limbic ?? 'claude-sonnet-4-6'
      const adapter = new ClaudeAgentSDKAdapter({
        ...shared,
        model: limbicModel,
      })
      adapters.set('limbic', adapter)
      adapters.set('cortex', adapter)
      adapters.set('brainstem', adapter)
      return adapters
    }

    throw new Error(`Unknown adapter type: ${config.adapter satisfies never}`)
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create and start an AIMAInstance in one step.
 * Recommended entry point for production use.
 */
export async function createAIMAInstance(config: AIMAInstanceConfig): Promise<AIMAInstance> {
  const instance = new AIMAInstance(config)
  await instance.start()
  return instance
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildAssemblerConfig(config: AIMAInstanceConfig): ContextAssemblerConfig {
  const defaultIdentities: Record<CognitiveBrainType, BrainIdentity> = {
    limbic: {
      role: 'Limbic — Communication & Routing',
      instructions:
        'You are the Limbic brain. Parse user intent, route to appropriate brain areas, and compose final responses.',
    },
    cortex: {
      role: 'Cortex — Reasoning & Planning',
      instructions:
        'You are the Cortex brain. Analyze context, make routing decisions, and plan complex tasks.',
    },
    brainstem: {
      role: 'Brainstem — Execution',
      instructions:
        'You are the Brainstem brain. Execute tasks using available tools and report results.',
    },
  }

  return {
    identities: {
      ...defaultIdentities,
      ...config.identities,
    },
    ...(config.skillIndex !== undefined ? { skillIndex: config.skillIndex } : {}),
    ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
  }
}
