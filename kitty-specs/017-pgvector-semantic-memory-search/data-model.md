# Data Model: pgvector Semantic Memory Search (Feature 017)
*Path: kitty-specs/017-pgvector-semantic-memory-search/data-model.md*

## Schema Changes

### memories 表新增字段

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `embedding` | `vector(1536)` | nullable | 记忆内容的嵌入向量；旧记忆为 null，按需降级 ILIKE |

### 新增索引

| 索引名 | 类型 | 字段 | 说明 |
|---|---|---|---|
| `idx_memories_embedding_hnsw` | HNSW | `embedding` | 近似最近邻向量检索，仅对非 null embedding 有效 |

HNSW 参数：`m=16, ef_construction=64`（平衡 recall 与构建速度，可在生产运行后调整）

### 迁移

迁移文件 `0004_vector_embedding.sql` 包含：
```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

> 注：HNSW 索引只能在 pgvector ≥ 0.5.0 上创建。迁移不检测版本，失败时需手动确认 extension 版本。

## 接口变更

### EmbeddingConfig（新增，src/embedding.ts）

```typescript
export interface EmbeddingConfig {
  apiKey?: string       // 默认 OPENAI_API_KEY
  model?: string        // 默认 'text-embedding-3-small'
  dimensions?: number   // 默认 1536（与 vector 列维度一致）
}
```

### CognitiveWorkspaceConfig（新增字段）

```typescript
export interface CognitiveWorkspaceConfig {
  // ... existing fields ...
  embedding?: EmbeddingConfig   // ← 新增；undefined 时 embedding 功能关闭
}
```

当 `embedding` 未配置（`undefined`）时：
- `writeMemory()` 不生成 embedding（静默跳过）
- `findSimilarSituations()` / `getProcedure()` 全部使用 ILIKE（同现有行为）

### MemoryEntry（不变）

`MemoryEntry` 公共类型不暴露 `embedding` 字段（向量数据不需要传给脑区）。`embedding` 只在 DB 层和 workspace 内部使用。

## 向量检索语义

- **相似度度量**：余弦距离（`<=>` 运算符）；距离越小越相似（0 = 完全相同，2 = 完全相反）
- **无阈值过滤**：由 `.limit(n)` 控制结果数量，不设固定相似度阈值（避免无结果情况）
- **fallback 条件**：当 `isNotNull(memories.embedding)` 无记录匹配（即所有候选记忆的 embedding 均为 null），自动执行 ILIKE 查询
