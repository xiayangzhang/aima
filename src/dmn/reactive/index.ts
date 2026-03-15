import { randomUUID } from 'node:crypto'
import type { BrainEvent } from '../../adapters/index'
import { callLlm, parseLlmJson } from '../../llm'
import type { BrainType, UsageOutcome } from '../../types/index'
import type { CognitiveWorkspace } from '../../workspace/index'
import type { DmnConfig } from '../index'

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

// ─── Segment state (process-level, resets on restart) ────────────────────────

interface SegmentState {
  segmentId: string
  nextSeq: number
}

// ─── DmnReactive ─────────────────────────────────────────────────────────────

export class DmnReactive {
  private unsubscribe: (() => void) | undefined = undefined
  private readonly inFlightHandlers = new Set<Promise<void>>()
  private readonly threadSegments = new Map<string, SegmentState>()

  constructor(private readonly config: DmnReactiveConfig) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return
    await this.restoreSegmentTracking()
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

  private async restoreSegmentTracking(): Promise<void> {
    const states = await this.config.workspace.getLatestSegmentStates()
    for (const [threadId, state] of states) {
      this.threadSegments.set(threadId, state)
    }
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

    // Responsibility 6: DEFER scheduling (limbic slot.done with output.next=self)
    if (
      event_type === 'slot.done' &&
      brain === 'limbic' &&
      (payload.output as Record<string, unknown> | undefined)?.next === 'self'
    ) {
      await this.handleDefer(event)
    }

    // Amygdala interrupt: episodic memory + significance mark
    if (event_type === 'amygdala.interrupt' && level === 'ALERT') {
      await this.handleAmygdalaInterrupt(event)
    }

    // Responsibility 7: signal capture (INFO+ events)
    if (level === 'INFO' || level === 'COMPLIANCE' || level === 'ALERT') {
      await this.handleSignalCapture(event)
    }

    // Responsibilities 2/3/4/5: brain.complete four-way parallel
    if (event_type === 'brain.complete') {
      await this.handleBrainComplete(event)
    }
  }

  // ── brain.complete: four responsibilities in parallel ──────────────────────

  private async handleBrainComplete(event: BrainEvent): Promise<void> {
    const { brain, thread_id } = event
    if (!thread_id) return

    // Enrich the event with real Slot + Thread data from workspace.
    // Sub-responsibilities read payload.outputSlot and payload.thread instead of
    // receiving undefined (the brain.complete emitter does not include slot data).
    const [slots, thread] = await Promise.all([
      this.config.workspace.getSlotsByThread(thread_id),
      this.config.workspace.getThread(thread_id),
    ])
    const outputSlot = slots.find((s) => s.brain === brain) ?? null

    const enrichedEvent: BrainEvent = {
      ...event,
      payload: { ...event.payload, outputSlot, thread },
    }

    await Promise.all([
      this.assignSegmentAndWriteEpisodic(enrichedEvent), // Responsibility 3 + 4
      this.feedbackMemoryUsage(enrichedEvent), // Responsibility 5
      this.retroactiveCorrection(enrichedEvent), // Responsibility 2
    ])
  }

  // ── Responsibility 3 + 4: Segment assignment + episodic write + significance ─

  private async assignSegmentAndWriteEpisodic(event: BrainEvent): Promise<void> {
    const { brain, thread_id, payload } = event
    if (!thread_id) return
    const workspace = this.config.workspace

    const needNewSegment = await this.shouldStartNewSegment(event)
    let segState = this.threadSegments.get(thread_id)
    if (!segState || needNewSegment) {
      segState = { segmentId: randomUUID(), nextSeq: 0 }
      this.threadSegments.set(thread_id, segState)
    }

    const { segmentId } = segState
    const segmentSeq = segState.nextSeq++

    const significanceBoost = (payload.significance_boost as number | undefined) ?? 0
    const baseImportance = Math.min(1.0, 0.5 + significanceBoost)

    await workspace.writeMemory({
      type: 'episodic',
      sourceBrain: brain,
      threadId: thread_id,
      segmentId,
      segmentSeq,
      content: this.buildEpisodicContent(event),
      baseImportance,
      tags: ['brain_complete', brain, `thread:${thread_id}`],
    })

    // Significance mark (Responsibility 4): extra record when boost present
    if (significanceBoost > 0) {
      await workspace.writeMemory({
        type: 'episodic',
        sourceBrain: brain,
        threadId: thread_id,
        segmentId,
        segmentSeq: segState.nextSeq++,
        content: JSON.stringify({
          event_type: 'significance_mark',
          boost: significanceBoost,
          trigger: 'amygdala',
          original_brain: brain,
        }),
        baseImportance: Math.min(1.0, 0.7 + significanceBoost),
        tags: ['significance_mark', 'amygdala', `thread:${thread_id}`],
      })
    }
  }

  private async shouldStartNewSegment(event: BrainEvent): Promise<boolean> {
    const { thread_id, payload } = event

    if (!thread_id || !this.threadSegments.has(thread_id)) return true

    const outputSlot = payload.outputSlot as Record<string, unknown> | undefined
    if (outputSlot?.status === 'error') return true

    const output = outputSlot?.output as Record<string, unknown> | undefined
    if (output?.next === 'cortex' && output.needs_analysis) return true

    // Topic switch check: only on RESPOND output with enough context
    // Respond = has reply and no further routing (thread ends)
    const segState = this.threadSegments.get(thread_id)
    if (output?.reply != null && !output?.next && segState && segState.nextSeq > 5) {
      return await this.isTopicSwitch(event)
    }

    return false
  }

  private async isTopicSwitch(event: BrainEvent): Promise<boolean> {
    if (!event.thread_id) return false

    const recent = await this.config.workspace.searchMemory({
      type: 'episodic',
      tags: ['brain_complete', `thread:${event.thread_id}`],
      limit: 3,
      excludeInvalid: true,
    })
    if (recent.length < 2) return false

    const outputSlot = event.payload.outputSlot as Record<string, unknown> | undefined
    const prompt = `Compare these two consecutive brain outputs and determine if the topic has significantly shifted.

Previous output summary: ${recent[1]?.content.slice(0, 200) ?? 'N/A'}
Current output: ${JSON.stringify(outputSlot?.output ?? {}).slice(0, 200)}

Respond with JSON: {"topic_switched": boolean, "reason": string}`

    const { text, usage } = await callLlm(prompt, this.config.llm)
    this.config.eventBus.emit({
      event_type: 'brain.token_usage',
      level: 'INFO',
      brain: 'dmn',
      thread_id: event.thread_id,
      payload: { brain: 'dmn', threadId: event.thread_id, tokenUsage: usage },
    })
    const result = parseLlmJson<{ topic_switched: boolean }>(text, { topic_switched: false })
    return result.topic_switched
  }

  private buildEpisodicContent(event: BrainEvent): string {
    const { brain, thread_id, payload } = event
    const outputSlot = payload.outputSlot as Record<string, unknown> | null | undefined
    const output = outputSlot?.output as Record<string, unknown> | undefined
    const status = outputSlot?.status as string | undefined
    const next = (output?.next as string | undefined) ?? null
    const handoff = (output?.handoff as string | undefined) ?? null
    const reply = (output?.reply as string | undefined) ?? null
    const stopReason = payload.stopReason as string | undefined

    // Extract situation: from slot.input.handoff (upstream handoff) or thread.trigger
    const slotInput = outputSlot?.input as Record<string, unknown> | null | undefined
    const handoffIn = (slotInput?.handoff as string | undefined) ?? null
    const thread = (payload.thread as { trigger?: string | null } | undefined) ?? null
    const situation = handoffIn ?? thread?.trigger ?? null

    // Derive routing decision token
    // 'end_turn' = raw LLM stop reason; 'done' = adapter-normalized success — both are non-error
    const decision =
      stopReason && stopReason !== 'end_turn' && stopReason !== 'done'
        ? 'error'
        : next === null || next === undefined
          ? 'complete'
          : next === 'self'
            ? 'defer'
            : `route → ${next}`

    const parts: string[] = [`[${brain}]`]

    if (situation) {
      parts.push(`situation: "${situation.slice(0, 200)}"`)
    }
    parts.push(`decided: ${decision}`)
    if (handoff) {
      parts.push(`handoff: "${handoff.slice(0, 200)}"`)
    }
    if (reply) {
      parts.push(`reply: "${reply.slice(0, 100)}"`)
    }
    if (decision === 'error' && stopReason) {
      parts.push(`stopReason: ${stopReason}`)
    }
    parts.push(`status: ${status ?? 'unknown'}`)
    parts.push(`thread: ${thread_id}`)

    return parts.join(' | ')
  }

  // ── Responsibility 5: Memory usage feedback ────────────────────────────────

  private async feedbackMemoryUsage(event: BrainEvent): Promise<void> {
    const injectedIds = event.payload.injectedMemoryIds as string[] | undefined
    if (!injectedIds || injectedIds.length === 0) return

    // Pre-compute heuristic outcome — always available as fallback
    const fallbackOutcome = this.evaluateOutcome(event)

    // Goal-based evaluation: attempt quality signal if thread has a goal
    if (event.thread_id) {
      try {
        const thread = await this.config.workspace.getThread(event.thread_id)
        const goal = thread?.goal

        if (goal) {
          const outputSlot = event.payload.outputSlot as Record<string, unknown> | undefined
          const output = outputSlot?.output as Record<string, unknown> | undefined
          const reply = output?.reply as string | undefined

          if (reply) {
            const prompt = `You are evaluating whether an AI response achieved a stated goal.

Goal: ${goal}

Response: ${reply}

Did the response achieve the goal? Respond with JSON: {"achieved": boolean, "reason": string}`

            const { text: llmResponse, usage: feedbackUsage } = await callLlm(
              prompt,
              this.config.llm,
            )
            this.config.eventBus.emit({
              event_type: 'brain.token_usage',
              level: 'INFO',
              brain: 'dmn',
              thread_id: event.thread_id,
              payload: { brain: 'dmn', threadId: event.thread_id, tokenUsage: feedbackUsage },
            })
            const result = parseLlmJson<{ achieved: boolean; reason: string }>(llmResponse, {
              achieved: false,
              reason: 'evaluation failed',
            })
            const outcome: UsageOutcome = result.achieved ? 'positive' : 'negative'
            await this.config.workspace.markMemoryUsed(injectedIds, outcome)
            return
          }
        }
      } catch {
        // Goal evaluation failed — fall through to heuristic
      }
    }

    await this.config.workspace.markMemoryUsed(injectedIds, fallbackOutcome)
  }

  private evaluateOutcome(event: BrainEvent): UsageOutcome {
    const outputSlot = event.payload.outputSlot as Record<string, unknown> | undefined
    const output = outputSlot?.output as Record<string, unknown> | undefined

    if (outputSlot?.status === 'error') return 'negative'
    if (event.payload.stopReason === 'error') return 'negative'
    // Positive: brain produced a user-visible reply OR triggered execution
    if (output?.reply != null) return 'positive'
    if (output?.next === 'brainstem') return 'positive'

    return 'neutral'
  }

  // ── Responsibility 2: Retroactive correction ───────────────────────────────

  private async retroactiveCorrection(event: BrainEvent): Promise<void> {
    const { brain, thread_id, payload } = event
    if (!thread_id) return

    // Rule pre-check: only run LLM correction if there's a clear anomaly signal
    const outputSlot = payload.outputSlot as Record<string, unknown> | undefined
    const output = outputSlot?.output as Record<string, unknown> | undefined

    const hasError = outputSlot?.status === 'error'
    const hasErrorStop = payload.stopReason === 'error'
    const hasNoOutput = output == null

    if (!hasError && !hasErrorStop && !hasNoOutput) return // healthy output — skip

    const windowSize = this.config.retroactionWindowSize ?? 20

    const recentEvents = await this.config.workspace.searchMemory({
      type: 'episodic',
      tags: ['brain_complete', `thread:${thread_id}`],
      limit: windowSize,
      excludeInvalid: true,
    })

    if (recentEvents.length < 2) return

    const prompt = `You are reviewing recent brain activity for potential errors requiring correction.

Brain: ${brain}
Thread: ${thread_id}
Recent activity (most recent last):
${recentEvents
  .map((e) => e.content)
  .slice(-5)
  .join('\n---\n')}

Current output: ${JSON.stringify(outputSlot?.output ?? {})}

Determine if any correction is needed. Respond with JSON:
{
  "needs_correction": boolean,
  "correction_type": "factual_error" | "reasoning_error" | "task_deviation" | null,
  "correction_message": string
}

Only set needs_correction=true if there is a clear, significant error. Be conservative.`

    const { text: response, usage: correctionUsage } = await callLlm(prompt, this.config.llm)
    this.config.eventBus.emit({
      event_type: 'brain.token_usage',
      level: 'INFO',
      brain: 'dmn',
      thread_id: thread_id,
      payload: { brain: 'dmn', threadId: thread_id, tokenUsage: correctionUsage },
    })
    const result = parseLlmJson<{
      needs_correction: boolean
      correction_type: string | null
      correction_message: string
    }>(response, { needs_correction: false, correction_type: null, correction_message: '' })

    if (result.needs_correction && result.correction_message) {
      this.config.workspace.pushSignal({
        type: 'dmn_correction',
        threadId: thread_id,
        message: result.correction_message,
      })

      this.config.eventBus.emit({
        event_type: 'dmn.correction_issued',
        level: 'COMPLIANCE',
        brain: 'dmn',
        thread_id,
        payload: { correctionType: result.correction_type, targetBrain: brain },
      })
    }
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

    // No rule matched + unhandled ALERT (non-retryable, not amygdala.interrupt) → Haiku fallback
    if (
      event.level === 'ALERT' &&
      !event.payload.retryable &&
      event.event_type !== 'amygdala.interrupt'
    ) {
      await this.haikuSignalFallback(event)
    }
  }

  // ── Amygdala interrupt: episodic write + significance mark ─────────────────

  private async handleAmygdalaInterrupt(event: BrainEvent): Promise<void> {
    const { thread_id, payload } = event
    const workspace = this.config.workspace
    const significanceBoost = (payload.significance_boost as number | undefined) ?? 0

    await workspace.writeMemory({
      type: 'episodic',
      sourceBrain: 'amygdala',
      ...(thread_id != null ? { threadId: thread_id } : {}),
      content: JSON.stringify({
        event_type: 'amygdala_interrupt',
        tool: payload.tool,
        decision: payload.decision,
        reason: payload.reason,
        boost: significanceBoost,
      }),
      baseImportance: Math.min(1.0, 0.5 + significanceBoost),
      tags: ['amygdala_interrupt', 'amygdala'],
    })

    if (significanceBoost > 0) {
      await workspace.writeMemory({
        type: 'episodic',
        sourceBrain: 'amygdala',
        ...(thread_id != null ? { threadId: thread_id } : {}),
        content: JSON.stringify({
          event_type: 'significance_mark',
          boost: significanceBoost,
          trigger: 'amygdala',
          original_brain: 'amygdala',
        }),
        baseImportance: Math.min(1.0, 0.7 + significanceBoost),
        tags: ['significance_mark', 'amygdala'],
      })
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

    const { text: response, usage: fallbackUsage } = await callLlm(prompt, this.config.llm)
    this.config.eventBus.emit({
      event_type: 'brain.token_usage',
      level: 'INFO',
      brain: 'dmn',
      thread_id: event.thread_id,
      payload: { brain: 'dmn', threadId: event.thread_id, tokenUsage: fallbackUsage },
    })
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
