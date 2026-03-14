import { describe, expect, mock, test } from 'bun:test'
import { buildMcpTools } from '../../../../src/adapters/pi-coding-agent/mcp-tools'
import type { ICognitiveWorkspace, MemoryEntry } from '../../../../src/types/index'

// ─── Mock Workspace ───────────────────────────────────────────────────────────

function makeWorkspace(overrides: Partial<ICognitiveWorkspace> = {}): ICognitiveWorkspace {
  return {
    readSlot: mock(async () => null),
    writeSlot: mock(async () => undefined),
    searchMemory: mock(async () => [] as MemoryEntry[]),
    getEntityContext: mock(async () => [] as MemoryEntry[]),
    findSimilarSituations: mock(async () => [] as MemoryEntry[]),
    ...overrides,
  } as unknown as ICognitiveWorkspace
}

/** Find a tool in the list by name */
function getTool(tools: ReturnType<typeof buildMcpTools>, name: string) {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found`)
  return tool
}

/** Call a tool's execute and parse the JSON text result */
async function execTool(
  tools: ReturnType<typeof buildMcpTools>,
  name: string,
  params: unknown,
): Promise<unknown> {
  const tool = getTool(tools, name)
  const result = await tool.execute(
    'tc',
    params as Record<string, unknown>,
    undefined as never,
    undefined,
    undefined,
  )
  const text = result.content[0]
  if (text.type !== 'text') throw new Error('expected text content')
  return JSON.parse(text.text)
}

// ─── workspace_read_slot ──────────────────────────────────────────────────────

describe('buildMcpTools — workspace_read_slot', () => {
  test('calls workspace.readSlot with correct threadId and brain', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'workspace_read_slot', { threadId: 'tid-1', brain: 'limbic' })
    expect(workspace.readSlot).toHaveBeenCalledWith('tid-1', 'limbic')
  })

  test('returns null when slot does not exist', async () => {
    const workspace = makeWorkspace({ readSlot: mock(async () => null) })
    const tools = buildMcpTools(workspace as never)
    const result = await execTool(tools, 'workspace_read_slot', {
      threadId: 'tid',
      brain: 'cortex',
    })
    expect(result).toBeNull()
  })

  test('returns slot data when slot exists', async () => {
    const slotData = { status: 'done', output: { answer: 42 } }
    const workspace = makeWorkspace({ readSlot: mock(async () => slotData) })
    const tools = buildMcpTools(workspace as never)
    const result = await execTool(tools, 'workspace_read_slot', {
      threadId: 'tid',
      brain: 'brainstem',
    })
    expect(result).toEqual(slotData)
  })
})

// ─── workspace_write_slot ─────────────────────────────────────────────────────

describe('buildMcpTools — workspace_write_slot', () => {
  test('calls workspace.writeSlot with threadId, brain, and status', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'workspace_write_slot', {
      threadId: 'tid',
      brain: 'cortex',
      status: 'running',
    })
    expect(workspace.writeSlot).toHaveBeenCalledWith('tid', 'cortex', { status: 'running' })
  })

  test('returns { ok: true } on success', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    const result = await execTool(tools, 'workspace_write_slot', {
      threadId: 'tid',
      brain: 'limbic',
      status: 'done',
    })
    expect(result).toEqual({ ok: true })
  })
})

// ─── memory_search ────────────────────────────────────────────────────────────

describe('buildMcpTools — memory_search', () => {
  test('calls workspace.searchMemory with type filter when provided', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'memory_search', { type: 'semantic', limit: 5 })
    expect(workspace.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'semantic', limit: 5, excludeInvalid: true }),
    )
  })

  test('always sets excludeInvalid: true', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'memory_search', {})
    expect(workspace.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ excludeInvalid: true }),
    )
  })
})

// ─── memory_entity_context ────────────────────────────────────────────────────

describe('buildMcpTools — memory_entity_context', () => {
  test('calls getEntityContext with entityId', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'memory_entity_context', { entityId: 'entity-42' })
    expect(workspace.getEntityContext).toHaveBeenCalledWith('entity-42', expect.any(Object))
  })

  test('passes limit when provided', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'memory_entity_context', { entityId: 'e1', limit: 10 })
    expect(workspace.getEntityContext).toHaveBeenCalledWith(
      'e1',
      expect.objectContaining({ limit: 10 }),
    )
  })

  test('passes depth when provided', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'memory_entity_context', { entityId: 'e1', depth: 2 })
    expect(workspace.getEntityContext).toHaveBeenCalledWith(
      'e1',
      expect.objectContaining({ depth: 2 }),
    )
  })
})

// ─── memory_similar_situations ────────────────────────────────────────────────

describe('buildMcpTools — memory_similar_situations', () => {
  test('without situation: calls searchMemory twice (episodic + procedural fallback)', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'memory_similar_situations', {})
    expect(workspace.searchMemory).toHaveBeenCalledTimes(2)
    const calls = (workspace.searchMemory as ReturnType<typeof mock>).mock.calls
    const types = calls.map((c) => (c[0] as Record<string, unknown>).type)
    expect(types).toContain('episodic')
    expect(types).toContain('procedural')
  })

  test('without situation: returns { episodes, procedures } shape', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    const result = (await execTool(tools, 'memory_similar_situations', {})) as Record<
      string,
      unknown
    >
    expect(result).toHaveProperty('episodes')
    expect(result).toHaveProperty('procedures')
  })

  test('with situation: calls findSimilarSituations', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'memory_similar_situations', { situation: 'user asked about billing' })
    expect(workspace.findSimilarSituations).toHaveBeenCalledWith(
      'user asked about billing',
      expect.any(Object),
    )
    expect(workspace.searchMemory).not.toHaveBeenCalled()
  })
})

// ─── memory_procedure ─────────────────────────────────────────────────────────

describe('buildMcpTools — memory_procedure', () => {
  test('calls searchMemory with type: procedural', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'memory_procedure', {})
    expect(workspace.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'procedural', excludeInvalid: true }),
    )
  })

  test('passes tags when provided', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    await execTool(tools, 'memory_procedure', { tags: ['coding', 'review'] })
    expect(workspace.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['coding', 'review'] }),
    )
  })
})

// ─── Tool Structure ───────────────────────────────────────────────────────────

describe('buildMcpTools — tool structure', () => {
  test('returns 6 tools', () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    expect(tools).toHaveLength(6)
  })

  test('all tools have name, label, description, parameters, execute', () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.label).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe('function')
    }
  })

  test('execute returns content array with type text', async () => {
    const workspace = makeWorkspace()
    const tools = buildMcpTools(workspace as never)
    const result = await tools[0].execute(
      'tc',
      { threadId: 't', brain: 'limbic' },
      undefined as never,
      undefined,
      undefined,
    )
    expect(Array.isArray(result.content)).toBe(true)
    expect(result.content[0].type).toBe('text')
  })
})
