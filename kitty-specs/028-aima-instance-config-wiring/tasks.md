# Tasks: Feature 028 — AIMAInstance Config Wiring for Embedding and Amygdala

## WP01 — Wire embedding and amygdala configs through AIMAInstance and add unit tests

**Lane**: planned
**Depends on**: none

| ID   | Task | Details |
|------|------|---------|
| T001 | Update `AIMAInstanceConfig` in `src/instance.ts` | Add two imports (`EmbeddingConfig` from `'./embedding'` and `LlmConfig` from `'./llm'`). Add two optional fields to the `AIMAInstanceConfig` interface: `embedding?: EmbeddingConfig` (with JSDoc: "Embedding config for pgvector semantic memory search. If omitted, all memory searches fall back to ILIKE text matching.") and `amygdala?: { llm?: LlmConfig; riskLevels?: Record<string, 'low' \| 'medium' \| 'high'>; haiku_enabled?: boolean }` (with JSDoc: "Amygdala configuration for risk evaluation behavior."). Place both fields after the existing `_subQueryFn` field. |
| T002 | Wire configs in `AIMAInstance` constructor in `src/instance.ts` | Replace `this.workspace = new CognitiveWorkspace(db)` (line ~147) with `this.workspace = new CognitiveWorkspace(db, { ...(config.embedding ? { embedding: config.embedding } : {}) })`. Replace `this.amygdala = new Amygdala({}, this.workspace, this.eventBus)` (line ~153) with `this.amygdala = new Amygdala({ ...(config.amygdala?.llm ? { llm: config.amygdala.llm } : {}), ...(config.amygdala?.riskLevels ? { riskLevels: config.amygdala.riskLevels } : {}), ...(config.amygdala?.haiku_enabled !== undefined ? { haiku_enabled: config.amygdala.haiku_enabled } : {}) }, this.workspace, this.eventBus)`. No other changes to the constructor. |
| T003 | Write unit tests in `tests/unit/aima-instance.test.ts` | Add two new describe blocks. (1) `'AIMAInstance — embedding config wiring'`: spy on `CognitiveWorkspace` constructor using Bun `mock()`; construct `AIMAInstance` with `embedding: { apiKey: 'sk-test', model: 'text-embedding-3-small' }`; assert the spy was called with a second argument containing `{ embedding: { apiKey: 'sk-test', model: 'text-embedding-3-small' } }`. Also test that omitting `embedding` still calls `CognitiveWorkspace` (no regression). (2) `'AIMAInstance — amygdala config wiring'`: spy on `Amygdala` constructor; construct with `amygdala: { llm: { apiKey: 'sk-test' }, haiku_enabled: true }`; assert spy first argument contains `llm` and `haiku_enabled: true`. Also test omitting `amygdala` passes empty config `{}`. Follow existing test patterns in the file: construct `AIMAInstance` with `databaseUrl: 'postgresql://localhost/test'` and `adapter: 'claude-sdk'`. |

**Done criteria**: `bun run typecheck` passes with zero errors, `biome check` passes, all new tests green, no regressions in existing test suite.
