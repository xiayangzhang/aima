import type { BrainEvent } from '../../adapters/index'
import type { BrainType } from '../../types/index'
import type { CognitiveWorkspace } from '../../workspace/index'
import type { DmnConfig } from '../index'
import { callLlm, parseLlmJson } from '../llm'

// ─── SignalRule ───────────────────────────────────────────────────────────────

export interface SignalRule {
  match: (event: BrainEvent) => boolean
  handle: (event: BrainEvent, workspace: CognitiveWorkspace) => Promise<void>
}

const DEFAULT_SIGNAL_RULES: SignalRule[] = [
  {
    // Cross-thread follow-up: brain.complete with creates_followup flag
    match: (event) =>
      event.event_type === 'brain.complete' &&
      Boolean((event.payload.output as Record<string, unknown> | undefined)?.creates_followup),
    handle: async (event, workspace) => {
      const output = event.payload.output as Record<string, unknown>
      await workspace.writePending({
        targetBrain: (output.followup_brain as BrainType | undefined) ?? 'limbic',
        note: (output.followup_note as string | undefined) ?? 'Follow-up from completed task',
        triggerAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        baseImportance: 0.6,
      })
    },
  },
]

// ─── DmnReactive ─────────────────────────────────────────────────────────────

type DmnReactiveConfig = DmnConfig & {
  eventBus: NonNullable<DmnConfig['eventBus']>
  signalRules?: SignalRule[]
}

export class DmnReactive {
  private unsubscribe: (() => void) | undefined = undefined
  private readonly inFlightHandlers = new Set<Promise<void>>()

  constructor(private readonly config: DmnReactiveConfig) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return
    const { eventBus } = this.config

    this.unsubscribe = eventBus.subscribe((event) => {
      // Synchronous entry: fire-and-forget, errors are isolated per handler
      const p = this.handleEvent(event).catch((err) => {
        eventBus.emit({
          event_type: 'dmn.handler_error',
          level: 'ALERT',
          brain: 'dmn',
          thread_id: event.thread_id,
          payload: { error: String(err), originalEvent: event.event_type },
        })
      })
      this.inFlightHandlers.add(p)
      p.finally(() => this.inFlightHandlers.delete(p))
    })
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    // Wait for in-flight handlers, up to 10 seconds
    await Promise.race([
      Promise.all([...this.inFlightHandlers]),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ])
  }

  // ── Event routing ───────────────────────────────────────────────────────────

  private async handleEvent(event: BrainEvent): Promise<void> {
    const { level, event_type, brain, payload } = event

    // Responsibility 1: error recovery (ALERT events with retryable flag present)
    if (level === 'ALERT' && 'retryable' in payload) {
      await this.handleErrorRecovery(event)
    }

    // Responsibility 6: DEFER scheduling (limbic slot.done with output.mode=DEFER)
    if (
      event_type === 'slot.done' &&
      brain === 'limbic' &&
      (payload.output as Record<string, unknown> | undefined)?.mode === 'DEFER'
    ) {
      await this.handleDefer(event)
    }

    // Responsibility 7: signal capture (INFO+ events)
    if (level === 'INFO' || level === 'COMPLIANCE' || level === 'ALERT') {
      await this.handleSignalCapture(event)
    }

    // Responsibilities 2/3/4/5 implemented in WP03 (brain.complete routing)
  }

  // ── Responsibility 1: Error recovery ───────────────────────────────────────

  private async handleErrorRecovery(event: BrainEvent): Promise<void> {
    const { brain, thread_id, payload } = event
    if (!thread_id) return

    const { workspace, eventBus } = this.config
    const maxRetries = this.config.maxRetries ?? 3

    // Thread-scoped tag to isolate retry counts per thread
    const threadTag = `thread:${thread_id}`
    const retryMemories = await workspace.searchMemory({
      type: 'working',
      tags: ['dmn_retry_count', threadTag],
      excludeInvalid: true,
      limit: 1,
    })

    const retryRecord = retryMemories[0]
    const retryData = retryRecord
      ? (JSON.parse(retryRecord.content) as { count: number; brain: string })
      : { count: 0, brain }

    if (payload.retryable && retryData.count < maxRetries) {
      // Retryable: reset slot to pending so ThreadRunner re-activates it
      await workspace.writeSlot(thread_id, brain, {
        status: 'pending',
        output: {
          retry: true,
          retryCount: retryData.count + 1,
          lastError: (payload.errorMessage as string | undefined) ?? 'unknown',
        },
      })

      // Persist updated retry count in working memory
      await workspace.writeMemory({
        type: 'working',
        threadId: thread_id,
        content: JSON.stringify({ count: retryData.count + 1, brain }),
        tags: ['dmn_retry_count', threadTag],
        baseImportance: 1.0,
      })

      eventBus.emit({
        event_type: 'dmn.retry_scheduled',
        level: 'INFO',
        brain: 'dmn',
        thread_id,
        payload: { targetBrain: brain, retryCount: retryData.count + 1 },
      })
    } else {
      // Non-retryable or max retries exceeded: interrupt thread
      await workspace.updateThreadState(thread_id, 'interrupted')

      eventBus.emit({
        event_type: 'dmn.thread_interrupted',
        level: 'ALERT',
        brain: 'dmn',
        thread_id,
        payload: {
          reason: payload.retryable ? 'max_retries_exceeded' : 'non_retryable_error',
          errorMessage: payload.errorMessage,
        },
      })
    }
  }

  // ── Responsibility 6: DEFER scheduling ────────────────────────────────────

  private async handleDefer(event: BrainEvent): Promise<void> {
    const { thread_id, payload } = event
    const { workspace, eventBus } = this.config

    const output = payload.output as Record<string, unknown> | undefined
    const timeoutMs = (output?.timeout_ms as number | undefined) ?? 3_600_000
    const deferReason = (output?.defer_reason as string | undefined) ?? 'unspecified'
    const triggerAt = new Date(Date.now() + timeoutMs)

    await workspace.writePending({
      targetBrain: 'limbic',
      note: `[DEFER recovery] Original reason: ${deferReason}. Thread: ${thread_id ?? 'unknown'}`,
      triggerAt,
      expiresAt: new Date(triggerAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      baseImportance: 0.5,
    })

    eventBus.emit({
      event_type: 'dmn.defer_scheduled',
      level: 'INFO',
      brain: 'dmn',
      thread_id,
      payload: { triggerAt: triggerAt.toISOString(), reason: deferReason },
    })
  }

  // ── Responsibility 7: Signal capture ──────────────────────────────────────

  private async handleSignalCapture(event: BrainEvent): Promise<void> {
    const rules = this.config.signalRules ?? DEFAULT_SIGNAL_RULES

    for (const rule of rules) {
      if (rule.match(event)) {
        await rule.handle(event, this.config.workspace)
        return // first matching rule wins
      }
    }

    // No rule matched + unhandled ALERT (non-retryable) → Haiku fallback
    if (event.level === 'ALERT' && !event.payload.retryable) {
      await this.haikuSignalFallback(event)
    }
  }

  private async haikuSignalFallback(event: BrainEvent): Promise<void> {
    const prompt = `You are analyzing an AIMA brain event to determine if it requires a follow-up action.

Event: ${JSON.stringify(event, null, 2)}

Respond with JSON:
{
  "requires_followup": boolean,
  "target_brain": "limbic" | "cortex" | "brainstem" | null,
  "note": string
}

Only set requires_followup=true if there is a clear, actionable follow-up needed.`

    const response = await callLlm(prompt, this.config.llm)
    const result = parseLlmJson<{
      requires_followup: boolean
      target_brain: BrainType | null
      note: string
    }>(response, { requires_followup: false, target_brain: null, note: '' })

    if (result.requires_followup && result.target_brain) {
      await this.config.workspace.writePending({
        targetBrain: result.target_brain,
        note: result.note,
        triggerAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        baseImportance: 0.4,
      })
    }
  }
}
