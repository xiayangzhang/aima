---
work_package_id: "WP01"
title: "Core Adapter Scaffold"
phase: "Phase 1 - Foundation"
lane: "planned"
dependencies: []
subtasks:
  - "T001"
  - "T002"
  - "T003"
  - "T004"
  - "T005"
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

# Work Package Prompt: WP01 – Core Adapter Scaffold

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, scroll to Review Feedback section.

---

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

Create `src/adapters/pi-coding-agent/index.ts` with a fully functional `PiCodingAgentAdapter` class implementing the `BrainAdapter` interface. The adapter manages per-session AgentSession instances and provides run/inject/abort. Extension is a stub that will be filled in by WP02.

**Success criteria**:
- `bun run typecheck` zero errors after WP01
- `biome check` passes
- Adapter can be instantiated: `new PiCodingAgentAdapter(config)` without errors
- `abort()` clears session map
- `abortSession(brain, threadId)` clears specific entry

**Implementation command**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/006-pi-coding-agent-adapter-migration/spec.md` — FR-01, FR-04
- **Plan**: `kitty-specs/006-pi-coding-agent-adapter-migration/plan.md` — WP01 breakdown
- **Constitution**: `.kittify/memory/constitution.md` — 不敷衍 (no stubs), 不降级 (no fallback when params present), type safety (no `any`, no `!`)
- **Reference implementation**: `src/adapters/pi-agent/index.ts` — structurally similar but uses `pi-agent-core`; the new adapter replaces `Agent` with `AgentSession` from pi-coding-agent
- **BrainAdapter interface**: `src/adapters/index.ts` — `run()`, `inject()`, `abort()` must all be implemented
- **Biome strict**: no `any`, no `!` non-null assertion, import order enforced

---

## Subtasks & Detailed Guidance

### Subtask T001 — Install @mariozechner/pi-coding-agent

**Purpose**: The new adapter depends on this package. It must be installed before any code can import from it.

**Steps**:
1. In the worktree root, run:
   ```bash
   bun add @mariozechner/pi-coding-agent@0.57.1
   ```
2. Verify installation:
   ```bash
   ls node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts
   ```
3. Read the type definitions to confirm API:
   ```bash
   cat node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts | head -100
   ```
   Key exports to verify: `createAgentSession`, `SessionManager`, `AgentSession`, `Extension`, `ToolCallEvent`.

**Notes**:
- If the package is not on the public npm registry, it may have been installed as a local tarball in a previous session. Check: `ls /tmp/mariozechner-pi-coding-agent-0.57.1.tgz`. If found: `bun add /tmp/mariozechner-pi-coding-agent-0.57.1.tgz`
- After install, `package.json` must reference the exact version `0.57.1`

---

### Subtask T002 — PiCodingAgentAdapterConfig Interface

**Purpose**: Define the typed configuration for the new adapter.

**Steps**:
1. Create `src/adapters/pi-coding-agent/index.ts` (new file).
2. Add the following interface at the top (after imports):

```typescript
import type { AgentSession, SessionManager as PiSessionManager } from '@mariozechner/pi-coding-agent'
import type { Amygdala } from '../../amygdala/index'
import type { BrainEventBus } from '../../eventbus/index'
import type { CognitiveBrainType } from '../../types/index'
import type { CognitiveWorkspace } from '../../workspace/index'
import type { BrainAdapter, BrainRunParams, BrainRunResult, BrainSignal } from '../index'

export interface PiCodingAgentAdapterConfig {
  /** Anthropic model ID, e.g. 'claude-sonnet-4-6' */
  modelId: string
  workspace: CognitiveWorkspace
  eventBus: BrainEventBus
  amygdala: Amygdala
  getApiKey: () => string | undefined
}
```

**Notes**:
- Verify exact import paths from pi-coding-agent type definitions (T001 step 3). The types `AgentSession` and `SessionManager` may be named differently.
- `CognitiveWorkspace` is imported as a type (not value) because we only need its interface

---

### Subtask T003 — PiCodingAgentAdapter Class + SessionManager + Session Map

**Purpose**: Define the class structure with in-memory session management.

**Steps**:
1. Add the class after the interface:

```typescript
export class PiCodingAgentAdapter implements BrainAdapter {
  private readonly config: PiCodingAgentAdapterConfig
  // key = `${brain}:${threadId}` → live AgentSession
  private readonly sessions: Map<string, AgentSession> = new Map()
  private readonly sessionManager: PiSessionManager

  constructor(config: PiCodingAgentAdapterConfig) {
    this.config = config
    // SessionManager.inMemory() holds all sessions; one per adapter instance
    this.sessionManager = SessionManager.inMemory()
  }
  // ... methods added in T004 and T005
}
```

2. Import `SessionManager` from pi-coding-agent (adjust import in T002 to include it as a value, not just type).

**Notes**:
- `SessionManager.inMemory()` is a factory method — it does NOT need `new`. Verify this in the type defs.
- The sessions Map stores live `AgentSession` objects for inject/abort access

---

### Subtask T004 — run() Method

**Purpose**: Implement the main brain execution loop — create or resume an AgentSession per `brain:threadId`.

**Steps**:

1. Add `run()` method:

```typescript
async run(params: BrainRunParams): Promise<BrainRunResult> {
  const { brain, threadId, systemPrompt, initialPrompt } = params
  const key = `${brain}:${threadId}`

  let session = this.sessions.get(key)

  if (!session) {
    // First run: create new session
    const { createAimaExtension } = await import('./extension')
    const { buildMcpTools } = await import('./mcp-tools')
    const mcpTools = buildMcpTools(this.config.workspace)
    const extension = createAimaExtension(
      brain,
      threadId,
      this.config.amygdala,
      this.config.eventBus,
      mcpTools,
    )
    session = await createAgentSession({
      modelId: this.config.modelId,
      apiKey: this.config.getApiKey() ?? '',
      sessionManager: this.sessionManager,
      systemPrompt,
      extensions: [extension],
    })
    this.sessions.set(key, session)
  } else {
    // Subsequent run: refresh system prompt and continue
    // Check if pi-coding-agent session has a setSystemPrompt method
    if (typeof (session as { setSystemPrompt?: (s: string) => void }).setSystemPrompt === 'function') {
      (session as { setSystemPrompt: (s: string) => void }).setSystemPrompt(systemPrompt)
    }
  }

  if (initialPrompt) {
    await session.prompt(initialPrompt)
  } else {
    // Resume with no new message (e.g., wake-up run)
    await session.prompt('')
  }

  return {
    sessionId: key,
    output: {},
    stopReason: 'done',
    injectedMemoryIds: [],
  }
}
```

**Important caveats**:
- Verify the exact `createAgentSession` parameter shape from the installed type defs. The `modelId` and `apiKey` field names may differ. The plan listed `model` and `sessionManager`.
- Dynamic imports (`await import('./extension')`) avoid circular dependency during WP01; replace with static imports once WP02/WP03 are implemented
- If `setSystemPrompt` doesn't exist, create a new session (re-call `createAgentSession` with updated systemPrompt) and update the Map — sessionManager will handle session persistence

**Import to add at top of file**:
```typescript
import { createAgentSession } from '@mariozechner/pi-coding-agent'
```

---

### Subtask T005 — inject(), abort(), abortSession() + Stub Files

**Purpose**: Complete the BrainAdapter interface with inject/abort and create stub files for extension.ts and mcp-tools.ts so typecheck passes.

**Steps**:

1. Add `inject()`:

```typescript
async inject(signal: BrainSignal): Promise<void> {
  for (const [_key, session] of this.sessions) {
    if (signal.type === 'amygdala_interrupt') {
      session.steer(`[AMYGDALA INTERRUPT] ${signal.message}`)
    } else if (signal.type === 'dmn_correction') {
      session.followUp(`[DMN CORRECTION] ${signal.message}`)
    }
  }
  // If no active sessions, fall back to workspace signal storage
  if (this.sessions.size === 0) {
    this.config.workspace.setSignal(signal)
  }
}
```

2. Add `abort()`:

```typescript
abort(): void {
  for (const [key, session] of this.sessions) {
    session.abort()
    this.sessions.delete(key)
  }
}
```

3. Add `abortSession()`:

```typescript
abortSession(brain: CognitiveBrainType, threadId: string): void {
  const key = `${brain}:${threadId}`
  const session = this.sessions.get(key)
  if (session) {
    session.abort()
    this.sessions.delete(key)
  }
}
```

4. Create `src/adapters/pi-coding-agent/extension.ts` (stub so typecheck passes):

```typescript
import type { AgentTool } from '@mariozechner/pi-coding-agent'
import type { Amygdala } from '../../amygdala/index'
import type { BrainEventBus } from '../../eventbus/index'
import type { CognitiveBrainType } from '../../types/index'

// Stub: full implementation in WP02
export function createAimaExtension(
  _brain: CognitiveBrainType,
  _threadId: string,
  _amygdala: Amygdala,
  _eventBus: BrainEventBus,
  _registeredTools: AgentTool[],
): object {
  return { handlers: {} }
}
```

5. Create `src/adapters/pi-coding-agent/mcp-tools.ts` (stub):

```typescript
import type { AgentTool } from '@mariozechner/pi-coding-agent'
import type { CognitiveWorkspace } from '../../workspace/index'

// Stub: full implementation in WP03
export function buildMcpTools(_workspace: CognitiveWorkspace): AgentTool[] {
  return []
}
```

**Notes**:
- `session.steer()` and `session.followUp()` may accept a string directly, or a message object — check pi-coding-agent types. If they need `{ role: 'user', content: '...' }`, adjust accordingly.
- `workspace.setSignal()` may not exist — check `src/workspace/index.ts` for the correct method name (may be `workspace.storeSignal()` or similar)
- Verify `AgentTool` export name from pi-coding-agent type defs

---

## Test Strategy

After completing T001-T005:

```bash
bun run typecheck
biome check src/adapters/pi-coding-agent/
```

Both must pass with zero errors. No test files created in this WP — tests are in WP05/WP06.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| pi-coding-agent `createAgentSession` param names differ | Read installed type defs immediately after T001; adjust T004 |
| `setSystemPrompt` doesn't exist on AgentSession | Fall back to re-creating session with new systemPrompt in Map |
| `session.steer()` requires object not string | Check types; wrap string in `{ role: 'user', content: msg }` if needed |
| `workspace.setSignal()` method name wrong | Read `src/workspace/index.ts` to find correct method |
| `SessionManager.inMemory()` may be a class constructor not factory | Check: `new SessionManager()` vs `SessionManager.inMemory()` |

---

## Definition of Done Checklist

- [ ] T001: `@mariozechner/pi-coding-agent@0.57.1` in `package.json` + installed
- [ ] T002: `PiCodingAgentAdapterConfig` interface defined in `src/adapters/pi-coding-agent/index.ts`
- [ ] T003: `PiCodingAgentAdapter` class with `SessionManager` + sessions Map
- [ ] T004: `run()` creates session on first call, resumes on subsequent calls, refreshes systemPrompt
- [ ] T005: `inject()` routes to `steer()`/`followUp()`; `abort()` + `abortSession()` clear session Map
- [ ] T005: Stub `extension.ts` and `mcp-tools.ts` exist with correct export signatures
- [ ] `bun run typecheck` zero errors
- [ ] `biome check src/adapters/pi-coding-agent/` passes

## Review Guidance

Reviewers: check that:
1. Session key pattern is `${brain}:${threadId}` (not `${threadId}` alone)
2. `SessionManager.inMemory()` is called ONCE in constructor (not per-session in run())
3. `run()` always refreshes systemPrompt before prompting (Block 3/4 content changes each activation)
4. inject() iterates ALL sessions (not just brain-specific) — this matches spec FR-04 semantics
5. Stub files match the signature expected by index.ts

## Activity Log

- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created.
