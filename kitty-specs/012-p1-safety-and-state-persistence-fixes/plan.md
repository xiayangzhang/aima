# Implementation Plan: P1 Safety & State Persistence Fixes

**Branch**: `012-p1-safety-and-state-persistence-fixes` | **Date**: 2026-03-12 | **Spec**: [spec.md](spec.md)

## Summary

修复三个在代码审查中确认的 P1 bug，均已有明确的根因和修复路径。无需额外研究；技术决策在代码审查过程中已全部确定。

| Bug | 根因 | 修复范围 |
|---|---|---|
| DEFER 状态转换缺失 | `runner/index.ts` DEFER 分支写 pending 后直接 return，未调 `updateThreadState('waiting')`；崩溃恢复扫描 `active` 状态时误包含 `waiting` | runner + workspace |
| Signal 线程隔离缺失 | `BrainSignal` 无 `threadId`；workspace signals 按 type 全局 FIFO | types + adapters + workspace |
| Segment State 无持久化 | DMN Reactive `threadSegments` Map 只存内存 | DMN reactive + threads schema + workspace |

---

## Technical Context

**Language/Version**: TypeScript (Bun runtime)
**Primary Dependencies**: Drizzle ORM, PostgreSQL, `@mariozechner/pi-agent-core`
**Storage**: PostgreSQL（已有 threads / slots / memories / pending_observations 表）
**Testing**: `bun test`，分 unit（mock DB）和 integration（真实 PostgreSQL）两层
**Target Platform**: Linux server / Kubernetes
**Project Type**: Single TypeScript package (`src/`)
**Performance Goals**: 修复不引入新的同步阻塞；segment state 写入与 episodic 记录写入在同一事务
**Constraints**: 不破坏现有 Feature 002 测试套件（39 项）；不改变对外 API 形态

---

## Constitution Check

### 实现标准

- **1.1 不敷衍** ✓ — 每个 FR 有对应的具体实现步骤，不以"近似"替代
- **1.2 不降级** ✓ — 信号查询必须按 `${threadId}:${type}` 查，不 fallback 到全局查询
- **1.3 不过度工程** ✓ — segment state 用 threads 表 JSONB 字段扩展，不新建独立表

### 测试标准

- **2.1 真实测试** ✓ — Signal 隔离和 Segment 持久化均涉及 DB 语义，必须有集成测试
- **2.2 边界覆盖** ✓ — 测试矩阵见 quickstart.md
- **2.3 测试隔离** ✓ — 每个集成测试块独立 db/client，afterEach 清理测试数据

### 代码质量

- **3.1 类型安全** ✓ — `BrainSignal` 增加 `threadId: string`（必填），所有调用方同步更新
- **3.2 Biome 合规** ✓ — 每个 WP 完成后运行 `bun run typecheck` + `biome check`
- **3.3 一致性** ✓ — Drizzle ORM 风格与已有 workspace.ts 保持一致

**Constitution Check PASSED — 无违规。**

---

## Project Structure

### Documentation (this feature)

```
kitty-specs/012-p1-safety-and-state-persistence-fixes/
├── plan.md              ← 本文件
├── data-model.md        ← Thread schema 变更 + BrainSignal 类型变更
├── quickstart.md        ← 验证场景
└── tasks.md             ← /spec-kitty.tasks 生成
```

### Source Code (affected files)

```
src/
├── types/index.ts              — BrainSignal 增加 threadId 字段
├── adapters/index.ts           — BrainSignal 类型定义同步更新
├── runner/index.ts             — Fix 1: DEFER 分支加 updateThreadState('waiting')
│                                 Fix 1: recoverInFlightThreads 跳过 waiting 状态
├── workspace/index.ts          — Fix 2: signals 存储改为 Map<string, BrainSignal[]>
│                                 Fix 2: pushSignal / popSignal / hasSignal 接口更新
│                                 Fix 3: getActiveThreads 过滤逻辑
│                                 Fix 3: 新增 updateThreadSegmentState / getThreadSegmentStates
├── dmn/reactive/index.ts       — Fix 3: 启动时从 DB 加载 segment state
│                                 Fix 3: 每次写 episodic 后持久化 segment state
└── schema/threads.ts           — Fix 3: 增加 segmentState JSONB 列（nullable）

tests/
├── unit/
│   ├── runner/defer.test.ts    — 新建：DEFER 状态转换单元测试
│   └── workspace/signals.test.ts — 新建：Signal 隔离单元测试（mock DB）
└── integration/
    ├── workspace/signals.integration.test.ts — 新建：Signal 并发隔离集成测试
    └── dmn/segment-persistence.integration.test.ts — 新建：Segment 持久化集成测试
```

---

## Phase 0: Research

本 Feature 无需外部研究。三个 bug 的根因和修复路径已在代码审查中完全确认：

- **DEFER fix**: runner.ts L130-139 确认缺失一行，fix 路径明确
- **Signal fix**: workspace.ts signals Map 结构确认，BrainSignal 类型确认缺 threadId
- **Segment fix**: DMN reactive `threadSegments` 确认为内存 Map，threads schema 确认无 segmentState 字段

**研究结论**：无 NEEDS CLARIFICATION，直接进入 Phase 1 设计。

---

## Phase 1: Design

### Fix 1 — DEFER 状态转换

**根因**：`runner/index.ts:130-139`

```typescript
// 当前（有 bug）
} else if (mode === 'DEFER') {
    await this.workspace.writePending({ ... })
    return  // ← Thread 仍为 active
}

// 修复后
} else if (mode === 'DEFER') {
    await this.workspace.updateThreadState(threadId, 'waiting')
    await this.workspace.writePending({ ... })
    return
}
```

**崩溃恢复联动修复**：`recoverInFlightThreads()` 当前调用 `getActiveThreads()`，该方法返回 `state NOT IN ('complete', 'interrupted')`，会包含 `waiting` 状态。需在查询中排除 `waiting`，或在循环内跳过：

```typescript
// workspace.getActiveThreads() 修改过滤条件：
// state NOT IN ('complete', 'interrupted', 'waiting')
// 或在 recoverInFlightThreads 内显式跳过 waiting 状态
```

**设计决策**：在 `getActiveThreads()` 中排除 `waiting`，语义更准确（"需要处理的 active 线程"不包括正在等待的线程）。

---

### Fix 2 — BrainSignal 线程隔离

**类型变更**（`src/types/index.ts` 或 `src/adapters/index.ts`）：

```typescript
// 当前
interface BrainSignal {
  type: BrainSignalType
  message: string
  causationId?: string
}

// 修复后
interface BrainSignal {
  type: BrainSignalType
  threadId: string          // 必填，信号归属的 Thread
  message: string
  causationId?: string
}
```

**Workspace 存储变更**（`src/workspace/index.ts`）：

```typescript
// 当前：Map<BrainSignalType, BrainSignal[]>
// 修复后：Map<string, BrainSignal[]>  key = `${threadId}:${type}`

pushSignal(signal: BrainSignal): void
popSignal(type: BrainSignalType, threadId: string): BrainSignal | undefined
hasSignal(type: BrainSignalType, threadId: string): boolean
```

**调用方更新**：所有 `pushSignal` 调用处加 `threadId`；所有 `popSignal/hasSignal` 调用处加 `threadId` 参数。主要调用方：
- `amygdala/index.ts` — pushSignal
- `adapters/claude-sdk/index.ts` — popSignal（canUseTool hook）
- `adapters/pi-agent/index.ts` — pushSignal + popSignal

---

### Fix 3 — Segment State 持久化

**Schema 变更**（`src/schema/threads.ts`）：

```typescript
// threads 表新增字段
segmentState: jsonb('segment_state').$type<Record<string, { segmentId: string; nextSeq: number }>>()
// nullable，默认 null（向后兼容）
// 结构：{ [threadId]: { segmentId: string; nextSeq: number } }
// 注意：key 是 thread 内部的脑区标识，实际 DMN 用 threadId 作 key
```

实际上 `threadSegments` 是 `Map<threadId, {segmentId, nextSeq}>`，存在 threads 表上不合适（一个 thread 只有自己的 segment 信息）。更合理的设计：

**最终设计**：将 `segmentState` 直接存在各自 Thread 行上，字段类型为：

```typescript
// threads 表
segmentState: jsonb('segment_state').$type<{ segmentId: string; nextSeq: number } | null>()
```

即每个 Thread 行存自己的当前 segment 状态。DMN Reactive 在写 episodic 后，同步 `UPDATE threads SET segment_state = $state WHERE id = $threadId`。

**Workspace 新增方法**：

```typescript
updateThreadSegmentState(threadId: string, state: { segmentId: string; nextSeq: number }): Promise<void>
getThreadSegmentState(threadId: string): Promise<{ segmentId: string; nextSeq: number } | null>
```

**DMN Reactive 启动恢复**：

```typescript
// start() 时：
const activeThreads = await workspace.getActiveThreads()
for (const thread of activeThreads) {
  if (thread.segmentState) {
    this.threadSegments.set(thread.id, thread.segmentState)
  }
}
```

**DMN Reactive 写入时持久化**（每次更新 `threadSegments` Map 后）：

```typescript
this.threadSegments.set(threadId, newState)
await workspace.updateThreadSegmentState(threadId, newState)
```

**DB Migration**：新增 `ALTER TABLE threads ADD COLUMN segment_state jsonb`（nullable，无 default 即为 null）。

---

## Quickstart（验证场景）

见 [quickstart.md](quickstart.md)

---

## Implementation Order（WP 拆分建议）

三个 fix 独立，建议拆为 3 个 WP：

| WP | 内容 | 依赖 | 测试重点 |
|---|---|---|---|
| WP01 | Fix 1: DEFER 状态转换 + 崩溃恢复修复 | 无 | Thread state machine，crash recovery skip waiting |
| WP02 | Fix 2: BrainSignal 线程隔离 | 无 | 并发信号不跨 Thread |
| WP03 | Fix 3: Segment State 持久化 + Migration | 无 | 重启后 segment 链连续 |

三个 WP 无相互依赖，可串行或并行执行。
