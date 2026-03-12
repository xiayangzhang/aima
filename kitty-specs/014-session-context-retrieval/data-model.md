# Data Model: Session Context Retrieval

## 无新实体

本 feature 不新增表或字段。所有查询数据来自现有 `memories` 表。

## 现有实体使用

### MemoryEntry（查询目标）

| 字段 | 类型 | 用途 |
|---|---|---|
| `id` | `uuid` | 记录唯一标识 |
| `type` | `memory_type` enum | 过滤条件：`= 'episodic'` |
| `content` | `text` | 事件内容（JSON 序列化的 episodic 元数据） |
| `sessionId` | `text \| null` | 过滤条件：`= <sessionId>` |
| `tInvalid` | `timestamp \| null` | 软删除：`IS NULL` = 有效记录 |
| `forgotten` | `boolean` | 额外有效性过滤：`= false` |
| `createdAt` | `timestamp` | 排序键：`ASC` |

### getSessionContext 返回类型

```typescript
{
  anchor: MemoryEntry | null   // createdAt 最早的有效 episodic，或 null
  events: MemoryEntry[]        // 全部有效 episodic，按 createdAt ASC，含 anchor
}
```

## Schema 变更

### 新增索引（唯一 DB 变更）

**目的**：`getSessionContext` 按 `session_id` 过滤，需要索引支持

**Drizzle schema**（`src/schema/memories.ts`）：

```typescript
// 在 pgTable 定义的 (table) => ({ ... }) 内新增：
sessionIdIdx: index('idx_memories_session_id')
  .on(table.sessionId)
  .where(sql`session_id IS NOT NULL`),
```

**Migration SQL**：

```sql
-- 新增 session_id 局部索引（仅索引非 NULL 值，减少索引体积）
CREATE INDEX IF NOT EXISTS idx_memories_session_id
  ON memories(session_id)
  WHERE session_id IS NOT NULL;
```

## 接口变更

### ICognitiveWorkspace（`src/types/index.ts`）

在 `// ── Memory` 区块的 `getLatestSegmentStates()` 之前新增方法：

```typescript
getSessionContext(sessionId: string): Promise<{
  anchor: MemoryEntry | null
  events: MemoryEntry[]
}>
```

**位置**：`ICognitiveWorkspace` 接口末尾，`getLatestSegmentStates` 前（语义上属于 Memory 区块）。

## 无变更项

- 无新表
- 无新列
- 无修改现有方法签名
- 无修改 `CreateMemoryParams`
- 无修改 `MemorySearchFilters`
