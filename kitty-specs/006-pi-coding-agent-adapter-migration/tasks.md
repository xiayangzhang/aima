# Work Packages: pi-coding-agent Adapter Migration

**Inputs**: Design documents from `kitty-specs/006-pi-coding-agent-adapter-migration/`
**Prerequisites**: [spec.md](spec.md) (required), [plan.md](plan.md) (required)

---

## Work Package WP01: Core Adapter Scaffold (Priority: P0)

**Goal**: Install `@mariozechner/pi-coding-agent` and create `src/adapters/pi-coding-agent/index.ts` with `PiCodingAgentAdapter` class implementing `BrainAdapter`. Session management, `run()`, `inject()`, `abort()` all implemented. Extension will be a stub (empty handlers) until WP02 fills it in.
**Independent Test**: `bun run typecheck` passes; adapter can be instantiated and `abort()` called without errors.
**Prompt**: `tasks/WP01-core-adapter-scaffold.md`
**Estimated size**: ~350 lines

### Included Subtasks
- [x] T001 Install `@mariozechner/pi-coding-agent@0.57.1` via `bun add`
- [x] T002 Define `PiCodingAgentAdapterConfig` interface
- [x] T003 `PiCodingAgentAdapter` class — `SessionManager.inMemory()`, session Map
- [x] T004 `run()` — `createAgentSession` (first run) + resume (subsequent runs) + systemPrompt refresh
- [x] T005 `inject()` (steer/followUp/workspace fallback) + `abort()` + `abortSession()`

### Implementation Notes
- Create `src/adapters/pi-coding-agent/index.ts` (new file, ~130 lines)
- Stub `src/adapters/pi-coding-agent/extension.ts` (exports empty `createAimaExtension`) and `src/adapters/pi-coding-agent/mcp-tools.ts` (exports empty `buildMcpTools`) to satisfy imports and allow typecheck to pass
- Session key = `${brain}:${threadId}`; `SessionManager.inMemory()` created once per adapter instance

### Parallel Opportunities
- None; this is the foundation.

### Dependencies
- None (first package).

### Risks & Mitigations
- pi-coding-agent API may differ slightly from type defs — read `node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts` after installation to verify exact signatures.

---

## Work Package WP02: Extension Factory — Amygdala + EventBus (Priority: P0)

**Goal**: Implement `createAimaExtension()` in `src/adapters/pi-coding-agent/extension.ts`. The Extension handles per-tool Amygdala interception (`tool_call` → allow/block/escalate) and EventBus event emission (`tool.pre_use`, `tool.post_use`, `tool.blocked`, `amygdala.escalation`, `brain.loop_end`). Update `run()` in index.ts to use it.
**Independent Test**: Mock amygdala returning block → factory returns extension that would block; mock EventBus verifies event emission.
**Prompt**: `tasks/WP02-extension-factory-amygdala-eventbus.md`
**Estimated size**: ~420 lines

### Included Subtasks
- [x] T006 `createAimaExtension(brain, threadId, amygdala, eventBus)` function signature + empty handlers
- [x] T007 `tool_call` handler — default policy table (bash/edit/write BLOCK; read/grep/find/ls ALLOW) + `amygdala.check()` for non-default tools
- [x] T008 Block/escalate decision paths — `{ block: true, message }` return + `tool.blocked`/`amygdala.escalation` EventBus events
- [x] T009 `tool_execution_start` → emit `tool.pre_use` (INFO) with `brain`, `thread_id`, `tool`, `toolCallId`, `args`
- [x] T010 `tool_execution_end` → emit `tool.post_use` (INFO) with `brain`, `thread_id`, `tool`, `toolCallId`, `isError`
- [x] T011 `agent_end` → emit `brain.loop_end` (INFO); update `run()` in index.ts to use `createAimaExtension()`

### Implementation Notes
- `extension.ts` will be ~100 lines
- The `tool_call` handler must return `Promise<{ block: true; message: string } | undefined>` — check actual pi-coding-agent types after install
- Default policy applied BEFORE `amygdala.check()` — no Amygdala call needed for bash (always block)

### Parallel Opportunities
- Can proceed in parallel with WP03 (different files: extension.ts vs mcp-tools.ts).

### Dependencies
- Depends on WP01.

### Risks & Mitigations
- `amygdala.check()` interface must match existing Amygdala class — read `src/amygdala/index.ts` to confirm method signature.

---

## Work Package WP03: MCP Tool Registration (Priority: P0)

**Goal**: Implement `buildMcpTools(workspace)` in `src/adapters/pi-coding-agent/mcp-tools.ts`, wrapping AIMA MCP tools as `AgentTool[]` for pi-coding-agent. Update `createAimaExtension` to accept and wire `registeredTools`. Update `run()` to call `buildMcpTools` and pass to Extension.
**Independent Test**: `buildMcpTools(mockWorkspace)` returns non-empty array of valid `AgentTool` objects.
**Prompt**: `tasks/WP03-mcp-tool-registration.md`
**Estimated size**: ~260 lines

### Included Subtasks
- [x] T012 Find `createAimaMcpServer` export path in `src/`; implement `buildMcpTools(workspace): AgentTool[]` in `mcp-tools.ts`
- [ ] T013 Update `createAimaExtension` to accept optional `registeredTools?: AgentTool[]` parameter + wire to Extension's `registeredTools` field
- [ ] T014 Update `run()` in index.ts to call `buildMcpTools(this.config.workspace)` and pass to `createAimaExtension`

### Implementation Notes
- `mcp-tools.ts` ~50 lines; uses `wrapRegisteredTool()` from pi-coding-agent
- MCP tools go through the same `tool_call` Amygdala handler (no bypass) — this is automatic because they're in `registeredTools`
- `createAimaMcpServer` may be in `src/mcp/index.ts` or similar — find before implementing

### Parallel Opportunities
- Can proceed in parallel with WP02 (T012 touches different files; T013-T014 need extension.ts from WP02 — do T013/T014 after WP02 is done).

### Dependencies
- Depends on WP01. T013/T014 also depend on WP02.

### Risks & Mitigations
- `createAimaMcpServer` may not yet export all needed methods — check current src/mcp/index.ts.

---

## Work Package WP04: AIMAInstance Integration + Old Adapter Rename (Priority: P0)

**Goal**: Rename existing `PiCodingAgentAdapter` (pi-agent-core) to `PiAgentAdapter` in `src/adapters/pi-agent/index.ts`. Add `'pi-coding-agent'` to `AdapterType` in `src/instance.ts` and create the new adapter creation branch. Export new adapter + config type from `src/index.ts`. All existing `'pi-agent'` tests must remain green.
**Independent Test**: `adapter: 'pi-coding-agent'` creates new adapter; `adapter: 'pi-agent'` still works; `bun run typecheck` zero errors; `biome check` passes.
**Prompt**: `tasks/WP04-aimainstance-integration.md`
**Estimated size**: ~280 lines

### Included Subtasks
- [ ] T015 Rename `PiCodingAgentAdapter` → `PiAgentAdapter` in `src/adapters/pi-agent/index.ts`; update named export; fix any reference in `src/instance.ts`
- [ ] T016 Add `'pi-coding-agent'` to `AdapterType` union; add `import { PiCodingAgentAdapter } from './adapters/pi-coding-agent/index'` to `src/instance.ts`
- [ ] T017 Add `adapter === 'pi-coding-agent'` branch in AIMAInstance constructor — instantiates `PiCodingAgentAdapter` with workspace/eventBus/amygdala/getApiKey
- [ ] T018 Export `PiCodingAgentAdapter` and `PiCodingAgentAdapterConfig` from `src/index.ts`; run `bun run typecheck` + `biome check --write`

### Implementation Notes
- The rename in T015 is mechanical — `sed` replacement or Edit tool; no logic changes
- T017 mirrors the existing `'pi-agent'` branch — copy structure, change class name + config type
- Run full test suite after T018 to confirm zero regressions: `bun test`

### Parallel Opportunities
- T015 and T016 can proceed in parallel (different files).

### Dependencies
- Depends on WP01, WP02, WP03.

### Risks & Mitigations
- Other files may import `PiCodingAgentAdapter` from `./adapters/pi-agent` — run `grep -r PiCodingAgentAdapter src/` to find all references before renaming.

---

## Work Package WP05: Unit Tests ≥30 (Priority: P1)

**Goal**: Implement ≥30 unit tests covering all behavioral paths of the new adapter. Tests mock pi-coding-agent sessions (no real API calls). Coverage spans: session management, run() paths, inject() scenarios, abort(), Extension factory decisions, EventBus event shapes, and MCP tool wrapping.
**Independent Test**: `bun test tests/unit/adapters/pi-coding-agent/` — all ≥30 tests pass; `biome check` passes.
**Prompt**: `tasks/WP05-unit-tests.md`
**Estimated size**: ~550 lines

### Included Subtasks
- [ ] T019 Create `tests/unit/adapters/pi-coding-agent/` directory + `adapter.test.ts` structure with mock session factory
- [ ] T020 `adapter.test.ts` — `run()` tests: first-run creates session, second-run resumes, systemPrompt refreshed, multi-brain isolation (~5 tests)
- [ ] T021 `adapter.test.ts` — `inject()` tests: amygdala_interrupt → steer(); dmn_correction → followUp(); no active session → workspace fallback (~3 tests)
- [ ] T022 `adapter.test.ts` — `abort()` clears all sessions; `abortSession()` clears specific key (~2 tests)
- [ ] T023 `extension.test.ts` — `tool_call` allow decision → returns `undefined`; block → returns `{ block: true }`; escalate → returns `{ block: true }` + ALERT event (~3 tests)
- [ ] T024 `extension.test.ts` — default policy: `bash` → blocked without `amygdala.check()` call; `read` → `amygdala.check()` called; `edit` → blocked; `grep` → allowed (~4 tests)
- [ ] T025 `extension.test.ts` — EventBus events: `tool.pre_use` (INFO), `tool.post_use` (INFO), `tool.blocked` (COMPLIANCE), `amygdala.escalation` (ALERT), `brain.loop_end` (INFO); verify brain/thread_id/payload shape (~5 tests)
- [ ] T026 `mcp-tools.test.ts` — `buildMcpTools()` returns AgentTool[]; each tool has name/description/execute; execute() calls workspace method correctly (~3 tests + ~2 edge cases = ~5 tests)

### Implementation Notes
- Mock session: `{ steer: mock(), followUp: mock(), abort: mock(), prompt: mock() }` pattern
- Mock EventBus: collect emitted events in array, assert shape
- Bun `mock()` from `bun:test` for spy functions
- Total test count: T020(5) + T021(3) + T022(2) + T023(3) + T024(4) + T025(5) + T026(5) = **27 tests minimum**; aim for 32+ by adding edge cases

### Parallel Opportunities
- T019-T022 (adapter.test.ts) can proceed in parallel with T023-T025 (extension.test.ts).

### Dependencies
- Depends on WP04 (all code complete).

### Risks & Mitigations
- If pi-coding-agent session mock doesn't match real interface, integration tests (WP06) will catch behavioral differences.

---

## Work Package WP06: Integration Tests ≥10 (Priority: P1)

**Goal**: Implement ≥10 integration tests using real `@mariozechner/pi-coding-agent` sessions (no LLM, mock tools only). Verify actual Extension event flow, block behavior, steer/followUp mechanics, and MCP tool execution through the real session machinery.
**Independent Test**: `bun test tests/integration/adapters/pi-coding-agent/` — all ≥10 tests pass using real pi-coding-agent sessions.
**Prompt**: `tasks/WP06-integration-tests.md`
**Estimated size**: ~430 lines

### Included Subtasks
- [ ] T027 Setup: `tests/integration/adapters/pi-coding-agent/session.test.ts` — real `SessionManager.inMemory()`, mock tool factory (`wrapRegisteredTool`), `describeWithPiAgent` helper (skip if package unavailable)
- [ ] T028 Session creation + resumption: two consecutive runs share conversation history (~2 tests)
- [ ] T029 Extension `tool_call` event fires when mock tool is invoked via real session (~1 test)
- [ ] T030 Block decision: `tool_call` returns `{ block: true }` → `tool_execution_end` does NOT fire; `tool.blocked` EventBus event received (~2 tests)
- [ ] T031 Allow decision: `tool_call` returns `undefined` → both `tool_execution_start` and `tool_execution_end` fire; `tool.pre_use` + `tool.post_use` EventBus events received (~2 tests)
- [ ] T032 `steer()` injects content into active session; `followUp()` queues content for next turn (~1 test each = 2 tests)
- [ ] T033 MCP tool registered in Extension `registeredTools` is callable; its `execute()` is invoked and result returned to session (~1 test)
- [ ] T034 Multi-session isolation: two sessions with different `brain:threadId` keys maintain independent histories (~1 test)

### Implementation Notes
- These tests use **real pi-coding-agent** sessions but do NOT connect to any LLM or API — all tools are mock; no AI responses
- Skip pattern: `const hasPiCodingAgent = !!process.env.PI_CODING_AGENT_AVAILABLE || checkPackageExists()` — use `test.skipIf()`
- Mock tool: returns a deterministic string so tests are hermetic
- Total: T028(2) + T029(1) + T030(2) + T031(2) + T032(2) + T033(1) + T034(1) = **11 tests minimum**

### Parallel Opportunities
- Can proceed in parallel with WP05 (different test directories).

### Dependencies
- Depends on WP04 (all production code complete).

### Risks & Mitigations
- pi-coding-agent session without LLM may behave differently than expected — read SDK docs on how to trigger tool calls without a real model response.

---

## Dependency & Execution Summary

```
WP01 (foundation)
  └─→ WP02 (Extension factory)   [parallel with WP03]
  └─→ WP03 (MCP tools)           [parallel with WP02; T013/T014 need WP02]
        └─→ WP04 (AIMAInstance integration)
              ├─→ WP05 (unit tests)   [parallel with WP06]
              └─→ WP06 (integration tests) [parallel with WP05]
```

- **MVP Scope**: WP01 + WP02 + WP03 + WP04 = working adapter with full Amygdala/EventBus coverage
- **Full Scope**: All 6 WPs = MVP + ≥30 unit tests + ≥10 integration tests

---

## Subtask Index (Reference)

| Subtask | Summary | WP | Parallel? |
|---------|---------|-----|-----------|
| T001 | Install pi-coding-agent@0.57.1 | WP01 | No |
| T002 | PiCodingAgentAdapterConfig interface | WP01 | No |
| T003 | Adapter class + SessionManager + Map | WP01 | No |
| T004 | run() — create/resume + systemPrompt | WP01 | No |
| T005 | inject() + abort() + abortSession() | WP01 | No |
| T006 | createAimaExtension() signature + empty handlers | WP02 | No |
| T007 | tool_call handler — default policy + amygdala.check() | WP02 | No |
| T008 | block/escalate paths + tool.blocked/amygdala.escalation | WP02 | No |
| T009 | tool_execution_start → tool.pre_use | WP02 | No |
| T010 | tool_execution_end → tool.post_use | WP02 | No |
| T011 | agent_end → brain.loop_end; update run() | WP02 | No |
| T012 | buildMcpTools(workspace) → AgentTool[] | WP03 | Yes [P] |
| T013 | Update createAimaExtension for registeredTools | WP03 | After WP02 |
| T014 | Update run() to wire MCP tools | WP03 | After WP02 |
| T015 | Rename PiCodingAgentAdapter → PiAgentAdapter | WP04 | Yes [P] |
| T016 | AdapterType += 'pi-coding-agent' + import | WP04 | Yes [P] |
| T017 | AIMAInstance 'pi-coding-agent' branch | WP04 | No |
| T018 | src/index.ts exports + typecheck + biome | WP04 | No |
| T019 | adapter.test.ts structure + mock session factory | WP05 | Yes [P] |
| T020 | run() tests (5 tests) | WP05 | Yes [P] |
| T021 | inject() tests (3 tests) | WP05 | Yes [P] |
| T022 | abort() tests (2 tests) | WP05 | Yes [P] |
| T023 | extension.test.ts — allow/block/escalate (3 tests) | WP05 | Yes [P] |
| T024 | default policy tests (4 tests) | WP05 | Yes [P] |
| T025 | EventBus event shape tests (5 tests) | WP05 | Yes [P] |
| T026 | mcp-tools.test.ts (5 tests) | WP05 | Yes [P] |
| T027 | Integration test setup + helpers | WP06 | No |
| T028 | Session creation + resumption (2 tests) | WP06 | No |
| T029 | tool_call event fires (1 test) | WP06 | No |
| T030 | Block behavior (2 tests) | WP06 | No |
| T031 | Allow behavior (2 tests) | WP06 | No |
| T032 | steer() + followUp() (2 tests) | WP06 | No |
| T033 | MCP tool callable (1 test) | WP06 | No |
| T034 | Multi-session isolation (1 test) | WP06 | No |
