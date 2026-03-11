# Implementation Plan: Brain-Specific Memory Retrieval

**Branch**: `main` (worktrees per WP) | **Date**: 2026-03-11 | **Spec**: [spec.md](./spec.md)
**Feature**: 005-brain-specific-memory-retrieval

---

## Technical Context

### Stack

- **Language**: TypeScript (strict), Bun runtime
- **ORM**: Drizzle ORM (`drizzle-orm/pg-core`)
- **DB**: PostgreSQL (real DB for integration tests, mock DB for unit tests)
- **Linter**: Biome (strict: no `any`, no non-null assertions, import ordering)
- **Test runner**: `bun:test`

### Key Files

| File | Role |
|------|------|
| `src/workspace/index.ts` | `CognitiveWorkspace` class — 新增 3 个方法 |
| `src/types/index.ts` | `ICognitiveWorkspace` 接口 + `MemoryType` — 新增方法签名 |
| `src/context/index.ts` | `assembleBlock4` + `assembleContext` — 升级 Block 4 路由 |
| `src/index.ts` | 公开导出 — 新增 `AssembleBlock4Opts` |
| `tests/unit/workspace/memory.test.ts` | 现有单元测试（新增 describe 块，不破坏已有测试） |
| `tests/unit/context/` | 新建 `assembleBlock4.test.ts` |
| `tests/integration/workspace/` | 新建 `brain-retrieval.test.ts` |

### 关键约束（来自 Feature 001–004 先例）

1. **mock DB 模式**：unit tests 用 `makeMockDb()` 工厂，不连接真实 DB，测试 SQL 构造逻辑
2. **integration tests 用 `describeWithDb`**：连接真实 DB，验证 SQL 语义正确性（ILIKE、排序、limit）
3. **`lastAccessedAt` 排序**：`markMemoryUsed` 不更新 `lastAccessedAt`（只更新 `usageOutcomes`）——`lastAccessedAt` 在 `writeMemory` 时设置，排序时 nulls 排在后面（`desc(memories.lastAccessedAt)` 在 PostgreSQL 中 null 在最后）
4. **`ICognitiveWorkspace` 接口必须同步更新**：新方法需同时在 `src/types/index.ts` 的接口声明和 `src/workspace/index.ts` 的实现中添加
5. **Biome 行长度限制**：复杂 SQL 查询需要适当换行，避免超行

### FR-05 状态

`markAccessed` 别名在当前代码库中**不存在**。Feature 003 已直接实现 `markMemoryUsed(ids, outcome)`，无需兼容别名。FR-05 **不实现**（spec 中保留作记录，实际工作包跳过）。

---

## 架构决策

### 决策 1：`assembleBlock4` 参数扩展方式

**现状**：`assembleBlock4(brain, workspace, threadId)` — threadId 当前未使用（prefixed `_threadId`）

**方案**：新增可选参数对象 `opts?: AssembleBlock4Opts`：

```typescript
export interface AssembleBlock4Opts {
  entityId?: string     // limbic 脑区：实体上下文检索的目标实体
  taskType?: string     // brainstem 脑区：过程检索的任务类型
  situation?: string    // cortex 脑区：情境匹配的描述字符串
}
```

**理由**：
- 不破坏现有调用方（opts 是可选的，旧调用方无需修改）
- 各脑区在调用 `assembleContext` 时传入自己知道的上下文
- 比在 workspace slot 中查询更直接，避免引入不必要的查询

`assembleContext` 同步新增 `opts?: AssembleBlock4Opts` 参数，透传到 `assembleBlock4`。

### 决策 2：`findSimilarSituations` 的 fallback 行为

当 `situation` 为空字符串或 undefined 时，三组均返回空数组（不 fallback 到 `searchMemory`）——语义清晰，避免意外的全量查询。

### 决策 3：ILIKE 查询的构造方式

使用 Drizzle 的 `ilike(memories.content, '%' + situation + '%')` 而非 `sql` 模板——类型安全，与现有 `searchMemory` 风格一致。

### 决策 4：`getEntityContext` 排序

`ORDER BY base_importance DESC, last_accessed_at DESC NULLS LAST`——Drizzle 写法：`.orderBy(desc(memories.baseImportance), sql\`${memories.lastAccessedAt} DESC NULLS LAST\`)`

### 决策 5：单元测试 mock DB 扩展

`assembleBlock4` 单元测试不使用真实 DB，而是 spy 注入——用 `workspace.getEntityContext` 等方法替换为 mock 函数，验证调用路径正确。

---

## Phase 0: Research

无外部未知项。所有技术选择（Drizzle ilike、NULLS LAST、mock 模式）在 Feature 001-004 中已有先例。无需生成 research.md。

---

## Phase 1: Design

### 数据模型变更

**无新字段、无 migration**。所有新方法只读已有字段：
- `entity_id`（Feature 001 已添加）
- `base_importance`（已有）
- `last_accessed_at`（已有）
- `forgotten`（已有）
- `t_invalid`（已有，`excludeInvalid` 逻辑沿用）

### 新方法签名（`src/types/index.ts`）

```typescript
// 追加到 ICognitiveWorkspace 接口
getEntityContext(
  entityId: string,
  opts?: { types?: MemoryType[]; limit?: number }
): Promise<MemoryEntry[]>

findSimilarSituations(
  situation: string,
  opts?: { limit?: number }
): Promise<{ episodes: MemoryEntry[]; procedures: MemoryEntry[]; facts: MemoryEntry[] }>

getProcedure(
  taskType: string,
  opts?: { limit?: number }
): Promise<MemoryEntry[]>
```

### `assembleBlock4` 升级后逻辑

```
limbic:
  if opts.entityId:
    → workspace.getEntityContext(opts.entityId, { limit: 10 })
  else:
    → workspace.searchMemory({ type: 'semantic', limit: 10, excludeInvalid: true })
       + workspace.searchMemory({ type: 'episodic', limit: 5, excludeInvalid: true })
       (保留旧 fallback 行为，entity 未知时不退化)

cortex:
  if opts.situation:
    → workspace.findSimilarSituations(opts.situation, { limit: 5 })
      combine: [...episodes, ...procedures, ...facts]
  else:
    → 旧 fallback（procedural + episodic）

brainstem:
  if opts.taskType:
    → workspace.getProcedure(opts.taskType, { limit: 10 })
  else:
    → 旧 fallback（procedural, limit 10）
```

### SQL 实现规格

**getEntityContext**：

```sql
SELECT * FROM memories
WHERE entity_id = $entityId
  AND forgotten = false
  AND t_invalid IS NULL
  [AND type IN (...types)]    -- 仅 types 非空时
ORDER BY base_importance DESC, last_accessed_at DESC NULLS LAST
LIMIT $limit  -- default 10
```

**findSimilarSituations**（三条并行查询）：

```sql
-- episodes
SELECT * FROM memories
WHERE type = 'episodic' AND forgotten = false AND t_invalid IS NULL
  AND content ILIKE '%' || $situation || '%'
ORDER BY base_importance DESC
LIMIT $limit  -- default 5

-- procedures（同上，type = 'procedural'）
-- facts（同上，type = 'semantic'）
```

**getProcedure**：

```sql
SELECT * FROM memories
WHERE type = 'procedural' AND forgotten = false AND t_invalid IS NULL
  AND content ILIKE '%' || $taskType || '%'
ORDER BY base_importance DESC, last_accessed_at DESC NULLS LAST
LIMIT $limit  -- default 3
```

### 导出更新（`src/index.ts`）

新增：
```typescript
export type { AssembleBlock4Opts } from './context/index'
```

---

## 工作包规划

### WP01 — CognitiveWorkspace 新增三个专属检索方法

**修改文件**：
- `src/workspace/index.ts`：新增 `getEntityContext`、`findSimilarSituations`、`getProcedure` 三个方法
- `src/types/index.ts`：在 `ICognitiveWorkspace` 接口中追加三个方法签名

**子任务**：
- T001: `getEntityContext` 实现（entity_id 等值过滤 + types IN 过滤 + 双重排序）
- T002: `findSimilarSituations` 实现（三条并发 ILIKE 查询，返回分组对象）
- T003: `getProcedure` 实现（type=procedural + ILIKE + 双重排序）
- T004: `ICognitiveWorkspace` 接口更新（三个方法签名）
- T005: 单元测试（mock DB，覆盖边界：空结果、limit、forgotten 过滤、types 过滤）

**依赖**：无
**输出**：`src/workspace/index.ts`、`src/types/index.ts`、`tests/unit/workspace/brain-retrieval.test.ts`

---

### WP02 — assembleBlock4 升级 + AssembleBlock4Opts + 导出

**修改文件**：
- `src/context/index.ts`：新增 `AssembleBlock4Opts` 接口，升级 `assembleBlock4` 和 `assembleContext`
- `src/index.ts`：导出 `AssembleBlock4Opts`

**子任务**：
- T006: `AssembleBlock4Opts` 接口定义（`entityId?`、`taskType?`、`situation?`）
- T007: `assembleBlock4` 签名扩展（新增 `opts?: AssembleBlock4Opts` 参数）
- T008: limbic 分支升级（opts.entityId → `getEntityContext`，fallback 保留）
- T009: cortex 分支升级（opts.situation → `findSimilarSituations`，合并三组结果，fallback 保留）
- T010: brainstem 分支升级（opts.taskType → `getProcedure`，fallback 保留）
- T011: `assembleContext` 签名扩展（透传 opts 到 `assembleBlock4`）
- T012: `src/index.ts` 导出 `AssembleBlock4Opts`
- T013: 单元测试（spy workspace 方法验证路由逻辑，覆盖 opts 有值和无值两种情况）

**依赖**：WP01（调用 WP01 的新方法）
**输出**：`src/context/index.ts`、`src/index.ts`、`tests/unit/context/assembleBlock4.test.ts`

---

### WP03 — 集成测试（真实 DB）

**新建文件**：
- `tests/integration/workspace/brain-retrieval.test.ts`

**子任务**：
- T014: `getEntityContext` 集成测试（写入多实体记忆，验证仅返回目标实体、排序正确、types 过滤生效、forgotten 过滤生效）
- T015: `findSimilarSituations` 集成测试（验证三组分类正确、ILIKE 不含关键词时不返回、limit 生效）
- T016: `getProcedure` 集成测试（验证 type 纯净性、ILIKE 匹配、limit 生效）
- T017: `assembleBlock4` 集成测试（真实 workspace，验证 limbic/cortex/brainstem 路由正确，fallback 路由正确）

**依赖**：WP01、WP02
**输出**：`tests/integration/workspace/brain-retrieval.test.ts`

---

## Definition of Done（全局）

- [ ] `getEntityContext`：entity_id 等值过滤，双重排序，types 可过滤，limit 默认 10
- [ ] `findSimilarSituations`：三组 ILIKE 并行查询，分组返回，limit 独立默认 5
- [ ] `getProcedure`：type=procedural ILIKE，双重排序，limit 默认 3
- [ ] `ICognitiveWorkspace` 接口与实现同步
- [ ] `assembleBlock4` opts 有值时调用专属方法，无值时 fallback 到旧行为（不降级）
- [ ] `AssembleBlock4Opts` 类型从 `src/index.ts` 导出
- [ ] 单元测试：所有新方法边界覆盖（空结果、limit、forgotten、types）
- [ ] 集成测试：真实 DB 验证 ILIKE 语义正确、排序正确
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过（无 `any`，无 non-null assertion，import 排序正确）
