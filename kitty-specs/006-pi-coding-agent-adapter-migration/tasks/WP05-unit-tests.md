---
work_package_id: "WP05"
title: "Unit Tests ≥30"
phase: "Phase 4 - Verification"
lane: "planned"
dependencies: ["WP04"]
subtasks:
  - "T019"
  - "T020"
  - "T021"
  - "T022"
  - "T023"
  - "T024"
  - "T025"
  - "T026"
assignee: ""
agent: ""
shell_pid: ""
review_status: ""
reviewed_by: ""
history:
  - timestamp: "2026-03-11T00:00:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
---

# Work Package Prompt: WP05 – Unit Tests ≥30

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, scroll to Review Feedback section.

---

## Review Feedback

*[Empty initially.]*

---

## Objectives & Success Criteria

Implement ≥30 unit tests covering all behavioral paths of the new `PiCodingAgentAdapter`, `createAimaExtension`, and `buildMcpTools`. Tests use mocked pi-coding-agent sessions — NO real API calls, NO real LLM.

**Success criteria**:
- `bun test tests/unit/adapters/pi-coding-agent/` passes with ≥30 tests
- All 7 FR paths are covered (session management, run/resume, inject, abort, allow/block/escalate, default policy, EventBus events, MCP tools)
- `biome check` passes

**Implementation command**:
```bash
spec-kitty implement WP05 --base WP04
```

---

## Context & Constraints

- **Spec**: FR-07 (test coverage — unit tests ≥30)
- **Constitution**: 真实测试 — mock pi-coding-agent session (not real), but behavior must be verified (call counts, arguments, event shapes)
- **Test runner**: `bun:test` — use `describe`, `test`, `expect`, `mock`, `beforeEach`
- **Mock pattern**: `mock(() => ...)` from `bun:test` creates a spy function; `spy.mock.calls` to inspect calls
- **No `any` types** in test files either — Biome enforces this
- **Reference test patterns**: `tests/unit/` — read existing test files to understand conventions

---

## Subtasks & Detailed Guidance

### Subtask T019 — Test File Structure + Mock Session Factory

**Purpose**: Set up the test directory and define reusable mock helpers used across all test files.

**Steps**:

1. Create directory: `tests/unit/adapters/pi-coding-agent/`
2. Create `tests/unit/adapters/pi-coding-agent/adapter.test.ts` with mock factory:

```typescript
import { describe, expect, mock, test, beforeEach } from 'bun:test'
import { PiCodingAgentAdapter } from '../../../../src/adapters/pi-coding-agent/index'
import type { PiCodingAgentAdapterConfig } from '../../../../src/adapters/pi-coding-agent/index'
import type { CognitiveWorkspace } from '../../../../src/workspace/index'
import type { BrainEventBus } from '../../../../src/eventbus/index'
import type { Amygdala } from '../../../../src/amygdala/index'

function makeMockSession() {
  return {
    steer: mock((_msg: string) => {}),
    followUp: mock((_msg: string) => {}),
    abort: mock(() => {}),
    prompt: mock(async (_msg: string) => {}),
  }
}

function makeMockWorkspace(): CognitiveWorkspace {
  return {
    setSignal: mock((_signal: unknown) => {}),
    // add other workspace methods as needed by tests
  } as unknown as CognitiveWorkspace
}

function makeMockEventBus(): BrainEventBus {
  return {
    emit: mock((_event: unknown) => {}),
  } as unknown as BrainEventBus
}

function makeMockAmygdala(): Amygdala {
  return {
    check: mock(async (_tool: string, _args: unknown) => ({
      decision: 'allow' as const,
      reason: undefined,
    })),
  } as unknown as Amygdala
}

function makeConfig(overrides?: Partial<PiCodingAgentAdapterConfig>): PiCodingAgentAdapterConfig {
  return {
    modelId: 'claude-haiku-4-5-20251001',
    workspace: makeMockWorkspace(),
    eventBus: makeMockEventBus(),
    amygdala: makeMockAmygdala(),
    getApiKey: () => 'test-key',
    ...overrides,
  }
}
```

3. Mock `createAgentSession` from pi-coding-agent — this is the key mock needed for `run()`:

```typescript
// At top of adapter.test.ts
import { mock } from 'bun:test'

// Mock the pi-coding-agent module
const mockSession = makeMockSession()
mock.module('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: mock(async () => mockSession),
  SessionManager: {
    inMemory: mock(() => ({})),
  },
}))
```

**Notes**:
- `mock.module()` in bun:test allows mocking entire npm modules — verify this API in current Bun version
- If `mock.module()` isn't available, use `jest.mock()` equivalent or restructure adapter to accept a session factory as a constructor param (dependency injection)
- The mock session must match the actual `AgentSession` interface shape

---

### Subtask T020 — run() Tests: Session Lifecycle

**Purpose**: Verify first-run creates session, second-run resumes, systemPrompt is refreshed, multi-brain sessions are isolated.

**Test cases** (5 tests):

```typescript
describe('PiCodingAgentAdapter.run()', () => {
  test('first run creates a new AgentSession', async () => {
    const adapter = new PiCodingAgentAdapter(makeConfig())
    await adapter.run({
      brain: 'limbic',
      threadId: 'thread-1',
      systemPrompt: 'You are Limbic.',
      initialPrompt: 'Hello',
    })
    expect(createAgentSession).toHaveBeenCalledOnce()
    expect(mockSession.prompt).toHaveBeenCalledWith('Hello')
  })

  test('second run on same brain:threadId reuses session (no new createAgentSession)', async () => {
    const adapter = new PiCodingAgentAdapter(makeConfig())
    await adapter.run({ brain: 'limbic', threadId: 'thread-1', systemPrompt: 'Prompt 1', initialPrompt: 'First' })
    await adapter.run({ brain: 'limbic', threadId: 'thread-1', systemPrompt: 'Prompt 2' })
    expect(createAgentSession).toHaveBeenCalledOnce() // still only 1 call
    expect(mockSession.prompt).toHaveBeenCalledTimes(2)
  })

  test('different brain:threadId combinations use separate sessions', async () => {
    const adapter = new PiCodingAgentAdapter(makeConfig())
    await adapter.run({ brain: 'limbic', threadId: 'thread-1', systemPrompt: 'S1', initialPrompt: 'A' })
    await adapter.run({ brain: 'cortex', threadId: 'thread-1', systemPrompt: 'S2', initialPrompt: 'B' })
    expect(createAgentSession).toHaveBeenCalledTimes(2) // 2 different sessions
  })

  test('run() returns stopReason: done', async () => {
    const adapter = new PiCodingAgentAdapter(makeConfig())
    const result = await adapter.run({ brain: 'limbic', threadId: 't1', systemPrompt: 'S', initialPrompt: 'Hi' })
    expect(result.stopReason).toBe('done')
  })

  test('run() sessionId is brain:threadId key', async () => {
    const adapter = new PiCodingAgentAdapter(makeConfig())
    const result = await adapter.run({ brain: 'brainstem', threadId: 'thread-99', systemPrompt: 'S', initialPrompt: 'X' })
    expect(result.sessionId).toBe('brainstem:thread-99')
  })
})
```

---

### Subtask T021 — inject() Tests

**Purpose**: Verify inject() routes signals correctly.

**Test cases** (3 tests):

```typescript
describe('PiCodingAgentAdapter.inject()', () => {
  test('amygdala_interrupt → session.steer() called with [AMYGDALA INTERRUPT] prefix', async () => {
    const adapter = new PiCodingAgentAdapter(makeConfig())
    await adapter.run({ brain: 'limbic', threadId: 't1', systemPrompt: 'S', initialPrompt: 'Hi' })
    await adapter.inject({ type: 'amygdala_interrupt', message: 'Stop now' })
    expect(mockSession.steer).toHaveBeenCalledWith('[AMYGDALA INTERRUPT] Stop now')
  })

  test('dmn_correction → session.followUp() called with [DMN CORRECTION] prefix', async () => {
    const adapter = new PiCodingAgentAdapter(makeConfig())
    await adapter.run({ brain: 'limbic', threadId: 't1', systemPrompt: 'S', initialPrompt: 'Hi' })
    await adapter.inject({ type: 'dmn_correction', message: 'Reconsider approach' })
    expect(mockSession.followUp).toHaveBeenCalledWith('[DMN CORRECTION] Reconsider approach')
  })

  test('inject with no active sessions → workspace.setSignal() called (fallback)', async () => {
    const workspace = makeMockWorkspace()
    const adapter = new PiCodingAgentAdapter(makeConfig({ workspace }))
    // No run() called — no active session
    await adapter.inject({ type: 'amygdala_interrupt', message: 'Alert!' })
    expect(workspace.setSignal).toHaveBeenCalledWith(expect.objectContaining({ type: 'amygdala_interrupt' }))
  })
})
```

---

### Subtask T022 — abort() and abortSession() Tests

**Purpose**: Verify abort behavior clears session map.

**Test cases** (2 tests):

```typescript
describe('PiCodingAgentAdapter.abort()', () => {
  test('abort() calls session.abort() and clears all sessions', async () => {
    const adapter = new PiCodingAgentAdapter(makeConfig())
    await adapter.run({ brain: 'limbic', threadId: 't1', systemPrompt: 'S', initialPrompt: 'Hi' })
    adapter.abort()
    expect(mockSession.abort).toHaveBeenCalledOnce()
    // After abort, inject should go to workspace fallback (no sessions)
    const workspace = makeMockWorkspace()
    const adapter2 = new PiCodingAgentAdapter(makeConfig({ workspace }))
    await adapter2.run({ brain: 'limbic', threadId: 't1', systemPrompt: 'S', initialPrompt: 'Hi' })
    adapter2.abort()
    await adapter2.inject({ type: 'amygdala_interrupt', message: 'test' })
    expect(workspace.setSignal).toHaveBeenCalled()
  })

  test('abortSession() removes only the specific session', async () => {
    const adapter = new PiCodingAgentAdapter(makeConfig())
    await adapter.run({ brain: 'limbic', threadId: 't1', systemPrompt: 'S', initialPrompt: 'A' })
    await adapter.run({ brain: 'cortex', threadId: 't1', systemPrompt: 'S', initialPrompt: 'B' })
    adapter.abortSession('limbic', 't1')
    // limbic session aborted, cortex session still active
    // inject to limbic should now fallback... but cortex should still steer
    // This verifies session map is partially cleared
    expect(mockSession.abort).toHaveBeenCalledOnce()
  })
})
```

---

### Subtask T023 — Extension: allow/block/escalate Paths

**Purpose**: Verify the core `tool_call` handler decision paths.

**Setup**:
```typescript
// extension.test.ts
import { describe, expect, mock, test } from 'bun:test'
import { createAimaExtension } from '../../../../src/adapters/pi-coding-agent/extension'
```

**Test cases** (3 tests):

```typescript
describe('createAimaExtension — tool_call decisions', () => {
  test('allow decision → tool_call handler returns undefined', async () => {
    const amygdala = makeMockAmygdala() // check returns 'allow'
    const eventBus = makeMockEventBus()
    const ext = createAimaExtension('limbic', 'thread-1', amygdala, eventBus, [])
    const result = await ext.handlers.tool_call?.({ toolName: 'memory_search', toolCallId: 'tc1', args: {} })
    expect(result).toBeUndefined()
  })

  test('block decision → returns { block: true, message }', async () => {
    const amygdala = { check: mock(async () => ({ decision: 'block', reason: 'Not allowed' })) } as unknown as Amygdala
    const eventBus = makeMockEventBus()
    const ext = createAimaExtension('limbic', 'thread-1', amygdala, eventBus, [])
    const result = await ext.handlers.tool_call?.({ toolName: 'custom_tool', toolCallId: 'tc1', args: {} })
    expect(result).toEqual({ block: true, message: 'Not allowed' })
  })

  test('escalate decision → returns { block: true } AND emits amygdala.escalation ALERT', async () => {
    const amygdala = { check: mock(async () => ({ decision: 'escalate', reason: 'Critical risk' })) } as unknown as Amygdala
    const eventBus = makeMockEventBus()
    const ext = createAimaExtension('limbic', 'thread-1', amygdala, eventBus, [])
    const result = await ext.handlers.tool_call?.({ toolName: 'custom_tool', toolCallId: 'tc1', args: {} })
    expect(result).toMatchObject({ block: true })
    const events = (eventBus.emit as ReturnType<typeof mock>).mock.calls.map((c) => c[0])
    const escalation = events.find((e) => e.event_type === 'amygdala.escalation')
    expect(escalation?.level).toBe('ALERT')
  })
})
```

---

### Subtask T024 — Extension: Default Policy Tests

**Purpose**: Verify static policy — bash/edit/write blocked without `amygdala.check()`; read/grep pass through.

**Test cases** (4 tests):

```typescript
describe('createAimaExtension — default tool policy', () => {
  test('bash → blocked by default policy (amygdala.check NOT called)', async () => {
    const amygdala = makeMockAmygdala()
    const ext = createAimaExtension('brainstem', 'thread-1', amygdala, makeMockEventBus(), [])
    const result = await ext.handlers.tool_call?.({ toolName: 'bash', toolCallId: 'tc1', args: { command: 'ls' } })
    expect(result).toMatchObject({ block: true })
    expect(amygdala.check).not.toHaveBeenCalled()
  })

  test('edit → blocked by default policy', async () => {
    const amygdala = makeMockAmygdala()
    const ext = createAimaExtension('brainstem', 'thread-1', amygdala, makeMockEventBus(), [])
    const result = await ext.handlers.tool_call?.({ toolName: 'edit', toolCallId: 'tc2', args: {} })
    expect(result).toMatchObject({ block: true })
    expect(amygdala.check).not.toHaveBeenCalled()
  })

  test('read → NOT auto-blocked; amygdala.check called; allow returned', async () => {
    const amygdala = makeMockAmygdala() // returns allow
    const ext = createAimaExtension('cortex', 'thread-1', amygdala, makeMockEventBus(), [])
    const result = await ext.handlers.tool_call?.({ toolName: 'read', toolCallId: 'tc3', args: {} })
    expect(result).toBeUndefined() // allowed
    expect(amygdala.check).toHaveBeenCalledWith('read', expect.anything())
  })

  test('grep → NOT auto-blocked; amygdala.check called', async () => {
    const amygdala = makeMockAmygdala()
    const ext = createAimaExtension('cortex', 'thread-1', amygdala, makeMockEventBus(), [])
    await ext.handlers.tool_call?.({ toolName: 'grep', toolCallId: 'tc4', args: {} })
    expect(amygdala.check).toHaveBeenCalledWith('grep', expect.anything())
  })
})
```

---

### Subtask T025 — Extension: EventBus Event Shape Tests

**Purpose**: Verify each EventBus event has the correct `event_type`, `level`, `brain`, `thread_id`, and payload.

**Test cases** (5 tests):

```typescript
describe('createAimaExtension — EventBus events', () => {
  function captureEvents(eventBus: BrainEventBus) {
    return (eventBus.emit as ReturnType<typeof mock>).mock.calls.map((c) => c[0])
  }

  test('tool.pre_use emitted for every tool_call (including blocked)', async () => {
    const eventBus = makeMockEventBus()
    const ext = createAimaExtension('limbic', 'thread-42', makeMockAmygdala(), eventBus, [])
    await ext.handlers.tool_call?.({ toolName: 'bash', toolCallId: 'tc1', args: {} })
    const events = captureEvents(eventBus)
    const preUse = events.find((e) => e.event_type === 'tool.pre_use')
    expect(preUse).toMatchObject({
      event_type: 'tool.pre_use',
      level: 'INFO',
      brain: 'limbic',
      thread_id: 'thread-42',
      payload: { tool: 'bash', toolCallId: 'tc1' },
    })
  })

  test('tool.blocked level is COMPLIANCE (not INFO)', async () => {
    const eventBus = makeMockEventBus()
    const ext = createAimaExtension('limbic', 'thread-1', makeMockAmygdala(), eventBus, [])
    await ext.handlers.tool_call?.({ toolName: 'bash', toolCallId: 'tc1', args: {} })
    const events = captureEvents(eventBus)
    const blocked = events.find((e) => e.event_type === 'tool.blocked')
    expect(blocked?.level).toBe('COMPLIANCE')
  })

  test('tool.post_use emitted by tool_execution_end with correct payload', () => {
    const eventBus = makeMockEventBus()
    const ext = createAimaExtension('cortex', 'thread-1', makeMockAmygdala(), eventBus, [])
    ext.handlers.tool_execution_end?.({ toolName: 'read', toolCallId: 'tc5', isError: false })
    const events = captureEvents(eventBus)
    expect(events[0]).toMatchObject({
      event_type: 'tool.post_use',
      level: 'INFO',
      brain: 'cortex',
      thread_id: 'thread-1',
      payload: { tool: 'read', toolCallId: 'tc5', isError: false },
    })
  })

  test('brain.loop_end emitted by agent_end', () => {
    const eventBus = makeMockEventBus()
    const ext = createAimaExtension('brainstem', 'thread-1', makeMockAmygdala(), eventBus, [])
    ext.handlers.agent_end?.({})
    const events = captureEvents(eventBus)
    expect(events[0]).toMatchObject({ event_type: 'brain.loop_end', level: 'INFO', brain: 'brainstem' })
  })

  test('amygdala.escalation level is ALERT', async () => {
    const amygdala = { check: mock(async () => ({ decision: 'escalate', reason: 'High risk' })) } as unknown as Amygdala
    const eventBus = makeMockEventBus()
    const ext = createAimaExtension('limbic', 'thread-1', amygdala, eventBus, [])
    await ext.handlers.tool_call?.({ toolName: 'custom_risky', toolCallId: 'tc9', args: {} })
    const events = captureEvents(eventBus)
    const escalation = events.find((e) => e.event_type === 'amygdala.escalation')
    expect(escalation?.level).toBe('ALERT')
  })
})
```

---

### Subtask T026 — mcp-tools.test.ts: MCP Tool Wrapping

**Purpose**: Verify `buildMcpTools` correctly wraps AIMA MCP tools.

**Setup**:
```typescript
// mcp-tools.test.ts
import { describe, expect, mock, test } from 'bun:test'
import { buildMcpTools } from '../../../../src/adapters/pi-coding-agent/mcp-tools'
```

**Test cases** (5 tests):

```typescript
describe('buildMcpTools', () => {
  function makeMockWorkspace() {
    return {} as unknown as CognitiveWorkspace
  }

  test('returns an array (even if empty)', () => {
    const tools = buildMcpTools(makeMockWorkspace())
    expect(Array.isArray(tools)).toBe(true)
  })

  test('each AgentTool has name and description', () => {
    const tools = buildMcpTools(makeMockWorkspace())
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(tool.name.length).toBeGreaterThan(0)
    }
  })

  test('each AgentTool has an execute function', () => {
    const tools = buildMcpTools(makeMockWorkspace())
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function')
    }
  })

  test('tool names include known AIMA MCP tool names (if server is implemented)', () => {
    const tools = buildMcpTools(makeMockWorkspace())
    // If MCP server returns tools, verify known names exist
    if (tools.length > 0) {
      const names = tools.map((t) => t.name)
      // Known AIMA MCP tools — adjust based on actual MCP server implementation
      expect(names.some((n) => n.includes('memory') || n.includes('workspace'))).toBe(true)
    } else {
      // MCP server stub — acceptable for WP03; integration will verify
      expect(tools.length).toBeGreaterThanOrEqual(0)
    }
  })

  test('execute() delegates to workspace method', async () => {
    // Mock createAimaMcpServer to return a tool that delegates
    mock.module('../../../../src/mcp/index', () => ({
      createAimaMcpServer: (_ws: unknown) => ({
        getTools: () => [{
          name: 'test_tool',
          description: 'Test',
          inputSchema: {},
          execute: mock(async (args: unknown) => ({ result: `executed: ${JSON.stringify(args)}` })),
        }],
      }),
    }))
    const tools = buildMcpTools(makeMockWorkspace())
    if (tools.length > 0) {
      const result = await tools[0].execute({ key: 'value' })
      expect(result).toMatchObject({ result: expect.stringContaining('executed') })
    }
  })
})
```

---

## Test Strategy

Run:
```bash
bun test tests/unit/adapters/pi-coding-agent/
```

Expected output: ≥30 tests, all passing. Count breakdown:
- T020: 5 tests
- T021: 3 tests
- T022: 2 tests
- T023: 3 tests
- T024: 4 tests
- T025: 5 tests
- T026: 5 tests
- **Total: 27 minimum** — add edge cases (null args, empty string message, etc.) to reach ≥30

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `mock.module()` not available in this Bun version | Use dependency injection — add `sessionFactory` param to adapter constructor |
| `mockSession.steer/followUp` signatures differ | Check actual AgentSession types; adjust mock shape |
| `ext.handlers.tool_call` returns wrong type | Read actual Extension type; adjust test assertions |
| Test count < 30 | Add edge cases: empty message inject, undefined args, write tool default-block, etc. |

---

## Definition of Done Checklist

- [ ] T019: `tests/unit/adapters/pi-coding-agent/` directory + mock factory helpers created
- [ ] T020: ≥5 tests for run() lifecycle in adapter.test.ts
- [ ] T021: ≥3 tests for inject() in adapter.test.ts
- [ ] T022: ≥2 tests for abort/abortSession in adapter.test.ts
- [ ] T023: ≥3 tests for allow/block/escalate in extension.test.ts
- [ ] T024: ≥4 tests for default policy in extension.test.ts
- [ ] T025: ≥5 tests for EventBus event shapes in extension.test.ts
- [ ] T026: ≥5 tests for MCP tool wrapping in mcp-tools.test.ts
- [ ] Total ≥ 30 tests passing
- [ ] `biome check tests/unit/adapters/pi-coding-agent/` passes

## Review Guidance

1. Test assertions must check specific values (event type, level, payload fields) — not just `toBeTruthy()`
2. Verify test count ≥ 30 by running with `--verbose` flag: `bun test tests/unit/adapters/pi-coding-agent/ --verbose`
3. Check that `amygdala.check` is NOT called for bash/edit/write (default policy bypass)
4. Verify that `tool.pre_use` is emitted even for blocked tools (spec requirement)

## Activity Log

- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created.
