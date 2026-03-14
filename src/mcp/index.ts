import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'
import type { CognitiveBrainType, MemoryType, SlotStatus } from '../types/index'
import type { CognitiveWorkspace } from '../workspace/index'

// ─── Sub-Execution Session ────────────────────────────────────────────────────

/**
 * Callback for spawning an independent sub-execution session.
 * Implemented by AIMAInstance and injected into createAimaMcpServer.
 */
export type SpawnExecutionSessionFn = (params: {
  taskDescription: string
  model?: string
}) => Promise<{
  executionSessionId: string
  result: string
}>

// ─── AIMA MCP Server ──────────────────────────────────────────────────────────

type BrainEnum = 'limbic' | 'cortex' | 'brainstem' | 'amygdala' | 'dmn'
type MemoryTypeEnum = 'semantic' | 'episodic' | 'procedural' | 'working' | 'implicit'

/**
 * Creates an in-process MCP server exposing AIMA workspace and memory tools.
 * Pass the returned config to `query()` via `options.mcpServers`.
 */
export function createAimaMcpServer(
  workspace: CognitiveWorkspace,
  opts?: { spawnExecutionSession?: SpawnExecutionSessionFn },
) {
  return createSdkMcpServer({
    name: 'aima-workspace',
    version: '1.0.0',
    tools: [
      // ── workspace_read_slot ──────────────────────────────────────────────────
      {
        name: 'workspace_read_slot',
        description: 'Read a brain slot from the current thread',
        inputSchema: {
          threadId: z.string().describe('Thread ID'),
          brain: z
            .enum(['limbic', 'cortex', 'brainstem', 'amygdala', 'dmn'])
            .describe('Brain type'),
        },
        handler: async (args) => {
          const { threadId, brain } = args as { threadId: string; brain: BrainEnum }
          const slot = await workspace.readSlot(threadId, brain as CognitiveBrainType)
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(slot ?? null) }],
          }
        },
      },

      // ── workspace_write_slot ─────────────────────────────────────────────────
      {
        name: 'workspace_write_slot',
        description: "Write to the brain's own slot in the current thread",
        inputSchema: {
          threadId: z.string().describe('Thread ID'),
          brain: z
            .enum(['limbic', 'cortex', 'brainstem', 'amygdala', 'dmn'])
            .describe('Brain type'),
          status: z.enum(['pending', 'running', 'done', 'error']).optional(),
          output: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Structured output to write'),
        },
        handler: async (args) => {
          const { threadId, brain, status, output } = args as {
            threadId: string
            brain: BrainEnum
            status?: SlotStatus
            output?: Record<string, unknown>
          }
          await workspace.writeSlot(threadId, brain as CognitiveBrainType, {
            ...(status !== undefined ? { status } : {}),
            ...(output !== undefined ? { output } : {}),
          })
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
          }
        },
      },

      // ── memory_search ────────────────────────────────────────────────────────
      {
        name: 'memory_search',
        description: 'General semantic memory retrieval',
        inputSchema: {
          type: z
            .enum(['semantic', 'episodic', 'procedural', 'working', 'implicit'])
            .optional()
            .describe('Memory type filter'),
          tags: z.array(z.string()).optional().describe('AND tag filter'),
          limit: z.number().int().positive().optional().describe('Max results (default 20)'),
        },
        handler: async (args) => {
          const { type, tags, limit } = args as {
            type?: MemoryTypeEnum
            tags?: string[]
            limit?: number
          }
          const results = await workspace.searchMemory({
            ...(type !== undefined ? { type: type as MemoryType } : {}),
            ...(tags !== undefined ? { tags } : {}),
            ...(limit !== undefined ? { limit } : {}),
            excludeInvalid: true,
          })
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(results) }],
          }
        },
      },

      // ── memory_entity_context ────────────────────────────────────────────────
      {
        name: 'memory_entity_context',
        description: 'Entity-centric memory retrieval (Limbic)',
        inputSchema: {
          entityId: z.string().describe('Entity ID to retrieve context for'),
          types: z
            .array(z.enum(['semantic', 'episodic', 'procedural', 'working', 'implicit']))
            .optional(),
          limit: z.number().int().positive().optional(),
          depth: z.number().int().min(1).max(2).optional().describe('Relationship traversal depth'),
        },
        handler: async (args) => {
          const { entityId, types, limit } = args as {
            entityId: string
            types?: MemoryType[]
            limit?: number
          }
          const results = await workspace.getEntityContext(entityId, {
            ...(types !== undefined ? { types } : {}),
            ...(limit !== undefined ? { limit } : {}),
          })
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(results) }],
          }
        },
      },

      // ── memory_similar_situations ────────────────────────────────────────────
      {
        name: 'memory_similar_situations',
        description: 'Situation-based memory retrieval combining episodic and procedural (Cortex)',
        inputSchema: {
          situation: z
            .string()
            .optional()
            .describe('Current situation or query text for semantic matching'),
          limit: z.number().int().positive().optional(),
        },
        handler: async (args) => {
          const { situation, limit } = args as { situation?: string; limit?: number }
          if (situation !== undefined) {
            const result = await workspace.findSimilarSituations(situation, {
              ...(limit !== undefined ? { limit } : {}),
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            }
          }
          // Fallback: no situation provided — generic searchMemory
          const [episodes, procedures] = await Promise.all([
            workspace.searchMemory({ type: 'episodic', limit: limit ?? 5, excludeInvalid: true }),
            workspace.searchMemory({ type: 'procedural', limit: limit ?? 5, excludeInvalid: true }),
          ])
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ episodes, procedures }) }],
          }
        },
      },

      // ── memory_procedure ─────────────────────────────────────────────────────
      {
        name: 'memory_procedure',
        description: 'Task procedure retrieval (Brainstem)',
        inputSchema: {
          taskType: z.string().optional().describe('Task type or description for procedure lookup'),
          tags: z.array(z.string()).optional().describe('Filter by tags (e.g. task type)'),
          limit: z.number().int().positive().optional(),
        },
        handler: async (args) => {
          const { taskType, tags, limit } = args as {
            taskType?: string
            tags?: string[]
            limit?: number
          }
          if (taskType !== undefined) {
            const results = await workspace.getProcedure(taskType, {
              ...(limit !== undefined ? { limit } : {}),
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(results) }],
            }
          }
          // Fallback: no taskType provided — generic searchMemory with tags
          const results = await workspace.searchMemory({
            type: 'procedural',
            ...(tags !== undefined ? { tags } : {}),
            ...(limit !== undefined ? { limit } : {}),
            excludeInvalid: true,
          })
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(results) }],
          }
        },
      },

      // ── spawn_execution_session ──────────────────────────────────────────────
      {
        name: 'spawn_execution_session',
        description:
          'Brainstem: spawn an independent sub-execution session for deep reasoning tasks',
        inputSchema: {
          task_description: z.string().describe('Task to execute in the sub-session'),
          model: z.string().optional().describe("Model to use (default: 'claude-sonnet-4-6')"),
        },
        handler: async (args) => {
          const { task_description, model } = args as { task_description: string; model?: string }

          if (!opts?.spawnExecutionSession) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'spawn_execution_session: sub-execution not configured',
                  }),
                },
              ],
            }
          }

          const { executionSessionId, result } = await opts.spawnExecutionSession({
            taskDescription: task_description,
            ...(model !== undefined ? { model } : {}),
          })

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  execution_session_id: executionSessionId,
                  result,
                }),
              },
            ],
          }
        },
      },
    ],
  })
}
