# Research: pgvector Semantic Memory Search (Feature 017)
*Path: kitty-specs/017-pgvector-semantic-memory-search/research.md*

## Decision Log

| 决策 | 结论 | 依据 |
|---|---|---|
| pgvector in drizzle | 原生支持 `vector` 类型（drizzle-orm v0.38.4） | `node_modules/drizzle-orm/pg-core/columns/vector_extension/vector.d.ts` 存在 |
| HNSW index | Drizzle `.using('hnsw', column)` 生成 `USING hnsw (embedding)` | 同上 |
| 余弦相似度查询 | `cosineDistance()` from `drizzle-orm/sql/functions` | 原生函数，生成 `<=>` 运算符 |
| 嵌入 SDK | `openai` npm 包（需新增） | OpenAI text-embedding-3-small 标准客户端 |
| EmbeddingConfig 接口 | 镜像 `LlmConfig`（apiKey? / model? / dimensions?） | 与现有 `src/llm.ts` 一致 |
| 迁移模式 | Drizzle Kit SQL migrations，`drizzle/migrations/` | 现有 0000-0003 迁移文件 |
| writeMemory embedding | fire-and-forget，`.catch(() => {})` 静默失败 | 与 Amygdala writeEvalMemory 同一模式 |
| fallback 策略 | `isNotNull(memories.embedding)` 时走向量，否则走 ILIKE | 向后兼容旧记忆 |

## drizzle-orm vector 列定义

```typescript
import { vector } from 'drizzle-orm/pg-core'

// schema/memories.ts 新增：
embedding: vector('embedding', { dimensions: 1536 }),  // nullable
```

HNSW 索引（添加到 table indexes callback）：
```typescript
embeddingHnswIdx: index('idx_memories_embedding_hnsw')
  .using('hnsw', table.embedding)
  .with({ m: 16, ef_construction: 64 }),
```

迁移中需先 `CREATE EXTENSION IF NOT EXISTS vector`。

## 余弦相似度查询模式

```typescript
import { cosineDistance } from 'drizzle-orm/sql/functions'
import { isNotNull, asc } from 'drizzle-orm'

// 向量检索（仅对有 embedding 的记忆）：
const rows = await db
  .select()
  .from(memories)
  .where(and(
    eq(memories.type, 'episodic'),
    eq(memories.forgotten, false),
    isNull(memories.tInvalid),
    isNotNull(memories.embedding),
  ))
  .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
  .limit(lim)
```

## OpenAI Embedding API

包名：`openai`（需运行 `bun add openai`）

```typescript
import OpenAI from 'openai'

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
  return response.data[0].embedding  // number[] of length 1536
}
```

## EmbeddingConfig 接口（镜像 LlmConfig）

```typescript
export interface EmbeddingConfig {
  /** 如不设置，读 process.env.OPENAI_API_KEY */
  apiKey?: string
  /** 默认：'text-embedding-3-small' */
  model?: string
  /** 默认：1536 */
  dimensions?: number
}
```

## writeMemory 集成点

```typescript
// workspace/index.ts — writeMemory() 末尾追加：
this.generateAndStoreEmbedding(id, entry.content).catch(() => {})
// ^ fire-and-forget，失败静默

private async generateAndStoreEmbedding(id: string, content: string): Promise<void> {
  const embedding = await generateEmbedding(content, this.config.embedding ?? {})
  await this.db.update(memories).set({ embedding }).where(eq(memories.id, id))
}
```

`CognitiveWorkspaceConfig` 新增 `embedding?: EmbeddingConfig` 字段。

## LlmConfig 参考（src/llm.ts）

```typescript
export interface LlmConfig {
  apiKey?: string           // 默认 ANTHROPIC_API_KEY
  model?: string            // 默认 'claude-haiku-4-5-20251001'
  maxTokens?: number        // 默认 1024
}
```
