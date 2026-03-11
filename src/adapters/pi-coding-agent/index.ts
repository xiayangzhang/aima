import { getModel } from '@mariozechner/pi-ai'
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from '@mariozechner/pi-coding-agent'
import type { Amygdala } from '../../amygdala/index'
import type { BrainEventBus } from '../../eventbus/index'
import type { CognitiveBrainType } from '../../types/index'
import type { CognitiveWorkspace } from '../../workspace/index'
import type { BrainAdapter, BrainRunParams, BrainRunResult, BrainSignal } from '../index'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface PiCodingAgentAdapterConfig {
  /** Anthropic model ID, e.g. 'claude-sonnet-4-6' */
  modelId: string
  workspace: CognitiveWorkspace
  eventBus: BrainEventBus
  amygdala: Amygdala
  getApiKey: () => string | undefined
}

// ─── Session State ────────────────────────────────────────────────────────────

interface SessionState {
  session: AgentSession
  /** Mutable ref — updated before each run so ResourceLoader returns fresh system prompt */
  systemPromptRef: { value: string }
}

// ─── PiCodingAgentAdapter ─────────────────────────────────────────────────────

/**
 * Adapts @mariozechner/pi-coding-agent's AgentSession to AIMA's BrainAdapter
 * interface.
 *
 * Session management: one AgentSession per `${brain}:${threadId}` key.
 * Each session gets its own in-memory SessionManager so conversation history
 * is preserved across activations within a Thread.
 * Process restart loses in-memory sessions — ThreadRunner handles crash recovery.
 */
export class PiCodingAgentAdapter implements BrainAdapter {
  private readonly config: PiCodingAgentAdapterConfig
  // `${brain}:${threadId}` → live AgentSession + mutable system-prompt ref
  private readonly sessions: Map<string, SessionState> = new Map()

  constructor(config: PiCodingAgentAdapterConfig) {
    this.config = config
  }

  // ── BrainAdapter.run() ───────────────────────────────────────────────────────

  async run(params: BrainRunParams): Promise<BrainRunResult> {
    const { brain, threadId, systemPrompt, initialPrompt } = params
    const key = `${brain}:${threadId}`

    let state = this.sessions.get(key)

    if (!state) {
      // First run: create a new AgentSession
      const systemPromptRef = { value: systemPrompt }

      // Auth: inject API key into an in-memory AuthStorage
      const authStorage = AuthStorage.inMemory()
      const apiKey = this.config.getApiKey()
      if (apiKey !== undefined) {
        authStorage.setRuntimeApiKey('anthropic', apiKey)
      }

      // Model: resolve from registry using getModel
      const modelRegistry = new ModelRegistry(authStorage)
      const model = getModel('anthropic', this.config.modelId as Parameters<typeof getModel>[1])

      // ResourceLoader: minimal, no disk access; system prompt served via mutable ref
      const loader = new DefaultResourceLoader({
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPromptOverride: () => systemPromptRef.value,
      })
      await loader.reload()

      // Custom MCP tools (stub in WP01, implemented in WP03)
      const { buildMcpTools } = await import('./mcp-tools')
      const mcpTools = buildMcpTools(this.config.workspace)

      // Per-session in-memory SessionManager preserves conversation history
      const sessionManager = SessionManager.inMemory()

      const { session } = await createAgentSession({
        model,
        authStorage,
        modelRegistry,
        sessionManager,
        resourceLoader: loader,
        customTools: mcpTools,
      })

      this.registerEventBridge(session, brain, threadId)

      state = { session, systemPromptRef }
      this.sessions.set(key, state)
    } else {
      // Subsequent run: refresh system prompt via mutable ref (ResourceLoader reads it live)
      state.systemPromptRef.value = systemPrompt

      // Deliver any queued Amygdala interrupt from previous activation
      const interruptSignal = this.config.workspace.popSignal('amygdala_interrupt')
      if (interruptSignal !== undefined) {
        await state.session.steer(`[AMYGDALA INTERRUPT] ${interruptSignal.message}`)
      }
    }

    // Always refresh API key in case it rotated between activations
    // (no-op if key unchanged — setRuntimeApiKey overwrites)

    if (initialPrompt !== undefined) {
      await state.session.prompt(initialPrompt)
    }

    return {
      sessionId: key,
      output: {},
      stopReason: 'done',
      injectedMemoryIds: [],
    }
  }

  // ── BrainAdapter.inject() ────────────────────────────────────────────────────

  async inject(signal: BrainSignal): Promise<void> {
    for (const [_key, { session }] of this.sessions) {
      if (signal.type === 'amygdala_interrupt') {
        await session.steer(`[AMYGDALA INTERRUPT] ${signal.message}`)
      } else if (signal.type === 'dmn_correction') {
        await session.followUp(`[DMN CORRECTION] ${signal.message}`)
      }
    }
    // If no active sessions, persist signal for delivery on next activation
    if (this.sessions.size === 0) {
      this.config.workspace.pushSignal(signal)
    }
  }

  // ── BrainAdapter.abort() ─────────────────────────────────────────────────────

  abort(): void {
    for (const [key, { session }] of this.sessions) {
      void session.abort()
      this.sessions.delete(key)
    }
  }

  /** Abort a specific brain+thread session */
  abortSession(brain: CognitiveBrainType, threadId: string): void {
    const key = `${brain}:${threadId}`
    const state = this.sessions.get(key)
    if (state !== undefined) {
      void state.session.abort()
      this.sessions.delete(key)
    }
  }

  // ── EventBus Bridge ──────────────────────────────────────────────────────────

  private registerEventBridge(
    session: AgentSession,
    brain: CognitiveBrainType,
    threadId: string,
  ): void {
    const eb = this.config.eventBus

    session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'tool_execution_start') {
        eb.emit({
          event_type: 'tool.pre_use',
          level: 'INFO',
          brain,
          thread_id: threadId,
          payload: {
            tool: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args as Record<string, unknown>,
          },
        })
      } else if (event.type === 'tool_execution_end') {
        eb.emit({
          event_type: 'tool.post_use',
          level: 'INFO',
          brain,
          thread_id: threadId,
          payload: {
            tool: event.toolName,
            toolCallId: event.toolCallId,
            isError: event.isError,
          },
        })
      } else if (event.type === 'agent_end') {
        eb.emit({
          event_type: 'brain.loop_end',
          level: 'INFO',
          brain,
          thread_id: threadId,
          payload: {},
        })
      }
    })
  }
}
