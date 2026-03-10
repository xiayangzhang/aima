---
work_package_id: WP08
title: 公共 API 导出 + 构建验证
lane: planned
dependencies: []
subtasks:
- T035
- T036
- T037
- T038
phase: Phase 3 - Verification
assignee: ''
agent: ''
shell_pid: ''
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-10T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP08 — 公共 API 导出 + 构建验证

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, read Review Feedback section first.

---

## Review Feedback

*[Empty — no feedback yet]*

---

## Objectives & Success Criteria

`src/index.ts` 导出所有公共 API，tsup 构建成功，包可作为库被外部 import。完成标准：
- `bun run build` 成功，零错误
- `bun run typecheck` 零错误
- `dist/` 包含 `index.js`（ESM）、`index.cjs`（CJS）、`index.d.ts`（类型声明）
- Drizzle schema 内部对象（表定义、pgEnum）不在公共导出中
- 外部项目可以 `import { CognitiveWorkspace, type ICognitiveWorkspace } from '@aima/core'` 编译无误

## Context & Constraints

- **Repo**: `/Volumes/leoyun/aima/`
- **tsup 版本**: ^8.3.0，支持 ESM + CJS 双输出
- **package.json exports**: 已在 WP01 T001 中配置（`import: ./dist/index.js`，`require: ./dist/index.cjs`，`types: ./dist/index.d.ts`）
- **公共 API 边界**: 只导出业务层（CognitiveWorkspace class、ICognitiveWorkspace 接口、所有公共类型）；不导出 schema 层（Drizzle 表对象、pgEnum）

实现命令：`spec-kitty implement WP08 --base WP06`

---

## Subtasks & Detailed Guidance

### T035 — `src/index.ts` 公共导出

**Purpose**: 填充公共入口文件，声明所有外部调用方可以依赖的 API。

**Steps**:
1. WP01 T006 创建了空的 `src/index.ts`（注释占位）。现在填充内容：

```typescript
// Public API for @aima/core
// Populated in WP08

// ─── Primary Class ────────────────────────────────────────────────────────────
export { CognitiveWorkspace } from './workspace/index.js'
export type { DrizzleDB, CognitiveWorkspaceOptions } from './workspace/index.js'

// ─── Public Types ─────────────────────────────────────────────────────────────
export type {
  // Enums
  BrainType,
  CognitiveBrainType,
  ThreadState,
  SlotStatus,
  Intent,
  ComplexityHint,
  MemoryType,
  UsageOutcome,

  // Entity interfaces (return types from DAO methods)
  Thread,
  Slot,
  MemoryEntry,
  PendingObservation,
  UsageOutcomes,

  // Input params (arguments to DAO methods)
  CreateThreadParams,
  WriteSlotParams,
  CreateMemoryParams,
  MemorySearchFilters,
  CreatePendingParams,

  // Primary interface (for dependency inversion)
  ICognitiveWorkspace,
} from './types/index.js'
```

**设计说明**:
- `CognitiveWorkspace` 是 class（值），用 `export { ... }`（非 `export type`）
- 所有接口和类型用 `export type { ... }`（type-only export）
- `DrizzleDB` 导出：调用方需要构造 `CognitiveWorkspace` 实例时需要知道这个类型
- **不导出**: `src/schema/` 的任何内容（表对象、pgEnum、Row 类型）

**Files**: `src/index.ts`（修改，填充内容）

---

### T036 — 验证无内部实现细节泄漏

**Purpose**: 审查 `src/index.ts` 的导出列表，确认没有意外暴露内部实现。

**Steps**:
1. 逐行检查 `src/index.ts` 的导出：
   - ✅ 允许导出：`CognitiveWorkspace`（class）、所有 `ICognitiveWorkspace` 方法涉及的类型、`DrizzleDB` 类型
   - ❌ 不允许导出：`threads`、`slots`、`memories`、`pendingObservations`（Drizzle 表对象）
   - ❌ 不允许导出：`threadStateEnum`、`brainTypeEnum`、`slotStatusEnum`、`memoryTypeEnum`（pgEnum 对象）
   - ❌ 不允许导出：`ThreadRow`、`SlotRow`、`MemoryRow`、`NewThreadRow` 等（Drizzle 推断类型）

2. 运行泄漏检查（在项目根目录）：
```bash
# 确认 schema 对象未被导出
node -e "import('./dist/index.js').then(m => {
  const leaked = ['threads', 'slots', 'memories', 'pendingObservations', 'threadStateEnum'];
  leaked.forEach(k => {
    if (k in m) console.error('LEAK:', k);
    else console.log('OK:', k, 'not exported');
  });
})"
```

**Files**: 只做 review，不修改文件（如发现泄漏则修改 `src/index.ts`）

---

### T037 — `tsup.config.ts`

**Purpose**: 配置 tsup 构建，生成 ESM + CJS 双输出，含类型声明和 sourcemap。

**Steps**:
1. 创建 `tsup.config.ts`：

```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,           // 生成 .d.ts 类型声明
  sourcemap: true,     // 生成 sourcemap
  clean: true,         // 构建前清空 dist/
  splitting: false,    // 不拆分 chunk（单个库，保持简单）
  treeshake: true,     // 移除未使用的代码
  outDir: 'dist',
  // tsup 自动读取 tsconfig.json 的 compilerOptions
})
```

2. 验证 `package.json` 的 `exports` 字段（WP01 T001 已配置，但此处再次确认）：
```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  }
}
```

**Files**: `tsup.config.ts`（新建）

---

### T038 — 构建 + typecheck 验证

**Purpose**: 运行完整构建流程，验证零错误，检查 dist/ 输出。

**Steps**:
1. 运行完整验证序列：

```bash
cd /Volumes/leoyun/aima

# 1. 类型检查（不生成文件）
bun run typecheck

# 2. Lint 检查
biome check .

# 3. 构建
bun run build

# 4. 验证 dist/ 内容
ls -la dist/
# 预期：index.js, index.cjs, index.d.ts, index.js.map, index.cjs.map
```

2. 验证 dist/ 文件内容：
```bash
# 确认 ESM 文件是 module 格式
head -5 dist/index.js   # 应有 import/export 语句

# 确认 CJS 文件是 CommonJS 格式
head -5 dist/index.cjs  # 应有 require/exports 语句

# 确认类型声明存在
head -20 dist/index.d.ts  # 应有 export declare class CognitiveWorkspace
```

3. 如果 biome lint 报错（比如 `noUnusedVariables` 在 workspace 实现文件中），根据报错修复：
   - 参数前缀 `_`（如 `_params`）用于标记有意不使用的参数
   - 确认所有 import 都被使用

4. 如果 tsup 构建报 CJS/ESM 混用问题：
   - 确认 `src/index.ts` 所有 import 都有 `.js` 扩展名（ESM strict）
   - 确认 `package.json` 有 `"type": "module"`

**预期构建时间**: < 5 秒（单个文件，无复杂依赖）

**Files**: 只运行命令，验证输出

---

## Risks & Mitigations

- **CJS/ESM 双输出兼容性**: `postgres` 驱动是纯 ESM 包。tsup 的 CJS 输出在 Node.js 中使用时，`require('@aima/core')` 内部会动态 `import('postgres')`，这在现代 Node.js (v22+) 中支持，但在旧版本可能有问题。如果出现问题，考虑只输出 ESM（移除 `cjs` from format array）。
- **类型声明路径**: `dts: true` 会把 `dist/index.d.ts` 放在正确位置。确认 `package.json` 的 `types` 字段指向此文件。

## Definition of Done Checklist

- [ ] T035: `src/index.ts` 导出 `CognitiveWorkspace`、`ICognitiveWorkspace`、所有公共类型
- [ ] T036: 确认 schema 对象（表定义、pgEnum）未出现在 `dist/index.js` 的导出中
- [ ] T037: `tsup.config.ts` 配置 ESM + CJS + dts + sourcemap + treeshake
- [ ] T038: `bun run build` 成功，`dist/` 包含 index.js / index.cjs / index.d.ts，`bun run typecheck` 零错误

## Review Guidance

- 检查 `src/index.ts` 是否用 `export type` 导出接口（不是 `export`）——避免值空间污染
- 检查 tsup `splitting: false`——单个库文件，不需要 code splitting
- 检查 `biome check .` 是否通过（包括 dist/ 目录已在 biome.json 的 ignore 中）
- 验证 `dist/index.d.ts` 中有 `export declare class CognitiveWorkspace`（类型声明正确）

## Activity Log

- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
