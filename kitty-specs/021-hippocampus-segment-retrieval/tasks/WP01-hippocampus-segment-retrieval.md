---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
  - "T003"
title: "Hippocampus Segment Retrieval — Interface + Tests"
phase: "Phase 1 - Interface + Tests"
lane: "planned"
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

# Work Package Prompt: WP01 — Hippocampus Segment Retrieval

## Objectives & Success Criteria

将 `getSegmentSequence` 和 `getSegmentsByTimeRange` 添加到 `ICognitiveWorkspace` 接口，并为两个方法编写 workspace 单元测试。完成后：

- `ICognitiveWorkspace` 含 `getSegmentSequence(segmentId: string): Promise<MemoryEntry[]>` 方法签名
- `ICognitiveWorkspace` 含 `getSegmentsByTimeRange(range: { from: Date; to: Date }): Promise<Array<{ segmentId: string; eventCount: number; avgImportance: number; maxCreatedAt: Date }>>` 方法签名
- `CognitiveWorkspace` 已实现两个方法（无需修改代码，只需验证签名匹配）
- `bun tsc --noEmit` 零编译错误
- V1–V5 单元测试全部通过

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/021-hippocampus-segment-retrieval/spec.md`
- **Plan**: `kitty-specs/021-hippocampus-segment-retrieval/plan.md` — 含完整实现草稿和 Drizzle 查询
- **Source files**:
  - `src/types/index.ts` — `ICognitiveWorkspace` 接口（新增两个方法签名，约第 183 行 DMN Segment Tracking 区块）
  - `src/workspace/index.ts` — `CognitiveWorkspace` 实现（两个方法已存在，第 494–538 行，无需修改）
  - `tests/unit/workspace/segment-retrieval.test.ts` — 新建，V1–V5 单元测试
- **Depends on**: 无
- **Constraints**:
  - 不修改 `CognitiveWorkspace` 的实现代码——仅在接口中声明签名
  - 返回类型使用 `maxCreatedAt: Date`（匹配实现，而非 `latestAt`）
  - 不新增 DB migration，不修改 schema
  - 不改任何其他 `ICognitiveWorkspace` 方法

---

## Subtasks & Detailed Guidance

### Subtask T001 — 在 `ICognitiveWorkspace` 添加两个方法签名

**Purpose**: 将两个已有实现的方法正式纳入公共接口契约，使所有 workspace 消费者（含测试、未来 adapter）可依赖这两个方法。

**Steps**:

1. 打开 `src/types/index.ts`，找到 `// ── DMN Segment Tracking` 区块（约第 183 行）。

当前内容：
```typescript
  // ── DMN Segment Tracking ─────────────────────────────────────────────────
  getSessionContext(sessionId: string): Promise<{
    anchor: MemoryEntry | null
    events: MemoryEntry[]
  }>
  getLatestSegmentStates(): Promise<Map<string, { segmentId: string; nextSeq: number }>>
}
```

修改后在 `getSessionContext` 前插入两个新方法：
```typescript
  // ── DMN Segment Tracking ─────────────────────────────────────────────────
  getSegmentSequence(segmentId: string): Promise<MemoryEntry[]>
  getSegmentsByTimeRange(
    range: { from: Date; to: Date }
  ): Promise<Array<{ segmentId: string; eventCount: number; avgImportance: number; maxCreatedAt: Date }>>
  getSessionContext(sessionId: string): Promise<{
    anchor: MemoryEntry | null
    events: MemoryEntry[]
  }>
  getLatestSegmentStates(): Promise<Map<string, { segmentId: string; nextSeq: number }>>
}
```

**Files**: `src/types/index.ts`

**Validation**:
- [ ] `grep -n "getSegmentSequence\|getSegmentsByTimeRange" src/types/index.ts` → 两处 match 在接口内

---

### Subtask T002 — 验证 CognitiveWorkspace 满足更新后的接口

**Purpose**: 确认 `CognitiveWorkspace` 实现的两个方法签名与接口声明完全匹配，无编译错误。

**Steps**:

运行：
```bash
cd /Volumes/leoyun/aima && bun tsc --noEmit
```

预期输出：无错误（exit code 0）。

如果有类型错误，检查：
- `getSegmentsByTimeRange` 返回类型是否用了 `maxCreatedAt`（实现在 `src/workspace/index.ts` 第 494–528 行）
- `getSegmentSequence` 返回类型是否为 `Promise<MemoryEntry[]>`

**Files**: 只需验证，不修改

**Validation**:
- [ ] `bun tsc --noEmit` → 零编译错误，exit code 0

---

### Subtask T003 — 单元测试 V1–V5

**Purpose**: 为两个新接口方法编写集成级单元测试，覆盖 quickstart.md 中的 V1–V5 场景。

**Steps**:

参考 `tests/unit/workspace/memory.test.ts` 的测试 DB 初始化模式，新建文件 `tests/unit/workspace/segment-retrieval.test.ts`。

测试场景（参考 quickstart.md）：

**V1** — `getSegmentSequence` 按 `segmentSeq` 升序返回：
- 插入 3 条 episodic memories，`segment_id = 'seg-abc'`，`segmentSeq` 分别为 2, 0, 1
- 调用 `workspace.getSegmentSequence('seg-abc')`
- 断言结果长度为 3，顺序为 segmentSeq 0, 1, 2

**V2** — `getSegmentSequence` 排除软删除条目：
- 插入 3 条 episodic memories，`segment_id = 'seg-def'`
- 将其中 1 条设置 `t_invalid`（调用 `workspace.invalidateMemory(id)`）
- 调用 `workspace.getSegmentSequence('seg-def')`
- 断言结果长度为 2

**V3** — `getSegmentSequence` 对未知 segment 返回空数组：
- 调用 `workspace.getSegmentSequence('seg-unknown')`
- 断言结果为 `[]`

**V4** — `getSegmentsByTimeRange` 返回按 avgImportance 排序的 segments：
- 在时间范围内插入两个 segment 的 memories：
  - `seg-high`：3 条，baseImportance 各 0.9
  - `seg-low`：3 条，baseImportance 各 0.3
- 调用 `workspace.getSegmentsByTimeRange({ from, to })`（to = now + 1min）
- 断言结果长度为 2，第一条是 `seg-high`
- 断言每条含正确的 `eventCount`, `avgImportance`, `maxCreatedAt`

**V5** — `getSegmentsByTimeRange` 排除时间范围外的 segment：
- 插入 `seg-outside` memories（`created_at` 比 `from` 早）
- 插入 `seg-inside` memories（`created_at` 在 `[from, to)` 内）
- 调用 `workspace.getSegmentsByTimeRange({ from, to })`
- 断言只有 `seg-inside` 出现，`seg-outside` 不在结果中

**Files**: `tests/unit/workspace/segment-retrieval.test.ts`（新建）

**Validation**:
- [ ] `bun test tests/unit/workspace/segment-retrieval.test.ts` → 5 个测试全部通过
- [ ] `bun test tests/unit/workspace/` → 零回归

---

## Risks & Mitigations

| 风险 | 可能性 | 缓解方案 |
|---|---|---|
| `CognitiveWorkspace` 实现返回类型与接口不完全匹配 | 低 | T002 的 `bun tsc --noEmit` 会立即暴露，按报错调整接口签名 |
| 测试 DB 初始化模式与当前项目不一致 | 低 | 参考 `tests/unit/workspace/memory.test.ts` 的 beforeAll/beforeEach 模式 |
| `getSegmentsByTimeRange` 时间范围边界（from inclusive, to exclusive）测试设计 | 低 | V5 中明确使用 `created_at < to` 边界，用 `new Date(Date.now() + 60_000)` 作为 to |

## Definition of Done Checklist

- [ ] `grep -n "getSegmentSequence\|getSegmentsByTimeRange" src/types/index.ts` → 两处 match
- [ ] `bun tsc --noEmit` → 零编译错误
- [ ] `bun test tests/unit/workspace/segment-retrieval.test.ts` → V1–V5 全通过
- [ ] `bun test tests/unit/workspace/` → 零回归
- [ ] `bun test tests/unit/hippocampus/sequence-replay.test.ts` → 零回归（这些测试已使用 mock workspace，不受 interface 变更影响）

## Review Guidance

- 验证 T001：新方法签名位于 `ICognitiveWorkspace` 接口内部，`getSegmentsByTimeRange` 返回类型字段名是 `maxCreatedAt`（非 `latestAt`）
- 验证 T002：`bun tsc --noEmit` 无错误即可，无需修改实现
- 验证 T003：V4 测试应验证排序（seg-high 在前），不只是长度；V5 测试应验证 seg-outside 不存在于结果中（而非只检查 seg-inside 存在）

## Activity Log

- 2026-03-13T00:00:00Z – system – lane=planned – Prompt generated via spec-kitty agent workflow
