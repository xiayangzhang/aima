import { Agent } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
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

// ─── PiCodingAgentAdapter ─────────────────────────────────────────────────────

/**
 * Adapts pi-agent-core's Agent class to AIMA's BrainAdapter interface.
 *
 * Session management: pi-agent-core sessions are held by the Agent *instance*.
 * Within a Thread, the same Agent instance is reused (stored in agentInstances
 * by `${brain}:${threadId}`) so the conversation history is preserved.
 * Process restart loses in-memory sessions — ThreadRunner handles crash recovery.
 */
export class PiCodingAgentAdapter implements BrainAdapter {
  private readonly config: PiCodingAgentAdapterConfig
  // `${brain}:${threadId}` → live Agent instance
  private readonly agentInstances: Map<string, Agent> = new Map()

  constructor(config: PiCodingAgentAdapterConfig) {
    this.config = config
  }

  // ── BrainAdapter.run() ───────────────────────────────────────────────────────

  async run(params: BrainRunParams): Promise<BrainRunResult> {
    const { brain, threadId, systemPrompt, initialPrompt } = params
    const key = `${brain}:${threadId}`

    let agent = this.agentInstances.get(key)
    const isFirstRun = !agent

    if (!agent) {
      const model = getModel('anthropic', this.config.modelId as Parameters<typeof getModel>[1])
      agent = new Agent({
        getApiKey: (_provider) => this.config.getApiKey(),
      })
      agent.setModel(model)
      this.registerEventBridge(agent, brain, threadId)
      this.agentInstances.set(key, agent)
    }

    // Always refresh system prompt (Block 3/4 change each activation)
    agent.setSystemPrompt(systemPrompt)

    // Check for pending Amygdala interrupt from previous activation
    const interruptSignal = this.config.workspace.popSignal('amygdala_interrupt')
    if (interruptSignal) {
      agent.steer({
        role: 'user',
        content: `[AMYGDALA INTERRUPT] ${interruptSignal.message}`,
        timestamp: Date.now(),
      })
    }

    // First activation: send initial prompt; subsequent: continue existing session
    if (isFirstRun && initialPrompt) {
      await agent.prompt(initialPrompt)
    } else {
      await agent.continue()
    }

    // Wait for agent to finish its run loop
    await agent.waitForIdle()

    return {
      sessionId: key, // logical key; actual session = Agent instance
      output: {}, // slot output is written by tools during execution
      stopReason: 'done',
      injectedMemoryIds: [], // ThreadRunner provides this from Context Assembly
    }
  }

  // ── BrainAdapter.inject() ────────────────────────────────────────────────────

  async inject(signal: BrainSignal): Promise<void> {
    // Find any running Agent for this signal type and inject via steer/followUp
    for (const [_key, agent] of this.agentInstances) {
      if (signal.type === 'amygdala_interrupt') {
        agent.steer({
          role: 'user',
          content: `[AMYGDALA INTERRUPT] ${signal.message}`,
          timestamp: Date.now(),
        })
      } else if (signal.type === 'dmn_correction') {
        agent.followUp({
          role: 'user',
          content: `[DMN CORRECTION] ${signal.message}`,
          timestamp: Date.now(),
        })
      }
    }
  }

  // ── BrainAdapter.abort() ─────────────────────────────────────────────────────

  abort(): void {
    for (const [key, agent] of this.agentInstances) {
      agent.abort()
      this.agentInstances.delete(key)
    }
  }

  /** Abort a specific brain+thread session */
  abortSession(brain: CognitiveBrainType, threadId: string): void {
    const key = `${brain}:${threadId}`
    const agent = this.agentInstances.get(key)
    if (agent) {
      agent.abort()
      this.agentInstances.delete(key)
    }
  }

  // ── EventBus Bridge ──────────────────────────────────────────────────────────

  private registerEventBridge(agent: Agent, brain: CognitiveBrainType, threadId: string): void {
    const eb = this.config.eventBus

    agent.subscribe((event) => {
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
