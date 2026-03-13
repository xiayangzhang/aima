import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import type { CognitiveBrainType, MemoryType, SlotStatus } from '../../types/index'
import type { CognitiveWorkspace } from '../../workspace/index'

/** Helper: wrap a JSON-serializable result in the AgentToolResult content format */
function ok(data: unknown): { content: [{ type: 'text'; text: string }]; details: undefined } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    details: undefined,
  }
}

// ─── AIMA Workspace + Memory Tools ───────────────────────────────────────────

type BrainParam = CognitiveBrainType | 'amygdala' | 'dmn'

/**
 * Build ToolDefinition[] exposing AIMA workspace and memory tools to the LLM.
 * These tools go through the standard Amygdala tool_call handler — no bypass.
 * MCP tools with names starting with 'memory_' or 'workspace_' are default-allowed
 * in the extension's DEFAULT_ALLOWED_TOOLS prefix list.
 */
export function buildMcpTools(workspace: CognitiveWorkspace): ToolDefinition[] {
  return [
    // ── workspace_read_slot ──────────────────────────────────────────────────
    {
      name: 'workspace_read_slot',
      label: 'Read Workspace Slot',
      description: 'Read a brain slot from the current thread',
      parameters: Type.Object({
        threadId: Type.String({ description: 'Thread ID' }),
        brain: Type.Union(
          [
            Type.Literal('limbic'),
            Type.Literal('cortex'),
            Type.Literal('brainstem'),
            Type.Literal('amygdala'),
            Type.Literal('dmn'),
          ],
          { description: 'Brain type' },
        ),
      }),
      async execute(_toolCallId, params) {
        const { threadId, brain } = params as { threadId: string; brain: BrainParam }
        const slot = await workspace.readSlot(threadId, brain as CognitiveBrainType)
        return ok(slot ?? null)
      },
    },

    // ── workspace_write_slot ─────────────────────────────────────────────────
    {
      name: 'workspace_write_slot',
      label: 'Write Workspace Slot',
      description: "Write to the brain's own slot in the current thread",
      parameters: Type.Object({
        threadId: Type.String({ description: 'Thread ID' }),
        brain: Type.Union(
          [
            Type.Literal('limbic'),
            Type.Literal('cortex'),
            Type.Literal('brainstem'),
            Type.Literal('amygdala'),
            Type.Literal('dmn'),
          ],
          { description: 'Brain type' },
        ),
        status: Type.Optional(
          Type.Union(
            [
              Type.Literal('pending'),
              Type.Literal('running'),
              Type.Literal('done'),
              Type.Literal('error'),
            ],
            { description: 'Slot execution status' },
          ),
        ),
        output: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: 'Structured output to write',
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { threadId, brain, status, output } = params as {
          threadId: string
          brain: BrainParam
          status?: SlotStatus
          output?: Record<string, unknown>
        }
        await workspace.writeSlot(threadId, brain as CognitiveBrainType, {
          ...(status !== undefined ? { status } : {}),
          ...(output !== undefined ? { output } : {}),
        })
        return ok({ ok: true })
      },
    },

    // ── memory_search ────────────────────────────────────────────────────────
    {
      name: 'memory_search',
      label: 'Memory Search',
      description: 'General semantic memory retrieval',
      parameters: Type.Object({
        type: Type.Optional(
          Type.Union(
            [
              Type.Literal('semantic'),
              Type.Literal('episodic'),
              Type.Literal('procedural'),
              Type.Literal('working'),
              Type.Literal('implicit'),
            ],
            { description: 'Memory type filter' },
          ),
        ),
        tags: Type.Optional(Type.Array(Type.String(), { description: 'AND tag filter' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Max results (default 20)' })),
      }),
      async execute(_toolCallId, params) {
        const { type, tags, limit } = params as {
          type?: MemoryType
          tags?: string[]
          limit?: number
        }
        const results = await workspace.searchMemory({
          ...(type !== undefined ? { type } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(limit !== undefined ? { limit } : {}),
          excludeInvalid: true,
        })
        return ok(results)
      },
    },

    // ── memory_entity_context ────────────────────────────────────────────────
    {
      name: 'memory_entity_context',
      label: 'Memory Entity Context',
      description: 'Entity-centric memory retrieval (Limbic)',
      parameters: Type.Object({
        entityId: Type.String({ description: 'Entity ID to retrieve context for' }),
        types: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Literal('semantic'),
              Type.Literal('episodic'),
              Type.Literal('procedural'),
              Type.Literal('working'),
              Type.Literal('implicit'),
            ]),
            { description: 'Filter by memory types' },
          ),
        ),
        depth: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 2, description: 'Relationship traversal depth' }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_toolCallId, params) {
        const { entityId, types, depth, limit } = params as {
          entityId: string
          types?: MemoryType[]
          depth?: number
          limit?: number
        }
        const results = await workspace.getEntityContext(entityId, {
          ...(types !== undefined ? { types } : {}),
          ...(depth !== undefined ? { depth } : {}),
          ...(limit !== undefined ? { limit } : {}),
        })
        return ok(results)
      },
    },

    // ── memory_similar_situations ────────────────────────────────────────────
    {
      name: 'memory_similar_situations',
      label: 'Memory Similar Situations',
      description: 'Situation-based memory retrieval combining episodic and procedural (Cortex)',
      parameters: Type.Object({
        situation: Type.Optional(
          Type.String({ description: 'Current situation or query text for semantic matching' }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_toolCallId, params) {
        const { situation, limit } = params as { situation?: string; limit?: number }
        if (situation !== undefined) {
          const result = await workspace.findSimilarSituations(situation, {
            ...(limit !== undefined ? { limit } : {}),
          })
          return ok(result)
        }
        // Fallback: no situation provided — generic searchMemory
        const cap = limit ?? 5
        const [episodes, procedures] = await Promise.all([
          workspace.searchMemory({ type: 'episodic', limit: cap, excludeInvalid: true }),
          workspace.searchMemory({ type: 'procedural', limit: cap, excludeInvalid: true }),
        ])
        return ok({ episodes, procedures })
      },
    },

    // ── memory_procedure ─────────────────────────────────────────────────────
    {
      name: 'memory_procedure',
      label: 'Memory Procedure',
      description: 'Task procedure retrieval (Brainstem)',
      parameters: Type.Object({
        tags: Type.Optional(
          Type.Array(Type.String(), { description: 'Filter by tags (e.g. task type)' }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_toolCallId, params) {
        const { tags, limit } = params as { tags?: string[]; limit?: number }
        const results = await workspace.searchMemory({
          type: 'procedural',
          ...(tags !== undefined ? { tags } : {}),
          ...(limit !== undefined ? { limit } : {}),
          excludeInvalid: true,
        })
        return ok(results)
      },
    },
  ]
}
