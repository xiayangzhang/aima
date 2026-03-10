# Implementation Plan: AIMA Core — Workspace & Schema

**Branch**: `001-aima-core-workspace-schema` | **Date**: 2026-03-10 | **Spec**: [spec.md](./spec.md)

---

## Summary

建立 `@aima/core` 包的数据基础层：Drizzle ORM schema（4 张表）、CognitiveWorkspace DAO 类，以及完整的单元 + 集成测试。`pending_observations` 采用独立表而非 JSONB 字段，消除并发热点，使用 advisory lock 序列化写入。

---

## Technical Context

**Language/Version**: TypeScript 5.7+, strict mode, ESM-only
**Runtime**: Bun v1.x
**Primary Dependencies**: drizzle-orm, drizzle-kit, postgres (porsager driver), vitest
**Linting/Formatting**: Biome
**Build**: tsup (ESM + CJS dual output)
**Storage**: PostgreSQL 16+ — 4 tables: `threads`, `slots`, `memories`, `pending_observations`
**Testing**: bun test (unit, no DB) + vitest (integration, real PostgreSQL via `AIMA_TEST_DATABASE_URL`)
**Target Platform**: Node.js 20+ / Bun 1.x 兼容 library
**Constraints**: 无 `any`，无 default exports，TypeScript strict，集成测试用事务回滚隔离
**Key Decision**: `pending_observations` 独立表 + advisory lock，不用 JSONB 字段

---

## Constitution Check

- ✅ 单包结构 (`@aima/core`)
- ✅ 无过度抽象——CognitiveWorkspace 直接包装 Drizzle，无 Repository 层
- ✅ 无 `any`，TypeScript strict
- ✅ 类型权威来源单一：`src/types/index.ts`
- ✅ 测试覆盖率目标 ≥ 80%

---

## Project Structure

### Documentation (this feature)

```
kitty-specs/001-aima-core-workspace-schema/
├── plan.md              ← 本文件
├── research.md          ← Phase 0 技术决策记录
├── data-model.md        ← Phase 1 数据模型详细设计
├── quickstart.md        ← 开发环境启动指南
├── contracts/
│   └── workspace.ts     ← CognitiveWorkspace TypeScript 接口定义
└── tasks.md             ← /spec-kitty.tasks 生成（本命令不创建）
```

### Source Code

```
src/
  types/
    index.ts             ← 全部核心枚举和接口（单一权威来源）
  schema/
    threads.ts           ← threads 表 Drizzle 定义
    slots.ts             ← slots 表 Drizzle 定义
    memories.ts          ← memories 表 Drizzle 定义
    pending.ts           ← pending_observations 表 Drizzle 定义
    index.ts             ← re-export 所有表
  workspace/
    index.ts             ← CognitiveWorkspace class（主入口）
    pending.ts           ← pending 专属操作（含 advisory lock 并发保护）
    memory.ts            ← memory 专属操作
  index.ts               ← 包公共导出

tests/
  unit/
    workspace/           ← 纯逻辑测试（mock DB，bun test）
  integration/
    workspace/           ← 真实 PostgreSQL 测试（vitest）

drizzle/
  migrations/            ← drizzle-kit generate 输出，不手动编辑

biome.json
drizzle.config.ts
package.json
tsconfig.json
```

---

## Work Package Breakdown

| WP | 标题 | 依赖 | 可并行 |
|---|---|---|---|
| WP01 | 包初始化 + 工具链 | — | 否（基础） |
| WP02 | 核心类型定义 | WP01 | 否（被所有后续 WP 依赖） |
| WP03 | Drizzle Schema + Migration | WP02 | 否（被 WP04-06 依赖） |
| WP04 | CognitiveWorkspace — Thread & Slot | WP03 | ✅ 可与 WP05/06 并行 |
| WP05 | CognitiveWorkspace — Pending Observations | WP03 | ✅ 可与 WP04/06 并行 |
| WP06 | CognitiveWorkspace — Memory | WP03 | ✅ 可与 WP04/05 并行 |
| WP07 | 集成测试套件 | WP04-06 | 否（依赖全部 DAO） |
| WP08 | 公共 API 导出 + 构建验证 | WP04-06 | 否（最终整合） |

---

## Key Design Decisions

### pending_observations 并发保护

读路径无锁。写路径使用 PostgreSQL advisory lock 序列化：

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('aima_pending_write'));
-- 查当前行数，超限则按 base_importance ASC, added_at ASC 淘汰最低优先级条目
-- INSERT 新条目
COMMIT;
```

Advisory lock 随事务自动释放，无需手动 unlock。

### supersedes_id 原子失效

`writeMemory` 在同一事务内完成两步：
1. INSERT 新记忆条目
2. `UPDATE memories SET t_invalid = now() WHERE id = supersedes_id`

### updated_at 维护策略

不用数据库触发器。所有 UPDATE 操作由 CognitiveWorkspace 方法显式设置 `updated_at: new Date()`，保持 schema 简单。

### 集成测试隔离

```typescript
beforeEach(() => db.execute(sql`BEGIN`))
afterEach(() => db.execute(sql`ROLLBACK`))
```

每个测试用例在事务内运行，afterEach 回滚，无状态污染，无需清空表。
