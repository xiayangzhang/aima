---
work_package_id: "WP02"
title: "Extension Factory — Amygdala + EventBus"
phase: "Phase 2 - Core Behavior"
lane: "planned"
dependencies: ["WP01"]
subtasks:
  - "T006"
  - "T007"
  - "T008"
  - "T009"
  - "T010"
  - "T011"
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

# Work Package Prompt: WP02 – Extension Factory — Amygdala + EventBus

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, scroll to Review Feedback section.

---

## Review Feedback

*[Empty initially.]*

---

## Objectives & Success Criteria

Replace the stub `createAimaExtension()` in `src/adapters/pi-coding-agent/extension.ts` with a full implementation. The Extension wires:
1. **Amygdala per-tool interception** via `tool_call` handler — default policy table + `amygdala.check()` for dynamic rules
2. **EventBus event bridge** via `tool_execution_start/end` and `agent_end` handlers

Update `run()` in `index.ts` to use the real extension (replace the dynamic import with a static import if needed).

**Success criteria**:
- `tool_call` handler with `decision: 'block'` → returns `{ block: true, message: ... }` + emits `tool.blocked` (COMPLIANCE)
- `tool_call` handler with `decision: 'escalate'` → same as block + emits `amygdala.escalation` (ALERT)
- `tool_call` handler with `decision: 'allow'` → returns `undefined`
- `bash` tool → blocked by default policy without calling `amygdala.check()`
- `read` tool → `amygdala.check()` called, result determines outcome
- `tool_execution_start` → `tool.pre_use` EventBus event emitted with correct payload
- `tool_execution_end` → `tool.post_use` EventBus event emitted
- `agent_end` → `brain.loop_end` emitted

**Implementation command**:
```bash
spec-kitty implement WP02 --base WP01
```

---

## Context & Constraints

- **Spec**: FR-02 (Amygdala Extension), FR-03 (EventBus tool events)
- **Plan**: plan.md WP02 section
- **Constitution**: 不降级 — block decision MUST prevent tool execution; no silent fallback
- **Amygdala interface**: Read `src/amygdala/index.ts` to understand `amygdala.check(toolName, args)` return type — should return `{ decision: 'allow' | 'block' | 'escalate', reason?: string }`
- **EventBus emit**: `src/eventbus/index.ts` — `eventBus.emit({ event_type, level, brain, thread_id, payload })`
- **Extension type**: From pi-coding-agent — verify exact shape of `Extension` and `ToolCallEvent` types after package install

---

## Subtasks & Detailed Guidance

### Subtask T006 — createAimaExtension() Function Signature

**Purpose**: Define the public API of the extension factory and establish the file structure.

**Steps**:
1. Read `src/amygdala/index.ts` to understand the `check()` method signature.
2. Read `node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts` — find the `Extension` type definition.
3. Replace stub in `src/adapters/pi-coding-agent/extension.ts` with:

```typescript
import type { AgentTool, Extension, ToolCallEvent } from '@mariozechner/pi-coding-agent'
import type { Amygdala } from '../../amygdala/index'
import type { BrainEventBus } from '../../eventbus/index'
import type { CognitiveBrainType } from '../../types/index'

/** Default tool policy: true = BLOCK without Amygdala check */
const DEFAULT_BLOCKED_TOOLS = new Set(['bash', 'edit', 'write'])
const DEFAULT_ALLOWED_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

export function createAimaExtension(
  brain: CognitiveBrainType,
  threadId: string,
  amygdala: Amygdala,
  eventBus: BrainEventBus,
  registeredTools: AgentTool[] = [],
): Extension {
  return {
    registeredTools,
    handlers: {
      // Handlers filled in T007-T011
    },
  }
}
```

**Notes**:
- `Extension` type from pi-coding-agent — if exact name differs, use the correct name. Common alternatives: `AgentExtension`, `ExtensionDefinition`.
- `ToolCallEvent` fields to confirm: `toolName: string`, `toolCallId: string`, `args: unknown`

---

### Subtask T007 — tool_call Handler: Default Policy + amygdala.check()

**Purpose**: Implement the core Amygdala interception logic.

**Steps**:

Add the `tool_call` handler to the `handlers` object:

```typescript
tool_call: async (event: ToolCallEvent) => {
  const { toolName, toolCallId, args } = event

  // 1. Default policy: statically block high-risk tools
  if (DEFAULT_BLOCKED_TOOLS.has(toolName)) {
    eventBus.emit({
      event_type: 'tool.pre_use',
      level: 'INFO',
      brain,
      thread_id: threadId,
      payload: { tool: toolName, toolCallId, args: args as Record<string, unknown> },
    })
    // Emit block event BEFORE returning block decision
    eventBus.emit({
      event_type: 'tool.blocked',
      level: 'COMPLIANCE',
      brain,
      thread_id: threadId,
      payload: {
        tool: toolName,
        toolCallId,
        reason: `${toolName} tool blocked by default policy`,
      },
    })
    return { block: true, message: `${toolName} tool blocked by default policy` }
  }

  // 2. Emit pre_use BEFORE amygdala check
  eventBus.emit({
    event_type: 'tool.pre_use',
    level: 'INFO',
    brain,
    thread_id: threadId,
    payload: { tool: toolName, toolCallId, args: args as Record<string, unknown> },
  })

  // 3. For known-safe tools, skip check
  if (DEFAULT_ALLOWED_TOOLS.has(toolName)) {
    return undefined // allow
  }

  // 4. Dynamic Amygdala check for all other tools (including MCP tools)
  const result = await amygdala.check(toolName, args as Record<string, unknown>)
  // ... handled in T008
},
```

**Notes**:
- Verify `amygdala.check()` return type — may be `{ decision: string; reason?: string }` or similar
- `tool.pre_use` is emitted for ALL tools (including default-blocked) — spec FR-03: "被 block 的工具调用产生 `tool.pre_use` + `tool.blocked` 事件"
- Type `args as Record<string, unknown>` is acceptable here since event type is `unknown`

---

### Subtask T008 — Block/Escalate Decision Paths + EventBus Events

**Purpose**: Complete the `tool_call` handler with block/escalate outcome handling.

**Steps**:

Continue T007's handler after the `amygdala.check()` call:

```typescript
  if (result.decision === 'allow') {
    return undefined
  }

  if (result.decision === 'escalate') {
    eventBus.emit({
      event_type: 'amygdala.escalation',
      level: 'ALERT',
      brain,
      thread_id: threadId,
      payload: {
        tool: toolName,
        toolCallId,
        reason: result.reason ?? 'Amygdala escalation',
      },
    })
    eventBus.emit({
      event_type: 'tool.blocked',
      level: 'COMPLIANCE',
      brain,
      thread_id: threadId,
      payload: {
        tool: toolName,
        toolCallId,
        reason: result.reason ?? 'Amygdala escalation',
      },
    })
    return { block: true, message: result.reason ?? 'Tool blocked by Amygdala (escalated)' }
  }

  // decision === 'block'
  eventBus.emit({
    event_type: 'tool.blocked',
    level: 'COMPLIANCE',
    brain,
    thread_id: threadId,
    payload: {
      tool: toolName,
      toolCallId,
      reason: result.reason ?? 'Tool blocked by Amygdala',
    },
  })
  return { block: true, message: result.reason ?? 'Tool blocked by Amygdala' }
```

**Key points**:
- `tool.blocked` level = `COMPLIANCE` (not `INFO`)
- `amygdala.escalation` level = `ALERT`
- For `escalate`: emit BOTH `amygdala.escalation` AND `tool.blocked` — spec says "同 block + 发射 amygdala.escalation ALERT 事件"
- `result.reason` may be undefined — use `??` fallback

---

### Subtask T009 — tool_execution_start → tool.pre_use Event

**Purpose**: Wait — `tool.pre_use` is already emitted in T007 inside `tool_call`. This is correct per the spec ("tool_call 处理器"). The `tool_execution_start` Extension event is a SEPARATE event that fires AFTER tool_call handler returns. We do NOT need to emit `tool.pre_use` twice.

**Clarification**: Looking at spec FR-03 table:
- `tool.pre_use` → triggered by `tool_call` handler ✅ (done in T007)
- `tool.post_use` → triggered by `tool_execution_end` ← this is T009/T010

**Steps**:

Add `tool_execution_start` handler — this can optionally emit DEBUG info or be left minimal:

```typescript
tool_execution_start: (event) => {
  // tool.pre_use was already emitted in tool_call handler
  // tool_execution_start fires only when tool was ALLOWED (not blocked)
  // Use this for trace-level debug if needed — currently no additional EventBus event
},
```

**Note**: If there's any mismatch between `tool_call` pre_use timing and `tool_execution_start`, the integration tests (WP06) will catch it.

---

### Subtask T010 — tool_execution_end → tool.post_use Event

**Purpose**: Emit `tool.post_use` when a tool finishes executing successfully (i.e., was not blocked).

**Steps**:

Add `tool_execution_end` handler:

```typescript
tool_execution_end: (event) => {
  eventBus.emit({
    event_type: 'tool.post_use',
    level: 'INFO',
    brain,
    thread_id: threadId,
    payload: {
      tool: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError ?? false,
    },
  })
},
```

**Verify**: `ToolExecutionEndEvent` fields from pi-coding-agent types — confirm `toolName`, `toolCallId`, `isError` field names.

---

### Subtask T011 — agent_end → brain.loop_end + Update run()

**Purpose**: Emit `brain.loop_end` when the agent finishes its run; update `run()` in `index.ts` to use the real extension.

**Steps**:

1. Add `agent_end` handler:

```typescript
agent_end: (_event) => {
  eventBus.emit({
    event_type: 'brain.loop_end',
    level: 'INFO',
    brain,
    thread_id: threadId,
    payload: {},
  })
},
```

2. Update `src/adapters/pi-coding-agent/index.ts` to use static import:
   - Replace dynamic `await import('./extension')` with: `import { createAimaExtension } from './extension'`
   - Move the import to the top of the file

3. Verify `Extension` return type matches what `createAgentSession` expects — if the function returns `Extension` but TypeScript complains, check that the Extension type is exactly what pi-coding-agent `extensions: Extension[]` expects.

4. Run `bun run typecheck` and `biome check --write` — fix any issues.

---

## Test Strategy

No test files in this WP. Unit tests are in WP05. However, run:

```bash
bun run typecheck
biome check src/adapters/pi-coding-agent/
```

Zero errors required before marking done.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `amygdala.check()` is sync not async | Remove `await`; adjust handler to be sync |
| `ToolCallEvent` has different field names | Read installed types; adjust destructuring |
| Extension `handlers` type doesn't include all keys | Use `Partial<ExtensionHandlers>` if needed |
| `tool.pre_use` emitted twice (in tool_call + tool_execution_start) | Only emit in tool_call; keep tool_execution_start minimal |
| `agent_end` event type name is different | Check installed type defs; may be `agentEnd` or `run_end` |

---

## Definition of Done Checklist

- [ ] T006: `createAimaExtension()` function with correct `Extension` return type
- [ ] T007: `tool_call` handler — default policy (bash/edit/write blocked, read/grep/find/ls allowed) + amygdala.check()
- [ ] T008: block → `tool.blocked` (COMPLIANCE); escalate → `amygdala.escalation` (ALERT) + `tool.blocked`; allow → `undefined`
- [ ] T009: `tool_execution_start` handler defined (minimal or debug-only)
- [ ] T010: `tool_execution_end` → `tool.post_use` (INFO) with correct payload
- [ ] T011: `agent_end` → `brain.loop_end` (INFO); `run()` in index.ts uses static import
- [ ] `bun run typecheck` zero errors
- [ ] `biome check` passes

## Review Guidance

1. Verify `tool.pre_use` is emitted for ALL tools before any block decision (including default-blocked bash)
2. Verify `tool.blocked` is emitted ONCE per blocked tool call (not twice if escalate)
3. Verify `amygdala.escalation` is ALERT level; `tool.blocked` is COMPLIANCE level
4. Verify `tool_execution_end` fires only for ALLOWED tools (blocked ones never reach execution)
5. Confirm `registeredTools` is passed through correctly to Extension (MCP tools will be wired in WP03)

## Activity Log

- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created.
