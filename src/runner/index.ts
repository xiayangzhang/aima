import type { BrainAdapter, BrainRunParams } from '../adapters/index'
import { assembleBlock12, assembleContext } from '../context/index'
import type { ContextAssemblerConfig } from '../context/index'
import type { BrainEventBus } from '../eventbus/index'
import type { CognitiveBrainType } from '../types/index'
import type { CognitiveWorkspace } from '../workspace/index'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ThreadRunnerConfig {
  workspace: CognitiveWorkspace
  eventBus: BrainEventBus
  adapters: Map<CognitiveBrainType, BrainAdapter>
  assemblerConfig: ContextAssemblerConfig
}

// ─── ThreadRunner ─────────────────────────────────────────────────────────────

export class ThreadRunner {
  private readonly workspace: CognitiveWorkspace
  private readonly eventBus: BrainEventBus
  private readonly adapters: Map<CognitiveBrainType, BrainAdapter>
  private readonly assemblerConfig: ContextAssemblerConfig
  private readonly cachedBlock12: Record<CognitiveBrainType, string>
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

        let nextBrain: CognitiveBrainType | null = null

        if (currentBrain === 'limbic') {
          const output = slotMap.limbic?.output as Record<string, unknown> | null
          const mode = output?.mode as string | undefined

          if (mode === 'RESPOND' || mode === 'NO_REPLY') {
            await this.workspace.updateThreadState(threadId, 'complete')
            this.workspace.notifyThreadComplete(threadId)
            return
          }
          if (mode === 'ROUTE') {
            nextBrain = 'cortex'
          } else if (mode === 'EXECUTE') {
            nextBrain = 'brainstem'
          } else if (mode === 'DEFER') {
            const timeoutMs = (output?.timeout_ms as number | undefined) ?? 60_000
            const triggerAt = new Date(Date.now() + timeoutMs)
            await this.workspace.writePending({
              targetBrain: 'limbic',
              note: 'DEFER timeout — re-activate Limbic with channel downgrade',
              triggerAt,
              expiresAt: new Date(triggerAt.getTime() + 7 * 24 * 60 * 60 * 1000),
            })
            return
          }
        } else if (currentBrain === 'cortex') {
          const output = slotMap.cortex?.output as Record<string, unknown> | null
          const intent = output?.intent as string | undefined

          if (intent === 'communicate') {
            nextBrain = 'limbic'
          } else if (intent === 'execute') {
            nextBrain = 'brainstem'
          } else if (intent === 'both') {
            // First activate Limbic (tentative reply); Brainstem follows when Limbic done
            nextBrain = 'limbic'
          }
        } else if (currentBrain === 'brainstem') {
          const cortexOutput = slotMap.cortex?.output as Record<string, unknown> | null
          if (cortexOutput?.intent === 'both') {
            // intent=both path: Brainstem done → final Limbic confirmation
            nextBrain = 'limbic'
          } else {
            await this.workspace.updateThreadState(threadId, 'complete')
            this.workspace.notifyThreadComplete(threadId)
            return
          }
        }

        if (!nextBrain) return
        await this.activateBrain(nextBrain, threadId)
        currentBrain = nextBrain
      }
    } finally {
      this.processingThreads.delete(threadId)
    }
  }

  // ── Brain Activation ─────────────────────────────────────────────────────────

  /** Trigger a brain activation from outside the routing loop (e.g. AIMAInstance.receive()). */
  async trigger(brain: CognitiveBrainType, threadId: string): Promise<void> {
    await this.activateBrain(brain, threadId)
  }

  private async activateBrain(brain: CognitiveBrainType, threadId: string): Promise<void> {
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

  // ── Pending Observations Routing ─────────────────────────────────────────────

  async routePending(): Promise<void> {
    if (!this.running) return
    const now = new Date()
    await this.workspace.removeExpiredPending(now)
    const pending = await this.workspace.getPendingObservations()

    for (const item of pending) {
      if (item.triggerAt !== null && item.triggerAt > now) continue

      const thread = await this.workspace.createThread({
        initiatedBy: 'dmn',
        trigger: item.note,
        sourceChannel: null,
      })

      await this.activateBrain(item.targetBrain as CognitiveBrainType, thread.id)
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
