---
work_package_id: WP01
title: Wire embedding and amygdala configs through AIMAInstance and add unit tests
lane: "done"
dependencies: []
subtasks: [T001, T002, T003]
assignee: ""
agent: ""
shell_pid: "42255"
review_status: "approved"
reviewed_by: "XIAYANG ZHANG"
history:
  - timestamp: "2026-03-13T00:00:00Z"
    lane: "planned"
    agent: "system"
    action: "Prompt generated via spec-kitty agent feature finalize-tasks"
---

# Work Package Prompt: WP01 — Wire Embedding and Amygdala Configs Through AIMAInstance and Add Unit Tests

## Goal

`CognitiveWorkspace` (Feature 017) and `Amygdala` (Feature 016) already accept config for vector search and Stage 3 LLM evaluation, but `AIMAInstance` always constructs them with empty/no options. This WP adds `embedding` and `amygdala` fields to `AIMAInstanceConfig` and wires them into the two constructors. Add unit tests that verify the pass-through.

## Implementation Command

```bash
spec-kitty agent workflow implement --agent <your-name>
```

No dependencies — implement directly on the feature branch.

## Context

### Key Files

- **Modified**: `src/instance.ts` — two new imports, two new interface fields, two constructor call updates
- **Modified**: `tests/unit/aima-instance.test.ts` — two new describe blocks (~60 lines)

### The Gap

**`src/instance.ts`, line 147** — no options passed to workspace:
```typescript
// Current:
this.workspace = new CognitiveWorkspace(db)

// Target:
this.workspace = new CognitiveWorkspace(db, {
  ...(config.embedding ? { embedding: config.embedding } : {}),
})
```

**`src/instance.ts`, line 153** — empty config hardcoded:
```typescript
// Current:
this.amygdala = new Amygdala({}, this.workspace, this.eventBus)

// Target:
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

### Interface Shape

`AmygdalaConfig` (from `src/amygdala/index.ts`) has:
```typescript
export interface AmygdalaConfig {
  rules?: AmygdalaRule[]
  riskLevels?: Record<string, ToolRiskLevel>
  haiku_enabled?: boolean
  llm?: LlmConfig
}
```

`CognitiveWorkspaceOptions` (from `src/workspace/index.ts`) has:
```typescript
export interface CognitiveWorkspaceOptions {
  pendingCapacity?: number
  embedding?: EmbeddingConfig
}
```

`EmbeddingConfig` (from `src/embedding.ts`) has:
```typescript
export interface EmbeddingConfig {
  apiKey?: string
  model?: string
  dimensions?: number
}
```

`LlmConfig` (from `src/llm.ts`) — already used by `DmnConfig`. Import `type { LlmConfig } from './llm'`.

### Import Notes

Neither `EmbeddingConfig` nor `LlmConfig` is currently imported in `src/instance.ts`. Both must be added as type-only imports.

## T001 — Add fields to AIMAInstanceConfig

**File**: `src/instance.ts`

Add two imports at the top of the file (after existing imports, before the `// ─── Config ─` comment):
```typescript
import type { EmbeddingConfig } from './embedding'
import type { LlmConfig } from './llm'
```

Add to `AIMAInstanceConfig` interface, after the `_subQueryFn` field:
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

## T002 — Wire configs in AIMAInstance constructor

**File**: `src/instance.ts`

Find and replace the workspace construction (line ~147):
```typescript
// Before:
this.workspace = new CognitiveWorkspace(db)

// After:
this.workspace = new CognitiveWorkspace(db, {
  ...(config.embedding ? { embedding: config.embedding } : {}),
})
```

Find and replace the amygdala construction (line ~153):
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

No other constructor changes. The `amygdala` variable alias on line 154 (`const amygdala = this.amygdala`) remains unchanged.

## T003 — Unit tests

**File**: `tests/unit/aima-instance.test.ts`

Append two new describe blocks at the end of the file.

### Block 1 — Embedding config wiring

```typescript
describe('AIMAInstance — embedding config wiring', () => {
  test('embedding config is passed through to CognitiveWorkspace constructor', () => {
    const embeddingConfig: EmbeddingConfig = { apiKey: 'sk-test', model: 'text-embedding-3-small' }

    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
      embedding: embeddingConfig,
    })

    // Access private workspace options via cast
    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const workspace = (instance as unknown as Record<string, any>).workspace
    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const options = (workspace as unknown as Record<string, any>).options
    expect(options.embedding).toEqual(embeddingConfig)
  })

  test('omitting embedding config passes empty options to CognitiveWorkspace', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const workspace = (instance as unknown as Record<string, any>).workspace
    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const options = (workspace as unknown as Record<string, any>).options
    expect(options.embedding).toBeUndefined()
  })
})
```

### Block 2 — Amygdala config wiring

```typescript
describe('AIMAInstance — amygdala config wiring', () => {
  test('amygdala llm and haiku_enabled are passed through to Amygdala constructor', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
      amygdala: {
        llm: { apiKey: 'sk-test' },
        haiku_enabled: true,
      },
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const amygdala = (instance as unknown as Record<string, any>).amygdala
    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const config = (amygdala as unknown as Record<string, any>).config
    expect(config.llm).toEqual({ apiKey: 'sk-test' })
    expect(config.haiku_enabled).toBe(true)
  })

  test('amygdala riskLevels override is passed through', () => {
    const riskLevels = { bash: 'high' as const, my_custom_tool: 'low' as const }

    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
      amygdala: { riskLevels },
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const amygdala = (instance as unknown as Record<string, any>).amygdala
    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const config = (amygdala as unknown as Record<string, any>).config
    expect(config.riskLevels).toEqual(riskLevels)
  })

  test('omitting amygdala config passes empty config object to Amygdala', () => {
    const instance = new AIMAInstance({
      databaseUrl: 'postgresql://localhost/test',
      adapter: 'claude-sdk',
    })

    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const amygdala = (instance as unknown as Record<string, any>).amygdala
    // biome-ignore lint/suspicious/noExplicitAny: accessing private members for unit testing
    const config = (amygdala as unknown as Record<string, any>).config
    expect(config.llm).toBeUndefined()
    expect(config.haiku_enabled).toBeUndefined()
    expect(config.riskLevels).toBeUndefined()
  })
})
```

The tests access private `config` and `options` fields via cast — this is acceptable in unit tests and consistent with the existing pattern in this file (see `getAdapters` helper at the top).

Both describe blocks need the `EmbeddingConfig` import added to the test file's import section if not already present. Check for it; if absent, add:
```typescript
import type { EmbeddingConfig } from '../../src/embedding'
```

## Done Criteria

- [ ] T001: `AIMAInstanceConfig` has `embedding?: EmbeddingConfig` and `amygdala?: { llm?, riskLevels?, haiku_enabled? }` with JSDoc
- [ ] T002: `CognitiveWorkspace` constructor receives embedding options when `config.embedding` is set
- [ ] T002: `Amygdala` constructor receives llm/riskLevels/haiku_enabled when `config.amygdala.*` fields are set
- [ ] T002: omitting both fields preserves existing behavior (`{}` options, `{}` config)
- [ ] T003: all five new tests pass
- [ ] All existing tests in `aima-instance.test.ts` continue to pass (zero regression)
- [ ] `bun run typecheck` zero errors
- [ ] `biome check` passes

## Activity Log

- 2026-03-13T07:10:22Z – unknown – shell_pid=42255 – lane=done – Review passed: embedding and amygdala configs correctly wired through AIMAInstanceConfig. All 451 unit tests pass, typecheck and biome clean. haiku_enabled: false edge case handled.
