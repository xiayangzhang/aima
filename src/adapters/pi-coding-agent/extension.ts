import type { ExtensionFactory, ToolCallEvent } from '@mariozechner/pi-coding-agent'
import type { Amygdala } from '../../amygdala/index'
import type { BrainEventBus } from '../../eventbus/index'
import type { CognitiveBrainType } from '../../types/index'

// ─── Default Tool Policy ──────────────────────────────────────────────────────

/** Blocked by default without calling amygdala.check() (high-risk built-in tools) */
const DEFAULT_BLOCKED_TOOLS = new Set(['bash', 'edit', 'write'])

/** Always allowed without calling amygdala.check() (read-only, low-risk) */
const DEFAULT_ALLOWED_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

// ─── Extension Factory ────────────────────────────────────────────────────────

/**
 * Creates an AIMA ExtensionFactory that wires:
 * 1. Amygdala per-tool interception via tool_call handler
 * 2. EventBus bridge via tool_execution_end and agent_end handlers
 *
 * Pass the returned factory to DefaultResourceLoader via extensionFactories option.
 */
export function createAimaExtension(
  brain: CognitiveBrainType,
  threadId: string,
  amygdala: Amygdala,
  eventBus: BrainEventBus,
  allowedTools?: string[],
  lastTextRef?: { value: string },
  tokenUsageRef?: {
    value: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    } | null
  },
): ExtensionFactory {
  return (pi) => {
    // Build per-brain override set from role's allowed_tools frontmatter
    const allowedSet = new Set(allowedTools ?? [])

    // ── tool_call: Amygdala interception ──────────────────────────────────────

    pi.on('tool_call', async (event: ToolCallEvent) => {
      const { toolCallId, toolName } = event
      const input = event.input as Record<string, unknown>

      // Stage 1: Default policy — block high-risk tools unless role overrides
      if (DEFAULT_BLOCKED_TOOLS.has(toolName) && !allowedSet.has(toolName)) {
        const reason = `${toolName} blocked by default policy`
        eventBus.emit({
          event_type: 'tool.pre_use',
          level: 'INFO',
          brain,
          thread_id: threadId,
          payload: { tool: toolName, toolCallId, args: input },
        })
        eventBus.emit({
          event_type: 'tool.blocked',
          level: 'COMPLIANCE',
          brain,
          thread_id: threadId,
          payload: { tool: toolName, toolCallId, reason },
        })
        return { block: true, reason }
      }

      // Emit tool.pre_use for all non-default-blocked tools
      eventBus.emit({
        event_type: 'tool.pre_use',
        level: 'INFO',
        brain,
        thread_id: threadId,
        payload: { tool: toolName, toolCallId, args: input },
      })

      // Stage 2: Default allow — skip Amygdala check for known-safe tools
      if (DEFAULT_ALLOWED_TOOLS.has(toolName)) {
        return undefined
      }

      // Stage 3: Dynamic Amygdala check for all other tools (MCP, custom, etc.)
      const result = await amygdala.check(toolName, input)

      if (result.decision === 'allow') {
        return undefined
      }

      if (result.decision === 'escalate') {
        eventBus.emit({
          event_type: 'amygdala.escalation',
          level: 'ALERT',
          brain,
          thread_id: threadId,
          payload: { tool: toolName, toolCallId, reason: result.reason },
        })
        eventBus.emit({
          event_type: 'tool.blocked',
          level: 'COMPLIANCE',
          brain,
          thread_id: threadId,
          payload: { tool: toolName, toolCallId, reason: result.reason },
        })
        return { block: true, reason: result.reason }
      }

      // decision === 'block'
      eventBus.emit({
        event_type: 'tool.blocked',
        level: 'COMPLIANCE',
        brain,
        thread_id: threadId,
        payload: { tool: toolName, toolCallId, reason: result.reason },
      })
      return { block: true, reason: result.reason }
    })

    // ── tool_execution_end: emit tool.post_use ────────────────────────────────
    // Fires only for ALLOWED tools (blocked ones never reach execution)

    pi.on('tool_execution_end', (event) => {
      eventBus.emit({
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
    })

    // ── agent_end: capture last text + emit brain.loop_end ───────────────────

    pi.on('agent_end', (event) => {
      // Capture last assistant text message for fallback slot write (FR-002)
      if (lastTextRef !== undefined) {
        let lastText = ''
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const m = event.messages[i]
          if (!m || !('role' in m) || m.role !== 'assistant' || !('content' in m)) continue
          const content = m.content
          if (!Array.isArray(content)) break
          for (let j = content.length - 1; j >= 0; j--) {
            const block = content[j] as { type: string; text?: string } | undefined
            if (block?.type === 'text' && typeof block.text === 'string') {
              lastText = block.text
              break
            }
          }
          break
        }
        lastTextRef.value = lastText
      }

      // Accumulate token usage from all AssistantMessage turns (FR-002)
      if (tokenUsageRef !== undefined) {
        let inputTokens = 0
        let outputTokens = 0
        let cacheRead = 0
        let cacheWrite = 0
        for (const m of event.messages) {
          if (!m || !('role' in m) || m.role !== 'assistant' || !('usage' in m)) continue
          const u = m.usage as
            | { input: number; output: number; cacheRead: number; cacheWrite: number }
            | undefined
          if (!u) continue
          inputTokens += u.input
          outputTokens += u.output
          cacheRead += u.cacheRead
          cacheWrite += u.cacheWrite
        }
        if (inputTokens > 0 || outputTokens > 0) {
          tokenUsageRef.value = {
            inputTokens,
            outputTokens,
            ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
            ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
          }
        }
      }

      eventBus.emit({
        event_type: 'brain.loop_end',
        level: 'INFO',
        brain,
        thread_id: threadId,
        payload: {},
      })
    })
  }
}
