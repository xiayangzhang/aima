import type { BrainAdapter, BrainRunParams } from '../adapters/index'
import { assembleBlock12, assembleContext } from '../context/index'
import type { AssembleBlock4Opts, ContextAssemblerConfig } from '../context/index'
import type { BrainEventBus } from '../eventbus/index'
import type { BrainOutput, CognitiveBrainType, Slot, Thread } from '../types/index'
import type { CognitiveWorkspace } from '../workspace/index'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ThreadRunnerConfig {
  workspace: CognitiveWorkspace
  eventBus: BrainEventBus
  adapters: Map<CognitiveBrainType, BrainAdapter>
  assemblerConfig: ContextAssemblerConfig
}

// ─── Legal Transition Table ───────────────────────────────────────────────────

const LEGAL_TRANSITIONS: Record<CognitiveBrainType, Set<CognitiveBrainType | 'self' | null>> = {
  limbic: new Set<CognitiveBrainType | 'self' | null>(['cortex', 'brainstem', 'self', null]),
  cortex: new Set<CognitiveBrainType | 'self' | null>(['limbic', 'brainstem', null]),
  brainstem: new Set<CognitiveBrainType | 'self' | null>(['limbic', 'cortex', null]),
}

function isLegalTransition(
  from: CognitiveBrainType,
  to: CognitiveBrainType | 'self' | null | undefined,
): boolean {
  if (to === undefined) return true // undefined = null = thread ends (legal)
  return LEGAL_TRANSITIONS[from]?.has(to) ?? false
}

// ─── ThreadRunner ─────────────────────────────────────────────────────────────

export class ThreadRunner {
  private readonly workspace: CognitiveWorkspace
  private readonly eventBus: BrainEventBus
  private readonly adapters: Map<CognitiveBrainType, BrainAdapter>
  private assemblerConfig: ContextAssemblerConfig
  private cachedBlock12: Record<CognitiveBrainType, string>
  // `${brain}:${threadId}` → sessionId (resumes existing session within Thread)
  private readonly brainSessions: Map<string, string> = new Map()
  // Prevents concurrent routing for the same Thread
  private readonly processingThreads: Set<string> = new Set()
  private running = false
  private unsubscribeSlot: (() => void) | null = null
  private unsubscribeThread: (() => void) | null = null

  constructor(config: ThreadRunnerConfig) {
    this.workspace = config.workspace
    this.eventBus = config.eventBus
    this.adapters = config.adapters
    this.assemblerConfig = config.assemblerConfig
    // Block 1+2 computed once at construction (prompt cache prefix — must be byte-identical)
    this.cachedBlock12 = {
      limbic: assembleBlock12('limbic', config.assemblerConfig),
      cortex: assembleBlock12('cortex', config.assemblerConfig),
      brainstem: assembleBlock12('brainstem', config.assemblerConfig),
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true
    await this.recoverInFlightThreads()
    this.unsubscribeSlot = this.workspace.onSlotChange((event) => {
      void this.route(event)
    })
    this.unsubscribeThread = this.workspace.onThreadComplete((threadId) => {
      this.eventBus.emit({
        event_type: 'thread.complete',
        level: 'INFO',
        brain: 'dmn',
        thread_id: threadId,
        session_id: null,
        payload: { threadId },
      })
    })
  }

  /** Update assembler config and rebuild cached Block 1+2 prefixes. */
  updateAssemblerConfig(config: ContextAssemblerConfig): void {
    this.assemblerConfig = config
    this.cachedBlock12 = {
      limbic: assembleBlock12('limbic', config),
      cortex: assembleBlock12('cortex', config),
      brainstem: assembleBlock12('brainstem', config),
    }
  }

  stop(): void {
    this.running = false
    this.unsubscribeSlot?.()
    this.unsubscribeThread?.()
    this.unsubscribeSlot = null
    this.unsubscribeThread = null
  }

  // ── Core Routing ─────────────────────────────────────────────────────────────

  private async route(event: {
    threadId: string
    brain: CognitiveBrainType
    slotStatus: string
  }): Promise<void> {
    if (!this.running) return
    const { threadId, slotStatus } = event
    if (slotStatus !== 'done') return

    // Thread-level serialisation: skip if already routing this Thread.
    // The loop below drives the entire chain inside a single route() call, so
    // inner notifySlotDone-triggered route() calls are intentionally ignored.
    if (this.processingThreads.has(threadId)) return
    this.processingThreads.add(threadId)

    try {
      let currentBrain: CognitiveBrainType = event.brain

      // Drive the full routing chain iteratively so that each activateBrain()
      // result is processed inline — avoiding the re-entrancy issue where a
      // notifySlotDone fired inside activateBrain() would be blocked by the
      // processingThreads lock and leave the chain stuck.
      while (this.running) {
        const thread = await this.workspace.getThread(threadId)
        if (!thread || thread.state === 'complete' || thread.state === 'interrupted') return

        const slots = await this.workspace.getSlotsByThread(threadId)
        const slotMap = Object.fromEntries(slots.map((s) => [s.brain, s]))

        const output = (slotMap[currentBrain]?.output ?? null) as BrainOutput | null

        // Emit reply event before routing (brain can reply and end thread in same turn)
        if (output?.reply) {
          this.eventBus.emit({
            event_type: 'thread.reply',
            level: 'INFO',
            brain: currentBrain,
            thread_id: threadId,
            session_id: null,
            payload: { reply: output.reply, threadId },
          })
        }

        const next = output?.next ?? null

        // No next → thread ends
        if (next === null || next === undefined) {
          await this.workspace.updateThreadState(threadId, 'complete')
          this.workspace.notifyThreadComplete(threadId)
          return
        }

        // Validate legal transition (includes 'self' — only limbic can defer)
        if (!isLegalTransition(currentBrain, next)) {
          await this.workspace.updateThreadState(threadId, 'interrupted')
          this.eventBus.emit({
            event_type: 'thread.interrupted',
            level: 'ALERT',
            brain: currentBrain,
            thread_id: threadId,
            session_id: null,
            payload: { reason: 'illegal_transition', from: currentBrain, to: next },
          })
          return
        }

        // DEFER (self-routing — only valid for limbic per legal transition table)
        if (next === 'self') {
          await this.handleDefer(output, threadId)
          return
        }

        // Pass handoff to next brain's input slot before activation
        if (output?.handoff) {
          await this.workspace.writeSlot(threadId, next as CognitiveBrainType, {
            input: { handoff: output.handoff },
          })
        }

        const nextBrain = next as CognitiveBrainType
        const opts = this.buildBlock4Opts(nextBrain, thread, slotMap)
        await this.activateBrain(nextBrain, threadId, opts)
        currentBrain = nextBrain
      }
    } finally {
      this.processingThreads.delete(threadId)
    }
  }

  // ── DEFER handling ────────────────────────────────────────────────────────────

  private async handleDefer(output: BrainOutput | null, threadId: string): Promise<void> {
    const timeoutMs =
      ((output as Record<string, unknown> | null)?.timeout_ms as number | undefined) ?? 60_000
    const triggerAt = new Date(Date.now() + timeoutMs)
    await this.workspace.updateThreadState(threadId, 'waiting')
    await this.workspace.writePending({
      targetBrain: 'limbic',
      threadId,
      note: 'DEFER timeout — re-activate Limbic with channel downgrade',
      triggerAt,
      expiresAt: new Date(triggerAt.getTime() + 7 * 24 * 60 * 60 * 1000),
    })
  }

  // ── Brain Activation ─────────────────────────────────────────────────────────

  /** Trigger a brain activation from outside the routing loop (e.g. AIMAInstance.receive()). */
  async trigger(brain: CognitiveBrainType, threadId: string): Promise<void> {
    const thread = await this.workspace.getThread(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)

    const slots = await this.workspace.getSlotsByThread(threadId)
    const slotMap = Object.fromEntries(slots.map((s) => [s.brain, s]))

    const opts = this.buildBlock4Opts(brain, thread, slotMap)
    await this.activateBrain(brain, threadId, opts)
  }

  private async activateBrain(
    brain: CognitiveBrainType,
    threadId: string,
    opts?: AssembleBlock4Opts,
  ): Promise<void> {
    const adapter = this.adapters.get(brain)
    if (!adapter) throw new Error(`No adapter registered for brain: ${brain}`)

    const sessionKey = `${brain}:${threadId}`
    const existingSessionId = this.brainSessions.get(sessionKey)

    const { systemPrompt, injectedMemoryIds } = await assembleContext(
      brain,
      this.workspace,
      threadId,
      this.assemblerConfig,
      this.cachedBlock12[brain],
      opts,
    )

    this.eventBus.emit({
      event_type: 'brain.activate',
      level: 'INFO',
      brain,
      thread_id: threadId,
      session_id: existingSessionId ?? null,
      payload: { brain, threadId },
    })

    const params: BrainRunParams = existingSessionId
      ? { brain, threadId, systemPrompt }
      : { brain, threadId, systemPrompt, initialPrompt: `Thread ${threadId} — activate ${brain}` }

    const result = await adapter.run(params)

    // Persist session ID for future activations within this Thread
    this.brainSessions.set(sessionKey, result.sessionId)

    // Notify workspace (triggers route())
    this.workspace.notifySlotDone(threadId, brain, result.stopReason === 'done' ? 'done' : 'error')

    this.eventBus.emit({
      event_type: 'brain.complete',
      level: 'INFO',
      brain,
      thread_id: threadId,
      session_id: result.sessionId,
      payload: { brain, threadId, stopReason: result.stopReason, injectedMemoryIds },
    })
  }

  /**
   * Build Block 4 context hints for a brain activation.
   * Returns undefined when no meaningful hints are available (Block 4 falls back to generic retrieval).
   */
  private buildBlock4Opts(
    brain: CognitiveBrainType,
    thread: Pick<Thread, 'trigger' | 'entityId'>,
    slotMap: Record<string, Pick<Slot, 'output'> | undefined>,
  ): AssembleBlock4Opts | undefined {
    if (brain === 'limbic') {
      if (thread.entityId) return { entityId: thread.entityId }
      if (thread.trigger) return { situation: thread.trigger }
      return undefined
    }

    if (brain === 'cortex') {
      if (!thread.trigger) return undefined
      return { situation: thread.trigger }
    }

    if (brain === 'brainstem') {
      const cortexOutput = slotMap.cortex?.output as Record<string, unknown> | null | undefined
      const taskType = cortexOutput?.task_type as string | undefined
      const hint = taskType ?? thread.trigger ?? undefined
      if (!hint) return undefined
      return { taskType: hint }
    }

    return undefined
  }

  // ── Pending Observations Routing ─────────────────────────────────────────────

  async routePending(): Promise<void> {
    if (!this.running) return
    const now = new Date()
    await this.workspace.removeExpiredPending(now)
    const pending = await this.workspace.getPendingObservations()

    for (const item of pending) {
      if (item.triggerAt !== null && item.triggerAt > now) continue

      let targetThreadId: string
      if (item.threadId) {
        // DEFER recovery: resume the original thread
        await this.workspace.updateThreadState(item.threadId, 'active')
        targetThreadId = item.threadId
      } else {
        const thread = await this.workspace.createThread({
          initiatedBy: 'dmn',
          trigger: item.note,
          sourceChannel: null,
        })
        targetThreadId = thread.id
      }

      await this.activateBrain(item.targetBrain as CognitiveBrainType, targetThreadId)
      await this.workspace.removePending(item.id)
    }
  }

  // ── Crash Recovery ───────────────────────────────────────────────────────────

  private async recoverInFlightThreads(): Promise<void> {
    const activeThreads = await this.workspace.getActiveThreads()
    for (const thread of activeThreads) {
      const slots = await this.workspace.getSlotsByThread(thread.id)
      const doneSlots = slots.filter((s) => s.status === 'done')

      if (doneSlots.length === 0) {
        // Thread exists but Limbic was never activated
        await this.activateBrain('limbic', thread.id)
      } else {
        // Re-route from the most recently completed Slot
        const lastDone = doneSlots.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
        if (lastDone) {
          void this.route({
            threadId: thread.id,
            brain: lastDone.brain as CognitiveBrainType,
            slotStatus: 'done',
          })
        }
      }
    }
  }
}
