# Implementation Plan: pgvector Semantic Memory Search
*Path: kitty-specs/017-pgvector-semantic-memory-search/plan.md*

**Branch**: `017-pgvector-semantic-memory-search` | **Date**: 2026-03-12 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/kitty-specs/017-pgvector-semantic-memory-search/spec.md`

## Summary

将 `CognitiveWorkspace` 的记忆检索从 ILIKE 字符串匹配升级为 pgvector 余弦相似度向量检索。新增嵌入服务模块 `src/embedding.ts`，在 `writeMemory()` 后异步生成向量，在 `findSimilarSituations()` 和 `getProcedure()` 中优先使用向量检索并回退 ILIKE。

## Technical Context

**Language/Version**: TypeScript (Bun runtime)
**Primary Dependencies**:
- `openai`（需新增：`bun add openai`）— text-embedding-3-small API
- `drizzle-orm` v0.38.4（已有）— 原生支持 `vector` 类型和 `cosineDistance()`
- `postgres` v3.4.0（已有）— 数据库驱动

**Storage**: PostgreSQL + pgvector extension；`memories` 表新增 `embedding vector(1536)` 列 + HNSW 索引
**Testing**: Bun test
**Target Platform**: Linux server (AKS) + 本地开发 Docker PostgreSQL
**Project Type**: Single project
**Performance Goals**: `writeMemory()` 延迟不因 embedding 生成增加（fire-and-forget）；向量检索 < 50ms（HNSW 索引）
**Constraints**: 不改 `MemoryEntry` 公共类型（embedding 不暴露到外部）；`config.embedding` 未配置时行为与修改前完全一致；不做历史记忆 backfill（null embedding 走 ILIKE）
**Scale/Scope**: 改动 ~80 行代码，新增 1 个源文件（embedding.ts），1 个迁移文件，新增 ~7 个测试

## Constitution Check

*无 constitution 文件，跳过。*

## Project Structure

### Documentation (this feature)

```
kitty-specs/017-pgvector-semantic-memory-search/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks/
```

### Source Code (repository root)

```
src/
├── embedding.ts               # 新增：EmbeddingConfig + generateEmbedding()
└── workspace/
    └── index.ts               # 改动：writeMemory + findSimilarSituations + getProcedure

src/schema/
└── memories.ts                # 改动：vector 列 + HNSW 索引

drizzle/migrations/
└── 0004_vector_embedding.sql  # 新增：pgvector extension + ALTER + index

tests/unit/workspace/
└── workspace.test.ts          # 改动：新增 V1-V7 向量检索测试

package.json                   # 改动：新增 openai 依赖
```

**Structure Decision**: Single project，改动集中在 1 个新模块 + 2 个现有文件 + 迁移。

## Phase 0: Research

**代码审查结论**：

| 决策 | 结论 | 依据 |
|---|---|---|
| vector 列定义 | `vector('embedding', { dimensions: 1536 })` from `drizzle-orm/pg-core` | drizzle-orm v0.38.4 原生支持 |
| HNSW 索引 | `.using('hnsw', table.embedding).with({ m: 16, ef_construction: 64 })` | drizzle-orm index API |
| 余弦距离查询 | `cosineDistance()` from `drizzle-orm/sql/functions` | `<=>` 运算符 |
| 嵌入 SDK | `openai`（`bun add openai`） | text-embedding-3-small，1536 维 |
| EmbeddingConfig | 镜像 `LlmConfig`（apiKey / model / dimensions） | `src/llm.ts` 一致性 |
| writeMemory 集成 | fire-and-forget，`.catch(() => {})` | FR-004 / Amygdala 同模式 |
| fallback 策略 | `isNotNull(embedding)` 走向量，否则 ILIKE | FR-003 向后兼容 |
| MemoryEntry 不变 | embedding 不暴露到公共类型 | data-model.md 决定 |

详见 [research.md](research.md)。

## Phase 1: Design & Contracts

### src/embedding.ts（新增）

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

### schema/memories.ts 变更

```typescript
import { vector } from 'drizzle-orm/pg-core'
import { cosineDistance } from 'drizzle-orm/sql/functions'  // 仅 workspace 用，不在 schema 里

// 在 memories pgTable 列定义中新增：
embedding: vector('embedding', { dimensions: 1536 }),

// 在 indexes callback 中新增：
embeddingHnswIdx: index('idx_memories_embedding_hnsw')
  .using('hnsw', table.embedding)
  .with({ m: 16, ef_construction: 64 }),
```

### CognitiveWorkspaceConfig 变更

```typescript
import type { EmbeddingConfig } from '../embedding'

export interface CognitiveWorkspaceConfig {
  // ... 现有字段 ...
  embedding?: EmbeddingConfig   // ← 新增；undefined 时禁用 embedding 功能
}
```

### writeMemory() 变更

写入 DB 成功后追加：

```typescript
// Fire-and-forget embedding generation
if (this.config.embedding != null) {
  this.generateAndStoreEmbedding(id, content).catch(() => {})
}

// 新增私有方法：
private async generateAndStoreEmbedding(id: string, content: string): Promise<void> {
  const embedding = await generateEmbedding(content, this.config.embedding!)
  await this.db
    .update(memories)
    .set({ embedding })
    .where(eq(memories.id, id))
}
```

### findSimilarSituations() 变更

```typescript
async findSimilarSituations(
  situation: string,
  opts?: { limit?: number },
): Promise<{ episodes: MemoryEntry[]; procedures: MemoryEntry[]; facts: MemoryEntry[] }> {
  const lim = opts?.limit ?? 5

  // 如果有 embedding config，尝试向量检索
  if (this.config.embedding != null && situation.trim() !== '') {
    try {
      const queryEmbedding = await generateEmbedding(situation, this.config.embedding)
      const baseConditions = (type: MemoryType) => [
        eq(memories.type, type),
        eq(memories.forgotten, false),
        isNull(memories.tInvalid),
        isNotNull(memories.embedding),
      ]
      const [episodeRows, procedureRows, factRows] = await Promise.all([
        this.db.select().from(memories)
          .where(and(...baseConditions('episodic')))
          .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
          .limit(lim),
        this.db.select().from(memories)
          .where(and(...baseConditions('procedural')))
          .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
          .limit(lim),
        this.db.select().from(memories)
          .where(and(...baseConditions('semantic')))
          .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
          .limit(lim),
      ])
      // 若向量检索有结果则返回，否则 fallback ILIKE
      if (episodeRows.length > 0 || procedureRows.length > 0 || factRows.length > 0) {
        return {
          episodes: episodeRows.map(mapMemoryRow),
          procedures: procedureRows.map(mapMemoryRow),
          facts: factRows.map(mapMemoryRow),
        }
      }
    } catch {
      // embedding 生成失败 → 静默 fallback ILIKE
    }
  }

  // ILIKE fallback（原有逻辑）
  const pattern = `%${situation}%`
  // ... 原有 ILIKE 查询 ...
}
```

### getProcedure() 变更

同样的向量优先 + ILIKE fallback 模式，针对 `procedural` 类型。

### 迁移文件 drizzle/migrations/0004_vector_embedding.sql

```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to memories table
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create HNSW index for approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

> 注：Drizzle Kit `bun run db:generate` 会生成自动迁移，但 `CREATE EXTENSION` 需要手动添加到迁移文件（Drizzle Kit 不自动处理 extension）。

## Complexity Tracking

*无 Constitution 违规，跳过。*
