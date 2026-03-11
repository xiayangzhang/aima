# Implementation Plan: pi-coding-agent Adapter Migration

**Branch**: `006-pi-coding-agent-adapter-migration` | **Date**: 2026-03-11 | **Spec**: [spec.md](spec.md)

---

## Summary

Feature 006 replaces the `pi-agent-core` backend with `@mariozechner/pi-coding-agent` as AIMA's primary brain adapter. The migration closes three structural gaps:

1. **Amygdala 无法拦截单次工具调用** — pi-coding-agent's Extension API provides a synchronous `tool_call` hook that can block individual tool executions before they run.
2. **EventBus 工具事件缺失** — Extension `tool_execution_start/end` events are mapped to `tool.pre_use/post_use` for DMN and audit visibility.
3. **inject() 非实时** — `session.steer()` delivers amygdala_interrupt within the current run; `session.followUp()` queues dmn_correction for the next turn.

The old `pi-agent-core` adapter is renamed `PiAgentAdapter` and preserved as a fallback under adapter key `'pi-agent'`. The new adapter is `PiCodingAgentAdapter` in `src/adapters/pi-coding-agent/` and becomes the default.

---

## Technical Context

**Language/Version**: TypeScript 5.x, Bun runtime
**Primary Dependencies**:
- `@mariozechner/pi-coding-agent` v0.57.1 (must be installed first — not yet in package.json)
- `@mariozechner/pi-agent-core` (retained, pi-agent fallback)
- `@mariozechner/pi-ai` (retained, model factory)
- Existing AIMA types: `BrainAdapter`, `BrainRunParams`, `BrainRunResult`, `BrainSignal`, `BrainEventBus`, `Amygdala`, `CognitiveWorkspace`

**Storage**: No additional storage — sessions held in-memory via `SessionManager.inMemory()`
**Testing**: `bun:test` for unit tests; `bun:test` + real pi-coding-agent session (no LLM, mock tools) for integration tests
**Target Platform**: Node.js / Bun process (same as existing adapters)
**Performance Goals**: Amygdala check latency ≤ tool execution latency (synchronous path)
**Constraints**: Must not break `adapter: 'pi-agent'` path; all tests from Feature 005 must remain green

---

## Constitution Check

From `.kittify/memory/constitution.md`:

- ✅ **不敷衍**: All 7 FRs must be fully implemented — no stub returns, no TODO placeholders
- ✅ **不降级**: When `amygdala.check()` returns block, tool MUST NOT execute; no silent fallback
- ✅ **真实测试**: Integration tests use real `createAgentSession()` with mock tools — no mock of the session itself
- ✅ **Test density**: ≥ 30 unit + ≥ 10 integration as specified in FR-07
- ✅ **Type safety**: No `any`, no `!` non-null assertion; Biome strict mode compliance
- ✅ **向后兼容**: `adapter: 'pi-agent'` adapter renamed but functional; test count not reduced

---

## pi-coding-agent API Reference

Key APIs confirmed from `@mariozechner/pi-coding-agent` v0.57.1 (`dist/index.d.ts`):

### Session Creation

```typescript
// Create a new session or resume from SessionManager
const session = await createAgentSession({
  model,
  sessionManager: SessionManager.inMemory(),
  systemPrompt: '...',
  extensions: [extension],  // Extension[] registered at session creation
})

// Resume existing session (same sessionManager instance)
await session.prompt('user message')   // First turn
await session.followUp('next message') // Queue for next run
session.steer('interrupt content')      // Inject into current run
await session.abort()                   // Cancel current run
```

### Extension Factory Pattern

```typescript
// Extension is an object with optional registeredTools and event handlers
const extension: Extension = {
  registeredTools: [agentTool1, agentTool2],  // MCP-style tools
  handlers: {
    tool_call: async (event: ToolCallEvent, ctx: ExtensionContext) => {
      // Return { block: true, message: 'reason' } to block; undefined to allow
      return undefined  // allow
    },
    tool_execution_start: (event) => { /* emit tool.pre_use */ },
    tool_execution_end: (event) => { /* emit tool.post_use */ },
    agent_end: (event) => { /* emit brain.loop_end */ },
  },
}
```

### ToolCallEvent Fields

```typescript
interface ToolCallEvent {
  toolName: string
  toolCallId: string
  args: unknown
}
```

### MCP Tool Wrapping

```typescript
// Wrap an AIMA MCP tool as an AgentTool for pi-coding-agent
const agentTool = wrapRegisteredTool({
  name: 'memory_search',
  description: '...',
  inputSchema: { ... },
  execute: async (args) => ({ result: '...' }),
})
```

### Built-in Tool Names (for default Amygdala policy)

- `bash` → BLOCK by default
- `edit`, `write` → BLOCK by default
- `read` → ALLOW by default
- `grep`, `find`, `ls` → ALLOW by default

---

## Current Code Structure (Before Migration)

```
src/adapters/
├── index.ts                  # BrainAdapter interface, BrainSignal, BrainEvent types
├── pi-agent/
│   └── index.ts              # PiCodingAgentAdapter (MISLEADINGLY NAMED — uses pi-agent-core)
└── claude-sdk/
    └── index.ts              # ClaudeAgentSDKAdapter

src/instance.ts               # AIMAInstance, AdapterType = 'pi-agent' | 'claude-sdk'
src/index.ts                  # Public exports
```

**Key current issues**:
- `PiCodingAgentAdapter` in `pi-agent/` uses `pi-agent-core`'s `Agent` class, NOT pi-coding-agent
- No per-tool Amygdala check (only `popSignal()` at run start)
- EventBus events come from `agent.subscribe()` — pi-agent-core's events, not Extension API
- `inject()` for amygdala uses `agent.steer()` but Amygdala signal is checked only at run start

---

## Target Code Structure (After Migration)

```
src/adapters/
├── index.ts                  # Unchanged — BrainAdapter interface stays
├── pi-agent/
│   └── index.ts              # RENAMED: PiAgentAdapter (was PiCodingAgentAdapter)
│                             # Uses pi-agent-core; adapter key = 'pi-agent'
├── pi-coding-agent/
│   └── index.ts              # NEW: PiCodingAgentAdapter (uses pi-coding-agent)
│                             # adapter key = 'pi-coding-agent'
└── claude-sdk/
    └── index.ts              # Unchanged

src/instance.ts               # AdapterType += 'pi-coding-agent'; default = 'pi-coding-agent'
src/index.ts                  # Export PiCodingAgentAdapter + config type

tests/
├── unit/
│   └── adapters/
│       └── pi-coding-agent/
│           ├── adapter.test.ts          # ≥15 unit tests for run/inject/abort
│           ├── extension.test.ts        # ≥10 unit tests for Amygdala + EventBus
│           └── mcp-tools.test.ts        # ≥5 unit tests for MCP registration
└── integration/
    └── adapters/
        └── pi-coding-agent/
            └── session.test.ts          # ≥10 integration tests with real sessions
```

---

## Architecture Decisions

### Decision 1: Extension is Created Per-Session

The Extension must be created fresh each time `createAgentSession()` is called (not shared across sessions). Each Extension instance captures the `brain` and `threadId` in its closure for EventBus event tagging.

### Decision 2: Session Key = `${brain}:${threadId}`

Same pattern as existing pi-agent adapter. `SessionManager.inMemory()` is created once per `PiCodingAgentAdapter` instance and holds all sessions.

### Decision 3: systemPrompt Refreshed Every run()

On first run: `createAgentSession({ systemPrompt })`. On subsequent runs: call `session.setSystemPrompt(systemPrompt)` before `session.prompt()` / `session.followUp()`. This matches pi-agent-core behavior (Block 3/4 change each activation).

### Decision 4: Amygdala Default Policy Lives in the Extension Factory

The default BLOCK/ALLOW table is implemented inside the Extension factory function `createAimaExtension()`, not in `Amygdala` class. The Amygdala class handles dynamic rule matching; the Extension factory applies static defaults for built-in tool names.

### Decision 5: MCP Tools Registered as `registeredTools` in Extension

`createAimaMcpServer(workspace).getTools()` returns AIMA MCP tools. Each is wrapped via `wrapRegisteredTool()` and passed in `extension.registeredTools`. These tools are subject to the same `tool_call` Amygdala check — no bypass.

### Decision 6: inject() Scope

Unlike the current implementation which iterates ALL agent instances, the new `inject()` must target the correct `brain:threadId` session. If the signal has a `causationId` that maps to a session key, use that; otherwise broadcast to all active sessions (same fallback behavior as current).

---

## Work Package Strategy

6 work packages in 3 dependency tiers:

**Tier 1 (independent)**:
- WP01: Core adapter scaffold (`src/adapters/pi-coding-agent/index.ts`, session management, run/abort)

**Tier 2 (depends on WP01)**:
- WP02: Extension factory — Amygdala + EventBus (`createAimaExtension()`, tool_call handler, pre/post events)
- WP03: inject() + MCP tool registration

**Tier 3 (depends on WP01-03)**:
- WP04: AIMAInstance integration + old adapter rename
- WP05: Unit tests (≥30 tests)
- WP06: Integration tests (≥10 tests, real pi-coding-agent sessions)

WP05 and WP06 may be worked in parallel after WP01-04 are merged.

---

## Detailed WP Breakdown

### WP01 — Core Adapter Scaffold

**Files**:
- `src/adapters/pi-coding-agent/index.ts` (new, ~120 lines)

**Subtasks**:
- T001: Install `@mariozechner/pi-coding-agent` package (add to `package.json`, `bun install`)
- T002: Define `PiCodingAgentAdapterConfig` interface (modelId, workspace, eventBus, amygdala, getApiKey)
- T003: Implement `PiCodingAgentAdapter` class with session Map (`brain:threadId → AgentSession`)
- T004: Implement `run()` — first run = createAgentSession, resume = existing session + refreshed systemPrompt
- T005: Implement `abort()` and `abortSession(brain, threadId)` — session.abort() + Map cleanup

**Acceptance**: `bun run typecheck` passes; adapter can be instantiated without errors.

---

### WP02 — Extension Factory (Amygdala + EventBus)

**Files**:
- `src/adapters/pi-coding-agent/extension.ts` (new, ~100 lines)

**Subtasks**:
- T006: `createAimaExtension(brain, threadId, amygdala, eventBus)` factory function signature
- T007: `tool_call` handler — call `amygdala.check(toolName, args)`:
  - `allow` → return `undefined`
  - `block` → emit `tool.blocked` (COMPLIANCE) + return `{ block: true, message: reason }`
  - `escalate` → emit `amygdala.escalation` (ALERT) + same as block
- T008: Default tool policy (before `amygdala.check`): bash/edit/write → synthetic block; read/grep/find/ls → skip check
- T009: `tool_execution_start` handler → emit `tool.pre_use` (INFO) with `brain`, `thread_id`, `tool`, `toolCallId`, `args`
- T010: `tool_execution_end` handler → emit `tool.post_use` (INFO) with `brain`, `thread_id`, `tool`, `toolCallId`, `isError`
- T011: `agent_end` handler → emit `brain.loop_end` (INFO)

**Acceptance**: mock amygdala returning block → tool not executed; EventBus receives paired events.

---

### WP03 — inject() + MCP Tool Registration

**Files**:
- `src/adapters/pi-coding-agent/index.ts` (extend WP01)
- `src/adapters/pi-coding-agent/mcp-tools.ts` (new, ~60 lines)

**Subtasks**:
- T012: Implement `inject(signal)` — look up session by iterating activeSession map:
  - `amygdala_interrupt` → `session.steer('[AMYGDALA INTERRUPT] ' + message)`
  - `dmn_correction` → `session.followUp('[DMN CORRECTION] ' + message)`
  - No active session → write to workspace (existing fallback behavior)
- T013: `buildMcpTools(workspace)` — call `createAimaMcpServer(workspace).getTools()`, wrap each with `wrapRegisteredTool()`, return `AgentTool[]`
- T014: Pass `buildMcpTools(workspace)` result into Extension `registeredTools` when creating session

**Acceptance**: `inject()` calls `steer()` for interrupt; MCP tools appear in session's available tools.

---

### WP04 — AIMAInstance Integration + Old Adapter Rename

**Files**:
- `src/adapters/pi-agent/index.ts` (rename class + export)
- `src/instance.ts` (add 'pi-coding-agent' to AdapterType, new creation branch, change default)
- `src/index.ts` (export new adapter + config type)

**Subtasks**:
- T015: Rename `PiCodingAgentAdapter` → `PiAgentAdapter` in `src/adapters/pi-agent/index.ts`; update named export
- T016: Add `'pi-coding-agent'` to `AdapterType` union in `src/instance.ts`
- T017: Add creation branch for `adapter: 'pi-coding-agent'` → `new PiCodingAgentAdapter({ ... })`
- T018: Change default adapter hint in JSDoc (not hardcoded default — user must specify)
- T019: Export `PiCodingAgentAdapter` and `PiCodingAgentAdapterConfig` from `src/index.ts`
- T020: Update import in `src/instance.ts` — `PiAgentAdapter` from `./adapters/pi-agent/index`

**Acceptance**: `adapter: 'pi-coding-agent'` creates new adapter; `adapter: 'pi-agent'` still works; typecheck clean.

---

### WP05 — Unit Tests (≥30 tests)

**Files**:
- `tests/unit/adapters/pi-coding-agent/adapter.test.ts` (new)
- `tests/unit/adapters/pi-coding-agent/extension.test.ts` (new)
- `tests/unit/adapters/pi-coding-agent/mcp-tools.test.ts` (new)

**Subtasks**:
- T021: `adapter.test.ts` — session management (first run creates session, second run resumes, multi-brain isolation)
- T022: `adapter.test.ts` — systemPrompt refreshed on each run
- T023: `adapter.test.ts` — abort() clears all sessions; abortSession() clears specific key
- T024: `adapter.test.ts` — inject() calls steer() for amygdala_interrupt; followUp() for dmn_correction
- T025: `adapter.test.ts` — inject() degrades gracefully when no active session
- T026: `extension.test.ts` — tool_call: allow decision → handler returns undefined
- T027: `extension.test.ts` — tool_call: block decision → returns `{ block: true }`, emits tool.blocked
- T028: `extension.test.ts` — tool_call: escalate → returns `{ block: true }`, emits amygdala.escalation (ALERT)
- T029: `extension.test.ts` — default policy: bash → blocked without amygdala.check call
- T030: `extension.test.ts` — default policy: read → amygdala.check called (not auto-blocked)
- T031: `extension.test.ts` — tool_execution_start → emits tool.pre_use with correct payload
- T032: `extension.test.ts` — tool_execution_end → emits tool.post_use with correct payload
- T033: `extension.test.ts` — agent_end → emits brain.loop_end
- T034: `extension.test.ts` — tool.blocked event level = COMPLIANCE; amygdala.escalation level = ALERT
- T035: `mcp-tools.test.ts` — buildMcpTools returns AgentTool array for each MCP tool
- T036: `mcp-tools.test.ts` — MCP tool execute() calls workspace method correctly
- T037: `mcp-tools.test.ts` — MCP tools in registeredTools are accessible via Extension

**Acceptance**: `bun test tests/unit/adapters/pi-coding-agent/` — all ≥30 tests pass.

---

### WP06 — Integration Tests (≥10 tests, real pi-coding-agent sessions)

**Files**:
- `tests/integration/adapters/pi-coding-agent/session.test.ts` (new)

**Subtasks**:
- T038: `SessionManager.inMemory()` creates session + resumes by key (no LLM needed)
- T039: Extension `tool_call` event fires when a mock tool is invoked via real session
- T040: block decision in `tool_call` handler prevents `tool_execution_end` from firing
- T041: allow decision in `tool_call` handler lets `tool_execution_start/end` both fire
- T042: `session.steer()` injects content into active session (verify via event stream)
- T043: `session.followUp()` queues content; received after current run completes
- T044: Amygdala block end-to-end: mock session with bash tool → Amygdala blocks → LLM sees refusal message
- T045: MCP tool registered in Extension is callable by the session
- T046: Multi-session isolation: `brain:threadId` sessions don't share history
- T047: systemPrompt update on second run() changes the active session's system context

**Skip condition**: Integration tests require `@mariozechner/pi-coding-agent` to be installed; skip with `test.skipIf(!PI_CODING_AGENT_AVAILABLE)` or rely on package presence check.

**Acceptance**: `bun test tests/integration/adapters/pi-coding-agent/` — all ≥10 tests pass with real sessions.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| pi-coding-agent API differs from v0.57.1 type defs | Low | High | Lock version in package.json; read actual source if types differ |
| `session.setSystemPrompt()` doesn't exist | Medium | Medium | Use `createAgentSession()` with new session if no method; log discovery |
| `tool_call` handler not truly synchronous | Low | Critical | Integration test T040 would catch this; fail fast |
| MCP `createAimaMcpServer` not yet exported | Medium | Low | Read current `src/index.ts`; find correct import path |
| Old `PiCodingAgentAdapter` tests break on rename | High | Low | WP04 updates imports; existing tests just need class name update |

---

## Implementation Notes for Agents

1. **Read `src/adapters/pi-agent/index.ts` FIRST** before writing the new adapter — the new code is structurally similar but replaces `Agent` with `createAgentSession()`.

2. **Read `src/instance.ts` FIRST** before WP04 — understand the existing adapter switch before adding the new branch.

3. **pi-coding-agent package install**: Run `bun add @mariozechner/pi-coding-agent@0.57.1` in the worktree. If the package is on npm but not in the registry cache, download from npm directly.

4. **`createAimaMcpServer` import**: Check `src/mcp/index.ts` or equivalent — the export path may differ from `createAimaMcpServer`. Find the correct import before implementing T013.

5. **Biome**: Import order matters. `@mariozechner/pi-coding-agent` imports must be in the correct group (external packages before internal). Run `biome check --write` after each file.

6. **No `any` types**: All Extension event types must be typed via the pi-coding-agent type definitions. Use `ToolCallEvent`, `ExtensionContext` etc directly.
