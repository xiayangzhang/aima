---
work_package_id: WP01
title: Fix MCP brain memory tools and add unit tests
lane: "doing"
dependencies: []
subtasks: [T001, T002, T003, T004]
assignee: ""
agent: "claude"
shell_pid: "31160"
review_status: ""
reviewed_by: ""
history:
  - timestamp: "2026-03-13T00:00:00Z"
    lane: "planned"
    agent: "system"
    action: "Prompt generated via spec-kitty agent feature finalize-tasks"
---

# Work Package Prompt: WP01 — Fix MCP Brain Memory Tools and Add Unit Tests

## Goal

Fix three MCP tool handlers in `src/mcp/index.ts` that call generic `workspace.searchMemory()` instead of the specialized workspace methods (`getEntityContext`, `findSimilarSituations`, `getProcedure`) that were added by Feature 005. Add unit tests asserting the correct methods are called.

## Implementation Command

```bash
spec-kitty agent workflow implement --agent <your-name>
```

No dependencies — implement directly on the feature branch:

```bash
spec-kitty implement WP01
```

## Context

### Key Files

- **Modified**: `src/mcp/index.ts` — fix three tool handlers (lines 118–181)
- **New**: `tests/unit/mcp/brain-memory-tools.test.ts`

### Bug Summary

| Tool | Current Bug | Fix |
|------|-------------|-----|
| `memory_entity_context` | calls `searchMemory({ entityId })`, ignores `types` filter | call `getEntityContext(entityId, { types, limit })` |
| `memory_similar_situations` | no `situation` param, two generic `searchMemory` calls | add optional `situation`, call `findSimilarSituations(situation, { limit })` |
| `memory_procedure` | no `taskType` param, generic `searchMemory({ type: 'procedural', tags })` | add optional `taskType`, call `getProcedure(taskType, { limit })` |

### Workspace Method Signatures (from `src/types/index.ts`)

```typescript
getEntityContext(
  entityId: string,
  opts?: { types?: MemoryType[]; limit?: number }
): Promise<MemoryEntry[]>

findSimilarSituations(
  situation: string,
  opts?: { limit?: number }
): Promise<{ episodes: MemoryEntry[]; procedures: MemoryEntry[]; facts: MemoryEntry[] }>

getProcedure(taskType: string, opts?: { limit?: number }): Promise<MemoryEntry[]>
```

### Backwards Compatibility

`memory_similar_situations` and `memory_procedure` must fall back to the current `searchMemory`-based behaviour when the new required parameter (`situation` / `taskType`) is absent. Both new params are optional (`z.string().optional()`).

### Feature 020 Note

`getEntityContext` does not yet accept a `depth` parameter. Add `depth` to the MCP tool input schema now (forward-compat) but do NOT pass it to `getEntityContext`. Add a `// TODO(Feature 020): pass depth once getEntityContext signature accepts it` comment in the handler.

## Subtasks

### T001 — Fix `memory_entity_context`

File: `src/mcp/index.ts`, lines 118–140

1. Add to `inputSchema`:
   ```typescript
   depth: z.number().int().min(1).max(2).optional().describe('Relationship depth (reserved for Feature 020)'),
   ```
2. Update handler to destructure `types` (already in schema but was ignored):
   ```typescript
   const { entityId, types, limit } = args as { entityId: string; types?: MemoryTypeEnum[]; limit?: number }
   ```
3. Replace `workspace.searchMemory(...)` call with:
   ```typescript
   // TODO(Feature 020): pass depth once getEntityContext signature accepts it
   const results = await workspace.getEntityContext(entityId, {
     ...(types !== undefined ? { types: types as MemoryType[] } : {}),
     ...(limit !== undefined ? { limit } : {}),
   })
   ```

### T002 — Fix `memory_similar_situations`

File: `src/mcp/index.ts`, lines 142–159

1. Add to `inputSchema`:
   ```typescript
   situation: z.string().optional().describe('Current situation or query text for semantic matching'),
   ```
2. Update handler:
   ```typescript
   const { situation, limit } = args as { situation?: string; limit?: number }
   if (situation !== undefined) {
     const results = await workspace.findSimilarSituations(situation, {
       ...(limit !== undefined ? { limit } : {}),
     })
     return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] }
   }
   // fallback: backwards-compatible generic search (no situation provided)
   const [episodes, procedures] = await Promise.all([
     workspace.searchMemory({ type: 'episodic', limit: limit ?? 5, excludeInvalid: true }),
     workspace.searchMemory({ type: 'procedural', limit: limit ?? 5, excludeInvalid: true }),
   ])
   return { content: [{ type: 'text' as const, text: JSON.stringify({ episodes, procedures }) }] }
   ```

### T003 — Fix `memory_procedure`

File: `src/mcp/index.ts`, lines 161–181

1. Add to `inputSchema`:
   ```typescript
   taskType: z.string().optional().describe('Task type or description for procedure lookup'),
   ```
   Keep existing `tags` field in schema.
2. Update handler:
   ```typescript
   const { taskType, tags, limit } = args as { taskType?: string; tags?: string[]; limit?: number }
   if (taskType !== undefined) {
     const results = await workspace.getProcedure(taskType, {
       ...(limit !== undefined ? { limit } : {}),
     })
     return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] }
   }
   // fallback: backwards-compatible tag-based search
   const results = await workspace.searchMemory({
     type: 'procedural',
     ...(tags !== undefined ? { tags } : {}),
     ...(limit !== undefined ? { limit } : {}),
     excludeInvalid: true,
   })
   return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] }
   ```

### T004 — Unit tests in `tests/unit/mcp/brain-memory-tools.test.ts`

New file. Follow the pattern from `tests/unit/aima-mcp.test.ts`.

**Setup** (reuse `getToolHandler` helper):
```typescript
import { describe, expect, mock, test } from 'bun:test'
import { createAimaMcpServer } from '../../../src/mcp/index'
import { CognitiveWorkspace } from '../../../src/workspace/index'

type AnyRecord = Record<string, any>

const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

function getToolHandler(server: ReturnType<typeof createAimaMcpServer>, toolName: string) {
  const registeredTools = (server.instance as AnyRecord)._registeredTools as AnyRecord
  const tool = registeredTools[toolName]
  if (!tool) throw new Error(`Tool '${toolName}' not found`)
  return (args: AnyRecord) => tool.handler(args, undefined)
}
```

**V1** — `memory_entity_context` calls `getEntityContext`, not `searchMemory`:
- Create workspace, mock `getEntityContext` to return `[]`, mock `searchMemory` to throw
- Call handler with `{ entityId: 'e1' }`
- Assert `getEntityContext` called once with `('e1', {})`
- Assert `searchMemory` NOT called

**V2** — `memory_entity_context` forwards `types`:
- Mock `getEntityContext` to return `[]`
- Call handler with `{ entityId: 'e1', types: ['semantic', 'episodic'] }`
- Assert `getEntityContext` called with `('e1', { types: ['semantic', 'episodic'] })`

**V3** — `memory_similar_situations` with `situation` calls `findSimilarSituations`:
- Mock `findSimilarSituations` to return `{ episodes: [], procedures: [], facts: [] }`, mock `searchMemory` to throw
- Call handler with `{ situation: 'client complaint' }`
- Assert `findSimilarSituations` called once with `('client complaint', {})`
- Assert `searchMemory` NOT called

**V4** — `memory_similar_situations` without `situation` falls back to `searchMemory`:
- Mock `searchMemory` to return `[]`, mock `findSimilarSituations` to throw
- Call handler with `{}`
- Assert `searchMemory` called (twice — episodes + procedures)
- Assert `findSimilarSituations` NOT called

**V5** — `memory_procedure` with `taskType` calls `getProcedure`:
- Mock `getProcedure` to return `[]`, mock `searchMemory` to throw
- Call handler with `{ taskType: 'expense approval' }`
- Assert `getProcedure` called once with `('expense approval', {})`
- Assert `searchMemory` NOT called

**V6** — `memory_procedure` without `taskType` falls back to `searchMemory`:
- Mock `searchMemory` to return `[]`, mock `getProcedure` to throw
- Call handler with `{}`
- Assert `searchMemory` called once with `{ type: 'procedural', ... }`
- Assert `getProcedure` NOT called

## Done Criteria

- `bun run typecheck` passes with zero errors
- `biome check` passes (no lint errors)
- All 6 new tests green
- Existing test suite has no regressions (`bun test`)

## Activity Log

- 2026-03-13T05:35:55Z – unknown – shell_pid=19501 – lane=for_review – All 3 tools fixed. 6 unit tests pass. 431 total unit tests, 0 regressions. typecheck clean. biome clean on changed files.
- 2026-03-13T05:36:06Z – claude – shell_pid=31160 – lane=doing – Started review via workflow command
