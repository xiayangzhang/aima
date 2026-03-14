/**
 * Integration tests: MCP → SpawnExecutionSessionFn → response chain.
 * Uses mock callbacks — no real database or Anthropic API required.
 */
import { describe, expect, test, vi } from 'vitest'
import type { SpawnExecutionSessionFn } from '../../src/index'
import { createAimaMcpServer } from '../../src/mcp/index'
import { CognitiveWorkspace } from '../../src/workspace/index'

// biome-ignore lint/suspicious/noExplicitAny: accessing McpServer internals for testing
type AnyRecord = Record<string, any>

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

function getToolHandler(
  server: ReturnType<typeof createAimaMcpServer>,
  toolName: string,
): (args: AnyRecord) => Promise<{ content: [{ type: string; text: string }] }> {
  const registeredTools = (server.instance as AnyRecord)._registeredTools as AnyRecord
  const tool = registeredTools[toolName]
  if (!tool) throw new Error(`Tool '${toolName}' not found`)
  return (args: AnyRecord) => tool.handler(args, undefined)
}

describe('spawn_execution_session integration chain', () => {
  test('Scenario A: mock callback — complete MCP → callback → response chain', async () => {
    const mockSpawn: SpawnExecutionSessionFn = vi.fn(() =>
      Promise.resolve({
        executionSessionId: '11111111-1111-4111-8111-111111111111',
        result: 'Integration test result',
      }),
    )

    const workspace = new CognitiveWorkspace(mockDb)
    const server = createAimaMcpServer(workspace, { spawnExecutionSession: mockSpawn })
    const tool = getToolHandler(server, 'spawn_execution_session')

    const response = await tool({ task_description: 'analyze and refactor code' })

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.execution_session_id).toBe('11111111-1111-4111-8111-111111111111')
    expect(parsed.result).toBe('Integration test result')
    expect(mockSpawn).toHaveBeenCalledWith({ taskDescription: 'analyze and refactor code' })
  })

  test('Scenario B: no callback configured returns clear error message', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const server = createAimaMcpServer(workspace) // no opts
    const tool = getToolHandler(server, 'spawn_execution_session')

    const response = await tool({ task_description: 'task' })

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error).toContain('sub-execution not configured')
    // Old stub text must be gone
    expect(response.content[0].text).not.toContain('[spawn_execution_session stub]')
    // execution_session_id must not be null (it should be absent or only in error responses)
    expect(parsed.execution_session_id).toBeUndefined()
  })

  test('Scenario C: SpawnExecutionSessionFn type contract — both params accessible', async () => {
    // Verifies the type is importable from public API and structurally correct
    const fn: SpawnExecutionSessionFn = async ({ taskDescription, model }) => {
      // type checking: both params should be accessible without TS errors
      expect(typeof taskDescription).toBe('string')
      expect(model === undefined || typeof model === 'string').toBe(true)
      return { executionSessionId: crypto.randomUUID(), result: 'ok' }
    }

    const workspace = new CognitiveWorkspace(mockDb)
    const server = createAimaMcpServer(workspace, { spawnExecutionSession: fn })
    const tool = getToolHandler(server, 'spawn_execution_session')

    const response = await tool({ task_description: 'type test', model: 'claude-opus-4-6' })
    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.result).toBe('ok')
    expect(typeof parsed.execution_session_id).toBe('string')
  })
})
