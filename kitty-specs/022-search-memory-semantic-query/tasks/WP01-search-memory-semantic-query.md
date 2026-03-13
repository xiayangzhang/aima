---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
  - "T003"
title: "searchMemory Semantic Query Upgrade — Interface + Implementation + Tests"
phase: "Phase 1 - Interface + Implementation + Tests"
lane: "for_review"
assignee: ""
agent: ""
shell_pid: ""
review_status: ""
dependencies: []
reviewed_by: ""
history:
  - timestamp: "2026-03-13T00:00:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via spec-kitty agent workflow"
---

# Work Package Prompt: WP01 — searchMemory Semantic Query Upgrade

## Objectives & Success Criteria

为 `MemorySearchFilters` 添加 `query?: string` 字段，并升级 `searchMemory()` 使其支持 vector-first + ILIKE-fallback 文本查询，与 `findSimilarSituations()` / `getProcedure()` 的已有模式完全一致。完成后：

- `MemorySearchFilters` 接口含 `query?: string` 字段
- `searchMemory()` 在 embedding 配置存在时走 vector 路径（cosine distance 排序 + `isNotNull` guard + 所有其他 filter 作为 WHERE 条件）
- vector 路径返回空或抛出时，自动 fallback 到 ILIKE
- 无 embedding 配置时直接走 ILIKE
- `query` 未传时行为与当前完全一致（不调用 `generateEmbedding`）
- `bun tsc --noEmit` 零编译错误
- V1–V6 单元测试全部通过，现有 searchMemory 测试零回归

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/022-search-memory-semantic-query/spec.md`
- **Plan**: `kitty-specs/022-search-memory-semantic-query/plan.md` — 含完整实现草稿
- **Source files**:
  - `src/types/index.ts` — `MemorySearchFilters` 接口（约第 128 行，添加 `query?: string`）
  - `src/workspace/index.ts` — `searchMemory()` 实现（约第 433 行，升级逻辑）
  - `tests/unit/workspace/search-memory.test.ts` — 新建，V1–V6 单元测试
- **Reference implementations** (do NOT modify these, only follow their pattern):
  - `findSimilarSituations()` — lines 650–725 of `src/workspace/index.ts` — vector + ILIKE pattern
  - `getProcedure()` — lines 734+ of `src/workspace/index.ts` — same pattern
  - `tests/unit/workspace/embedding-search.test.ts` — mock pattern to replicate
- **Depends on**: 无
- **Constraints**:
  - 所有已有 filter（type, tags, entityId, segmentId, excludeInvalid, createdAfter）在 vector 路径和 ILIKE 路径中都必须作为 WHERE 条件保留
  - 不修改 `findSimilarSituations()` 或 `getProcedure()`
  - 不新增 DB migration，不修改 schema
  - `cosineDistance` 和 `isNotNull` 已在 workspace 顶部 import，不需要新增 import

---

## Subtasks & Detailed Guidance

### Subtask T001 — 添加 `query?: string` 到 `MemorySearchFilters`

**Purpose**: 将新字段纳入公共类型契约，使所有调用方（含测试、未来 adapter）可依赖该字段。

**Steps**:

1. 打开 `src/types/index.ts`，找到 `MemorySearchFilters` 接口（约第 128 行）。

当前内容：
```typescript
export interface MemorySearchFilters {
  type?: MemoryType
  tags?: string[] // AND match: entry must have ALL specified tags
  entityId?: string
  segmentId?: string
  excludeInvalid?: boolean // default true (filter WHERE t_invalid IS NULL)
  limit?: number // default 20
  createdAfter?: Date // filter WHERE created_at > createdAfter
}
```

修改后（在 `createdAfter` 后追加）：
```typescript
export interface MemorySearchFilters {
  type?: MemoryType
  tags?: string[] // AND match: entry must have ALL specified tags
  entityId?: string
  segmentId?: string
  excludeInvalid?: boolean // default true (filter WHERE t_invalid IS NULL)
  limit?: number // default 20
  createdAfter?: Date // filter WHERE created_at > createdAfter
  query?: string // text search: vector (cosine) when embedding configured, ILIKE fallback
}
```

**Files**: `src/types/index.ts`

**Validation**:
- [ ] `grep -n "query" src/types/index.ts` → 1 match inside `MemorySearchFilters`

---

### Subtask T002 — 升级 `searchMemory()` 实现

**Purpose**: 在 `searchMemory()` 中加入 vector-first + ILIKE-fallback 逻辑，与 `findSimilarSituations()` 的已有模式一致。

**Steps**:

1. 打开 `src/workspace/index.ts`，找到 `searchMemory()` 方法（约第 433 行）。

当前实现（完整）：
```typescript
async searchMemory(filters: MemorySearchFilters): Promise<MemoryEntry[]> {
  const conditions = []

  if (filters.type !== undefined) {
    conditions.push(eq(memories.type, filters.type))
  }

  if (filters.tags && filters.tags.length > 0) {
    conditions.push(arrayContains(memories.tags, filters.tags))
  }

  if (filters.entityId !== undefined) {
    conditions.push(eq(memories.entityId, filters.entityId))
  }

  if (filters.segmentId !== undefined) {
    conditions.push(eq(memories.segmentId, filters.segmentId))
  }

  // Always exclude forgotten memories
  conditions.push(eq(memories.forgotten, false))
  // Exclude superseded memories unless caller explicitly opts out
  if (filters.excludeInvalid !== false) {
    conditions.push(isNull(memories.tInvalid))
  }

  if (filters.createdAfter !== undefined) {
    conditions.push(gt(memories.createdAt, filters.createdAfter))
  }

  const rows = await this.db
    .select()
    .from(memories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(memories.baseImportance))
    .limit(filters.limit ?? 20)

  return rows.map(mapMemoryRow)
}
```

修改后（完整替换）：
```typescript
async searchMemory(filters: MemorySearchFilters): Promise<MemoryEntry[]> {
  const conditions = []

  if (filters.type !== undefined) {
    conditions.push(eq(memories.type, filters.type))
  }

  if (filters.tags && filters.tags.length > 0) {
    conditions.push(arrayContains(memories.tags, filters.tags))
  }

  if (filters.entityId !== undefined) {
    conditions.push(eq(memories.entityId, filters.entityId))
  }

  if (filters.segmentId !== undefined) {
    conditions.push(eq(memories.segmentId, filters.segmentId))
  }

  // Always exclude forgotten memories
  conditions.push(eq(memories.forgotten, false))
  // Exclude superseded memories unless caller explicitly opts out
  if (filters.excludeInvalid !== false) {
    conditions.push(isNull(memories.tInvalid))
  }

  if (filters.createdAfter !== undefined) {
    conditions.push(gt(memories.createdAt, filters.createdAfter))
  }

  const lim = filters.limit ?? 20

  // ── Vector path: query + embedding config ──────────────────────────────────
  if (filters.query != null && this.options.embedding != null) {
    try {
      const queryEmbedding = await generateEmbedding(filters.query, this.options.embedding)

      const rows = await this.db
        .select()
        .from(memories)
        .where(
          and(
            ...conditions,
            isNotNull(memories.embedding),
          ),
        )
        .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
        .limit(lim)

      if (rows.length > 0) {
        return rows.map(mapMemoryRow)
      }
      // zero results → fall through to ILIKE
    } catch {
      // generateEmbedding failed (API error, timeout, etc.) → fall through to ILIKE
    }
  }

  // ── ILIKE fallback (or no-query path) ──────────────────────────────────────
  if (filters.query != null) {
    conditions.push(ilike(memories.content, `%${filters.query}%`))
  }

  const rows = await this.db
    .select()
    .from(memories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(memories.baseImportance))
    .limit(lim)

  return rows.map(mapMemoryRow)
}
```

**Important**: `isNotNull`, `asc`, `cosineDistance`, `ilike` are all already imported at the top of
`src/workspace/index.ts` (added by Feature 017). Do NOT add duplicate imports.

**Files**: `src/workspace/index.ts`

**Validation**:
- [ ] `bun tsc --noEmit` → 零编译错误，exit code 0
- [ ] Method body contains `cosineDistance` and `ilike` references

---

### Subtask T003 — 单元测试 V1–V6

**Purpose**: 验证 vector 路径、ILIKE fallback 路径、以及无 query 时的无回归行为。

**Steps**:

参考 `tests/unit/workspace/embedding-search.test.ts` 的完整 mock 模式，新建文件
`tests/unit/workspace/search-memory.test.ts`。

关键 mock 设置（必须在 workspace import 前完成）：
```typescript
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const mockGenerateEmbedding = mock((_text: string) =>
  Promise.resolve(new Array(1536).fill(0.1) as number[]),
)

mock.module('../../../src/embedding', () => ({
  generateEmbedding: mockGenerateEmbedding,
}))

const { CognitiveWorkspace } = await import('../../../src/workspace/index')
import type { DrizzleDB } from '../../../src/workspace/index'
```

Mock DB helper（两路返回值，用于 vector→ILIKE fallback 场景）：
```typescript
function makeSearchMockDb(firstCallRows: MemoryRow[], secondCallRows: MemoryRow[]): DrizzleDB {
  let callCount = 0
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              const rows = callCount === 0 ? firstCallRows : secondCallRows
              callCount++
              return rows
            },
          }),
        }),
      }),
    }),
  } as unknown as DrizzleDB
}
```

**V1 — vector 路径被使用**:
- embedding config 存在，DB 第一次调用返回 `[row]`
- `searchMemory({ query: 'policy violation' })`
- 断言：`generateEmbedding` 被调用一次，参数为 `'policy violation'`
- 断言：结果包含 `row`

**V2 — vector 返回空 → ILIKE fallback**:
- embedding config 存在，DB 第一次调用返回 `[]`，第二次返回 `[row]`
- `searchMemory({ query: 'policy violation' })`
- 断言：`generateEmbedding` 被调用一次
- 断言：结果包含来自 ILIKE 路径的 `row`

**V3 — 无 embedding config → 直接 ILIKE**:
- 无 embedding config，DB 第一次调用返回 `[row]`
- `searchMemory({ query: 'policy violation' })`
- 断言：`generateEmbedding` NOT called（`toHaveBeenCalledTimes(0)`）
- 断言：结果包含 `row`

**V4 — 无 query → 现有行为不变**:
- embedding config 存在，DB 返回 `[row]`
- `searchMemory({ type: 'semantic' })`（无 query）
- 断言：`generateEmbedding` NOT called
- 断言：结果包含 `row`

**V5 — vector 抛出 → ILIKE fallback，不传播错误**:
- embedding config 存在，`mockGenerateEmbedding.mockImplementation(() => Promise.reject(new Error('API timeout')))`
- DB 第一次调用返回 `[row]`（ILIKE path）
- `searchMemory({ query: 'policy violation' })`
- 断言：不抛出错误
- 断言：结果包含 `row`

**V6 — query + type + tags 全部生效**:
- embedding config 存在，DB 第一次调用返回 `[row]`（row 的 type='semantic', tags=['policy']）
- `searchMemory({ query: 'access control', type: 'semantic', tags: ['policy'] })`
- 断言：`generateEmbedding` 被调用一次，参数为 `'access control'`
- 断言：结果包含 `row`（验证其他 filter 未破坏 vector 路径）

V5 需要在 test 内临时覆盖 mock 实现后恢复：
```typescript
test('vector throws → ILIKE fallback, no error thrown', async () => {
  mockGenerateEmbedding.mockImplementationOnce(() => Promise.reject(new Error('API timeout')))
  // DB returns row on first call (ILIKE path will be reached)
  const db = makeSearchMockDb([], [row])  // first=[] but never reached; use single-path mock
  // ...
})
```

注意 V5 中 vector path 抛出后走 ILIKE，所以 mock DB 只需要一次 select call 返回 row。
可以简化为直接 `makeSearchMockDb([], [row])` 或使用单路 mock。

**Files**: `tests/unit/workspace/search-memory.test.ts`（新建）

**Validation**:
- [ ] `bun test tests/unit/workspace/search-memory.test.ts` → V1–V6 全部通过
- [ ] `bun test tests/unit/workspace/` → 零回归

---

## Risks & Mitigations

| 风险 | 可能性 | 缓解方案 |
|---|---|---|
| `and(...conditions)` 在 vector WHERE 中展开顺序错误 | 低 | conditions 在 vector 分支前已完整构建，spread 到 `and()` 即可 |
| Mock DB chain 深度不匹配（select/from/where/orderBy/limit）| 低 | 完全复制 `embedding-search.test.ts` 的 mock helper 结构 |
| V2/V5 的 callCount 逻辑理解错误 | 低 | V5 vector 抛出，完全不走 vector DB call，只有 ILIKE 一次 DB call |
| `isNotNull` 已 import 但 `asc` 未 import | 极低 | 文件顶部已有 `import { isNotNull, asc } from 'drizzle-orm'`（Feature 017 添加）|

## Definition of Done Checklist

- [ ] `grep -n "query" src/types/index.ts` → 1 match inside `MemorySearchFilters`
- [ ] `bun tsc --noEmit` → 零编译错误
- [ ] `bun test tests/unit/workspace/search-memory.test.ts` → V1–V6 全通过
- [ ] `bun test tests/unit/workspace/` → 零回归

## Review Guidance

- 验证 T001：`query` 字段在接口内，有注释说明 fallback 行为
- 验证 T002：vector 路径的 WHERE clause 包含所有现有 conditions + `isNotNull(memories.embedding)`；ILIKE 路径只在 `query != null` 时追加 ilike condition
- 验证 T003：V2 测试验证 `generateEmbedding` 被调用过（不是零次），同时最终结果来自 ILIKE 路径；V5 测试确认不抛出异常

## Activity Log

- 2026-03-13T00:00:00Z – system – lane=planned – Prompt generated via spec-kitty agent workflow
