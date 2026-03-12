---
work_package_id: WP02
title: Workspace Vector Integration
lane: "for_review"
dependencies:
- WP01
subtasks:
- T006
- T007
- T008
- T009
phase: Phase 2 - Integration
assignee: ''
agent: ''
shell_pid: ''
review_status: ''
history:
- timestamp: '2026-03-12T12:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt created.
---

# Work Package Prompt: WP02 — Workspace Vector Integration

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` field. If `has_feedback`, scroll to Review Feedback section.
- **Mark as acknowledged**: Update `review_status: acknowledged` when you begin addressing feedback.

---

## Review Feedback

*[Empty initially — reviewers populate if work is returned.]*

---

## Objectives & Success Criteria

将 embedding 基础设施（WP01）集成到 `CognitiveWorkspace`：
- `writeMemory()` 在 DB 写入后异步生成并存储 embedding（fire-and-forget）
- `findSimilarSituations()` 向量优先检索 + ILIKE fallback
- `getProcedure()` 同样升级
- 单元测试 V1-V7 全部通过

**To implement this WP**:
```bash
spec-kitty implement WP02 --base WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/017-pgvector-semantic-memory-search/spec.md`
- **Plan**: `kitty-specs/017-pgvector-semantic-memory-search/plan.md` — 含完整实现代码草稿
- **Research**: `kitty-specs/017-pgvector-semantic-memory-search/research.md`
- **Quickstart**: `kitty-specs/017-pgvector-semantic-memory-search/quickstart.md` — V1-V7 验证场景
- **Target file**: `src/workspace/index.ts`（主要改动）
- **Test file**: `tests/unit/workspace/` 目录（现有文件或新文件）
- **Depends on**: WP01（需要 `EmbeddingConfig`、`generateEmbedding`、`CognitiveWorkspaceConfig.embedding` 字段已存在）

**Key imports needed**:
```typescript
import { generateEmbedding } from '../embedding'
import { cosineDistance } from 'drizzle-orm/sql/functions'
import { isNotNull, asc } from 'drizzle-orm'
```

**Constraints**:
- `writeMemory()` 的返回时间不受 embedding 生成影响（fire-and-forget）
- `config.embedding === undefined` 时行为与修改前**完全一致**（零改变）
- `MemoryEntry` 公共类型不变——不暴露 `embedding` 字段
- 向量检索无结果时必须 fallback ILIKE，不能返回空数组

---

## Subtask Details

### T006 — `generateAndStoreEmbedding()` + `writeMemory()` 集成

**Purpose**: 每次新记忆写入后，异步生成并更新其 embedding，不阻断写入流程。

**Steps**:

1. 在 `CognitiveWorkspace` 类中新增私有方法（靠近 `writeMemory()` 位置）：

```typescript
private async generateAndStoreEmbedding(id: string, content: string): Promise<void> {
  const embedding = await generateEmbedding(content, this.config.embedding!)
  await this.db
    .update(memories)
    .set({ embedding })
    .where(eq(memories.id, id))
}
```

2. 在 `writeMemory()` 方法中，找到 DB 写入成功后的位置，追加 fire-and-forget 调用：

```typescript
// writeMemory 末尾（DB insert/update 成功后）
if (this.config.embedding != null) {
  this.generateAndStoreEmbedding(id, content).catch(() => {})
}
```

> 注：`id` 是新写入记忆的 UUID（写入时生成），`content` 是 `entry.content`。

**Files**: `src/workspace/index.ts`

**Validation**:
- [ ] `generateAndStoreEmbedding()` 方法存在，使用 `this.config.embedding!`
- [ ] `writeMemory()` 末尾有 `if (this.config.embedding != null)` + `.catch(() => {})`
- [ ] `writeMemory()` 的 await 不包含 embedding 生成（fire-and-forget）

---

### T007 — 升级 `findSimilarSituations()`

**Purpose**: 有 embedding 时优先向量检索，无结果时回退 ILIKE，行为对调用方透明。

**Steps**:

找到 `findSimilarSituations()` 方法（约 627 行附近），在其内部按以下逻辑重构：

```typescript
async findSimilarSituations(
  situation: string,
  opts?: { limit?: number },
): Promise<{ episodes: MemoryEntry[]; procedures: MemoryEntry[]; facts: MemoryEntry[] }> {
  const lim = opts?.limit ?? 5

  // Vector path: only when embedding config is set and situation is non-empty
  if (this.config.embedding != null && situation.trim() !== '') {
    try {
      const queryEmbedding = await generateEmbedding(situation, this.config.embedding)

      const vectorQuery = (type: MemoryType) =>
        this.db
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.type, type),
              eq(memories.forgotten, false),
              isNull(memories.tInvalid),
              isNotNull(memories.embedding),
            ),
          )
          .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
          .limit(lim)

      const [episodeRows, procedureRows, factRows] = await Promise.all([
        vectorQuery('episodic'),
        vectorQuery('procedural'),
        vectorQuery('semantic'),
      ])

      // Return vector results if any type has results
      if (episodeRows.length > 0 || procedureRows.length > 0 || factRows.length > 0) {
        return {
          episodes: episodeRows.map(mapMemoryRow),
          procedures: procedureRows.map(mapMemoryRow),
          facts: factRows.map(mapMemoryRow),
        }
      }
      // else: no embeddings exist yet, fall through to ILIKE
    } catch {
      // generateEmbedding failed (API error, timeout, etc.) → fall through to ILIKE
    }
  }

  // ILIKE fallback (original logic — preserved exactly)
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

**Files**: `src/workspace/index.ts`

**Validation**:
- [ ] 向量路径在 `config.embedding != null && situation.trim() !== ''` 时触发
- [ ] 向量路径有 try/catch，失败时 fallback ILIKE
- [ ] 向量路径无结果时 fallback ILIKE（不返回空数组）
- [ ] ILIKE 路径与原始逻辑完全一致（复制原代码，不改逻辑）

---

### T008 — 升级 `getProcedure()`

**Purpose**: 同 T007，对 procedural 类型使用向量优先检索。

**Steps**:

找到 `getProcedure()` 方法（约 668 行附近），在其内部同样加向量优先逻辑：

```typescript
async getProcedure(taskType: string, opts?: { limit?: number }): Promise<MemoryEntry[]> {
  const lim = opts?.limit ?? 3

  // Vector path
  if (this.config.embedding != null && taskType.trim() !== '') {
    try {
      const queryEmbedding = await generateEmbedding(taskType, this.config.embedding)
      const rows = await this.db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.type, 'procedural'),
            eq(memories.forgotten, false),
            isNull(memories.tInvalid),
            isNotNull(memories.embedding),
          ),
        )
        .orderBy(asc(cosineDistance(memories.embedding, queryEmbedding)))
        .limit(lim)

      if (rows.length > 0) {
        return rows.map(mapMemoryRow)
      }
      // else: fall through to ILIKE
    } catch {
      // fall through to ILIKE
    }
  }

  // ILIKE fallback (original logic)
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
    .limit(lim)

  return rows.map(mapMemoryRow)
}
```

**Files**: `src/workspace/index.ts`

**Validation**:
- [ ] 向量路径与 T007 同样的 try/catch + fallback 结构
- [ ] 默认 limit 保持为 3（与原来一致）
- [ ] ILIKE fallback 完全保留原始 `orderBy(desc(baseImportance), desc(lastAccessedAt))`

---

### T009 — 单元测试 V1-V7

**Purpose**: 覆盖 quickstart.md 定义的 7 个验证场景，确保向量检索和 fallback 行为正确。

**Steps**:

在 `tests/unit/workspace/` 目录下，找到或新建测试文件（推荐新建 `embedding-search.test.ts` 以避免修改现有测试文件）。

测试文件需要 mock 两件事：
1. `generateEmbedding`（避免真实 OpenAI API 调用）
2. DB `memories` 表（使用现有的 `MockCognitiveWorkspace` 或 `makeWorkspaceConfig()` 辅助函数）

查看现有的 workspace 测试文件了解 mock 模式。在 `tests/unit/workspace/` 目录查找辅助函数。

**V1 — 向量检索召回语义相似记忆**:
```typescript
it('V1: vector search recalls semantically similar memory', async () => {
  // Arrange: workspace with embedding config
  // Mock generateEmbedding: any text → fixed vector [0.1, 0.2, ...]
  // Pre-populate: episodic memory with embedding
  // Act: findSimilarSituations('some query')
  // Assert: episodic result returned (vector path used)
  // Assert: generateEmbedding was called
})
```

**V2 — embedding=null 记忆回退 ILIKE**:
```typescript
it('V2: falls back to ILIKE for memories without embedding', async () => {
  // Arrange: memory without embedding, config.embedding set
  // Mock generateEmbedding → vector (but no embedding in DB)
  // Vector query returns 0 results → ILIKE fallback
  // Memory has content matching ILIKE pattern
  // Assert: memory returned via ILIKE
})
```

**V3 — generateEmbedding 失败不阻断 writeMemory**:
```typescript
it('V3: embedding generation failure does not block writeMemory', async () => {
  // Arrange: mock generateEmbedding → throw Error('rate limit')
  // Act: await writeMemory({...})
  // Assert: no exception thrown
  // Assert: memory exists in DB (embedding=null)
})
```

**V4 — getProcedure 向量检索**:
```typescript
it('V4: getProcedure uses vector search when embedding configured', async () => {
  // Similar to V1 but for procedural type
})
```

**V5 — embedding=undefined 时完全降级**:
```typescript
it('V5: no embedding calls when config.embedding is undefined', async () => {
  // Arrange: workspace without embedding config
  // Spy on generateEmbedding
  // Act: writeMemory() + findSimilarSituations()
  // Assert: generateEmbedding not called (spy.mock.calls.length === 0)
})
```

**V6 — 向量路径抛异常时静默 fallback**:
```typescript
it('V6: vector path exception falls back silently to ILIKE', async () => {
  // Arrange: mock generateEmbedding → throw in findSimilarSituations
  // Assert: function still returns result (via ILIKE), no exception propagated
})
```

**V7 — 零回归（通过运行现有测试套件验证）**:
```bash
bun test tests/unit/workspace/
# 现有所有测试仍通过
```

**Files**:
- `tests/unit/workspace/embedding-search.test.ts`（新建，推荐）

**Validation**:
- [ ] V1-V6 各有对应 test case
- [ ] 所有测试通过（`bun test tests/unit/workspace/` 全绿）
- [ ] 现有测试无回归
- [ ] 不调用真实 OpenAI API（所有 generateEmbedding 都是 mock）

---

## Definition of Done

- [ ] T006: `writeMemory()` 有 fire-and-forget embedding 调用，V3 通过
- [ ] T007: `findSimilarSituations()` 向量优先 + fallback，V1/V2 通过
- [ ] T008: `getProcedure()` 向量优先 + fallback，V4 通过
- [ ] T009: V1-V6 测试全部存在且通过
- [ ] `config.embedding=undefined` 时行为与修改前完全一致（V5 通过）
- [ ] `bun test tests/unit/workspace/` 全绿
- [ ] `bun test` 全量零新增 failure

## Risks

- `cosineDistance()` 函数在 Drizzle ORM 中需要 `memories.embedding` 列不为 null；使用 `isNotNull(memories.embedding)` 过滤确保这一点
- 测试环境中 mock DB 不支持 pgvector 运算符（`<=>`）——测试应直接 mock `generateEmbedding` 并通过返回值验证行为，不依赖实际向量计算
- `cosineDistance` 可能需要 `import { cosineDistance } from 'drizzle-orm/sql/functions'`——确认这个路径在 drizzle-orm v0.38.4 中存在（研究已确认）

## Reviewer Guidance

- 验证 T006 的 `.catch(() => {})` 存在且在 `if (this.config.embedding != null)` 块内
- 验证 T007/T008 的 fallback 是真正的 fallback（向量无结果才 fallback，不是总是执行两次）
- 验证 `MemoryEntry` 类型未新增 `embedding` 字段
- 运行 `bun test` 确认零回归

## Activity Log

- 2026-03-12T13:45:15Z – unknown – lane=for_review – Moved to for_review
