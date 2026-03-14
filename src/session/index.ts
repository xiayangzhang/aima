import type { BrainEvent } from '../adapters/index'
import { getEventBus } from '../eventbus/index'
import { AIMAInstance, createAIMAInstance } from '../instance'
import type { CognitiveBrainType, Slot, Thread, ThreadState } from '../types/index'
import type {
  AIMASessionEvent,
  AIMASessionEventListener,
  CreateAIMASessionOptions,
  PromptResult,
} from './types'

export type { AIMASessionEvent, AIMASessionEventListener, CreateAIMASessionOptions, PromptResult }

// ─── AIMASession ──────────────────────────────────────────────────────────────

/**
 * High-level session wrapper for AIMAInstance.
 *
 * Provides a pi-coding-agent-compatible interaction model with fire-and-forget
 * prompt(), synchronous promptAndWait(), steer(), followUp(), newThread(), and
 * a typed event subscription API.
 *
 * Usage:
 *   const session = await createAIMASession({ databaseUrl: '...' })
 *   const result = await session.promptAndWait('Hello!')
 *   console.log(result.reply)
 *   await session.dispose()
 */
export class AIMASession {
  private readonly instance: AIMAInstance

  private _currentThreadId: string | null = null
  private _isProcessing = false
  private _followUpQueue: string[] = []
  private _listeners: Set<AIMASessionEventListener> = new Set()
  private _eventBusUnsub: (() => void) | null = null

  // Pending waiters: threadId → { resolve, capturedReply }
  private _waiters: Map<
    string,
    { resolve: (result: PromptResult) => void; reply: string | null; state: ThreadState }
  > = new Map()

  private constructor(instance: AIMASession['instance']) {
    this.instance = instance
    this._setupEventBridge()
  }

  // ── Factory ──────────────────────────────────────────────────────────────────

  static async create(options: CreateAIMASessionOptions): Promise<AIMASession> {
    const instance = await createAIMAInstance({
      databaseUrl: options.databaseUrl,
      adapter: options.adapter ?? 'pi-coding-agent',
      ...(options.identityDir !== undefined ? { identityDir: options.identityDir } : {}),
      ...(options.identities !== undefined ? { identities: options.identities } : {}),
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.brainModels !== undefined ? { brainModels: options.brainModels } : {}),
      ...(options.executionModel !== undefined ? { executionModel: options.executionModel } : {}),
      ...(options.enableDmn !== undefined ? { enableDmn: options.enableDmn } : {}),
      ...(options.enableHippocampus !== undefined
        ? { enableHippocampus: options.enableHippocampus }
        : {}),
      ...(options.skillIndex !== undefined ? { skillIndex: options.skillIndex } : {}),
      ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
      ...(options.amygdala !== undefined ? { amygdala: options.amygdala } : {}),
      ...(options.embedding !== undefined ? { embedding: options.embedding } : {}),
    })
    return new AIMASession(instance)
  }

  // ── Core Interaction ─────────────────────────────────────────────────────────

  /**
   * Fire-and-forget: create a new Thread and trigger processing.
   * Returns the threadId immediately without waiting for completion.
   * Subscribe to events or call promptAndWait() for synchronous behavior.
   *
   * Equivalent to pi-coding-agent's session.prompt() but non-blocking.
   */
  async prompt(text: string, options?: { channel?: string }): Promise<string> {
    const threadId = await this.instance.receiveAsync({
      content: text,
      ...(options?.channel !== undefined ? { channel: options.channel } : {}),
    })
    this._currentThreadId = threadId
    this._isProcessing = true
    this._emit({ type: 'thread_start', threadId })
    return threadId
  }

  /**
   * Synchronous version: create a new Thread and wait for completion.
   * Returns a PromptResult with the reply text and final slot snapshot.
   */
  async promptAndWait(text: string, options?: { channel?: string }): Promise<PromptResult> {
    const threadId = await this.prompt(text, options)
    return this._waitForThread(threadId)
  }

  /**
   * Fire-and-forget continue: inject new input into the current Thread.
   * Requires an active or completed thread (currentThreadId must be set).
   *
   * Equivalent to pi-coding-agent's concept of continuing a conversation.
   */
  async continue(text: string): Promise<void> {
    if (!this._currentThreadId) {
      throw new Error('No active thread. Call prompt() first.')
    }
    this._isProcessing = true
    await this.instance.continueAsync(this._currentThreadId, { content: text })
  }

  /**
   * Synchronous continue: inject new input into the current Thread and wait for completion.
   */
  async continueAndWait(text: string): Promise<PromptResult> {
    await this.continue(text)
    if (!this._currentThreadId) throw new Error('No active thread')
    return this._waitForThread(this._currentThreadId)
  }

  /**
   * Real-time interrupt injection into the currently running brain.
   * Equivalent to pi-coding-agent's session.steer().
   *
   * Pushes an amygdala_interrupt signal to all brain adapters. The active
   * adapter delivers it in real-time; idle adapters queue it for next activation.
   */
  steer(text: string): void {
    if (!this._currentThreadId) return
    void this.instance.injectToThread(this._currentThreadId, 'amygdala_interrupt', text)
  }

  /**
   * Queue a follow-up message to be sent after the current Thread completes.
   * Equivalent to pi-coding-agent's session.followUp().
   */
  followUp(text: string): void {
    this._followUpQueue.push(text)
  }

  /**
   * Abort the current Thread processing.
   */
  async abort(): Promise<void> {
    if (!this._currentThreadId) return
    this._isProcessing = false
    this._followUpQueue = []
    // Abort all brain adapters
    this.instance.resetBrainSessions()
    this._currentThreadId = null
  }

  /**
   * Subscribe to session events. Returns an unsubscribe function.
   * Equivalent to pi-coding-agent's session.subscribe().
   */
  subscribe(listener: AIMASessionEventListener): () => void {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  // ── newThread() ──────────────────────────────────────────────────────────────

  /**
   * Reset all brain LLM sessions — "new conversation, same person".
   *
   * Clears all brain LLM conversation history (in-memory session state).
   * Does NOT clear DB records (Thread/Slot/Memory) — Alex retains all memories
   * and knowledge. The next prompt() creates a new DB Thread with fresh brain
   * sessions, but the same accumulated experience.
   *
   * Semantically different from pi-coding-agent's newSession():
   *   pi:   new JSONL file, completely blank history
   *   AIMA: reset LLM history only, memory system persists
   */
  async newThread(): Promise<void> {
    if (this._currentThreadId && this._isProcessing) {
      await this.abort()
    }
    this.instance.resetBrainSessions()
    this._currentThreadId = null
    this._followUpQueue = []
  }

  // ── AIMA Extensions ──────────────────────────────────────────────────────────

  /** Current active Thread ID, or null if no thread is active. */
  get currentThreadId(): string | null {
    return this._currentThreadId
  }

  /**
   * Query Thread state. Returns the current thread if no threadId provided.
   */
  async getThread(threadId?: string): Promise<Thread | null> {
    const id = threadId ?? this._currentThreadId
    if (!id) return null
    return this.instance.workspace.getThread(id)
  }

  /**
   * Query all Slots for a Thread. Returns slots for the current thread if no threadId.
   */
  async getSlots(threadId?: string): Promise<Slot[]> {
    const id = threadId ?? this._currentThreadId
    if (!id) return []
    return this.instance.workspace.getSlotsByThread(id)
  }

  /**
   * Read a specific brain's Slot for a Thread.
   */
  async getSlot(brain: CognitiveBrainType, threadId?: string): Promise<Slot | null> {
    const id = threadId ?? this._currentThreadId
    if (!id) return null
    return this.instance.workspace.readSlot(id, brain)
  }

  /**
   * Reload identity files from identityDir. No-op if identityDir not configured.
   */
  async reloadIdentity(): Promise<void> {
    await this.instance.reloadIdentity()
  }

  /**
   * Shut down the session and all underlying services.
   */
  async dispose(): Promise<void> {
    this._eventBusUnsub?.()
    this._eventBusUnsub = null
    this._listeners.clear()
    this._waiters.clear()
    await this.instance.stop()
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private _emit(event: AIMASessionEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event)
      } catch {
        // Never let a listener crash the session
      }
    }
  }

  private _setupEventBridge(): void {
    const bus = getEventBus()

    const handler = (rawEvent: BrainEvent) => {
      const threadId = rawEvent.thread_id
      const brain = rawEvent.brain as CognitiveBrainType

      switch (rawEvent.event_type) {
        case 'brain.activate':
          if (threadId && this._isCognitiveBrain(brain)) {
            this._emit({ type: 'brain_start', brain, threadId })
          }
          break

        case 'brain.complete':
          if (threadId && this._isCognitiveBrain(brain)) {
            this._emit({ type: 'brain_end', brain, threadId })
          }
          break

        case 'thread.reply':
          if (threadId) {
            const content = rawEvent.payload?.reply as string | undefined
            if (content) {
              this._emit({ type: 'reply', threadId, content })
              // Capture reply for waiters
              const waiter = this._waiters.get(threadId)
              if (waiter) waiter.reply = content
            }
          }
          break

        case 'thread.complete':
          if (threadId) {
            this._emit({ type: 'thread_end', threadId, state: 'complete' })
            this._onThreadEnd(threadId, 'complete')
          }
          break

        case 'thread.interrupted':
          if (threadId) {
            this._emit({ type: 'thread_end', threadId, state: 'interrupted' })
            this._onThreadEnd(threadId, 'interrupted')
          }
          break

        case 'tool.pre_use':
          if (threadId && this._isCognitiveBrain(brain)) {
            this._emit({
              type: 'tool_start',
              brain,
              toolName: rawEvent.payload?.tool as string,
              args: rawEvent.payload?.args,
            })
          }
          break

        case 'tool.post_use':
          if (threadId && this._isCognitiveBrain(brain)) {
            this._emit({
              type: 'tool_end',
              brain,
              toolName: rawEvent.payload?.tool as string,
              result: rawEvent.payload?.result,
              isError: Boolean(rawEvent.payload?.error),
            })
          }
          break
      }
    }

    this._eventBusUnsub = bus.subscribe(handler)
  }

  private _isCognitiveBrain(brain: string): brain is CognitiveBrainType {
    return brain === 'limbic' || brain === 'cortex' || brain === 'brainstem'
  }

  private async _onThreadEnd(threadId: string, state: ThreadState): Promise<void> {
    if (this._currentThreadId === threadId) {
      this._isProcessing = false
    }

    // Resolve any pending waiters
    const waiter = this._waiters.get(threadId)
    if (waiter) {
      waiter.state = state
      const slots = await this.instance.workspace.getSlotsByThread(threadId)
      waiter.resolve({
        threadId,
        reply: waiter.reply,
        finalState: state === 'complete' ? 'complete' : 'interrupted',
        slots,
      })
      this._waiters.delete(threadId)
    }

    // Process followUp queue if this is the active thread
    if (this._currentThreadId === threadId && state === 'complete') {
      const next = this._followUpQueue.shift()
      if (next) {
        await this.continue(next)
      }
    }
  }

  private _waitForThread(threadId: string): Promise<PromptResult> {
    return new Promise((resolve) => {
      this._waiters.set(threadId, { resolve, reply: null, state: 'complete' })
    })
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a new AIMASession — the high-level entry point for AIMA.
 * Drop-in replacement for pi-coding-agent's createAgentSession().
 *
 * Usage:
 *   const session = await createAIMASession({ databaseUrl: '...' })
 *   const result = await session.promptAndWait('Hello!')
 *   await session.dispose()
 */
export async function createAIMASession(options: CreateAIMASessionOptions): Promise<AIMASession> {
  return AIMASession.create(options)
}
