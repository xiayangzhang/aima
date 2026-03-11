import { describe, expect, mock, test } from 'bun:test'
import { createAimaMcpServer } from '../../src/mcp/index'
import { CognitiveWorkspace } from '../../src/workspace/index'

// biome-ignore lint/suspicious/noExplicitAny: accessing private MCP server internals for testing
type AnyRecord = Record<string, any>

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

/** Helper: access a registered tool's handler via the McpServer internal registry */
function getToolHandler(
  server: ReturnType<typeof createAimaMcpServer>,
  toolName: string,
): (args: AnyRecord) => Promise<{ content: [{ type: string; text: string }] }> {
  const registeredTools = (server.instance as AnyRecord)._registeredTools as AnyRecord
  const tool = registeredTools[toolName]
  if (!tool) throw new Error(`Tool '${toolName}' not found`)
  // Wrap handler to match expected signature (strip extra arg)
  return (args: AnyRecord) => tool.handler(args, undefined)
}

describe('createAimaMcpServer — spawn_execution_session', () => {
  test('returns error when spawnExecutionSession not configured', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const server = createAimaMcpServer(workspace)
    const handler = getToolHandler(server, 'spawn_execution_session')

    const result = await handler({ task_description: 'test task' })
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.error).toBe('spawn_execution_session: sub-execution not configured')
    expect(parsed.result).toBeUndefined()
    // Old stub text must be gone
    expect(result.content[0].text).not.toContain('[spawn_execution_session stub]')
  })

  test('calls spawnExecutionSession callback and returns executionSessionId', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const mockSpawn = mock(() =>
      Promise.resolve({
        executionSessionId: 'abc-123-uuid',
        result: 'Task completed successfully',
      }),
    )

    const server = createAimaMcpServer(workspace, { spawnExecutionSession: mockSpawn })
    const handler = getToolHandler(server, 'spawn_execution_session')
    const result = await handler({ task_description: 'analyze code' })

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(mockSpawn).toHaveBeenCalledWith({ taskDescription: 'analyze code' })

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.execution_session_id).toBe('abc-123-uuid')
    expect(parsed.result).toBe('Task completed successfully')
  })

  test('passes model parameter to callback when provided', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const mockSpawn = mock(() =>
      Promise.resolve({ executionSessionId: 'uuid-456', result: 'done' }),
    )

    const server = createAimaMcpServer(workspace, { spawnExecutionSession: mockSpawn })
    const handler = getToolHandler(server, 'spawn_execution_session')
    await handler({ task_description: 'task', model: 'claude-opus-4-6' })

    expect(mockSpawn).toHaveBeenCalledWith({
      taskDescription: 'task',
      model: 'claude-opus-4-6',
    })
  })

  test('does not pass model to callback when model is absent', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const mockSpawn = mock(() =>
      Promise.resolve({ executionSessionId: 'uuid-789', result: 'done' }),
    )

    const server = createAimaMcpServer(workspace, { spawnExecutionSession: mockSpawn })
    const handler = getToolHandler(server, 'spawn_execution_session')
    await handler({ task_description: 'task without model' })

    // model key must not be present (no undefined pollution)
    const callArgs = mockSpawn.mock.calls[0][0]
    expect(callArgs).not.toHaveProperty('model')
    expect(callArgs.taskDescription).toBe('task without model')
  })

  test('other tools are unaffected by opts', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const server = createAimaMcpServer(workspace)
    // Should not throw — workspace_read_slot exists and is registered
    const handler = getToolHandler(server, 'workspace_read_slot')
    expect(handler).toBeDefined()
  })
})
