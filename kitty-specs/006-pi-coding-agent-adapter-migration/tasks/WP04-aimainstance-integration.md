---
work_package_id: "WP04"
title: "AIMAInstance Integration + Old Adapter Rename"
phase: "Phase 3 - Integration"
lane: "for_review"
dependencies: ["WP01", "WP02", "WP03"]
subtasks:
  - "T015"
  - "T016"
  - "T017"
  - "T018"
assignee: ""
agent: "claude-sonnet-4-6"
shell_pid: "1912"
review_status: ""
reviewed_by: ""
history:
  - timestamp: "2026-03-11T00:00:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
---

# Work Package Prompt: WP04 – AIMAInstance Integration + Old Adapter Rename

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, scroll to Review Feedback section.

---

## Review Feedback

*[Empty initially.]*

---

## Objectives & Success Criteria

Wire the new `PiCodingAgentAdapter` into `AIMAInstance` so users can configure `adapter: 'pi-coding-agent'`. Rename the existing pi-agent-core based adapter from `PiCodingAgentAdapter` to `PiAgentAdapter` (preserving the `'pi-agent'` adapter key). Export the new adapter from `src/index.ts`.

**Success criteria**:
- `adapter: 'pi-coding-agent'` in `AIMAInstanceConfig` creates `PiCodingAgentAdapter` (new)
- `adapter: 'pi-agent'` still creates `PiAgentAdapter` (old pi-agent-core, no functional change)
- `adapter: 'claude-sdk'` unchanged
- `bun run typecheck` zero errors
- `biome check` passes
- Existing test suite (`bun test`) passes without new failures

**Implementation command**:
```bash
spec-kitty implement WP04 --base WP03
```

---

## Context & Constraints

- **Spec**: FR-06 (AIMAInstance integration)
- **Plan**: plan.md WP04 section
- **Constitution**: 向后兼容 — `'pi-agent'` adapter must remain 100% functional
- **Files to read first**:
  - `src/adapters/pi-agent/index.ts` — current `PiCodingAgentAdapter` (will be renamed)
  - `src/instance.ts` — current `AdapterType`, constructor logic
  - `src/index.ts` — current exports

---

## Subtasks & Detailed Guidance

### Subtask T015 — Rename PiCodingAgentAdapter → PiAgentAdapter

**Purpose**: The existing adapter in `src/adapters/pi-agent/index.ts` was misnamed — it wraps pi-agent-core (not pi-coding-agent). Rename the class to avoid confusion.

**Steps**:

1. Read `src/adapters/pi-agent/index.ts` to understand current exports.
2. Find all references to `PiCodingAgentAdapter` in the pi-agent directory:
   ```bash
   grep -n "PiCodingAgentAdapter" src/adapters/pi-agent/index.ts
   ```
3. Rename the class:
   - `class PiCodingAgentAdapter` → `class PiAgentAdapter`
   - `export { PiAgentAdapter }` (or update named export)
   - Also rename `PiCodingAgentAdapterConfig` → `PiAgentAdapterConfig`
4. Find all imports of the old name across the codebase:
   ```bash
   grep -rn "PiCodingAgentAdapter\|PiCodingAgentAdapterConfig" src/ --include="*.ts"
   ```
5. Update `src/instance.ts` import line:
   - Before: `import { PiCodingAgentAdapter } from './adapters/pi-agent/index'`
   - After: `import { PiAgentAdapter } from './adapters/pi-agent/index'`
6. Update usage in `src/instance.ts`:
   - `new PiCodingAgentAdapter(...)` → `new PiAgentAdapter(...)`

**Files**:
- `src/adapters/pi-agent/index.ts`
- `src/instance.ts`

**Notes**:
- The adapter key `'pi-agent'` does NOT change — only the TypeScript class name changes
- Config type rename: `PiCodingAgentAdapterConfig` → `PiAgentAdapterConfig` in the pi-agent file

---

### Subtask T016 — Add 'pi-coding-agent' to AdapterType + Import

**Purpose**: Extend `AdapterType` union to include the new adapter key and import the new class.

**Steps**:

1. In `src/instance.ts`, find:
   ```typescript
   export type AdapterType = 'pi-agent' | 'claude-sdk'
   ```
   Change to:
   ```typescript
   export type AdapterType = 'pi-coding-agent' | 'pi-agent' | 'claude-sdk'
   ```

2. Add import for new adapter (at the top, with other imports):
   ```typescript
   import { PiCodingAgentAdapter } from './adapters/pi-coding-agent/index'
   ```

3. Verify import order follows Biome rules (external packages first, then relative; relative imports in alphabetical/depth order).

**Files**: `src/instance.ts`

---

### Subtask T017 — AIMAInstance 'pi-coding-agent' Creation Branch

**Purpose**: Add the creation branch for the new adapter in `AIMAInstance` constructor.

**Steps**:

1. Read `src/instance.ts` — find the existing `if (config.adapter === 'pi-agent')` block.
2. Add a new branch BEFORE the pi-agent branch (so it's checked first):

```typescript
if (config.adapter === 'pi-coding-agent') {
  const adapter = new PiCodingAgentAdapter({
    modelId: config.brainModels?.limbic ?? 'claude-sonnet-4-6',
    workspace: this.workspace,
    eventBus: this.eventBus,
    amygdala: this.amygdala,
    getApiKey: () => config.apiKey ?? process.env.ANTHROPIC_API_KEY,
  })
  // Register adapter for all brain types (same pattern as pi-agent)
  for (const brain of COGNITIVE_BRAIN_TYPES) {
    this.threadRunner.registerAdapter(brain, adapter)
  }
}
```

3. Verify:
   - `COGNITIVE_BRAIN_TYPES` is the array used by the pi-agent branch
   - `this.amygdala` exists on `AIMAInstance` — read the class to confirm
   - `this.eventBus` is set before this branch (it's a class field initialized in constructor)
   - `PiCodingAgentAdapterConfig` shape matches what WP01/02/03 defined

**Files**: `src/instance.ts`

**Notes**:
- Model ID selection: use `config.brainModels?.limbic` as a sensible default — or use a separate config field if it exists in WP06's spec. For now, limbic model = shared model for all brains in pi-coding-agent adapter.
- If `threadRunner.registerAdapter(brain, adapter)` doesn't exist, find the correct method name by reading `src/runner/index.ts`.

---

### Subtask T018 — src/index.ts Exports + typecheck + biome

**Purpose**: Export the new adapter and config type from the public API surface. Run final quality checks.

**Steps**:

1. Read `src/index.ts` — find the adapters export section.
2. Add exports:
   ```typescript
   export { PiCodingAgentAdapter } from './adapters/pi-coding-agent/index'
   export type { PiCodingAgentAdapterConfig } from './adapters/pi-coding-agent/index'
   ```
3. Also export renamed old adapter (for backward compat if anyone imported it):
   ```typescript
   export { PiAgentAdapter } from './adapters/pi-agent/index'
   export type { PiAgentAdapterConfig } from './adapters/pi-agent/index'
   ```
4. Run typecheck:
   ```bash
   bun run typecheck
   ```
5. Run biome and auto-fix:
   ```bash
   biome check --write src/
   ```
6. Run full test suite:
   ```bash
   bun test
   ```
   All previously passing tests must still pass. New failures = regression.

**Files**: `src/index.ts`

---

## Test Strategy

Run the existing test suite to confirm zero regressions:

```bash
bun test
```

All tests from Feature 001-005 must remain green. The new adapter will be tested in WP05/WP06.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `PiCodingAgentAdapter` used in test files | `grep -rn PiCodingAgentAdapter tests/` to find and update |
| `PiCodingAgentAdapterConfig` type imported externally | Update exports in index.ts; old name may need type alias for compat |
| `COGNITIVE_BRAIN_TYPES` not exported or named differently | Read instance.ts to find correct constant name |
| `threadRunner.registerAdapter` has different signature | Read `src/runner/index.ts` before T017 |
| `this.amygdala` not on AIMAInstance | Check if amygdala is stored as instance field; it should be from Feature 002 |

---

## Definition of Done Checklist

- [ ] T015: `PiCodingAgentAdapter` → `PiAgentAdapter` rename complete in pi-agent/index.ts; instance.ts updated
- [ ] T016: `AdapterType = 'pi-coding-agent' | 'pi-agent' | 'claude-sdk'` in instance.ts; import added
- [ ] T017: `adapter === 'pi-coding-agent'` branch creates `PiCodingAgentAdapter` with workspace/eventBus/amygdala
- [ ] T018: `src/index.ts` exports `PiCodingAgentAdapter`, `PiCodingAgentAdapterConfig`, `PiAgentAdapter`, `PiAgentAdapterConfig`
- [ ] `bun run typecheck` zero errors
- [ ] `biome check` passes
- [ ] `bun test` — zero new test failures vs before this WP

## Review Guidance

1. Verify `adapter: 'pi-agent'` still creates the OLD pi-agent-core based adapter (not the new one)
2. Verify `adapter: 'pi-coding-agent'` creates the NEW pi-coding-agent based adapter
3. Check that `PiAgentAdapter` class is correctly renamed (not just aliased) — no duplicate definitions
4. Verify exports in `src/index.ts` include both old and new adapters with their config types

## Activity Log

- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created.
- 2026-03-11T10:48:37Z – claude-sonnet-4-6 – shell_pid=1912 – lane=doing – Started implementation via workflow command
- 2026-03-11T10:52:44Z – claude-sonnet-4-6 – shell_pid=1912 – lane=for_review – Ready for review: renamed PiCodingAgentAdapter→PiAgentAdapter in pi-agent/, added 'pi-coding-agent' AdapterType + PiCodingAgentAdapter wiring in instance.ts, updated exports and unit test. All 229 tests pass.
