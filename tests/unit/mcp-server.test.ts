import { describe, expect, test } from 'bun:test'
import { createAimaMcpServer } from '../../src/mcp/index'
import { CognitiveWorkspace } from '../../src/workspace/index'

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

describe('createAimaMcpServer', () => {
  test('returns an MCP server config with instance', () => {
    const workspace = new CognitiveWorkspace(mockDb)
    const server = createAimaMcpServer(workspace)
    expect(server).toBeDefined()
    // McpSdkServerConfigWithInstance has type and instance fields
    expect(server).toHaveProperty('instance')
  })
})
