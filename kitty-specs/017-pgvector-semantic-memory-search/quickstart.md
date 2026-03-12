# Quickstart & Validation: pgvector Semantic Memory Search (Feature 017)

## 构建验证

```bash
cd /Volumes/leoyun/aima
bun test tests/unit/workspace/
bun test
```

## 验证场景

### V1 — 语义相似查询召回词汇不重叠的记忆

```typescript
// mock generateEmbedding: 给"rejected delete request"返回向量 A
// 给"prevent destructive action"返回向量 B（与 A 余弦距离 < 0.2）
// workspace.writeMemory({ content: 'rejected delete request', type: 'episodic', ... })
// — embedding 已生成
const result = await workspace.findSimilarSituations('prevent destructive action')
assert(result.episodes.some(e => e.content === 'rejected delete request'))
// 断言：调用了 generateEmbedding（一次写入，一次查询）
```

### V2 — embedding=null 的旧记忆回退 ILIKE

```typescript
// 数据库中存在一条 embedding=null 的 episodic 记忆，content='data export task'
// embedding mock 返回向量（不与 'data export task' 匹配）
const result = await workspace.findSimilarSituations('data export task')
assert(result.episodes.some(e => e.content.includes('data export')))
// 断言：ILIKE 路径执行，记忆被召回
```

### V3 — generateEmbedding 失败不阻断 writeMemory

```typescript
// mock generateEmbedding → throw new Error('rate limit')
const p = workspace.writeMemory({ content: 'test content', type: 'semantic', ... })
await p  // 不应该抛异常
// 断言：DB 中存在该记忆（embedding=null）
// 断言：writeMemory 返回正常
```

### V4 — getProcedure 向量检索

```typescript
// 存在 procedural 记忆 content='AKS cluster deployment steps'，有 embedding
// mock generateEmbedding: 'deploy to kubernetes' 与 'AKS cluster deployment steps' 相似
const result = await workspace.getProcedure('deploy to kubernetes')
assert(result.some(r => r.content.includes('AKS')))
```

### V5 — embedding 配置未设置时完全使用 ILIKE（向后兼容）

```typescript
// workspace 初始化时 config.embedding = undefined
// mock generateEmbedding 不被调用
const ws = new CognitiveWorkspace({ db, ..., embedding: undefined })
await ws.writeMemory({ content: 'test', type: 'episodic', ... })
// 断言：generateEmbedding 未被调用
// findSimilarSituations 正常工作（ILIKE）
```

### V6 — searchMemory query 字段向量检索（次要）

```typescript
// 有 embedding 的记忆存在
// mock generateEmbedding → 向量
const result = await workspace.searchMemory({ query: 'security violation' })
// 断言：返回语义相关的记忆（embedding 路径）
// 断言：仍可用 type/tags 过滤（与向量检索并用）
```

### V7 — 零回归

```bash
bun test
# 全部现有测试通过，无新 failure
```

## Definition of Done

- [ ] `bun add openai` 已执行，package.json 含 openai 依赖
- [ ] `src/schema/memories.ts` 含 `embedding vector(1536)` 列 + HNSW 索引
- [ ] `drizzle/migrations/` 含新迁移文件（pgvector extension + ALTER + index）
- [ ] `src/embedding.ts` 存在，导出 `generateEmbedding` 和 `EmbeddingConfig`
- [ ] `CognitiveWorkspaceConfig` 含 `embedding?: EmbeddingConfig`
- [ ] `writeMemory()` fire-and-forget embedding 生成（V3 通过）
- [ ] `findSimilarSituations()` 向量优先 + ILIKE fallback（V1/V2 通过）
- [ ] `getProcedure()` 同上（V4 通过）
- [ ] `embedding=undefined` 完全降级（V5 通过）
- [ ] `bun test` 全量零新增 failure
