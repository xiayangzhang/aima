import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Amygdala } from '../../amygdala/index'
import type { BrainEventBus } from '../../eventbus/index'
import { createAimaMcpServer } from '../../mcp/index'
import type { SpawnExecutionSessionFn } from '../../mcp/index'
import type { BrainTokenUsage, CognitiveBrainType, MultiProviderConfig } from '../../types/index'
import type { CognitiveWorkspace } from '../../workspace/index'
import type { BrainAdapter, BrainRunParams, BrainRunResult, BrainSignal } from '../index'
import {
  buildAttemptList,
  classifyProviderError,
  resolveBrainConfig,
  validateMultiProviderConfig,
} from '../provider-utils'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ClaudeAgentSDKAdapterConfig {
  /** Multi-provider configuration with per-brain model assignment and fallback chains. */
  providers: MultiProviderConfig
  workspace: CognitiveWorkspace
  eventBus: BrainEventBus
  amygdala: Amygdala
  /** Optional callback for spawning sub-execution sessions (injected by AIMAInstance). */
  spawnExecutionSession?: SpawnExecutionSessionFn
}

// ─── ClaudeAgentSDKAdapter ────────────────────────────────────────────────────

/**
 * Adapts @anthropic-ai/claude-agent-sdk's query() to AIMA's BrainAdapter interface.
 *
 * Session management: session_id returned by SDKResultSuccess is stored per
 * `${brain}:${threadId}` key and passed as `resume` on subsequent activations,
 * preserving conversation history across Thread activations.
 *
 * Amygdala integration: canUseTool hook calls Amygdala.check() before each
 * tool call, blocking or escalating as configured.
 *
 * MCP: an in-process AIMA MCP server is mounted for workspace/memory tools.
 *
 * Multi-provider: per-brain provider config resolved from MultiProviderConfig.
 * On 429/5xx/timeout, retries with the next provider in the fallback chain,
 * emitting a provider.fallback event to EventBus. Session is cleared before
 * each retry (sessions are not transferable across providers).
 */
export class ClaudeAgentSDKAdapter implements BrainAdapter {
  private readonly config: ClaudeAgentSDKAdapterConfig
  // `${brain}:${threadId}` → Claude session_id for resumption
  private readonly sessionIds: Map<string, string> = new Map()
  // `${brain}:${threadId}` → AbortController for active queries
  private readonly abortControllers: Map<string, AbortController> = new Map()

  constructor(config: ClaudeAgentSDKAdapterConfig) {
    validateMultiProviderConfig(config.providers)
    this.config = config
  }

  // ── BrainAdapter.run() ───────────────────────────────────────────────────────

  async run(params: BrainRunParams): Promise<BrainRunResult> {
    const { brain, threadId, systemPrompt, initialPrompt } = params
    const key = `${brain}:${threadId}`

    // Resolve per-brain provider config and build the ordered attempt list once
    const brainConfig = resolveBrainConfig(this.config.providers, brain)
    const attempts = buildAttemptList(brainConfig)

    const mcpServer = createAimaMcpServer(
      this.config.workspace,
      this.config.spawnExecutionSession
        ? { spawnExecutionSession: this.config.spawnExecutionSession }
        : undefined,
    )

    let sessionId = this.sessionIds.get(key) ?? ''
    let tokenUsage: BrainTokenUsage | null = null

    for (let i = 0; i < attempts.length; i++) {
      const spec = attempts[i]
      if (spec === undefined) break
      // Create a fresh AbortController for each attempt (aborted controllers cannot be re-armed)
      const abortController = new AbortController()
      this.abortControllers.set(key, abortController)

      const existingSessionId = this.sessionIds.get(key)

      const q = query({
        prompt: initialPrompt ?? '',
        options: {
          model: spec.model,
          systemPrompt,
          abortController,
          ...(existingSessionId !== undefined ? { resume: existingSessionId } : {}),
          persistSession: false,
          mcpServers: {
            'aima-workspace': mcpServer,
          },
          env: {
            ANTHROPIC_API_KEY: spec.provider.apiKey,
            ANTHROPIC_BASE_URL: spec.provider.baseUrl,
          },
          canUseTool: async (toolName, input) => {
            const { decision, reason } = await this.config.amygdala.check(toolName, input)
            if (decision === 'block' || decision === 'escalate') {
              return { behavior: 'deny', message: reason }
            }
            return { behavior: 'allow' }
          },
        },
      })

      try {
        for await (const msg of q) {
          if (msg.type === 'result') {
            if (msg.subtype === 'success') {
              sessionId = msg.session_id
            }
            // Capture token usage from result message (present on both success and error)
            const u = msg.usage
            tokenUsage = {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              ...(u.cache_read_input_tokens > 0
                ? { cacheReadTokens: u.cache_read_input_tokens }
                : {}),
              ...(u.cache_creation_input_tokens > 0
                ? { cacheWriteTokens: u.cache_creation_input_tokens }
                : {}),
            }
          }
        }
        // Success: store session and exit retry loop
        break
      } catch (err) {
        const reason = classifyProviderError(err)
        const isLastAttempt = i === attempts.length - 1

        if (reason === null || isLastAttempt) {
          // Not retryable, or no more attempts — propagate error to caller
          throw err
        }

        // Retryable and more providers available — emit fallback event and retry
        const nextSpec = attempts[i + 1]
        if (nextSpec === undefined) break
        this.config.eventBus.emit({
          event_type: 'provider.fallback',
          level: 'INFO',
          brain,
          thread_id: threadId,
          session_id: sessionId || null,
          payload: {
            brain,
            fromModel: spec.model,
            fromBaseUrl: spec.provider.baseUrl,
            toModel: nextSpec.model,
            toBaseUrl: nextSpec.provider.baseUrl,
            reason,
            attempt: i + 1, // 1-based: attempt 1 = primary failed
          },
        })

        // Clear session — fallback must start fresh (sessions don't transfer across providers)
        this.sessionIds.delete(key)
      } finally {
        this.abortControllers.delete(key)
      }
    }

    if (sessionId) {
      this.sessionIds.set(key, sessionId)
    }

    // Emit brain.token_usage event if tokens were recorded
    if (tokenUsage !== null) {
      this.config.eventBus.emit({
        event_type: 'brain.token_usage',
        level: 'INFO',
        brain,
        thread_id: threadId,
        session_id: sessionId,
        payload: { brain, threadId, tokenUsage },
      })
    }

    return {
      sessionId,
      output: {},
      stopReason: 'done',
      injectedMemoryIds: [],
    }
  }

  // ── BrainAdapter.inject() ────────────────────────────────────────────────────

  async inject(signal: BrainSignal): Promise<void> {
    // query() is one-shot; signals are stored in workspace and picked up
    // at the next activation via the system prompt (Block 3/4).
    this.config.workspace.pushSignal(signal)
  }

  // ── BrainAdapter.abort() ─────────────────────────────────────────────────────

  abort(): void {
    for (const [key, controller] of this.abortControllers) {
      controller.abort()
      this.abortControllers.delete(key)
    }
  }

  /** Abort a specific brain+thread session */
  abortSession(brain: CognitiveBrainType, threadId: string): void {
    const key = `${brain}:${threadId}`
    const controller = this.abortControllers.get(key)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(key)
    }
  }

  // ── BrainAdapter.resetSession() ───────────────────────────────────────────────

  resetSession(brain: CognitiveBrainType, threadId: string): void {
    const key = `${brain}:${threadId}`
    this.sessionIds.delete(key)
    this.abortControllers.delete(key)
  }

  resetAllSessions(): void {
    this.sessionIds.clear()
    this.abortControllers.clear()
  }
}
