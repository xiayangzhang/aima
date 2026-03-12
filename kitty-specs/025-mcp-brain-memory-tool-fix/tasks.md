# Tasks: Feature 025 — MCP Brain-Specific Memory Tool Correctness

## WP01 — Fix MCP brain memory tools and add unit tests

**Lane**: planned
**Depends on**: none

| ID   | Task | Details |
|------|------|---------|
| T001 | Fix `memory_entity_context` handler in `src/mcp/index.ts` | Add `depth: z.number().int().min(1).max(2).optional().describe('Relationship depth (reserved for Feature 020)')` to inputSchema. In the handler, destructure `types` from args (it was already in schema but ignored). Call `workspace.getEntityContext(entityId, { ...(types !== undefined ? { types: types as MemoryType[] } : {}), ...(limit !== undefined ? { limit } : {}) })` instead of `workspace.searchMemory`. Add a `// TODO(Feature 020): pass depth once getEntityContext signature accepts it` comment. Remove the `excludeInvalid: true` flag (getEntityContext already filters internally). |
| T002 | Fix `memory_similar_situations` handler in `src/mcp/index.ts` | Add `situation: z.string().optional().describe('Current situation or query text for semantic matching')` to inputSchema. In the handler, when `situation !== undefined` call `workspace.findSimilarSituations(situation, { ...(limit !== undefined ? { limit } : {}) })` and return the result directly (it's already `{ episodes, procedures, facts }`). When `situation` is undefined, keep the existing parallel `searchMemory` fallback for backwards compat. |
| T003 | Fix `memory_procedure` handler in `src/mcp/index.ts` | Add `taskType: z.string().optional().describe('Task type or description for procedure lookup')` to inputSchema (keep existing `tags` for fallback path). In the handler, when `taskType !== undefined` call `workspace.getProcedure(taskType, { ...(limit !== undefined ? { limit } : {}) })` and return the result. When `taskType` is undefined, keep the existing `searchMemory({ type: 'procedural', tags, limit, excludeInvalid: true })` fallback. |
| T004 | Write unit tests in `tests/unit/mcp/brain-memory-tools.test.ts` | Follow the mock pattern from `tests/unit/aima-mcp.test.ts`: use `getToolHandler` helper to access handlers via `server.instance._registeredTools`. Mock workspace methods using `mock()` from `bun:test`. Six test cases: (V1) `memory_entity_context` with entityId calls `getEntityContext` not `searchMemory`; (V2) `memory_entity_context` forwards `types` to `getEntityContext`; (V3) `memory_similar_situations` with `situation` string calls `findSimilarSituations`; (V4) `memory_similar_situations` without `situation` falls back to `searchMemory`; (V5) `memory_procedure` with `taskType` calls `getProcedure`; (V6) `memory_procedure` without `taskType` falls back to `searchMemory`. For mocking: construct `CognitiveWorkspace` with `mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]` then override individual methods with `mock(() => Promise.resolve(...))`. |

**Done criteria**: `bun run typecheck` passes with zero errors, `biome check` passes, all 6 new tests green, no regressions in existing suite.
