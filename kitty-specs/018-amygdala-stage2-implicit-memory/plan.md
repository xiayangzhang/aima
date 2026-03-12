# Implementation Plan: Amygdala Stage 2 Implicit Memory
*Path: kitty-specs/018-amygdala-stage2-implicit-memory/plan.md*

**Branch**: `018-amygdala-stage2-implicit-memory` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/kitty-specs/018-amygdala-stage2-implicit-memory/spec.md`

## Summary

替换 `src/amygdala/index.ts` 中 Stage 2 的 `const memoryResult = null` 存根，改为真实的隐性记忆检索。同时在 `ICognitiveWorkspace` interface 和 `CognitiveWorkspace` 实现中新增 `getByTags` 方法，供 Stage 2 调用。

## Technical Context

**Language/Version**: TypeScript (Bun runtime)
**Primary Dependencies**: `drizzle-orm`（`arrayContains`，已有），`src/workspace/index.ts`（现有 workspace 实现）
**Storage**: `memories` 表（只读查询，无 schema 变更）
**Testing**: Bun test
**Target Platform**: Linux server (AKS)
**Project Type**: Single project
**Performance Goals**: Stage 2 查询 < 10ms（简单 tag AND 查询 + ORDER BY + LIMIT 5）
**Constraints**: 不改 `check()` 方法签名；不改 Stage 1 逻辑；Stage 2 失败必须静默穿透；不写入任何新记忆
**Scale/Scope**: 改动 ~60 行代码（interface + workspace impl + amygdala），新增 ~5 个测试

## Constitution Check

*无 constitution 文件，跳过。*

## Project Structure

### Documentation (this feature)

```
kitty-specs/018-amygdala-stage2-implicit-memory/
├── plan.md
├── quickstart.md
└── tasks/
```

### Source Code (repository root)

```
src/
├── types/index.ts              # ICognitiveWorkspace 新增 getByTags 方法签名
├── workspace/index.ts          # CognitiveWorkspace 新增 getByTags 实现
└── amygdala/index.ts           # Stage 2 存根替换

tests/unit/amygdala/
└── amygdala.test.ts            # 新增 Stage 2 测试场景
```

**Structure Decision**: Single project，改动集中在 3 个源文件 + 测试更新。

## Phase 0: Research

**代码审查结论**：

| 决策 | 结论 | 依据 |
|---|---|---|
| `getByTags` 是否已有 | **不存在** — `ICognitiveWorkspace` 和 `CognitiveWorkspace` 中均无此方法 | 直接在 `src/types/index.ts` 和 `src/workspace/index.ts` 中 grep 确认 |
| 查询模式 | `arrayContains(memories.tags, tags)` + `desc(memories.createdAt)` + `limit` | `searchMemory` 已有 `arrayContains` 用法，直接复用 |
| Stage 2 插入点 | `check()` 中 `const memoryResult = null` 那两行（约第 76-77 行） | 直接读源码确认 |
| `workspace` 字段类型 | `CognitiveWorkspace`（不是 `ICognitiveWorkspace`）— Amygdala 构造函数直接接收 `CognitiveWorkspace` | `src/amygdala/index.ts` 第 52 行 |
| `implicit` 记忆 content 格式 | `JSON.stringify({ tool: toolName, decision, reason })` | Feature 016 `writeEvalMemory` 已确立 |
| tags 格式 | `['amygdala_eval', toolName, decision]` | Feature 016 `writeEvalMemory` 已确立 |
| 排序逻辑 | 按 `createdAt` 降序，取 `sorted[0]` | 最近决策最相关 |

### getByTags 实现草稿（workspace/index.ts）

```typescript
async getByTags(
  tags: string[],
  timeRange?: { after?: Date; before?: Date },
  limit?: number,
): Promise<MemoryEntry[]> {
  const conditions = [
    arrayContains(memories.tags, tags),
    isNull(memories.tInvalid),
  ]
  if (timeRange?.after) conditions.push(gt(memories.createdAt, timeRange.after))
  if (timeRange?.before) conditions.push(lt(memories.createdAt, timeRange.before))

  const rows = await this.db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.createdAt))
    .limit(limit ?? 20)

  return rows.map(mapMemoryRow)
}
```

### ICognitiveWorkspace 新增方法签名（types/index.ts）

```typescript
getByTags(
  tags: string[],
  timeRange?: { after?: Date; before?: Date },
  limit?: number,
): Promise<MemoryEntry[]>
```

### Stage 2 实现草稿（amygdala/index.ts）

替换当前存根（第 74-77 行）：
```typescript
// Stage 2: Implicit memory match (medium/high tools)
// Stub for Feature 002 transition period — full implementation in DMN Reactive feature
const memoryResult: { decision: AmygdalaDecision; reason: string } | null = null
if (memoryResult) return memoryResult
```

替换为：
```typescript
// Stage 2: Implicit memory match (medium/high tools)
try {
  const history = await this.workspace.getByTags(['amygdala_eval', toolName], undefined, 5)
  if (history.length > 0) {
    // Use most recent decision (sort by createdAt desc, take first)
    const sorted = history.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    const recent = sorted[0]
    const parsed = JSON.parse(recent.content) as { tool: string; decision: string; reason: string }
    const validDecisions: AmygdalaDecision[] = ['allow', 'block', 'escalate']
    if (validDecisions.includes(parsed.decision as AmygdalaDecision)) {
      return {
        decision: parsed.decision as AmygdalaDecision,
        reason: `[memory] ${parsed.reason}`,
      }
    }
  }
} catch {
  // getByTags failed — fall through to Stage 3
}
```

## Complexity Tracking

*无 Constitution 违规，跳过。*
