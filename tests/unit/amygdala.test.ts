import { describe, expect, test } from 'bun:test'
import { Amygdala } from '../../src/amygdala/index'
import type { AmygdalaConfig } from '../../src/amygdala/index'
import { BrainEventBus } from '../../src/eventbus/index'
import { CognitiveWorkspace } from '../../src/workspace/index'

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
  test('escalates high-risk tool when haiku_enabled=true', async () => {
    const { amygdala } = makeSetup({
      rules: [], // no custom rules — let default BLOCK fire first
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

    expect(workspace.hasSignal('amygdala_interrupt')).toBe(true)
    const sig = workspace.popSignal('amygdala_interrupt')
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
    expect(workspace.hasSignal('amygdala_interrupt')).toBe(false)

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
    expect(workspace.hasSignal('amygdala_interrupt')).toBe(false)
  })
})
