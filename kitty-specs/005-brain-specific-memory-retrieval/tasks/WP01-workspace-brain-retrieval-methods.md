---
work_package_id: WP01
title: CognitiveWorkspace 专属检索方法实现
lane: "doing"
dependencies: []
subtasks: [T001, T002, T003, T004, T005, T006, T007, T008]
assignee: claude
agent: "claude-sonnet-4-6"
shell_pid: "44019"
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP01 — CognitiveWorkspace 专属检索方法实现

## 目标

在 `src/workspace/index.ts` 中实现三个脑区专属检索方法，同步更新 `src/types/index.ts` 的 `ICognitiveWorkspace` 接口和 `src/index.ts` 的导出，并为所有新方法编写完整的单元测试。

## 实施命令

```bash
spec-kitty agent workflow implement --agent <your-name>
```

无依赖，直接在 main 上创建 worktree：

```bash
spec-kitty implement WP01
```

## 上下文

### 关键文件

- **修改**：`src/workspace/index.ts`（追加三个方法，不改动已有方法）
- **修改**：`src/types/index.ts`（在 `ICognitiveWorkspace` 接口追加三个方法签名）
- **修改**：`src/index.ts`（追加导出）
- **新建**：`tests/unit/workspace/brain-retrieval.test.ts`

### 现有代码约定

1. **方法定义**：追加在 `forgetExpiredMemories` 之后（文件末尾区域），不插入已有方法之间
2. **SQL 构造**：用 Drizzle ORM 条件数组 + `and(...conditions)` 模式（见 `searchMemory`）
3. **行映射**：所有方法返回前调用 `rows.map(mapMemoryRow)` 转换为 `MemoryEntry`
4. **Import**：`ilike` 尚未在 workspace 中导入，需要添加到 drizzle-orm import 列表（字母顺序，排在 `inArray` 和 `isNotNull` 之间）
5. **Mock DB 测试**：参照 `tests/unit/workspace/memory.test.ts` 的 `makeMockDb` 工厂模式

### `ilike` 位置

`drizzle-orm` 的 `ilike` 与 `like` 在同一包中，直接 import 即可：

```typescript
// 在已有 import 列表中按字母顺序插入：
import {
  and,
  arrayContains,
  asc,
  avg,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,   // ← 新增，排在 gte 和 inArray 之间
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  not,
  sql,
} from 'drizzle-orm'
```

### `NULLS LAST` 排序

Drizzle 的 `desc()` 在 PostgreSQL 中默认 NULL 排在最后（`DESC NULLS LAST`），不需要额外处理。可直接用：

```typescript
.orderBy(desc(memories.baseImportance), desc(memories.lastAccessedAt))
```

如果实测发现行为不符合预期，则改用 `sql` 模板显式指定：

```typescript
.orderBy(desc(memories.baseImportance), sql`${memories.lastAccessedAt} DESC NULLS LAST`)
```

---

## 子任务

### T001 — `getEntityContext` 实现

**目的**：按 `entity_id` 等值过滤，返回该实体所有相关记忆，按重要度和最近访问时间排序。

**实现**（追加到 `CognitiveWorkspace` 类末尾）：

```typescript
async getEntityContext(
  entityId: string,
  opts?: { types?: MemoryType[]; limit?: number },
): Promise<MemoryEntry[]> {
  const conditions = [
    eq(memories.entityId, entityId),
    eq(memories.forgotten, false),
    isNull(memories.tInvalid),
  ]

  if (opts?.types && opts.types.length > 0) {
    conditions.push(inArray(memories.type, opts.types))
  }

  const rows = await this.db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.baseImportance), desc(memories.lastAccessedAt))
    .limit(opts?.limit ?? 10)

  return rows.map(mapMemoryRow)
}
```

**关键点**：
- `forgotten = false` 和 `t_invalid IS NULL` 是必须的硬条件，不可省略
- `types` 为空数组或 undefined 时不加 `inArray` 条件（返回所有类型）
- 默认 limit = 10

---

### T002 — `findSimilarSituations` 实现

**目的**：对 situation 字符串做 ILIKE 匹配，同时查询三种类型，返回分组结果。

**实现**：

```typescript
async findSimilarSituations(
  situation: string,
  opts?: { limit?: number },
): Promise<{ episodes: MemoryEntry[]; procedures: MemoryEntry[]; facts: MemoryEntry[] }> {
  const lim = opts?.limit ?? 5
  const pattern = `%${situation}%`

  const baseConditions = (type: MemoryType) => [
    eq(memories.type, type),
    eq(memories.forgotten, false),
    isNull(memories.tInvalid),
    ilike(memories.content, pattern),
  ]

  const [episodeRows, procedureRows, factRows] = await Promise.all([
    this.db
      .select()
      .from(memories)
      .where(and(...baseConditions('episodic')))
      .orderBy(desc(memories.baseImportance))
      .limit(lim),
    this.db
      .select()
      .from(memories)
      .where(and(...baseConditions('procedural')))
      .orderBy(desc(memories.baseImportance))
      .limit(lim),
    this.db
      .select()
      .from(memories)
      .where(and(...baseConditions('semantic')))
      .orderBy(desc(memories.baseImportance))
      .limit(lim),
  ])

  return {
    episodes: episodeRows.map(mapMemoryRow),
    procedures: procedureRows.map(mapMemoryRow),
    facts: factRows.map(mapMemoryRow),
  }
}
```

**关键点**：
- 三条查询 `Promise.all` 并发执行，不是顺序查询
- 各组独立 limit（不是总量 limit）
- situation 为空字符串时，`%` + `%` = `%%`，匹配所有内容——这是预期行为（调用方负责不传空字符串）

---

### T003 — `getProcedure` 实现

**目的**：只检索 procedural 类型，ILIKE 匹配 taskType，按重要度/访问时间排序。

**实现**：

```typescript
async getProcedure(
  taskType: string,
  opts?: { limit?: number },
): Promise<MemoryEntry[]> {
  const rows = await this.db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.type, 'procedural'),
        eq(memories.forgotten, false),
        isNull(memories.tInvalid),
        ilike(memories.content, `%${taskType}%`),
      ),
    )
    .orderBy(desc(memories.baseImportance), desc(memories.lastAccessedAt))
    .limit(opts?.limit ?? 3)

  return rows.map(mapMemoryRow)
}
```

**关键点**：
- type 硬编码为 `'procedural'`，调用方无法覆盖
- 默认 limit = 3（有意较小，Brainstem 只需要最相关的几条流程）

---

### T004 — `ilike` 导入 + `ICognitiveWorkspace` 接口更新

**目的**：添加 `ilike` 到 drizzle-orm import，并在 `src/types/index.ts` 的 `ICognitiveWorkspace` 接口中追加三个方法签名。

**`src/workspace/index.ts`** — 仅修改 import 列表：

```typescript
// 在现有 import 中插入 ilike（字母顺序，gte 和 inArray 之间）：
import {
  and,
  arrayContains,
  asc,
  avg,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,     // ← 新增
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  not,
  sql,
} from 'drizzle-orm'
```

**`src/types/index.ts`** — 在 `ICognitiveWorkspace` 接口的 `// ── Memory` 区块末尾追加：

```typescript
// 追加到 ICognitiveWorkspace 的 Memory 区块末尾
getEntityContext(
  entityId: string,
  opts?: { types?: MemoryType[]; limit?: number },
): Promise<MemoryEntry[]>

findSimilarSituations(
  situation: string,
  opts?: { limit?: number },
): Promise<{ episodes: MemoryEntry[]; procedures: MemoryEntry[]; facts: MemoryEntry[] }>

getProcedure(
  taskType: string,
  opts?: { limit?: number },
): Promise<MemoryEntry[]>
```

---

### T005 — `src/index.ts` 导出更新

**目的**：三个新方法是 `CognitiveWorkspace` 实例方法，不需要单独导出类型。但如果调用方需要用到参数类型，需要导出 opts 类型。

**分析**：三个方法的 opts 都是内联匿名类型（`{ types?: MemoryType[]; limit?: number }`），不需要额外命名类型，调用方可直接传对象字面量。

**结论**：`src/index.ts` 本次无需修改——新方法通过已导出的 `CognitiveWorkspace` 类自然暴露。

**验证**：运行 `bun run typecheck` 确认无报错即可。

---

### T006 — 单元测试：`getEntityContext`

**文件**：`tests/unit/workspace/brain-retrieval.test.ts`（新建）

**Mock DB 注意事项**：

现有 `makeMockDb` 的 `select()` 路径：
```
select().from().where() → { orderBy: () => ({ limit: async () => rows }) }
```
`getEntityContext` 的 Drizzle 查询链是 `.select().from().where().orderBy().limit()`，这与现有 mock 路径一致。

**测试用例**（覆盖以下场景）：

```typescript
import { describe, expect, test } from 'bun:test'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import type { DrizzleDB } from '../../../src/workspace/index'

// 复用 makeMockDb 和 makeMemoryRow 的结构（可 copy 自 memory.test.ts 并精简）

describe('getEntityContext', () => {
  test('returns memories matching entityId', async () => {
    // mock 返回两条 entity_id='e1' 的记忆
    // 验证结果长度 = 2，id 正确
  })

  test('returns empty array when no matching entity', async () => {
    // mock 返回 []
    // 验证结果 = []
  })

  test('passes types filter: returns only specified types', async () => {
    // 调用 getEntityContext('e1', { types: ['semantic'] })
    // mock 返回一条 semantic 记忆
    // 验证结果 type = 'semantic'
    // 注意：mock 不验证 SQL WHERE 条件，只验证方法调用和映射
  })

  test('uses default limit 10 when not specified', async () => {
    // 通过 spy 或 mock 验证 .limit(10) 被调用
    // 最简方式：配置 mock 返回 10 条记忆，验证结果长度 = 10
  })

  test('respects custom limit', async () => {
    // 调用 getEntityContext('e1', { limit: 3 })
    // mock 返回 3 条
    // 验证结果长度 = 3
  })

  test('maps row fields correctly (uses mapMemoryRow)', async () => {
    // mock 返回一条有完整字段的 MemoryRow
    // 验证 MemoryEntry 字段映射正确（id, type, content, entityId 等）
  })
})
```

---

### T007 — 单元测试：`findSimilarSituations`

**Mock DB 注意事项**：

`findSimilarSituations` 发起三次并发 `select()` 调用。现有 `makeMockDb` 的 `select()` 每次返回同一个 `config.memorySelectResult`。

为了区分三次调用，有两个策略：

**策略 A（推荐）**：让 mock 返回不同 type 的行，但共用同一个 `memorySelectResult`，然后在测试验证侧用 `result.episodes/procedures/facts` 各自 check。因为实现中每条查询只查自己的 type，mock 可以配置为返回混合数据，验证映射是否正确分组。

实际上更简单的方式：为 `findSimilarSituations` 创建一个**专用 mock**，直接替换 `db.select` 为一个计数器函数：

```typescript
// 专用 mock for findSimilarSituations
let callCount = 0
const selectResults = [
  [makeMemoryRow({ type: 'episodic', content: 'episode about complaint' })],
  [makeMemoryRow({ type: 'procedural', content: 'procedure for complaint' })],
  [makeMemoryRow({ type: 'semantic', content: 'fact about complaint' })],
]

const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => selectResults[callCount++] ?? [],
        }),
      }),
    }),
  }),
} as unknown as DrizzleDB
```

**测试用例**：

```typescript
describe('findSimilarSituations', () => {
  test('returns three groups: episodes, procedures, facts', async () => {
    // 验证返回对象有 episodes/procedures/facts 三个数组
  })

  test('executes three parallel queries', async () => {
    // 用 callCount spy 验证 select 被调用 3 次
  })

  test('returns empty arrays when no matches', async () => {
    // 所有 select 返回 []
    // 验证 episodes=[], procedures=[], facts=[]
  })

  test('uses default limit 5 per group', async () => {
    // 验证每组各调用 .limit(5)
  })

  test('respects custom limit', async () => {
    // 调用 findSimilarSituations('x', { limit: 2 })
    // 验证 .limit(2) 被调用
  })
})
```

---

### T008 — 单元测试：`getProcedure`

**测试用例**：

```typescript
describe('getProcedure', () => {
  test('returns only procedural type memories', async () => {
    // mock 返回一条 type='procedural' 记忆
    // 验证结果 type = 'procedural'
  })

  test('returns empty array when no matches', async () => {
    // mock 返回 []
  })

  test('uses default limit 3', async () => {
    // mock 返回 3 条
    // 验证结果长度 = 3
  })

  test('respects custom limit', async () => {
    // 调用 getProcedure('task', { limit: 1 })
    // mock 返回 1 条
  })

  test('maps row fields correctly', async () => {
    // 验证 MemoryEntry 字段正确映射
  })
})
```

---

## Definition of Done

- [ ] T001: `getEntityContext` 已实现，entity_id 等值过滤，types IN 过滤（可选），双重降序排序，limit 默认 10
- [ ] T002: `findSimilarSituations` 已实现，三条并发 ILIKE 查询，返回 `{ episodes, procedures, facts }` 分组对象，limit 默认 5
- [ ] T003: `getProcedure` 已实现，type 硬编码 procedural，ILIKE 匹配，双重降序排序，limit 默认 3
- [ ] T004: `ilike` 已加入 drizzle-orm import（字母序），`ICognitiveWorkspace` 接口已同步三个方法签名
- [ ] T005: `src/index.ts` 确认无需额外类型导出（typecheck 通过即满足）
- [ ] T006-T008: 单元测试覆盖空结果、limit、forgotten/tInvalid 过滤、映射正确性
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过（import 排序，无 `any`，无 `!`）

## 完成命令

```bash
spec-kitty agent tasks move-task WP01 --to for_review --note "Ready: <summary>"
```

## 实施提示

1. 先读 `src/workspace/index.ts` 完整文件再动笔，理解 `mapMemoryRow` 的位置和签名
2. 先写实现（T001-T004），再写测试（T006-T008）
3. 每写完一个方法立即运行 `bun run typecheck` 检查类型
4. 最后运行 `biome check --write` 修复格式

## Activity Log

- 2026-03-11T05:43:49Z – claude-sonnet-4-6 – shell_pid=81351 – lane=doing – Started implementation via workflow command
- 2026-03-11T05:46:21Z – claude-sonnet-4-6 – shell_pid=81351 – lane=for_review – Ready for review: getEntityContext (entity+types filter, limit 10), findSimilarSituations (3 parallel ILIKE queries, limit 5 per group), getProcedure (procedural ILIKE, limit 3). ICognitiveWorkspace interface updated. 16 unit tests, 220 total passing. biome clean on modified files.
- 2026-03-11T06:49:06Z – claude-sonnet-4-6 – shell_pid=44019 – lane=doing – Started review via workflow command
