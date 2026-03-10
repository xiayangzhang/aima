# AIMA Project Rules

## What is AIMA

**AIMA** = Artificial Intelligence: A Minded Architecture

An open-source framework for building autonomous cognitive agents with a five-brain functional architecture (Limbic / Cortex / Brainstem / Amygdala / DMN).

---

## Language Convention
- All code, comments, variable names, API identifiers: **English**
- All documentation (`docs/`, `research/`): **Chinese (中文)**
- Git commit messages: **English**

---

## First Principles
Apply in order before adding anything:
1. **Question the requirement** — does this need to exist?
2. **Delete** — remove before adding
3. **Simplify** — only after deleting
4. **Accelerate** — speed up what remains
5. **Automate** — last step only

---

## Strategic Positioning

**AIMA is a cognitive superset of pi-coding-agent.** It replaces the single Agent loop with five brain-area functional clusters, gaining behavior-consciousness separation, autonomy, and full observability.

**@aima/crew** is the OpenClaw compatibility bridge — it lets OpenClaw projects swap their Agent engine for AIMA without changing anything else.

---

## Architecture Principles
- Five brains are fixed core: Limbic / Cortex / Brainstem / Amygdala / DMN
- Loop is infrastructure — no business logic inside the loop
- Cognition layer = Skill (Markdown), not code
- Brain Event Bus is the only audit interface
- Cognitive Workspace (Thread + Slot) is the coordination primitive

---

## Technology Stack

### Runtime & Package Manager
- **Bun v1.x** — runtime and package manager
  - Native TypeScript execution, no transpile step in dev
  - `bun install` for dependencies, `bun run` for scripts
  - `bun test` for unit tests

### Language
- **TypeScript 5.7+**, `strict: true`
- ESM-only (`"type": "module"` in package.json)
- No `any`. No non-null assertions (`!`) except where the absence of null is structurally provable.

### Database
- **PostgreSQL 16+**
- **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`) — schema-first, TypeScript-native, no magic
- **`postgres` driver** (porsager/postgres) — modern, connection-pooling built-in, Drizzle-recommended
- Migrations via `drizzle-kit generate` + `drizzle-kit migrate`

### Testing
- **`bun test`** — unit tests (zero config, co-located or in `tests/unit/`)
- **`vitest`** — integration tests requiring real PostgreSQL (`tests/integration/`)
  - Separate runner for DB-dependent tests to keep unit suite fast
  - Test isolation: transaction rollback per test (`BEGIN` / `ROLLBACK`)
  - Env var: `AIMA_TEST_DATABASE_URL`

### Linting & Formatting
- **Biome** — single tool replacing ESLint + Prettier
  - `biome check --write` in pre-commit (via Bun's lifecycle hooks)
  - Config: `biome.json` at repo root

### Build (library output)
- **tsup** — dual ESM + CJS output for library consumers
  - Input: `src/index.ts`
  - Output: `dist/` (ESM: `index.js`, CJS: `index.cjs`, types: `index.d.ts`)

---

## Package Structure

Single package: `@aima/core`

```
src/
  types/              — 所有公共类型定义（枚举、接口）的单一来源
  schema/             — Drizzle schema（表定义，不含业务逻辑）
  workspace/          — CognitiveWorkspace class（Thread/Slot/Pending DAO）
  hippocampus/        — Hippocampus Encoding + Recall + Consolidation（Feature 002+）
  event-bus/          — Brain Event Bus（Feature 002+）
  thread-runner/      — Thread Runner 路由核心（Feature 003+）
  adapters/           — BrainAdapter 接口 + 适配器（Feature 003+）
  index.ts            — 公共导出入口（re-export all public API）

tests/
  unit/               — 纯函数测试，不依赖数据库
  integration/        — 需要真实 PostgreSQL 的测试

drizzle/
  migrations/         — drizzle-kit 生成的迁移文件（不手动编辑）

biome.json
bun.lock
drizzle.config.ts
package.json
tsconfig.json
```

**规则**：
- `src/types/` 是所有类型的权威来源，其他模块只从这里导入，不重复定义
- 每个模块目录有自己的 `index.ts` 用于内部 barrel export
- 跨模块的类型依赖方向：`types` ← `schema` ← `workspace` ← 上层模块（单向）

---

## Core Type Definitions

所有核心枚举和接口定义在 `src/types/index.ts`，其他文件从此导入。

```typescript
// 脑区标识（Event Bus 字段标注用）
type BrainType = 'limbic' | 'cortex' | 'brainstem' | 'amygdala' | 'dmn'

// BrainAdapter 实例化用（仅认知脑区）
type CognitiveBrainType = 'limbic' | 'cortex' | 'brainstem'

// Thread 状态机
type ThreadState = 'active' | 'waiting' | 'complete' | 'interrupted'

// Slot 执行状态
type SlotStatus = 'pending' | 'running' | 'done' | 'error'

// 记忆类型
type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'working' | 'implicit'

// Cortex 路由决策
type Intent = 'communicate' | 'execute' | 'both'

// Cortex 给 Brainstem 的执行复杂度提示（可选）
type ComplexityHint = 'simple' | 'complex'

// Brain Event Bus 事件级别
type EventLevel = 'debug' | 'info' | 'compliance' | 'alert' | 'critical'

// 工具风险等级
type RiskLevel = 'low' | 'medium' | 'high'

// Skill 类型
type SkillType = 'reference' | 'adapted' | 'first-party'

// 记忆使用结果反馈
type UsageOutcome = 'positive' | 'negative' | 'neutral'
```

---

## Database Conventions

### Schema 约定
- 主键：`id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- 时间戳：所有表必须有 `created_at timestamptz NOT NULL DEFAULT now()`
- 更新时间：可变表必须有 `updated_at timestamptz NOT NULL DEFAULT now()`（应用层负责更新，不用触发器）
- 枚举：通过 Drizzle `pgEnum` 定义，对应 `src/types/` 中的 TypeScript 类型
- JSONB：用于 `input`、`output`、`usage_outcomes` 等结构不固定或为空的字段
- 外键：显式声明，带 `ON DELETE CASCADE` 或 `ON DELETE RESTRICT`（按语义选择）

### 事务约定
- 写入操作默认不自动开启事务，调用方负责事务边界
- 需要跨表原子性的操作（如 `supersedes_id` 软删除）必须显式使用 `db.transaction()`
- `pending_observations` 并发写：调用方必须在事务内使用 SELECT FOR UPDATE 锁定 workspace 行

### 迁移约定
- 只通过 `drizzle-kit generate` 生成迁移文件，**不手动编辑** `drizzle/migrations/`
- Schema 修改只在 `src/schema/` 中进行，然后重新生成

---

## Testing Strategy

### 单元测试（`bun test`）
- 测试纯函数和类方法的逻辑，不依赖真实 DB
- 文件命名：`*.test.ts`，与被测文件同目录或在 `tests/unit/`
- Mock 数据库依赖（注入 mock `CognitiveWorkspace`）

### 集成测试（`vitest`）
- 测试 DAO 层、并发行为、事务正确性
- 使用真实 PostgreSQL，通过 `AIMA_TEST_DATABASE_URL` 指定
- 每个测试用 `BEGIN` + `ROLLBACK` 隔离，不依赖测试间顺序
- 并发测试（如 pending_observations 写锁）是集成测试的核心场景

### 覆盖率目标
- `CognitiveWorkspace` 所有 public 方法：≥ 80%
- 核心类型转换函数：100%

---

## Export Conventions

- **Named exports only** — no default exports
- 所有公共 API 从 `src/index.ts` re-export
- 内部实现细节不导出（`src/schema/` 的 Drizzle table 对象是内部细节，不从 `index.ts` 导出）
- 类型与实现分离：`export type { BrainType }` 用于纯类型导出

---

## Error Handling

- 数据库错误：在 DAO 层 catch，包装为 domain error（如 `WorkspaceError`），向上抛出
- 不静默失败——所有错误必须向调用方传递
- 外键违反、枚举值非法等约束错误视为调用方 bug，直接抛出，不做业务兜底

---

## Git / Spec-Kitty Rules

- **Never commit directly to `main`.** All work happens in a feature worktree.
- **Spec must reach `approved` status before merge.**
- One Feature = one worktree (`spec-kitty implement WP##`)
- Before any `git push`: confirm GitHub account with Leo

---

## Open Source Guidelines
- Public API surface must be stable and well-documented before tagging releases
- Core framework is provider-agnostic; official adapters provided for pi-agent-core and Claude Agent SDK
- Breaking changes require major version bump
- `docs/`, `research/`, `scripts/` 是 local-only（`.gitignore`），不进入 tracking
