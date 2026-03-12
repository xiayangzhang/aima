---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
  - "T003"
  - "T004"
  - "T005"
title: "Embedding Infrastructure"
phase: "Phase 1 - Infrastructure"
lane: "planned"
assignee: ""
agent: ""
shell_pid: ""
review_status: ""
dependencies: []
history:
  - timestamp: "2026-03-12T12:00:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt created."
---

# Work Package Prompt: WP01 — Embedding Infrastructure

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` field. If `has_feedback`, scroll to Review Feedback section.
- **Mark as acknowledged**: Update `review_status: acknowledged` when you begin addressing feedback.

---

## Review Feedback

*[Empty initially — reviewers populate if work is returned.]*

---

## Objectives & Success Criteria

建立 pgvector 嵌入基础设施：OpenAI embedding 服务模块、DB schema 向量列、Drizzle 迁移文件、`CognitiveWorkspaceConfig` 扩展。完成后：

- `src/embedding.ts` 导出 `EmbeddingConfig` 接口和 `generateEmbedding()` 函数
- `memories` 表有 `embedding vector(1536)` 列（nullable）
- 迁移文件可运行 `bun run db:migrate` 应用
- `CognitiveWorkspaceConfig` 有 `embedding?: EmbeddingConfig` 字段
- `bun build src/embedding.ts` 无编译错误
- 全量测试零回归

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/017-pgvector-semantic-memory-search/spec.md`
- **Plan**: `kitty-specs/017-pgvector-semantic-memory-search/plan.md`
- **Research**: `kitty-specs/017-pgvector-semantic-memory-search/research.md` — 含完整实现代码草稿
- **Target files**:
  - `src/embedding.ts`（新建）
  - `src/schema/memories.ts`（修改）
  - `src/types/index.ts`（修改 `CognitiveWorkspaceConfig`）
  - `drizzle/migrations/0004_vector_embedding.sql`（新建）
  - `package.json`（`bun add openai`）
- **Key dependency**: `drizzle-orm` v0.38.4 已原生支持 `vector` 类型，从 `drizzle-orm/pg-core` 导入
- **Constraints**:
  - `MemoryEntry` 公共类型**不变**（embedding 不暴露到外部）
  - 迁移文件手动创建（Drizzle Kit 不处理 `CREATE EXTENSION`）

---

## Subtask Details

### T001 — 新增 openai 依赖

**Purpose**: text-embedding-3-small 调用需要 openai SDK。

**Steps**:
```bash
cd /Volumes/leoyun/aima
bun add openai
```

验证 `package.json` 的 `dependencies` 包含 `"openai": "^..."`.

**Files**:
- `package.json` — 新增 openai 依赖
- `bun.lockb` — 更新

---

### T002 — 创建 `src/embedding.ts`

**Purpose**: 嵌入服务，镜像 `src/llm.ts` 的接口风格，统一为 fire-and-forget 或直接调用提供接口。

**Steps**:

创建 `src/embedding.ts`：

```typescript
import OpenAI from 'openai'

export interface EmbeddingConfig {
  /** 如不设置，读 process.env.OPENAI_API_KEY */
  apiKey?: string
  /** 默认：'text-embedding-3-small' */
  model?: string
  /** 默认：1536（与 vector 列维度一致） */
  dimensions?: number
}

/**
 * 生成文本的嵌入向量（number[]）。
 * 使用 OpenAI text-embedding-3-small，返回 1536 维 float 数组。
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig = {},
): Promise<number[]> {
  const client = new OpenAI({
    apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
  })
  const response = await client.embeddings.create({
    model: config.model ?? 'text-embedding-3-small',
    input: text,
    encoding_format: 'float',
  })
  return response.data[0].embedding
}
```

**Validation**:
- [ ] 文件存在于 `src/embedding.ts`
- [ ] 导出 `EmbeddingConfig` 和 `generateEmbedding`
- [ ] TypeScript 无编译错误

---

### T003 — 更新 `src/schema/memories.ts`

**Purpose**: 在 memories 表添加 vector 列和 HNSW 索引定义，供 Drizzle ORM 管理。

**Steps**:

1. 在文件顶部 imports 中添加 `vector` 和 `index`（`index` 可能已导入）：

```typescript
import {
  // ... 现有导入 ...
  vector,   // ← 新增
} from 'drizzle-orm/pg-core'
```

2. 在 `memories` 表的列定义中，**在最后一个现有列之后**添加：

```typescript
embedding: vector('embedding', { dimensions: 1536 }),
```

3. 在 `(table) => ({...})` 的 indexes callback 中添加：

```typescript
embeddingHnswIdx: index('idx_memories_embedding_hnsw')
  .using('hnsw', table.embedding as any)
  .with({ m: 16, ef_construction: 64 }),
```

> 注：`as any` 是因为 Drizzle 的 HNSW index 类型推断可能报错，实际运行正常。

**Files**:
- `src/schema/memories.ts`

**Validation**:
- [ ] `embedding` 列存在，类型为 `vector(1536)`，nullable（无 `.notNull()`）
- [ ] HNSW index 定义存在于 indexes callback
- [ ] TypeScript 无编译错误

---

### T004 — 创建迁移文件

**Purpose**: pgvector extension + ALTER TABLE + index，一次性应用到数据库。

**Steps**:

1. 检查 `drizzle/migrations/` 目录，确认最新迁移编号（通常是 `0003_*.sql`），新建 `drizzle/migrations/0004_vector_embedding.sql`：

```sql
-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to memories table
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

-- Create HNSW index for cosine similarity search
-- Note: requires pgvector >= 0.5.0
CREATE INDEX IF NOT EXISTS "idx_memories_embedding_hnsw"
  ON "memories" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

2. 同时更新 Drizzle migrations journal。检查 `drizzle/migrations/meta/_journal.json`，添加新条目：

```json
{
  "idx": 4,
  "version": "7",
  "when": 1741737600000,
  "tag": "0004_vector_embedding",
  "breakpoints": true
}
```

> 注：`when` 字段为 Unix timestamp（毫秒），使用当前时间即可。`version` 和结构参考已有条目的格式。

**Files**:
- `drizzle/migrations/0004_vector_embedding.sql`（新建）
- `drizzle/migrations/meta/_journal.json`（更新）

**Validation**:
- [ ] SQL 文件存在
- [ ] `CREATE EXTENSION IF NOT EXISTS vector` 存在
- [ ] `ALTER TABLE` 和 `CREATE INDEX` 存在
- [ ] journal 更新完毕

---

### T005 — 扩展 `CognitiveWorkspaceConfig`

**Purpose**: 使 workspace 可接受 embedding 配置，下游 WP02 使用。

**Steps**:

在 `src/types/index.ts` 找到 `CognitiveWorkspaceConfig` 接口，新增字段：

```typescript
import type { EmbeddingConfig } from '../embedding'

export interface CognitiveWorkspaceConfig {
  // ... 现有字段（db, eventBus 等） ...
  /**
   * Embedding config for semantic memory search.
   * If not set, embedding generation is disabled and all searches fall back to ILIKE.
   */
  embedding?: EmbeddingConfig
}
```

> 注：如果 `src/types/index.ts` 中没有 `CognitiveWorkspaceConfig`，在 `src/workspace/index.ts` 找到它并在那里添加字段 + import。

**Files**:
- `src/types/index.ts` 或 `src/workspace/index.ts`（取决于接口定义位置）

**Validation**:
- [ ] `CognitiveWorkspaceConfig` 有 `embedding?: EmbeddingConfig` 字段
- [ ] import 路径正确
- [ ] TypeScript 无编译错误

---

## Definition of Done

- [ ] T001: `package.json` 含 openai 依赖，`bun install` 成功
- [ ] T002: `src/embedding.ts` 存在，`EmbeddingConfig` + `generateEmbedding` 导出正确
- [ ] T003: `src/schema/memories.ts` 含 `embedding vector(1536)` 列 + HNSW 索引
- [ ] T004: `drizzle/migrations/0004_vector_embedding.sql` 存在，journal 已更新
- [ ] T005: `CognitiveWorkspaceConfig.embedding?: EmbeddingConfig` 字段存在
- [ ] `bun build src/embedding.ts` 无错误（或 `bun check` 通过）
- [ ] `bun test` 零新增 failure

## Risks

- Drizzle HNSW index 的 `.with()` 参数格式可能需要 `as any` 绕过类型检查（实际 SQL 生成正确）
- `drizzle/migrations/meta/_journal.json` 格式需与现有条目保持一致（检查已有 idx/version 字段结构）
- pgvector 扩展在本地 Docker PostgreSQL 需确认已安装；测试环境可先跳过 `db:migrate`（测试通过即可）

## Reviewer Guidance

- 确认 `embedding` 列为 nullable（无 `.notNull()`）——旧记忆无 embedding 是预期状态
- 确认迁移文件使用 `IF NOT EXISTS` 以实现幂等性
- 确认 `EmbeddingConfig` 与 `LlmConfig` 风格一致（apiKey/model 模式，env fallback）
- T005 的 import 不能产生循环依赖——`types/index.ts` 导入 `embedding.ts` 应该没有循环风险
