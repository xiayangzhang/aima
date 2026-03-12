# Implementation Plan: MCP Brain-Specific Memory Tool Correctness

**Branch**: `025-mcp-brain-memory-tool-fix` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

## Summary

Fix three MCP tool handlers in `src/mcp/index.ts` that call generic `workspace.searchMemory()` instead of the specialized workspace methods added by Feature 005. Add unit tests asserting the correct methods are called.

## Technical Context

**Language/Version**: TypeScript 5.x
**Primary file**: `src/mcp/index.ts` — tools at lines 118–181
**Test file**: `tests/unit/mcp/brain-memory-tools.test.ts` (new)
**Testing**: Bun test
**Constraint**: Optional parameters must fall back gracefully to maintain backwards compatibility

## Current Implementations (bugs)

### `memory_entity_context` (lines 118–140)
- Schema: has `entityId`, `types` (ignored), `limit`
- Bug: calls `workspace.searchMemory({ entityId, limit })` — `types` filter is silently dropped
- Fix: call `workspace.getEntityContext(entityId, { types, limit })`

### `memory_similar_situations` (lines 142–159)
- Schema: has only `limit`, no `situation`
- Bug: calls two parallel `searchMemory` calls with type filters; no semantic content matching
- Fix: add optional `situation` param; when present call `workspace.findSimilarSituations(situation, { limit })`

### `memory_procedure` (lines 161–181)
- Schema: has `tags`, `limit`, no `taskType`
- Bug: calls `workspace.searchMemory({ type: 'procedural', tags, limit })` — no content matching
- Fix: add optional `taskType` param; when present call `workspace.getProcedure(taskType, { limit })`

## New Implementations

### `memory_entity_context`
```typescript
inputSchema: {
  entityId: z.string().describe('Entity ID to retrieve context for'),
  types: z.array(z.enum(['semantic', 'episodic', 'procedural', 'working', 'implicit'])).optional(),
  limit: z.number().int().positive().optional(),
  // depth: forwarded to getEntityContext when Feature 020 ships (signature not yet updated)
  depth: z.number().int().min(1).max(2).optional().describe('Relationship depth (reserved for Feature 020)'),
},
handler: async (args) => {
  const { entityId, types, limit } = args
  // TODO(Feature 020): pass depth once getEntityContext signature accepts it
  const results = await workspace.getEntityContext(entityId, {
    ...(types !== undefined ? { types: types as MemoryType[] } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
  return { content: [{ type: 'text', text: JSON.stringify(results) }] }
}
```

### `memory_similar_situations`
```typescript
inputSchema: {
  situation: z.string().optional().describe('Current situation or query text for semantic matching'),
  limit: z.number().int().positive().optional(),
},
handler: async (args) => {
  const { situation, limit } = args
  if (situation !== undefined) {
    const results = await workspace.findSimilarSituations(situation, {
      ...(limit !== undefined ? { limit } : {}),
    })
    return { content: [{ type: 'text', text: JSON.stringify(results) }] }
  }
  // fallback: backwards-compatible generic search
  const [episodes, procedures] = await Promise.all([
    workspace.searchMemory({ type: 'episodic', limit: limit ?? 5, excludeInvalid: true }),
    workspace.searchMemory({ type: 'procedural', limit: limit ?? 5, excludeInvalid: true }),
  ])
  return { content: [{ type: 'text', text: JSON.stringify({ episodes, procedures }) }] }
}
```

### `memory_procedure`
```typescript
inputSchema: {
  taskType: z.string().optional().describe('Task type or description for procedure lookup'),
  tags: z.array(z.string()).optional().describe('Filter by tags (fallback path only)'),
  limit: z.number().int().positive().optional(),
},
handler: async (args) => {
  const { taskType, tags, limit } = args
  if (taskType !== undefined) {
    const results = await workspace.getProcedure(taskType, {
      ...(limit !== undefined ? { limit } : {}),
    })
    return { content: [{ type: 'text', text: JSON.stringify(results) }] }
  }
  // fallback: backwards-compatible tag-based search
  const results = await workspace.searchMemory({
    type: 'procedural',
    ...(tags !== undefined ? { tags } : {}),
    ...(limit !== undefined ? { limit } : {}),
    excludeInvalid: true,
  })
  return { content: [{ type: 'text', text: JSON.stringify(results) }] }
}
```

## Test Strategy

Follow the mock pattern from `tests/unit/aima-mcp.test.ts`:
- Access `server.instance._registeredTools[toolName].handler` to call handlers directly
- Use `mock()` from `bun:test` on individual workspace methods
- Construct workspace with `mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]`
- Spy on `getEntityContext`, `findSimilarSituations`, `getProcedure`, and `searchMemory`
- Assert the correct method is called (and `searchMemory` is NOT called) for the specialized path

## Estimated Size

- `src/mcp/index.ts` changes: ~40 lines modified (3 tool handlers)
- `tests/unit/mcp/brain-memory-tools.test.ts`: ~200 lines (6 test cases with setup)
- Total: ~240 lines
