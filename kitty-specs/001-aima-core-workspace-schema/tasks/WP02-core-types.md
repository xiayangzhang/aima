---
work_package_id: WP02
title: 核心类型定义
lane: "for_review"
dependencies: []
subtasks:
- T007
- T008
- T009
- T010
- T011
phase: Phase 1 - Foundation
assignee: ''
agent: "claude"
shell_pid: "90215"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-10T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP02 — 核心类型定义

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, read Review Feedback section first.

---

## Review Feedback

*[Empty — no feedback yet]*

---

## Objectives & Success Criteria

在 `src/types/index.ts` 建立所有核心枚举和接口的单一权威来源。完成标准：
- `bun run typecheck` 零错误
- `import type { BrainType, ThreadState, ICognitiveWorkspace } from './src/types/index.ts'` 编译无误
- 所有枚举值与 `contracts/workspace.ts` 和 `data-model.md` 完全一致
- 无 `any` 类型（`biome check .` 通过 `noExplicitAny` 规则）

## Context & Constraints

- **Repo**: `/Volumes/leoyun/aima/`
- **Plan**: `kitty-specs/001-aima-core-workspace-schema/plan.md`
- **Contracts**: `kitty-specs/001-aima-core-workspace-schema/contracts/workspace.ts`（权威接口定义）
- **CLAUDE.md**: Runtime = Bun v1.x，TypeScript strict，ESM-only，Biome，`noExplicitAny: error`
- **依赖**: WP01 已完成（tsconfig 就位）

实现命令：`spec-kitty implement WP02 --base WP01`

---

## Subtasks & Detailed Guidance

### T007 — 定义核心枚举

**Purpose**: 建立全部枚举类型——这些是整个系统的命名常量，Drizzle pgEnum 会直接引用这些值。

**Steps**:
1. 在 `src/types/index.ts` 开头（文件第一部分）定义以下枚举：

```typescript
// ─── Brain & Cognitive ────────────────────────────────────────────────────────

export type BrainType = 'limbic' | 'cortex' | 'brainstem' | 'amygdala' | 'dmn'

// BrainAdapter 只处理三个认知脑区，Amygdala 和 DMN 不走标准 BrainAdapter
export type CognitiveBrainType = 'limbic' | 'cortex' | 'brainstem'

// ─── Thread & Slot ────────────────────────────────────────────────────────────

export type ThreadState = 'active' | 'waiting' | 'complete' | 'interrupted'

export type SlotStatus = 'pending' | 'running' | 'done' | 'error'

// Cortex 专用：此次 Thread 的处理意图
export type Intent = 'communicate' | 'execute' | 'both'

// Cortex 专用（可选注解）：供 Brainstem 判断是否启动子执行 session
export type ComplexityHint = 'simple' | 'complex'

// ─── Memory ───────────────────────────────────────────────────────────────────

export type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'working' | 'implicit'

// markMemoryUsed 调用时传入的结果类型
export type UsageOutcome = 'positive' | 'negative' | 'neutral'
```

**注意事项**:
- 不要定义 `EventLevel`、`RiskLevel`、`SkillType`——这些不属于 Feature 001 的核心 workspace 类型
- 每个 enum 的注释要说明其**用途**（谁用、在哪用），不要用生物学类比解释

**Files**: `src/types/index.ts`（创建文件）

---

### T008 — 定义实体接口

**Purpose**: 定义从数据库读出的实体形态——这是 DAO 方法的返回值类型。

**Steps**:
1. 在 T007 枚举之后，添加实体接口：

```typescript
// ─── Entity Types ─────────────────────────────────────────────────────────────

export interface Thread {
  id: string
  state: ThreadState
  sourceChannel: string | null   // null = DMN-initiated, no external channel
  initiatedBy: string            // 'dmn' | 'external:teams' | 'external:webhook' etc.
  trigger: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Slot {
  id: string
  threadId: string
  brain: BrainType
  status: SlotStatus
  input: unknown | null
  output: unknown | null
  intent: Intent | null           // Cortex only
  complexityHint: ComplexityHint | null  // Cortex only, optional annotation
  executionSessionId: string | null      // Brainstem only
  createdAt: Date
  updatedAt: Date
}

export interface UsageOutcomes {
  positive: number
  negative: number
  neutral: number
}

export interface MemoryEntry {
  id: string
  type: MemoryType
  content: string                 // Brain action description, NOT raw input text
  entityId: string | null
  segmentId: string | null        // episodic only
  segmentSeq: number | null       // episodic only
  tags: string[]
  baseImportance: number          // 0.0–1.0
  usageOutcomes: UsageOutcomes
  sourceBrain: BrainType | null
  threadId: string | null         // working memory only
  sessionId: string | null
  supersedesId: string | null
  tInvalid: Date | null           // null = valid; non-null = soft-deleted
  lastAccessedAt: Date | null
  pinned: boolean
  forgotten: boolean
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface PendingObservation {
  id: string
  targetBrain: BrainType
  note: string
  triggerAt: Date | null          // null = route immediately
  expiresAt: Date                 // required TTL
  baseImportance: number
  addedAt: Date
}
```

**注意**:
- `MemoryEntry.content` 的注释非常重要：存储的是脑区的**行为描述**，不是原始输入
- 字段名全部用 camelCase（TypeScript 惯例），DB 列名 snake_case 由 Drizzle 映射

**Files**: `src/types/index.ts`（追加）

---

### T009 — 定义输入/参数类型

**Purpose**: 定义写入操作的输入参数——这些是 ICognitiveWorkspace 方法的参数类型。

**Steps**:
1. 继续在同一文件追加：

```typescript
// ─── Input Types ─────────────────────────────────────────────────────────────

export interface CreateThreadParams {
  trigger?: string
  initiatedBy: string
  sourceChannel?: string | null
}

export interface WriteSlotParams {
  status?: SlotStatus
  input?: unknown
  output?: unknown
  intent?: Intent | null
  complexityHint?: ComplexityHint | null
  executionSessionId?: string | null
}

export interface CreateMemoryParams {
  type: MemoryType
  content: string
  entityId?: string
  segmentId?: string
  segmentSeq?: number
  tags?: string[]
  baseImportance?: number
  sourceBrain?: BrainType
  threadId?: string
  sessionId?: string
  supersedesId?: string          // triggers atomic invalidation of old record
  expiresAt?: Date
  pinned?: boolean
}

export interface MemorySearchFilters {
  type?: MemoryType
  tags?: string[]                // AND match: entry must have ALL specified tags
  entityId?: string
  segmentId?: string
  excludeInvalid?: boolean       // default true (filter WHERE t_invalid IS NULL)
  limit?: number                 // default 20
}

export interface CreatePendingParams {
  targetBrain: BrainType
  note: string
  triggerAt?: Date | null
  expiresAt: Date
  baseImportance?: number
}
```

**设计要点**:
- `WriteSlotParams` 所有字段都是 optional——调用方按需传入（完整覆盖旧 slot）
- `MemorySearchFilters.tags` 是 AND 匹配：entry 必须包含所有指定 tag
- `CreateMemoryParams.supersedesId` 存在时，DAO 层会原子地将旧记录标记为失效

**Files**: `src/types/index.ts`（追加）

---

### T010 — 定义 ICognitiveWorkspace 接口

**Purpose**: 公共 API 的顶层接口——CognitiveWorkspace class 实现此接口，外部调用方依赖此类型。

**Steps**:
1. 追加接口定义（与 `contracts/workspace.ts` 完全对齐）：

```typescript
// ─── CognitiveWorkspace Interface ────────────────────────────────────────────

export interface ICognitiveWorkspace {
  // ── Thread ──────────────────────────────────────────────────────────────
  createThread(params: CreateThreadParams): Promise<Thread>
  getThread(id: string): Promise<Thread | null>
  updateThreadState(id: string, state: ThreadState): Promise<void>
  getActiveThreads(): Promise<Thread[]>          // state NOT IN ('complete')

  // ── Slot ────────────────────────────────────────────────────────────────
  writeSlot(threadId: string, brain: BrainType, data: WriteSlotParams): Promise<Slot>
  readSlot(threadId: string, brain: BrainType): Promise<Slot | null>
  getSlotsByThread(threadId: string): Promise<Slot[]>

  // ── Pending Observations ────────────────────────────────────────────────
  writePending(params: CreatePendingParams): Promise<PendingObservation>
  getPendingObservations(): Promise<PendingObservation[]>
  removeExpiredPending(now: Date): Promise<void>
  removePending(id: string): Promise<void>

  // ── Memory ──────────────────────────────────────────────────────────────
  writeMemory(params: CreateMemoryParams): Promise<MemoryEntry>
  searchMemory(filters: MemorySearchFilters): Promise<MemoryEntry[]>
  markMemoryUsed(ids: string[], outcome: UsageOutcome): Promise<void>
  clearWorkingMemory(threadId: string): Promise<void>
}
```

2. 对比 `contracts/workspace.ts` 逐行核对，确认方法签名完全一致。

**Files**: `src/types/index.ts`（追加）

---

### T011 — 验证类型

**Purpose**: 用编译器验证整个类型文件无错误，确保所有引用都正确。

**Steps**:
1. 在 `src/types/index.ts` 最后不添加任何实现代码，只有类型定义。
2. 运行：
```bash
cd /Volumes/leoyun/aima
bun run typecheck
```
3. 运行：
```bash
biome check src/types/index.ts
```
4. 预期结果：零错误，零警告。

**可能的问题**:
- `unknown | null` 类型——Drizzle 的 JSONB 字段映射结果，TypeScript 允许此用法
- 如果 biome 报 `noExplicitAny`，确认代码中没有 `any` 类型（`unknown` 是允许的）

**Files**: 只运行命令，不修改文件

---

## Risks & Mitigations

- **类型与 DB schema 枚举不同步**: WP03 的 pgEnum 定义必须直接使用这里定义的类型值（如 `brainTypeEnum` 的值列表应与 `BrainType` 完全一致），不要重复定义
- **`unknown` vs `any`**: JSONB 字段映射用 `unknown`，绝不用 `any`

## Definition of Done Checklist

- [ ] T007: 所有枚举定义完整（BrainType/CognitiveBrainType/ThreadState/SlotStatus/Intent/ComplexityHint/MemoryType/UsageOutcome）
- [ ] T008: 所有实体接口定义（Thread/Slot/UsageOutcomes/MemoryEntry/PendingObservation）
- [ ] T009: 所有输入类型定义（CreateThreadParams/WriteSlotParams/CreateMemoryParams/MemorySearchFilters/CreatePendingParams）
- [ ] T010: ICognitiveWorkspace 接口与 contracts/workspace.ts 逐行对齐
- [ ] T011: `bun run typecheck` 零错误，`biome check src/types/index.ts` 通过

## Review Guidance

- 核对 `BrainType` 值（5个）与 data-model.md 的 `brain_type` pgEnum 值一致
- 核对 `MemoryEntry.content` 注释是否明确说明"脑区行为描述，不是原始输入"
- 核对 `ICognitiveWorkspace` 方法签名是否与 contracts/workspace.ts 完全一致（每个参数类型、返回值类型）
- 确认无 `any` 类型

## Activity Log

- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
- 2026-03-10T10:03:19Z – claude – shell_pid=90215 – lane=doing – Started implementation via workflow command
- 2026-03-10T10:05:20Z – claude – shell_pid=90215 – lane=for_review – Ready for review: src/types/index.ts — all enums (BrainType/CognitiveBrainType/ThreadState/SlotStatus/Intent/ComplexityHint/MemoryType/UsageOutcome), entity interfaces (Thread/Slot/UsageOutcomes/MemoryEntry/PendingObservation), input types, ICognitiveWorkspace. typecheck ✓, biome ✓, no any
