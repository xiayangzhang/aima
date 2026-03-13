# Implementation Plan: AIMAInstance Config Wiring for Embedding and Amygdala

**Branch**: `028-aima-instance-config-wiring` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

## Summary

Add `embedding?: EmbeddingConfig` and `amygdala?: { llm?, riskLevels?, haiku_enabled? }` fields to `AIMAInstanceConfig`. Wire them through to `CognitiveWorkspace` and `Amygdala` constructors. Add unit tests verifying the pass-through using constructor spies.

## Technical Context

**Language/Version**: TypeScript 5.x
**Modified file**: `src/instance.ts` — add two interface fields + update two constructor call sites (~15 lines)
**Test file**: `tests/unit/aima-instance.test.ts` — append two describe blocks (~60 lines)
**Testing**: Bun test with `mock()` for constructor spies

## Current State (the gap)

`src/instance.ts`, lines 147 and 153:

```typescript
// Line 147 — no options passed:
this.workspace = new CognitiveWorkspace(db)

// Line 153 — empty config hardcoded:
this.amygdala = new Amygdala({}, this.workspace, this.eventBus)
```

`AIMAInstanceConfig` has no `embedding` or `amygdala` fields. Callers cannot enable vector search or Stage 3 LLM evaluation through the public API.

## Changes

### `src/instance.ts` — Interface additions

Add two imports at the top (after existing imports):
```typescript
import type { EmbeddingConfig } from './embedding'
import type { LlmConfig } from './llm'
```

Add to `AIMAInstanceConfig` interface (after the `_subQueryFn` field):
```typescript
/**
 * Embedding config for pgvector semantic memory search.
 * If omitted, all memory searches fall back to ILIKE text matching.
 */
embedding?: EmbeddingConfig

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

### `src/instance.ts` — Constructor wiring

Replace line 147:
```typescript
// Before:
this.workspace = new CognitiveWorkspace(db)

// After:
this.workspace = new CognitiveWorkspace(db, {
  ...(config.embedding ? { embedding: config.embedding } : {}),
})
```

Replace line 153:
```typescript
// Before:
this.amygdala = new Amygdala({}, this.workspace, this.eventBus)

// After:
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

### `tests/unit/aima-instance.test.ts` — New tests

Add two new describe blocks using Bun `mock()` to spy on constructors:

**Test: embedding config passes through to CognitiveWorkspace**

Use `mock.module` or spy on the module to intercept `CognitiveWorkspace` constructor.
Verify the options argument contains the embedding config.

**Test: amygdala config passes through to Amygdala**

Spy on `Amygdala` constructor.
Verify first argument contains `llm` and `haiku_enabled` when provided.

## Import Check

Before adding `import type { LlmConfig }`, verify it is not already imported.
`EmbeddingConfig` is likely not imported in `instance.ts` — add both.

`LlmConfig` is used in existing `DmnConfig` wiring — check if it is already in scope.

## Estimated Size

- `src/instance.ts`: ~20 lines (2 imports + 2 interface fields + 2 constructor call updates)
- `tests/unit/aima-instance.test.ts`: ~65 lines (2 describe blocks × ~30 lines)
- Total: ~85 lines
