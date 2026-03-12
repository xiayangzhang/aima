# Feature Specification: MCP Brain-Specific Memory Tool Correctness

**Feature**: 025-mcp-brain-memory-tool-fix
**Status**: draft
**Created**: 2026-03-13
**Depends on**: Feature 005 (Brain-Specific Memory Retrieval methods — already merged)

---

## Overview

Feature 005 implemented three specialized workspace methods (`getEntityContext`, `findSimilarSituations`, `getProcedure`) and wired them into Context Assembly Block 4. However, the corresponding MCP tools that expose these capabilities to brain LLMs were never updated. They still call generic `workspace.searchMemory()` and lack the required input parameters to use the specialized methods.

This feature fixes the last-mile connection: the three brain-specific MCP tools (`memory_entity_context`, `memory_similar_situations`, `memory_procedure`) are updated to call their matching workspace methods with the correct parameters.

---

## Actors

- **Limbic / Cortex / Brainstem LLMs**: call MCP tools to retrieve memory during cognition
- **CognitiveWorkspace**: the specialized methods are already implemented, just not called

---

## Problem Statement

The MCP tools were stubs from an earlier implementation pass. Since Feature 005 shipped the workspace methods, the tools have been silently degraded:

1. `memory_entity_context`: accepts `entityId` but ignores the `types` filter and calls `searchMemory({ entityId })` instead of `getEntityContext(entityId, { types, limit })`
2. `memory_similar_situations`: has no `situation` parameter; calls two parallel `searchMemory` calls without semantic filtering instead of `findSimilarSituations(situation, { limit })`
3. `memory_procedure`: has no `taskType` parameter; calls `searchMemory({ type: 'procedural', tags })` with no content matching instead of `getProcedure(taskType, { limit })`

---

## Functional Requirements

### FR-01: Fix `memory_entity_context`

Update the tool in `src/mcp/index.ts`:

- **Schema additions**: add optional `depth: z.number().int().min(1).max(2).optional()` (forward-compat for Feature 020 which adds depth traversal to `getEntityContext`)
- **Handler**: call `workspace.getEntityContext(entityId, { types, limit })` — pass `depth` as a comment/TODO until Feature 020 ships
- **Types filter**: pass the `types` array from input to `getEntityContext` opts (currently ignored)

**Acceptance criteria**:
- Handler calls `workspace.getEntityContext`, not `workspace.searchMemory`
- `types` filter is forwarded to `getEntityContext`
- `depth` appears in input schema; a TODO comment notes it will be wired when Feature 020 ships

### FR-02: Fix `memory_similar_situations`

Update the tool in `src/mcp/index.ts`:

- **Schema additions**: add `situation: z.string().optional().describe('Current situation or query text for semantic matching')`
- **Handler**: when `situation` is provided, call `workspace.findSimilarSituations(situation, { limit })`; when absent, fall back to the existing generic `searchMemory` approach for backwards compatibility
- **Response shape**: `findSimilarSituations` returns `{ episodes, procedures, facts }` — return this directly (the old `{ episodes, procedures }` shape is extended to include `facts`)

**Acceptance criteria**:
- `situation` parameter present in input schema (optional)
- With `situation`: handler calls `workspace.findSimilarSituations`
- Without `situation`: handler falls back to current behaviour (generic searchMemory)
- Response includes `facts` array when using the specialized path

### FR-03: Fix `memory_procedure`

Update the tool in `src/mcp/index.ts`:

- **Schema additions**: add `taskType: z.string().optional().describe('Task type or description for procedure lookup')`
- **Handler**: when `taskType` is provided, call `workspace.getProcedure(taskType, { limit })`; when absent, fall back to existing `searchMemory({ type: 'procedural', tags })` behaviour
- **Remove `tags` parameter**: the `tags` filter is superseded by `taskType` content matching in `getProcedure`; keep `tags` in schema for backwards compat but only use it in fallback path

**Acceptance criteria**:
- `taskType` parameter present in input schema (optional)
- With `taskType`: handler calls `workspace.getProcedure`
- Without `taskType`: handler falls back to current behaviour

### FR-04: Unit tests

New test file `tests/unit/mcp/brain-memory-tools.test.ts`:

- **V1**: `memory_entity_context` with `entityId` calls `getEntityContext`, not `searchMemory`
- **V2**: `memory_entity_context` forwards `types` array to `getEntityContext`
- **V3**: `memory_similar_situations` with `situation` string calls `findSimilarSituations`
- **V4**: `memory_similar_situations` without `situation` falls back to `searchMemory`
- **V5**: `memory_procedure` with `taskType` calls `getProcedure`
- **V6**: `memory_procedure` without `taskType` falls back to `searchMemory`

---

## Key Files

- **Modified**: `src/mcp/index.ts` — fix the three tool handlers
- **New**: `tests/unit/mcp/brain-memory-tools.test.ts`

---

## Assumptions

- Feature 005 workspace methods (`getEntityContext`, `findSimilarSituations`, `getProcedure`) are already implemented and merged
- Feature 020 (`depth` parameter on `getEntityContext`) is not yet implemented; `depth` is added to MCP schema now, passed through with a TODO comment
- `findSimilarSituations` returns `{ episodes, procedures, facts }` — confirmed from `src/types/index.ts` ICognitiveWorkspace signature
- `getEntityContext` current signature: `(entityId: string, opts?: { types?: MemoryType[]; limit?: number })` — no `depth` yet

---

## Out of Scope

- Feature 020 `depth` implementation in workspace
- Vector/embedding-based similarity (ILIKE is the current implementation)
- New MCP tools beyond fixing the three existing ones
- Changes to Context Assembly Block 4

---

## Success Criteria

1. All three tool handlers call the correct specialized workspace method when given the required parameter
2. Backwards compatibility maintained: optional parameters fall back gracefully
3. Unit tests pass with mock workspace — `searchMemory` is NOT called when the specialized path is taken
4. `bun run typecheck` zero errors, `biome check` passes
5. Test count: 6 test cases in the new test file
