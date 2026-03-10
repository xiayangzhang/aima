---
work_package_id: "WP01"
title: "包初始化 + 工具链"
phase: "Phase 1 - Foundation"
lane: "planned"
assignee: ""
agent: ""
shell_pid: ""
review_status: ""
reviewed_by: ""
subtasks:
  - "T001"
  - "T002"
  - "T003"
  - "T004"
  - "T005"
  - "T006"
dependencies: []
history:
  - timestamp: "2026-03-10T00:00:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
---

# Work Package Prompt: WP01 — 包初始化 + 工具链

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, read Review Feedback section first.

---

## Review Feedback

*[Empty — no feedback yet]*

---

## Objectives & Success Criteria

建立可运行的 `@aima/core` 包骨架。完成标准：
- `bun install` 无报错
- `bun run typecheck` 零错误
- `biome check .` 通过（无 lint 错误）
- 目录结构与 plan.md 完全一致

## Context & Constraints

- **Repo**: `/Volumes/leoyun/aima/`
- **Plan**: `kitty-specs/001-aima-core-workspace-schema/plan.md`
- **CLAUDE.md**: Runtime = Bun v1.x，TypeScript strict，ESM-only，Biome，tsup
- **无依赖**：这是起点 WP

实现命令：`spec-kitty implement WP01`

---

## Subtasks & Detailed Guidance

### T001 — 创建 package.json

**Purpose**: 声明包名、版本、依赖、scripts，建立 Bun 工作环境。

**Steps**:
1. 在 `/Volumes/leoyun/aima/` 创建 `package.json`：

```json
{
  "name": "@aima/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "test": "bun test",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:all": "bun test && vitest run --config vitest.integration.config.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "drizzle-orm": "^0.38.0",
    "postgres": "^3.4.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/bun": "latest",
    "drizzle-kit": "^0.30.0",
    "tsup": "^8.3.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

2. 运行 `bun install` 验证所有依赖安装成功。

**Files**: `/Volumes/leoyun/aima/package.json`

---

### T002 — 创建 tsconfig.json

**Purpose**: TypeScript 严格模式 + ESM + NodeNext 模块解析（Bun 兼容）。

**Steps**:
1. 创建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": false,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Files**: `/Volumes/leoyun/aima/tsconfig.json`

---

### T003 — 创建 biome.json

**Purpose**: Lint + 格式化配置，替代 ESLint + Prettier。

**Steps**:
1. 创建 `biome.json`：

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error"
      },
      "suspicious": {
        "noExplicitAny": "error"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "asNeeded"
    }
  },
  "files": {
    "ignore": ["dist/", "node_modules/", "drizzle/migrations/"]
  }
}
```

2. 运行 `biome check .` 验证（目前只有空目录，应无错误）。

**Files**: `/Volumes/leoyun/aima/biome.json`

---

### T004 — 创建 drizzle.config.ts

**Purpose**: Drizzle Kit 需要此文件来知道 schema 位置和数据库连接。

**Steps**:
1. 创建 `drizzle.config.ts`：

```typescript
import type { Config } from 'drizzle-kit'

export default {
  schema: './src/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
} satisfies Config
```

**Files**: `/Volumes/leoyun/aima/drizzle.config.ts`

---

### T005 — 创建 vitest.integration.config.ts

**Purpose**: 集成测试（真实 PostgreSQL）专用配置，与 bun test 单元测试隔离。

**Steps**:
1. 创建 `vitest.integration.config.ts`：

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }, // 避免多 worker 并发连接问题
    },
  },
})
```

**Files**: `/Volumes/leoyun/aima/vitest.integration.config.ts`

---

### T006 — 建立目录骨架

**Purpose**: 预建目录结构，避免后续 WP 创建文件时路径不存在。

**Steps**:
1. 创建以下目录（用 `.gitkeep` 占位）：

```bash
mkdir -p src/types src/schema src/workspace
mkdir -p tests/unit/workspace tests/integration/workspace
mkdir -p drizzle/migrations
touch src/types/.gitkeep src/schema/.gitkeep src/workspace/.gitkeep
touch tests/unit/workspace/.gitkeep tests/integration/workspace/.gitkeep
touch drizzle/migrations/.gitkeep
```

2. 创建空的 `src/index.ts`（WP08 填充内容）：
```typescript
// Public exports — populated in WP08
```

**Files**: 目录结构，`src/index.ts`

---

## Risks & Mitigations

- **版本冲突**: drizzle-orm 和 drizzle-kit 版本需配套（都用 0.38.x 系列）
- **Bun types**: `@types/bun` 已包含，不需要额外安装 `@types/node`

## Definition of Done Checklist

- [ ] T001: `bun install` 成功，`bun.lockb` 生成
- [ ] T002: `bun run typecheck` 零错误（目前 src/ 为空，应直接通过）
- [ ] T003: `biome check .` 通过
- [ ] T004: `drizzle.config.ts` 存在，语法正确
- [ ] T005: `vitest.integration.config.ts` 存在，语法正确
- [ ] T006: 所有目录已创建，`src/index.ts` 存在

## Review Guidance

- 检查 `package.json` 的 `exports` 字段是否正确（import/require/types 三路径）
- 检查 `tsconfig.json` 是否包含 `noUncheckedIndexedAccess: true`（防止数组越界无类型检查）
- 检查 `biome.json` 是否禁用了 `noExplicitAny`

## Activity Log

- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
