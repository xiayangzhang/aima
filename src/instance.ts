import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { ClaudeAgentSDKAdapter } from './adapters/claude-sdk/index'
import type { BrainAdapter } from './adapters/index'
import { PiAgentAdapter } from './adapters/pi-agent/index'
import { PiCodingAgentAdapter } from './adapters/pi-coding-agent/index'
import { Amygdala } from './amygdala/index'
import type { BrainIdentity, ContextAssemblerConfig } from './context/index'
import type { DmnConfig } from './dmn/index'
import { DmnService } from './dmn/index'
import { getEventBus } from './eventbus/index'
import type { BrainEventBus } from './eventbus/index'
import { HippocampusConsolidation } from './hippocampus/index'
import type { HippocampusConfig } from './hippocampus/index'
import { IdentityLoader } from './identity/index'
import type { IdentityCache } from './identity/index'
import type { SpawnExecutionSessionFn } from './mcp/index'
import { ThreadRunner } from './runner/index'
import * as schema from './schema/index'
import type { CognitiveBrainType } from './types/index'
import { CognitiveWorkspace } from './workspace/index'

// ─── Config ───────────────────────────────────────────────────────────────────

export type AdapterType = 'pi-agent' | 'pi-coding-agent' | 'claude-sdk'

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
  /** Per-brain model overrides.
   * - limbic: defaults to 'claude-haiku-4-5-20251001' (fast routing & communication)
   * - cortex: defaults to 'claude-sonnet-4-6' (reasoning & planning)
   * - brainstem: defaults to 'claude-sonnet-4-6' (execution & tool use)
   */
  brainModels?: {
    limbic?: string
    cortex?: string
    brainstem?: string
  }
  /** Enable DMN (Default Mode Network). Defaults to false. */
  enableDmn?: boolean
  /** DMN configuration overrides. Requires enableDmn: true. */
  dmnConfig?: Partial<Pick<DmnConfig, 'consolidationIntervalMs' | 'maxRetries' | 'llm'>>
  /** Enable Hippocampus Consolidation. Defaults to false. */
  enableHippocampus?: boolean
  /** Hippocampus configuration. Requires enableHippocampus: true. */
  hippocampus?: HippocampusConfig
  /**
   * Model to use for sub-execution sessions spawned via spawn_execution_session tool.
   * Defaults to 'claude-sonnet-4-6'. Override with e.g. 'claude-opus-4-6' for deep reasoning.
   */
  executionModel?: string
  /**
   * Optional. Absolute path to identity directory.
   * soul.md / skill-index.md / {brain}.md in this directory override Block 1/2 content.
   * When omitted, behaviour is identical to the previous version.
   */
  identityDir?: string
  /**
   * Optional. Defaults to false.
   * When true, reloadIdentity() is called automatically before each receive().
   * Adds file I/O latency; intended for development/debugging only.
   */
  reloadOnRun?: boolean
  /**
   * @internal Testing escape hatch: override the LLM query used for sub-execution.
   * Prevents real API calls in unit tests.
   */
  _subQueryFn?: (prompt: string, model: string) => Promise<string>
}

// ─── Default identities ───────────────────────────────────────────────────────

const DEFAULT_IDENTITIES: Record<CognitiveBrainType, BrainIdentity> = {
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
  private readonly amygdala: Amygdala
  private pgClient: ReturnType<typeof postgres> | null = null
  private dmnService?: DmnService
  private hippocampusConsolidation?: HippocampusConsolidation
  private readonly _config: AIMAInstanceConfig
  private readonly identityLoader?: IdentityLoader
  private identityCache: IdentityCache | null = null

  constructor(config: AIMAInstanceConfig) {
    this._config = config

    // Database
    const pgClient = postgres(config.databaseUrl)
    this.pgClient = pgClient
    const db = drizzle(pgClient, { schema })
    this.workspace = new CognitiveWorkspace(db)

    // Process-level singleton EventBus
    this.eventBus = getEventBus()

    // Amygdala (default rules)
    this.amygdala = new Amygdala({}, this.workspace, this.eventBus)
    const amygdala = this.amygdala

    // Identity loader (optional)
    if (config.identityDir) {
      this.identityLoader = new IdentityLoader(config.identityDir)
    }

    // Adapters
    const adapters = this.buildAdapters(config, amygdala)

    // ContextAssembler config (built without identity at construction — lazy init on receive())
    const assemblerConfig = this.buildAssemblerConfig()

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

    // Hippocampus (optional)
    if (config.enableHippocampus && config.hippocampus) {
      this.hippocampusConsolidation = new HippocampusConsolidation(
        this.workspace,
        config.hippocampus,
      )
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.threadRunner.start()
    if (this.dmnService) {
      await this.dmnService.start()
    }
    this.hippocampusConsolidation?.start()
  }

  async stop(): Promise<void> {
    if (this.dmnService) {
      await this.dmnService.stop()
    }
    await this.hippocampusConsolidation?.stop()
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
    // Identity lazy init / reload
    if (this.identityLoader) {
      if (this.identityCache === null || this._config.reloadOnRun) {
        this.identityCache = await this.identityLoader.load()
        this.threadRunner.updateAssemblerConfig(this.buildAssemblerConfig())
      }
    }

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

  /**
   * Continue an existing Thread with new input.
   * Reuses the existing Limbic session (conversation history preserved).
   *
   * Supported Thread states: 'complete', 'interrupted'.
   * Call receive() to start a new Thread instead.
   *
   * @throws {Error} if Thread does not exist
   * @throws {Error} if Thread is in 'active' or 'waiting' state
   */
  async continue(
    threadId: string,
    input: {
      content: string
      channel?: string
      externalId?: string
    },
  ): Promise<{ threadId: string }> {
    // Identity lazy init (same as receive())
    if (this.identityLoader) {
      if (this.identityCache === null || this._config.reloadOnRun) {
        this.identityCache = await this.identityLoader.load()
        this.threadRunner.updateAssemblerConfig(this.buildAssemblerConfig())
      }
    }

    // Reopen Thread with new trigger
    await this.workspace.reopenThread(threadId, input.content)

    // Same routing path as receive()
    await this.threadRunner.trigger('limbic', threadId)
    await this.workspace.waitForComplete(threadId)

    return { threadId }
  }

  // ── Identity ─────────────────────────────────────────────────────────────────

  /**
   * Reload all identity files from identityDir and refresh the in-memory cache.
   * New sessions created after this call will use the updated identity.
   *
   * Note: already-running sessions retain their original Extension tool policy;
   * only new brain:thread sessions pick up the new allowedTools.
   *
   * If identityDir is not configured, this method is a no-op.
   */
  async reloadIdentity(): Promise<void> {
    if (!this.identityLoader) return
    this.identityCache = await this.identityLoader.load()
    this.threadRunner.updateAssemblerConfig(this.buildAssemblerConfig())
  }

  /**
   * Returns the current identity cache.
   * @internal Used for testing and introspection.
   */
  getIdentityCache(): IdentityCache | null {
    return this.identityCache
  }

  // ── Sub-Execution ─────────────────────────────────────────────────────────────

  /**
   * Spawn an independent sub-execution session.
   * Used as the SpawnExecutionSessionFn injected into createAimaMcpServer().
   */
  private async spawnSubExecution(params: {
    taskDescription: string
    model?: string
  }): Promise<{ executionSessionId: string; result: string }> {
    const executionSessionId = randomUUID()
    const resolvedModel = params.model ?? this._config.executionModel ?? 'claude-sonnet-4-6'

    this.eventBus.emit({
      event_type: 'brain.activate',
      level: 'INFO',
      brain: 'brainstem',
      session_id: executionSessionId,
      payload: { isSubExecution: true },
    })

    let result: string
    if (this._config._subQueryFn) {
      result = await this._config._subQueryFn(params.taskDescription, resolvedModel)
    } else {
      const apiKey = this._config.apiKey ?? process.env.ANTHROPIC_API_KEY
      const client = new Anthropic({ ...(apiKey !== undefined ? { apiKey } : {}) })
      const response = await client.messages.create({
        model: resolvedModel,
        max_tokens: 8192,
        messages: [{ role: 'user', content: params.taskDescription }],
      })
      const textBlock = response.content.find((b) => b.type === 'text')
      result = textBlock?.type === 'text' ? textBlock.text : ''
    }

    this.eventBus.emit({
      event_type: 'brain.complete',
      level: 'INFO',
      brain: 'brainstem',
      session_id: executionSessionId,
      payload: { isSubExecution: true, executionSessionId },
    })

    return { executionSessionId, result }
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
      adapters.set(
        'limbic',
        new PiAgentAdapter({
          ...shared,
          modelId: config.brainModels?.limbic ?? 'claude-haiku-4-5-20251001',
          getApiKey: apiKeyFn,
        }),
      )
      adapters.set(
        'cortex',
        new PiAgentAdapter({
          ...shared,
          modelId: config.brainModels?.cortex ?? 'claude-sonnet-4-6',
          getApiKey: apiKeyFn,
        }),
      )
      adapters.set(
        'brainstem',
        new PiAgentAdapter({
          ...shared,
          modelId: config.brainModels?.brainstem ?? 'claude-sonnet-4-6',
          getApiKey: apiKeyFn,
        }),
      )
      return adapters
    }

    if (config.adapter === 'pi-coding-agent') {
      adapters.set(
        'limbic',
        new PiCodingAgentAdapter({
          ...shared,
          modelId: config.brainModels?.limbic ?? 'claude-haiku-4-5-20251001',
          getApiKey: apiKeyFn,
          getAllowedTools: (brain) => this.identityCache?.roles[brain]?.allowedTools ?? [],
        }),
      )
      adapters.set(
        'cortex',
        new PiCodingAgentAdapter({
          ...shared,
          modelId: config.brainModels?.cortex ?? 'claude-sonnet-4-6',
          getApiKey: apiKeyFn,
          getAllowedTools: (brain) => this.identityCache?.roles[brain]?.allowedTools ?? [],
        }),
      )
      adapters.set(
        'brainstem',
        new PiCodingAgentAdapter({
          ...shared,
          modelId: config.brainModels?.brainstem ?? 'claude-sonnet-4-6',
          getApiKey: apiKeyFn,
          getAllowedTools: (brain) => this.identityCache?.roles[brain]?.allowedTools ?? [],
        }),
      )
      return adapters
    }

    if (config.adapter === 'claude-sdk') {
      adapters.set(
        'limbic',
        new ClaudeAgentSDKAdapter({
          ...shared,
          model: config.brainModels?.limbic ?? 'claude-haiku-4-5-20251001',
        }),
      )
      adapters.set(
        'cortex',
        new ClaudeAgentSDKAdapter({
          ...shared,
          model: config.brainModels?.cortex ?? 'claude-sonnet-4-6',
        }),
      )
      adapters.set(
        'brainstem',
        new ClaudeAgentSDKAdapter({
          ...shared,
          model: config.brainModels?.brainstem ?? 'claude-sonnet-4-6',
          spawnExecutionSession: this.spawnSubExecution.bind(this) as SpawnExecutionSessionFn,
        }),
      )
      return adapters
    }

    throw new Error(`Unknown adapter type: ${config.adapter satisfies never}`)
  }

  private buildAssemblerConfig(): ContextAssemblerConfig {
    const config = this._config
    const cache = this.identityCache

    const buildIdentity = (brain: CognitiveBrainType): BrainIdentity => {
      const roleEntry = cache?.roles[brain]
      const configOverride = config.identities?.[brain]
      const defaults = DEFAULT_IDENTITIES[brain]
      return {
        role: configOverride?.role ?? defaults.role,
        instructions: roleEntry?.body || configOverride?.instructions || defaults.instructions,
      }
    }

    const soulRaw = cache?.soul || undefined
    const skillIndex = cache?.skillIndex || config.skillIndex

    return {
      ...(soulRaw !== undefined ? { soul: soulRaw } : {}),
      identities: {
        limbic: buildIdentity('limbic'),
        cortex: buildIdentity('cortex'),
        brainstem: buildIdentity('brainstem'),
      },
      ...(skillIndex !== undefined ? { skillIndex } : {}),
      ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
    }
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
