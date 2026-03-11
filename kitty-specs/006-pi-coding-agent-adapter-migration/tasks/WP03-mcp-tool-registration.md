---
work_package_id: "WP03"
title: "MCP Tool Registration"
phase: "Phase 2 - Core Behavior"
lane: "doing"
dependencies: ["WP01", "WP02"]
subtasks:
  - "T012"
  - "T013"
  - "T014"
assignee: ""
agent: "claude-sonnet-4-6"
shell_pid: "87805"
review_status: ""
reviewed_by: ""
history:
  - timestamp: "2026-03-11T00:00:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
---

# Work Package Prompt: WP03 – MCP Tool Registration

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, scroll to Review Feedback section.

---

## Review Feedback

*[Empty initially.]*

---

## Objectives & Success Criteria

Implement `buildMcpTools(workspace)` in `src/adapters/pi-coding-agent/mcp-tools.ts` to convert AIMA's MCP tools into `AgentTool[]` for pi-coding-agent. Wire MCP tools into the Extension so the LLM can call them. MCP tools go through the same Amygdala `tool_call` handler — no bypass.

**Success criteria**:
- `buildMcpTools(workspace)` returns a non-empty `AgentTool[]`
- Each tool has `name`, `description`, and an `execute()` function that calls the workspace
- MCP tools appear in the Extension's `registeredTools` and are subject to `tool_call` Amygdala check
- `bun run typecheck` zero errors; `biome check` passes

**Implementation command**:
```bash
spec-kitty implement WP03 --base WP02
```

---

## Context & Constraints

- **Spec**: FR-05 (MCP Tool Registration)
- **Plan**: plan.md WP03 section + Decision 5 (MCP via registeredTools)
- **Constitution**: 不敷衍 — real MCP tools must be wired, not stubbed
- **MCP server**: Somewhere in `src/` — likely `src/mcp/index.ts`. Find the correct export before implementing.
- **wrapRegisteredTool**: From pi-coding-agent — check exact import name/signature after T001 (WP01)
- **AgentTool type**: From pi-coding-agent — has `name`, `description`, `inputSchema`, `execute`

---

## Subtasks & Detailed Guidance

### Subtask T012 — buildMcpTools(workspace): AgentTool[]

**Purpose**: Wrap AIMA's MCP server tools into `AgentTool[]` for pi-coding-agent's Extension.

**Steps**:

1. Find the MCP server export:
   ```bash
   grep -r "createAimaMcpServer\|AimaMcpServer\|mcpServer\|getTools" src/ --include="*.ts" | head -20
   ```
   Common locations: `src/mcp/index.ts`, `src/mcp/server.ts`

2. Understand the AIMA MCP tool structure — read the relevant file to see what `getTools()` returns.

3. Replace the stub in `src/adapters/pi-coding-agent/mcp-tools.ts`:

```typescript
import type { AgentTool } from '@mariozechner/pi-coding-agent'
import { wrapRegisteredTool } from '@mariozechner/pi-coding-agent'
import type { CognitiveWorkspace } from '../../workspace/index'
// Adjust this import path to match actual MCP server location
import { createAimaMcpServer } from '../../mcp/index'

export function buildMcpTools(workspace: CognitiveWorkspace): AgentTool[] {
  const mcpServer = createAimaMcpServer(workspace)
  const tools = mcpServer.getTools()
  return tools.map((tool) =>
    wrapRegisteredTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (args: unknown) => tool.execute(args),
    }),
  )
}
```

**Notes**:
- `wrapRegisteredTool` may not exist — check pi-coding-agent exports. Alternative: construct `AgentTool` objects directly with the expected shape.
- `createAimaMcpServer` may accept additional params (like `apiKey`) — check the actual function signature.
- If `getTools()` returns a different shape, adapt the `map()` accordingly.
- If MCP server doesn't exist yet, create a minimal stub `src/mcp/index.ts`:
  ```typescript
  export function createAimaMcpServer(_workspace: unknown) {
    return { getTools: () => [] }
  }
  ```

---

### Subtask T013 — Update createAimaExtension to Accept registeredTools

**Purpose**: The stub in WP01 already has `registeredTools: AgentTool[] = []` as a parameter. Verify that WP02's implementation correctly passes it to the Extension's `registeredTools` field.

**Steps**:

1. Read `src/adapters/pi-coding-agent/extension.ts` (from WP02).
2. Confirm the function signature matches:
   ```typescript
   export function createAimaExtension(
     brain: CognitiveBrainType,
     threadId: string,
     amygdala: Amygdala,
     eventBus: BrainEventBus,
     registeredTools: AgentTool[] = [],
   ): Extension
   ```
3. Confirm `registeredTools` is included in the returned Extension:
   ```typescript
   return {
     registeredTools,  // ← must be here
     handlers: { ... },
   }
   ```
4. If WP02 didn't include `registeredTools` in the return, add it now.

**Files**: `src/adapters/pi-coding-agent/extension.ts`

---

### Subtask T014 — Update run() to Wire MCP Tools

**Purpose**: Update `run()` in `index.ts` so that MCP tools are built from the workspace and passed to the Extension on session creation.

**Steps**:

1. Read `src/adapters/pi-coding-agent/index.ts` (WP01+WP02 result).
2. Ensure static imports at top of file:
   ```typescript
   import { buildMcpTools } from './mcp-tools'
   import { createAimaExtension } from './extension'
   ```
3. In the `if (!session)` branch of `run()`, confirm:
   ```typescript
   const mcpTools = buildMcpTools(this.config.workspace)
   const extension = createAimaExtension(
     brain,
     threadId,
     this.config.amygdala,
     this.config.eventBus,
     mcpTools,
   )
   ```
4. If WP01 used dynamic imports (`await import('./mcp-tools')`), replace with static import.
5. Run `bun run typecheck` + `biome check --write`.

---

## Test Strategy

No test files in this WP. Unit tests for MCP tools are in WP05 (`mcp-tools.test.ts`), integration tests in WP06.

```bash
bun run typecheck
biome check src/adapters/pi-coding-agent/
```

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `createAimaMcpServer` doesn't exist | Check src/mcp/ — may be named differently; grep for it |
| `wrapRegisteredTool` not in pi-coding-agent exports | Use `AgentTool` object directly without wrapper |
| MCP tools' `inputSchema` format incompatible | Read pi-coding-agent's `AgentTool.inputSchema` type; adjust |
| `getTools()` not yet on McpServer | Create a minimal stub returning empty array; document for future |

---

## Definition of Done Checklist

- [ ] T012: `buildMcpTools(workspace)` returns `AgentTool[]` from AIMA MCP server tools
- [ ] T013: `createAimaExtension` has `registeredTools` in return value
- [ ] T014: `run()` calls `buildMcpTools` on first session creation; static imports used
- [ ] `bun run typecheck` zero errors
- [ ] `biome check` passes

## Review Guidance

1. MCP tools must appear in `extension.registeredTools` (not just created but unused)
2. MCP tools must be wrapped with correct `name`/`description`/`execute` shape
3. `tool_call` handler in extension.ts covers MCP tool names too (they're not in DEFAULT_BLOCKED_TOOLS or DEFAULT_ALLOWED_TOOLS → go through amygdala.check())

## Activity Log

- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created.
- 2026-03-11T10:41:19Z – claude-sonnet-4-6 – shell_pid=87805 – lane=doing – Started implementation via workflow command
