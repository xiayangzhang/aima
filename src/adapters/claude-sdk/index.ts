import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Amygdala } from '../../amygdala/index'
import type { BrainEventBus } from '../../eventbus/index'
import { createAimaMcpServer } from '../../mcp/index'
import type { SpawnExecutionSessionFn } from '../../mcp/index'
import type { BrainTokenUsage, CognitiveBrainType } from '../../types/index'
import type { CognitiveWorkspace } from '../../workspace/index'
import type { BrainAdapter, BrainRunParams, BrainRunResult, BrainSignal } from '../index'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ClaudeAgentSDKAdapterConfig {
  /** Anthropic model ID, e.g. 'claude-sonnet-4-6' */
  model: string
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
 */
export class ClaudeAgentSDKAdapter implements BrainAdapter {
  private readonly config: ClaudeAgentSDKAdapterConfig
  // `${brain}:${threadId}` → Claude session_id for resumption
  private readonly sessionIds: Map<string, string> = new Map()
  // `${brain}:${threadId}` → AbortController for active queries
  private readonly abortControllers: Map<string, AbortController> = new Map()

  constructor(config: ClaudeAgentSDKAdapterConfig) {
    this.config = config
  }

  // ── BrainAdapter.run() ───────────────────────────────────────────────────────

  async run(params: BrainRunParams): Promise<BrainRunResult> {
    const { brain, threadId, systemPrompt, initialPrompt } = params
    const key = `${brain}:${threadId}`

    const abortController = new AbortController()
    this.abortControllers.set(key, abortController)

    const existingSessionId = this.sessionIds.get(key)
    const mcpServer = createAimaMcpServer(
      this.config.workspace,
      this.config.spawnExecutionSession
        ? { spawnExecutionSession: this.config.spawnExecutionSession }
        : undefined,
    )

    const q = query({
      prompt: initialPrompt ?? '',
      options: {
        model: this.config.model,
        systemPrompt,
        abortController,
        ...(existingSessionId !== undefined ? { resume: existingSessionId } : {}),
        persistSession: false,
        mcpServers: {
          'aima-workspace': mcpServer,
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

    let sessionId = existingSessionId ?? ''
    let tokenUsage: BrainTokenUsage | null = null
    try {
      for await (const msg of q) {
        if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            sessionId = msg.session_id
          }
          // T008: Capture token usage from result message (present on both success and error)
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
    } finally {
      this.abortControllers.delete(key)
    }

    if (sessionId) {
      this.sessionIds.set(key, sessionId)
    }

    // T009: Emit brain.token_usage event if tokens were recorded (FR-003, FR-004)
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
