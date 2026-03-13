# Feature Specification: AIMAInstance Config Wiring for Embedding and Amygdala

**Feature**: 028-aima-instance-config-wiring
**Status**: draft
**Created**: 2026-03-13
**Depends on**: Feature 016 (Amygdala Stage 3 LLM), Feature 017 (pgvector semantic search)

---

## Overview

Features 016 and 017 implemented Amygdala Stage 3 LLM evaluation and pgvector semantic memory search respectively, but neither is accessible through `AIMAInstance` — the main public API. `AIMAInstanceConfig` has no fields for embedding or amygdala configuration. This feature adds those fields and wires them through to the constructors of `CognitiveWorkspace` and `Amygdala`.

---

## Actors

- **`AIMAInstance`**: top-level entry point; owns `CognitiveWorkspace` and `Amygdala` construction
- **`CognitiveWorkspace`**: accepts `CognitiveWorkspaceOptions.embedding` for vector search
- **`Amygdala`**: accepts `AmygdalaConfig` with `llm`, `riskLevels`, and `haiku_enabled` fields

---

## Problem Statement

### P1: Embedding config unreachable

`CognitiveWorkspace` already accepts `CognitiveWorkspaceOptions.embedding?: EmbeddingConfig`. However, `AIMAInstance` constructs workspace as:

```typescript
this.workspace = new CognitiveWorkspace(db)
```

No options object is passed. Callers have no way to enable pgvector semantic search through `AIMAInstance`.

### P2: Amygdala config unreachable

`AmygdalaConfig` has `llm?: LlmConfig`, `riskLevels?: Record<string, ToolRiskLevel>`, and `haiku_enabled?: boolean`. However, `AIMAInstance` constructs amygdala as:

```typescript
this.amygdala = new Amygdala({}, this.workspace, this.eventBus)
```

Empty config is always passed. Stage 3 LLM evaluation and custom risk levels are permanently disabled regardless of what the caller wants.

---

## Functional Requirements

### FR-01: Add `embedding` field to `AIMAInstanceConfig`

```typescript
/**
 * Embedding config for pgvector semantic memory search.
 * If omitted, all memory searches fall back to ILIKE text matching.
 */
embedding?: EmbeddingConfig
```

### FR-02: Add `amygdala` field to `AIMAInstanceConfig`

```typescript
/**
 * Amygdala configuration for risk evaluation behavior.
 */
amygdala?: {
  /** LLM config for Stage 3 evaluation (required for Stage 3 to activate) */
  llm?: LlmConfig
  /** Per-tool risk level overrides. Default: 'low' for all tools */
  riskLevels?: Record<string, 'low' | 'medium' | 'high'>
  /** Enable Stage 3 LLM evaluation for high-risk tools */
  haiku_enabled?: boolean
}
```

Note: `AmygdalaConfig.haiku_enabled` is the existing field name — do not rename.

### FR-03: Wire `embedding` into `CognitiveWorkspace` constructor

```typescript
this.workspace = new CognitiveWorkspace(db, {
  ...(config.embedding ? { embedding: config.embedding } : {}),
})
```

### FR-04: Wire `amygdala` into `Amygdala` constructor

```typescript
this.amygdala = new Amygdala(
  {
    ...(config.amygdala?.llm ? { llm: config.amygdala.llm } : {}),
    ...(config.amygdala?.riskLevels ? { riskLevels: config.amygdala.riskLevels } : {}),
    ...(config.amygdala?.haiku_enabled !== undefined
      ? { haiku_enabled: config.amygdala.haiku_enabled }
      : {}),
  },
  this.workspace,
  this.eventBus,
)
```

### FR-05: Tests

- If no embedding config is provided, `CognitiveWorkspace` is constructed with empty options (existing behavior unchanged).
- If `embedding` is provided, `CognitiveWorkspace` is constructed with the correct options object.
- If `amygdala.llm` is provided, `Amygdala` receives it in config.
- If `amygdala.haiku_enabled: true` is provided, `Amygdala` receives it.
- All existing `AIMAInstance` tests continue to pass.

---

## User Scenarios & Testing

### Scenario A: No embedding, no amygdala config

Existing behavior unchanged. `CognitiveWorkspace` gets `{}`, `Amygdala` gets `{}`. All existing tests pass.

**Test**: existing tests in `aima-instance.test.ts` continue to pass.

### Scenario B: Embedding config passed through

Caller sets `embedding: { apiKey: 'sk-...', model: 'text-embedding-3-small' }`. `CognitiveWorkspace` is constructed with that config.

**Test**: spy on `CognitiveWorkspace` constructor; assert it was called with options containing the embedding config.

### Scenario C: Amygdala LLM config passed through

Caller sets `amygdala: { llm: { apiKey: 'sk-...', model: 'claude-haiku-4-5-20251001' }, haiku_enabled: true }`. `Amygdala` constructor receives those fields.

**Test**: spy on `Amygdala` constructor; assert first argument contains `llm` and `haiku_enabled: true`.

---

## Key Entities

- **`src/instance.ts`**: add two fields to `AIMAInstanceConfig`, update two constructor calls
- **`tests/unit/aima-instance.test.ts`**: add tests for embedding and amygdala config pass-through

---

## Assumptions

- `EmbeddingConfig` is exported from `./embedding`; `LlmConfig` is exported from `./llm` — both already imported or importable
- `AmygdalaConfig.haiku_enabled` is the correct field name (not `stage3` or `llmEnabled`)
- The `stages` field described in the task instructions does NOT exist in `AmygdalaConfig` — use only `haiku_enabled`
- No new files needed — only two additions to `src/instance.ts` plus new tests

---

## Success Criteria

1. `AIMAInstanceConfig` has `embedding?` and `amygdala?` fields with JSDoc
2. `CognitiveWorkspace` constructor receives embedding options when provided
3. `Amygdala` constructor receives llm/riskLevels/haiku_enabled when provided
4. Omitted fields do not change existing behavior
5. All existing tests pass (zero regression)
6. `bun run typecheck` passes, `biome check` passes
7. New tests for both pass-throughs are green

---

## Out of Scope

- Adding new fields to `AmygdalaConfig` or `CognitiveWorkspaceOptions`
- Amygdala Stage 2 implementation
- Any behavior changes to Amygdala or CognitiveWorkspace internals
