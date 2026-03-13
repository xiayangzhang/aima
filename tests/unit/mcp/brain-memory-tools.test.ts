import { describe, expect, mock, test } from 'bun:test'
import { createAimaMcpServer } from '../../../src/mcp/index'
import type { MemoryEntry } from '../../../src/types/index'
import { CognitiveWorkspace } from '../../../src/workspace/index'

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
  return (args: AnyRecord) => tool.handler(args, undefined)
}

const emptyEntries: MemoryEntry[] = []

describe('memory_entity_context', () => {
  // V1: calls getEntityContext, not searchMemory
  test('V1: with entityId calls getEntityContext instead of searchMemory', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const mockGetEntityContext = mock(() => Promise.resolve(emptyEntries))
    const mockSearchMemory = mock(() => Promise.resolve(emptyEntries))
    workspace.getEntityContext = mockGetEntityContext
    workspace.searchMemory = mockSearchMemory

    const server = createAimaMcpServer(workspace)
    const handler = getToolHandler(server, 'memory_entity_context')
    await handler({ entityId: 'entity-abc' })

    expect(mockGetEntityContext).toHaveBeenCalledTimes(1)
    expect(mockSearchMemory).not.toHaveBeenCalled()
  })

  // V2: forwards types array to getEntityContext
  test('V2: forwards types filter to getEntityContext', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const mockGetEntityContext = mock(() => Promise.resolve(emptyEntries))
    workspace.getEntityContext = mockGetEntityContext

    const server = createAimaMcpServer(workspace)
    const handler = getToolHandler(server, 'memory_entity_context')
    await handler({ entityId: 'entity-xyz', types: ['semantic', 'episodic'] })

    expect(mockGetEntityContext).toHaveBeenCalledWith(
      'entity-xyz',
      expect.objectContaining({ types: ['semantic', 'episodic'] }),
    )
  })
})

describe('memory_similar_situations', () => {
  // V3: with situation calls findSimilarSituations
  test('V3: with situation string calls findSimilarSituations', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const mockFindSimilar = mock(() => Promise.resolve({ episodes: [], procedures: [], facts: [] }))
    const mockSearchMemory = mock(() => Promise.resolve(emptyEntries))
    workspace.findSimilarSituations = mockFindSimilar
    workspace.searchMemory = mockSearchMemory

    const server = createAimaMcpServer(workspace)
    const handler = getToolHandler(server, 'memory_similar_situations')
    const result = await handler({ situation: 'debugging a memory leak' })

    expect(mockFindSimilar).toHaveBeenCalledTimes(1)
    expect(mockFindSimilar).toHaveBeenCalledWith('debugging a memory leak', expect.any(Object))
    expect(mockSearchMemory).not.toHaveBeenCalled()

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveProperty('facts')
  })

  // V4: without situation falls back to searchMemory
  test('V4: without situation falls back to searchMemory', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const mockFindSimilar = mock(() => Promise.resolve({ episodes: [], procedures: [], facts: [] }))
    const mockSearchMemory = mock(() => Promise.resolve(emptyEntries))
    workspace.findSimilarSituations = mockFindSimilar
    workspace.searchMemory = mockSearchMemory

    const server = createAimaMcpServer(workspace)
    const handler = getToolHandler(server, 'memory_similar_situations')
    await handler({})

    expect(mockFindSimilar).not.toHaveBeenCalled()
    expect(mockSearchMemory).toHaveBeenCalled()
  })
})

describe('memory_procedure', () => {
  // V5: with taskType calls getProcedure
  test('V5: with taskType calls getProcedure', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const mockGetProcedure = mock(() => Promise.resolve(emptyEntries))
    const mockSearchMemory = mock(() => Promise.resolve(emptyEntries))
    workspace.getProcedure = mockGetProcedure
    workspace.searchMemory = mockSearchMemory

    const server = createAimaMcpServer(workspace)
    const handler = getToolHandler(server, 'memory_procedure')
    await handler({ taskType: 'code review' })

    expect(mockGetProcedure).toHaveBeenCalledTimes(1)
    expect(mockGetProcedure).toHaveBeenCalledWith('code review', expect.any(Object))
    expect(mockSearchMemory).not.toHaveBeenCalled()
  })

  // V6: without taskType falls back to searchMemory
  test('V6: without taskType falls back to searchMemory', async () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const mockGetProcedure = mock(() => Promise.resolve(emptyEntries))
    const mockSearchMemory = mock(() => Promise.resolve(emptyEntries))
    workspace.getProcedure = mockGetProcedure
    workspace.searchMemory = mockSearchMemory

    const server = createAimaMcpServer(workspace)
    const handler = getToolHandler(server, 'memory_procedure')
    await handler({})

    expect(mockGetProcedure).not.toHaveBeenCalled()
    expect(mockSearchMemory).toHaveBeenCalled()
  })
})
