import { getModel } from '@mariozechner/pi-ai'
import {
  type AgentSession,
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from '@mariozechner/pi-coding-agent'
import type { Amygdala } from '../../amygdala/index'
import type { BrainEventBus } from '../../eventbus/index'
import type { BrainTokenUsage, CognitiveBrainType } from '../../types/index'
import type { CognitiveWorkspace } from '../../workspace/index'
import type { BrainAdapter, BrainRunParams, BrainRunResult, BrainSignal } from '../index'
import { createAimaExtension } from './extension'
import { buildMcpTools } from './mcp-tools'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface PiCodingAgentAdapterConfig {
  /** Anthropic model ID, e.g. 'claude-sonnet-4-6' */
  modelId: string
  workspace: CognitiveWorkspace
  eventBus: BrainEventBus
  amygdala: Amygdala
  getApiKey: () => string | undefined
  /**
   * Optional. Returns the allowed tool names for a given brain.
   * Sourced from identity role file allowed_tools frontmatter.
   * When omitted, default blocking policy applies unchanged.
   */
  getAllowedTools?: (brain: CognitiveBrainType) => string[]
  /** Testing escape hatch: override session creation to inject a mock AgentSession. */
  _createSession?: () => Promise<AgentSession>
}

// ─── Session State ────────────────────────────────────────────────────────────

interface SessionState {
  session: AgentSession
  /** Mutable ref — updated before each run so ResourceLoader returns fresh system prompt */
  systemPromptRef: { value: string }
  /** Mutable ref — populated by agent_end handler with last assistant text (for fallback slot write) */
  lastTextRef: { value: string }
  /** Mutable ref — populated by agent_end handler with accumulated token usage */
  tokenUsageRef: { value: BrainTokenUsage | null }
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
      const lastTextRef = { value: '' }
      const tokenUsageRef: { value: BrainTokenUsage | null } = { value: null }

      // Auth: inject API key into an in-memory AuthStorage
      const authStorage = AuthStorage.inMemory()
      const apiKey = this.config.getApiKey()
      if (apiKey !== undefined) {
        authStorage.setRuntimeApiKey('anthropic', apiKey)
      }

      // Model: resolve from registry using getModel
      const modelRegistry = new ModelRegistry(authStorage)
      const model = getModel('anthropic', this.config.modelId as Parameters<typeof getModel>[1])

      // Extension: Amygdala interception + EventBus bridge
      const extensionFactory = createAimaExtension(
        brain,
        threadId,
        this.config.amygdala,
        this.config.eventBus,
        this.config.getAllowedTools?.(brain),
        lastTextRef,
        tokenUsageRef,
      )

      // ResourceLoader: minimal no-disk setup; extension wired via factory
      const loader = new DefaultResourceLoader({
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPromptOverride: () => systemPromptRef.value,
        extensionFactories: [extensionFactory],
      })
      await loader.reload()

      // Custom MCP tools (stub in WP01/WP02, implemented in WP03)
      const mcpTools = buildMcpTools(this.config.workspace)

      // Per-session in-memory SessionManager preserves conversation history
      const sessionManager = SessionManager.inMemory()

      const session = this.config._createSession
        ? await this.config._createSession()
        : (
            await createAgentSession({
              model,
              authStorage,
              modelRegistry,
              sessionManager,
              resourceLoader: loader,
              customTools: mcpTools,
            })
          ).session

      state = { session, systemPromptRef, lastTextRef, tokenUsageRef }
      this.sessions.set(key, state)
    } else {
      // Subsequent run: refresh system prompt via mutable ref (ResourceLoader reads it live)
      state.systemPromptRef.value = systemPrompt

      // Deliver any queued Amygdala interrupt from previous activation
      const interruptSignal = this.config.workspace.popSignal('amygdala_interrupt', threadId)
      if (interruptSignal !== undefined) {
        await state.session.steer(`[AMYGDALA INTERRUPT] ${interruptSignal.message}`)
      }
    }

    // Reset token usage before each run so we capture only this activation's tokens
    state.tokenUsageRef.value = null

    if (initialPrompt !== undefined) {
      await state.session.prompt(initialPrompt)

      // T003/T004: Fallback slot write if brain never called workspace_write_slot (FR-001..007)
      const slot = await this.config.workspace.readSlot(threadId, brain)
      if (slot?.output == null && slot?.status !== 'error') {
        await this.config.workspace.writeSlot(threadId, brain, {
          output: { reply: state.lastTextRef.value, _fallback: true },
        })
      }
    }

    // T007: Emit brain.token_usage event if token data was captured (FR-002, FR-004)
    const tokenUsage = state.tokenUsageRef.value
    if (tokenUsage !== null) {
      this.config.eventBus.emit({
        event_type: 'brain.token_usage',
        level: 'INFO',
        brain,
        thread_id: threadId,
        session_id: key,
        payload: { brain, threadId, tokenUsage },
      })
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
    // Only inject into sessions belonging to the signal's thread
    const threadSessions = [...this.sessions.entries()].filter(([key]) =>
      key.endsWith(`:${signal.threadId}`),
    )
    for (const [_key, { session }] of threadSessions) {
      if (signal.type === 'amygdala_interrupt') {
        await session.steer(`[AMYGDALA INTERRUPT] ${signal.message}`)
      } else if (signal.type === 'dmn_correction') {
        await session.followUp(`[DMN CORRECTION] ${signal.message}`)
      }
    }
    // If no active session for this thread, persist signal for delivery on next activation
    if (threadSessions.length === 0) {
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

  // ── BrainAdapter.resetSession() ───────────────────────────────────────────────

  resetSession(brain: CognitiveBrainType, threadId: string): void {
    this.sessions.delete(`${brain}:${threadId}`)
  }

  resetAllSessions(): void {
    this.sessions.clear()
  }
}
