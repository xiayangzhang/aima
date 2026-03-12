import { callLlm, parseLlmJson, type LlmConfig } from '../llm'
import type { BrainEventBus } from '../eventbus/index'
import type { CognitiveWorkspace } from '../workspace/index'

// ─── Risk & Decision Types ────────────────────────────────────────────────────

export type ToolRiskLevel = 'low' | 'medium' | 'high'
export type AmygdalaDecision = 'allow' | 'block' | 'escalate'

// ─── Default Tool Permission Table ───────────────────────────────────────────

// Blocked by default (high-risk, pre-pi-coding-agent migration)
const DEFAULT_BLOCK_TOOLS = new Set(['bash', 'file_write', 'file_delete', 'file_read'])

// Allowed by default prefix match (read-only workspace/memory tools)
const DEFAULT_ALLOW_TOOLS_PREFIX = ['memory_', 'workspace_']

const DEFAULT_RISK_LEVELS: Record<string, ToolRiskLevel> = {
  bash: 'high',
  file_write: 'high',
  file_delete: 'high',
  file_read: 'medium',
  memory_search: 'low',
  memory_entity_context: 'low',
  memory_similar_situations: 'low',
  memory_procedure: 'low',
  workspace_read_slot: 'low',
  workspace_write_slot: 'low',
  spawn_execution_session: 'medium',
}

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface AmygdalaRule {
  toolName: string | RegExp // exact match or regex
  decision: AmygdalaDecision
  reason: string
}

export interface AmygdalaConfig {
  rules?: AmygdalaRule[] // app-level custom rules (layered on top of defaults)
  riskLevels?: Record<string, ToolRiskLevel> // overrides for tool risk levels
  haiku_enabled?: boolean // enable Haiku LLM evaluation (default false)
  llm?: LlmConfig // LLM config for Stage 3 Haiku evaluation
}

// ─── Amygdala Class ───────────────────────────────────────────────────────────

export class Amygdala {
  private readonly config: AmygdalaConfig
  private readonly workspace: CognitiveWorkspace
  private readonly eventBus: BrainEventBus
  private readonly riskLevels: Record<string, ToolRiskLevel>

  constructor(config: AmygdalaConfig, workspace: CognitiveWorkspace, eventBus: BrainEventBus) {
    this.config = config
    this.workspace = workspace
    this.eventBus = eventBus
    this.riskLevels = { ...DEFAULT_RISK_LEVELS, ...config.riskLevels }
  }

  // ── Three-stage decision ─────────────────────────────────────────────────────

  async check(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ decision: AmygdalaDecision; reason: string }> {
    // Stage 1: Static rules (custom rules + default BLOCK/ALLOW table)
    const staticResult = this.checkStaticRules(toolName)
    if (staticResult) return staticResult

    const risk = this.riskLevels[toolName] ?? 'medium'

    // Stage 2: Implicit memory match (medium/high tools)
    try {
      const history = await this.workspace.getByTags(['amygdala_eval', toolName], undefined, 5)
      if (history.length > 0) {
        const sorted = history.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        const recent = sorted[0]!
        const parsed = JSON.parse(recent.content) as { tool: string; decision: string; reason: string }
        const validDecisions: AmygdalaDecision[] = ['allow', 'block', 'escalate']
        if (validDecisions.includes(parsed.decision as AmygdalaDecision)) {
          return {
            decision: parsed.decision as AmygdalaDecision,
            reason: `[memory] ${parsed.reason}`,
          }
        }
      }
    } catch {
      // getByTags failed — fall through to Stage 3
    }

    // Stage 3: Haiku LLM evaluation (high-risk only, when haiku_enabled=true)
    if (risk === 'high' && this.config.haiku_enabled) {
      return await this.evaluateWithLlm(toolName, args, risk)
    }

    // Default: allow when no rule matched
    return {
      decision: 'allow',
      reason: `No rule matched for ${toolName} (risk: ${risk})`,
    }
  }

  private async evaluateWithLlm(
    toolName: string,
    args: Record<string, unknown>,
    risk: ToolRiskLevel,
  ): Promise<{ decision: AmygdalaDecision; reason: string }> {
    const argsSummary = JSON.stringify(args).slice(0, 300)
    const prompt = `You are a security gate evaluating a tool call in an AI agent system.
Tool: ${toolName}
Risk level: ${risk}
Arguments: ${argsSummary}

Decide if this tool call should be allowed, blocked, or escalated for human review.
- allow: the tool call is safe in this context
- block: the tool call is clearly dangerous and should be prevented
- escalate: uncertain or sensitive — requires human review

Respond with JSON only: {"decision": "allow" | "block" | "escalate", "reason": string}
When in doubt, escalate.`

    let decision: AmygdalaDecision = 'escalate'
    let reason = 'LLM evaluation failed — defaulting to escalate'

    try {
      const response = await callLlm(prompt, this.config.llm ?? {})
      const result = parseLlmJson<{ decision: string; reason: string }>(response, {
        decision: 'escalate',
        reason: 'parse failed',
      })
      const validDecisions: AmygdalaDecision[] = ['allow', 'block', 'escalate']
      if (validDecisions.includes(result.decision as AmygdalaDecision)) {
        decision = result.decision as AmygdalaDecision
      }
      if (result.reason) reason = result.reason
    } catch {
      // LLM call failed — keep escalate defaults
    }

    // Write to implicit memory (fire-and-forget)
    this.writeEvalMemory(toolName, decision, reason).catch(() => {})

    return { decision, reason }
  }

  private async writeEvalMemory(
    toolName: string,
    decision: AmygdalaDecision,
    reason: string,
  ): Promise<void> {
    await this.workspace.writeMemory({
      type: 'implicit',
      content: JSON.stringify({ tool: toolName, decision, reason }),
      tags: ['amygdala_eval', toolName, decision],
      baseImportance: decision === 'allow' ? 0.4 : 0.8,
      sourceBrain: 'amygdala',
    })
  }

  private checkStaticRules(
    toolName: string,
  ): { decision: AmygdalaDecision; reason: string } | null {
    // App-level custom rules take highest priority
    for (const rule of this.config.rules ?? []) {
      const matches =
        typeof rule.toolName === 'string'
          ? rule.toolName === toolName
          : rule.toolName.test(toolName)
      if (matches) return { decision: rule.decision, reason: rule.reason }
    }

    // Default BLOCK list
    if (DEFAULT_BLOCK_TOOLS.has(toolName)) {
      return {
        decision: 'block',
        reason: `Tool ${toolName} is blocked by default policy (high-risk, pre-pi-coding-agent migration)`,
      }
    }

    // Default ALLOW prefix list
    if (DEFAULT_ALLOW_TOOLS_PREFIX.some((prefix) => toolName.startsWith(prefix))) {
      return {
        decision: 'allow',
        reason: `Tool ${toolName} is allowed by default (read-only workspace/memory tool)`,
      }
    }

    return null
  }

  // ── EventBus subscription (PiCodingAgentAdapter path) ───────────────────────

  /**
   * Subscribes to tool.pre_use events on the EventBus.
   * When a block/escalate decision is reached, writes an amygdala_interrupt
   * Signal to the workspace and emits an ALERT event.
   *
   * Note: ClaudeAgentSDKAdapter uses PreToolUse hook instead — it calls
   * check() directly rather than relying on this subscription.
   *
   * Returns an unsubscribe function.
   */
  startListening(): () => void {
    return this.eventBus.subscribe(async (event) => {
      if (event.event_type !== 'tool.pre_use') return

      const toolName = event.payload.tool as string
      const args = (event.payload.args as Record<string, unknown>) ?? {}

      const { decision, reason } = await this.check(toolName, args)

      if (decision === 'block' || decision === 'escalate') {
        this.workspace.pushSignal({
          type: 'amygdala_interrupt',
          threadId: event.thread_id ?? '',
          message: `Amygdala ${decision}: ${reason}`,
          causationId: event.event_id,
        })

        this.eventBus.emit({
          event_type: 'amygdala.interrupt',
          level: 'ALERT',
          brain: 'amygdala',
          thread_id: event.thread_id,
          session_id: event.session_id,
          causation_id: event.event_id,
          payload: { tool: toolName, decision, reason },
        })
      }
    })
  }
}
