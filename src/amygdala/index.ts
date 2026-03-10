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
  haiku_enabled?: boolean // enable Haiku fallback (default false, WIP)
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
    _args: Record<string, unknown>,
  ): Promise<{ decision: AmygdalaDecision; reason: string }> {
    // Stage 1: Static rules (custom rules + default BLOCK/ALLOW table)
    const staticResult = this.checkStaticRules(toolName)
    if (staticResult) return staticResult

    const risk = this.riskLevels[toolName] ?? 'medium'

    // Stage 2: Implicit memory match (medium/high tools)
    // Stub for Feature 002 transition period — full implementation in DMN Reactive feature
    const memoryResult: { decision: AmygdalaDecision; reason: string } | null = null
    if (memoryResult) return memoryResult

    // Stage 3: Haiku fallback (high-risk only, when haiku_enabled=true)
    if (risk === 'high' && this.config.haiku_enabled) {
      return {
        decision: 'escalate',
        reason: `High-risk tool ${toolName} requires human review (Haiku eval not yet implemented)`,
      }
    }

    // Default: allow when no rule matched
    return {
      decision: 'allow',
      reason: `No rule matched for ${toolName} (risk: ${risk})`,
    }
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
