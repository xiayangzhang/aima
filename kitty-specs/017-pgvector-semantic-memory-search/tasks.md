# Tasks: pgvector Semantic Memory Search (Feature 017)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-03-12

## Subtask Index

| ID | Description | WP | Status |
|---|---|---|---|
| T001 | `bun add openai`，更新 package.json | WP01 | planned |
| T002 | 创建 `src/embedding.ts`：`EmbeddingConfig` + `generateEmbedding()` | WP01 | planned |
| T003 | 更新 `src/schema/memories.ts`：新增 `vector` 列 + HNSW 索引 | WP01 | planned |
| T004 | 创建迁移文件 `drizzle/migrations/0004_vector_embedding.sql` | WP01 | planned |
| T005 | `CognitiveWorkspaceConfig` 新增 `embedding?: EmbeddingConfig` | WP01 | planned |
| T006 | workspace 新增 `generateAndStoreEmbedding()` 私有方法，集成到 `writeMemory()` | WP02 | planned |
| T007 | 升级 `findSimilarSituations()`：向量优先 + ILIKE fallback | WP02 | planned |
| T008 | 升级 `getProcedure()`：同 T007 模式 | WP02 | planned |
| T009 | 单元测试 V1-V7 | WP02 | planned |

---

## Phase 1 — Infrastructure

### WP01 — Embedding Infrastructure

**File**: [tasks/WP01-embedding-infrastructure.md](tasks/WP01-embedding-infrastructure.md)
**Priority**: P1 | **Estimated prompt size**: ~300 lines
**Dependencies**: 无

**Goal**: 建立 pgvector 嵌入基础设施——新增 openai 依赖、embedding 服务模块、DB schema 变更、迁移文件、config 类型扩展。

**Subtasks**:
- [x] T001 — `bun add openai`
- [x] T002 — `src/embedding.ts` 实现
- [x] T003 — schema 变更（vector 列 + HNSW 索引）
- [x] T004 — 迁移文件创建
- [x] T005 — `CognitiveWorkspaceConfig.embedding` 字段

**Independent test**:
```bash
cd /Volumes/leoyun/aima && bun build src/embedding.ts  # 确认编译无误
bun test  # 零回归
```

---

## Phase 2 — Workspace Integration

### WP02 — Workspace Vector Integration

**File**: [tasks/WP02-workspace-vector-integration.md](tasks/WP02-workspace-vector-integration.md)
**Priority**: P1 | **Estimated prompt size**: ~350 lines
**Dependencies**: WP01

**Goal**: 将 embedding 基础设施集成到 CognitiveWorkspace——writeMemory fire-and-forget embedding 生成，findSimilarSituations 和 getProcedure 向量优先检索，单元测试。

**Subtasks**:
- [x] T006 — `generateAndStoreEmbedding()` + `writeMemory()` 集成
- [x] T007 — `findSimilarSituations()` 向量升级
- [ ] T008 — `getProcedure()` 向量升级
- [ ] T009 — 单元测试 V1-V7

**Independent test**:
```bash
cd /Volumes/leoyun/aima && bun test tests/unit/workspace/
bun test
```

---

## Definition of Done

- [ ] WP01 lane = done
- [ ] WP02 lane = done
- [ ] `bun test` 全量零回归
