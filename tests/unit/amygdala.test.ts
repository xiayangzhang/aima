import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Amygdala } from '../../src/amygdala/index'
import type { AmygdalaConfig } from '../../src/amygdala/index'
import { BrainEventBus } from '../../src/eventbus/index'
import { CognitiveWorkspace } from '../../src/workspace/index'
import type { MemoryEntry } from '../../src/types/index'
import * as llmModule from '../../src/llm'

function makeMemoryEntry(opts: {
  decision?: string
  reason?: string
  toolName?: string
  rawContent?: string
  createdAt?: Date
}): MemoryEntry {
  const content =
    opts.rawContent ??
    JSON.stringify({
      tool: opts.toolName ?? 'test_tool',
      decision: opts.decision ?? 'allow',
      reason: opts.reason ?? 'test reason',
    })
  return {
    id: `test-id-${Math.random()}`,
    type: 'implicit',
    content,
    entityId: null,
    segmentId: null,
    segmentSeq: null,
    tags: ['amygdala_eval', opts.toolName ?? 'test_tool', opts.decision ?? 'allow'],
    baseImportance: 0.4,
    usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
    sourceBrain: 'amygdala',
    threadId: null,
    sessionId: null,
    supersedesId: null,
    tInvalid: null,
    lastAccessedAt: null,
    pinned: false,
    forgotten: false,
    expiresAt: null,
    createdAt: opts.createdAt ?? new Date(),
    updatedAt: new Date(),
  }
}

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

function makeSetup(config: AmygdalaConfig = {}) {
  const workspace = new CognitiveWorkspace(mockDb)
  const eventBus = new BrainEventBus()
  const amygdala = new Amygdala(config, workspace, eventBus)
  return { workspace, eventBus, amygdala }
}

describe('Amygdala.check — static rules', () => {
  test('blocks default high-risk tools (bash, file_write, file_delete, file_read)', async () => {
    const { amygdala } = makeSetup()
    for (const tool of ['bash', 'file_write', 'file_delete', 'file_read']) {
      const result = await amygdala.check(tool, {})
      expect(result.decision).toBe('block')
    }
  })

  test('allows memory_ prefix tools by default', async () => {
    const { amygdala } = makeSetup()
    const result = await amygdala.check('memory_search', {})
    expect(result.decision).toBe('allow')
  })

  test('allows workspace_ prefix tools by default', async () => {
    const { amygdala } = makeSetup()
    const result = await amygdala.check('workspace_read_slot', {})
    expect(result.decision).toBe('allow')
  })

  test('allows unknown medium-risk tool by default', async () => {
    const { amygdala } = makeSetup()
    const result = await amygdala.check('some_custom_tool', {})
    expect(result.decision).toBe('allow')
  })

  test('custom rules override defaults (exact match)', async () => {
    const { amygdala } = makeSetup({
      rules: [{ toolName: 'bash', decision: 'allow', reason: 'test override' }],
    })
    const result = await amygdala.check('bash', {})
    expect(result.decision).toBe('allow')
    expect(result.reason).toBe('test override')
  })

  test('custom rules support regex matching', async () => {
    const { amygdala } = makeSetup({
      rules: [{ toolName: /^dangerous_/, decision: 'block', reason: 'regex blocked' }],
    })
    const blocked = await amygdala.check('dangerous_op', {})
    expect(blocked.decision).toBe('block')

    const allowed = await amygdala.check('safe_op', {})
    expect(allowed.decision).toBe('allow')
  })
})

describe('Amygdala.check — escalation', () => {
  let callLlmSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    callLlmSpy = spyOn(llmModule, 'callLlm')
    callLlmSpy.mockResolvedValue('{"decision":"escalate","reason":"mocked"}')
  })

  afterEach(() => {
    callLlmSpy.mockRestore()
  })

  test('escalates high-risk tool when haiku_enabled=true (LLM returns escalate)', async () => {
    const { amygdala } = makeSetup({
      haiku_enabled: true,
      riskLevels: { unknown_high: 'high' },
    })
    const result = await amygdala.check('unknown_high', {})
    expect(result.decision).toBe('escalate')
  })

  test('allows high-risk tool when haiku_enabled=false (no BLOCK match)', async () => {
    const { amygdala } = makeSetup({
      haiku_enabled: false,
      riskLevels: { custom_high: 'high' },
    })
    const result = await amygdala.check('custom_high', {})
    // No static block rule matches, haiku disabled → falls through to allow
    expect(result.decision).toBe('allow')
    expect(callLlmSpy).not.toHaveBeenCalled()
  })
})

describe('Amygdala Stage 3 — LLM evaluation', () => {
  let callLlmSpy: ReturnType<typeof spyOn>

  // Use a mock workspace so writeMemory calls don't hit a real DB
  function makeStage3Setup(config: AmygdalaConfig = {}) {
    const writeMemory = mock(() => Promise.resolve({} as never))
    const workspace = {
      writeMemory,
      getByTags: mock(() => Promise.resolve([])),
      // minimal stubs for other workspace methods Amygdala may access
      pushSignal: mock(() => {}),
      hasSignal: mock(() => false),
      popSignal: mock(() => null),
    } as unknown as CognitiveWorkspace
    const eventBus = new BrainEventBus()
    const amygdala = new Amygdala(
      { riskLevels: { custom_tool: 'high' }, ...config },
      workspace,
      eventBus,
    )
    return { workspace, writeMemory, eventBus, amygdala }
  }

  beforeEach(() => {
    callLlmSpy = spyOn(llmModule, 'callLlm')
  })

  afterEach(() => {
    callLlmSpy.mockRestore()
  })

  // V1: LLM returns allow
  test('V1 — returns allow when LLM responds allow', async () => {
    callLlmSpy.mockResolvedValue('{"decision":"allow","reason":"safe context"}')
    const { amygdala } = makeStage3Setup({ haiku_enabled: true })
    const result = await amygdala.check('custom_tool', { cmd: 'ls /tmp' })
    expect(result.decision).toBe('allow')
    expect(result.reason).toBe('safe context')
  })

  // V2: LLM returns block
  test('V2 — returns block when LLM responds block', async () => {
    callLlmSpy.mockResolvedValue('{"decision":"block","reason":"dangerous command"}')
    const { amygdala } = makeStage3Setup({ haiku_enabled: true })
    const result = await amygdala.check('custom_tool', { cmd: 'rm -rf /' })
    expect(result.decision).toBe('block')
    expect(result.reason).toBe('dangerous command')
  })

  // V3: LLM throws → escalate, no exception propagated
  test('V3 — falls back to escalate when LLM call throws', async () => {
    callLlmSpy.mockRejectedValue(new Error('network timeout'))
    const { amygdala } = makeStage3Setup({ haiku_enabled: true })
    const result = await amygdala.check('custom_tool', {})
    expect(result.decision).toBe('escalate')
    expect(result.reason).toContain('failed')
  })

  // V4: LLM returns invalid decision → escalate
  test('V4 — falls back to escalate when LLM returns invalid decision', async () => {
    callLlmSpy.mockResolvedValue('{"decision":"unknown_value","reason":"..."}')
    const { amygdala } = makeStage3Setup({ haiku_enabled: true })
    const result = await amygdala.check('custom_tool', {})
    expect(result.decision).toBe('escalate')
  })

  // V5: haiku_enabled=false → Stage 3 not triggered
  test('V5 — does not call LLM when haiku_enabled is false', async () => {
    const { amygdala } = makeStage3Setup({ haiku_enabled: false })
    const result = await amygdala.check('custom_tool', {})
    expect(callLlmSpy).not.toHaveBeenCalled()
    expect(result.decision).toBe('allow')
  })

  // V6: medium risk → Stage 3 not triggered
  test('V6 — does not call LLM for medium-risk tools', async () => {
    // spawn_execution_session is medium risk in DEFAULT_RISK_LEVELS
    const { amygdala } = makeStage3Setup({ haiku_enabled: true })
    await amygdala.check('spawn_execution_session', {})
    expect(callLlmSpy).not.toHaveBeenCalled()
  })

  // V7: writeMemory called after evaluation (fire-and-forget)
  test('V7 — writes implicit memory after Stage 3 evaluation', async () => {
    callLlmSpy.mockResolvedValue('{"decision":"allow","reason":"safe"}')
    const { amygdala, writeMemory } = makeStage3Setup({ haiku_enabled: true })
    await amygdala.check('custom_tool', {})
    // Give the fire-and-forget writeMemory promise a tick to settle
    await new Promise((r) => setTimeout(r, 10))
    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'implicit',
        tags: expect.arrayContaining(['amygdala_eval', 'allow']),
      }),
    )
  })

  // V7b: writeMemory also called on LLM failure (escalate fallback)
  test('V7b — writes implicit memory even when LLM fails', async () => {
    callLlmSpy.mockRejectedValue(new Error('timeout'))
    const { amygdala, writeMemory } = makeStage3Setup({ haiku_enabled: true })
    await amygdala.check('custom_tool', {})
    await new Promise((r) => setTimeout(r, 10))
    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'implicit',
        tags: expect.arrayContaining(['amygdala_eval', 'escalate']),
      }),
    )
  })
})

describe('Amygdala Stage 2 — Implicit memory match', () => {
  let callLlmSpy: ReturnType<typeof spyOn>

  function makeStage2Setup(config: AmygdalaConfig = {}) {
    const getByTags = mock(() => Promise.resolve([] as MemoryEntry[]))
    const writeMemory = mock(() => Promise.resolve({} as never))
    const workspace = {
      writeMemory,
      getByTags,
      pushSignal: mock(() => {}),
      hasSignal: mock(() => false),
      popSignal: mock(() => null),
    } as unknown as CognitiveWorkspace
    const eventBus = new BrainEventBus()
    const amygdala = new Amygdala(
      { riskLevels: { spawn_execution_session: 'medium' }, ...config },
      workspace,
      eventBus,
    )
    return { workspace, getByTags, writeMemory, eventBus, amygdala }
  }

  beforeEach(() => {
    callLlmSpy = spyOn(llmModule, 'callLlm')
  })

  afterEach(() => {
    callLlmSpy.mockRestore()
  })

  // V1: memory hit block → returns block, no LLM call
  test('V1 — returns block from memory when recent history shows block', async () => {
    const { getByTags, amygdala } = makeStage2Setup({ haiku_enabled: true })
    getByTags.mockResolvedValue([
      makeMemoryEntry({ decision: 'block', reason: 'dangerous spawn', toolName: 'spawn_execution_session' }),
    ])
    const result = await amygdala.check('spawn_execution_session', {})
    expect(result.decision).toBe('block')
    expect(result.reason).toBe('[memory] dangerous spawn')
    expect(callLlmSpy).not.toHaveBeenCalled()
  })

  // V2: memory hit allow → returns allow, no LLM call
  test('V2 — returns allow from memory when recent history shows allow', async () => {
    const { getByTags, amygdala } = makeStage2Setup({ haiku_enabled: true })
    getByTags.mockResolvedValue([
      makeMemoryEntry({ decision: 'allow', reason: 'safe context', toolName: 'spawn_execution_session' }),
    ])
    const result = await amygdala.check('spawn_execution_session', {})
    expect(result.decision).toBe('allow')
    expect(result.reason.startsWith('[memory]')).toBe(true)
    expect(callLlmSpy).not.toHaveBeenCalled()
  })

  // V3: multiple records → uses most recent
  test('V3 — uses most recent record when multiple history entries exist', async () => {
    const { getByTags, amygdala } = makeStage2Setup({ haiku_enabled: true })
    const older = makeMemoryEntry({
      decision: 'allow',
      reason: 'old',
      toolName: 'spawn_execution_session',
      createdAt: new Date(Date.now() - 10000),
    })
    const newer = makeMemoryEntry({
      decision: 'block',
      reason: 'new',
      toolName: 'spawn_execution_session',
      createdAt: new Date(),
    })
    getByTags.mockResolvedValue([older, newer])
    const result = await amygdala.check('spawn_execution_session', {})
    expect(result.decision).toBe('block')
    expect(result.reason).toBe('[memory] new')
  })

  // V4: no history → falls through to Stage 3
  test('V4 — falls through to Stage 3 when no memory history exists', async () => {
    const { getByTags, amygdala } = makeStage2Setup({
      haiku_enabled: true,
      riskLevels: { custom_tool: 'high' },
    })
    getByTags.mockResolvedValue([])
    callLlmSpy.mockResolvedValue('{"decision":"allow","reason":"llm ok"}')
    await amygdala.check('custom_tool', {})
    expect(callLlmSpy).toHaveBeenCalledTimes(1)
  })

  // V5: getByTags throws → silently falls through, no exception propagated
  test('V5 — silently falls through when getByTags throws', async () => {
    const { getByTags, amygdala } = makeStage2Setup({
      haiku_enabled: true,
      riskLevels: { custom_tool: 'high' },
    })
    getByTags.mockRejectedValue(new Error('db error'))
    callLlmSpy.mockResolvedValue('{"decision":"escalate","reason":"fallback"}')
    const result = await amygdala.check('custom_tool', {})
    expect(result.decision).toBeDefined()
    expect(callLlmSpy).toHaveBeenCalledTimes(1)
  })

  // V6: invalid JSON in content → falls through (no [memory] prefix)
  test('V6 — falls through when memory content is invalid JSON', async () => {
    const { getByTags, amygdala } = makeStage2Setup({ haiku_enabled: true })
    getByTags.mockResolvedValue([
      makeMemoryEntry({ rawContent: 'not valid json', toolName: 'spawn_execution_session' }),
    ])
    const result = await amygdala.check('spawn_execution_session', {})
    expect(result.reason.startsWith('[memory]')).toBe(false)
  })
})

describe('Amygdala.startListening', () => {
  test('pushes amygdala_interrupt signal when tool.pre_use triggers block', async () => {
    const { workspace, eventBus, amygdala } = makeSetup()
    const unsub = amygdala.startListening()

    // Emit a tool.pre_use event for a blocked tool
    eventBus.emit({
      event_type: 'tool.pre_use',
      level: 'INFO',
      brain: 'brainstem',
      thread_id: 'thread-1',
      session_id: 'sess-1',
      payload: { tool: 'bash', args: {} },
    })

    // Give async listener a tick to process
    await new Promise((r) => setTimeout(r, 10))

    expect(workspace.hasSignal('amygdala_interrupt', 'thread-1')).toBe(true)
    const sig = workspace.popSignal('amygdala_interrupt', 'thread-1')
    expect(sig?.message).toContain('block')
    expect(sig?.message).toContain('bash')

    unsub()
  })

  test('does NOT push signal for allowed tools', async () => {
    const { workspace, eventBus, amygdala } = makeSetup()
    const unsub = amygdala.startListening()

    eventBus.emit({
      event_type: 'tool.pre_use',
      level: 'INFO',
      brain: 'brainstem',
      thread_id: 'thread-1',
      payload: { tool: 'memory_search', args: {} },
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(workspace.hasSignal('amygdala_interrupt', 'thread-1')).toBe(false)

    unsub()
  })

  test('emits amygdala.interrupt ALERT event on block', async () => {
    const { eventBus, amygdala } = makeSetup()
    const alerts: string[] = []
    eventBus.subscribeLevel('ALERT', (e) => {
      if (e.event_type === 'amygdala.interrupt') alerts.push(e.payload.tool as string)
    })

    amygdala.startListening()
    eventBus.emit({
      event_type: 'tool.pre_use',
      level: 'INFO',
      brain: 'brainstem',
      payload: { tool: 'file_delete', args: {} },
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(alerts).toContain('file_delete')
  })

  test('ignores non-tool.pre_use events', async () => {
    const { workspace, eventBus, amygdala } = makeSetup()
    amygdala.startListening()

    eventBus.emit({ event_type: 'brain.complete', level: 'INFO', brain: 'cortex', payload: {} })
    await new Promise((r) => setTimeout(r, 10))
    expect(workspace.hasSignal('amygdala_interrupt', '')).toBe(false)
  })
})
