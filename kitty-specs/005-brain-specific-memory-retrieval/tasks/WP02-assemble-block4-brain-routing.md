---
work_package_id: WP02
title: assembleBlock4 升级为脑区专属路由
lane: "done"
dependencies: [WP01]
subtasks: [T009, T010, T011, T012, T013, T014, T015]
assignee: claude
agent: "claude-sonnet-4-6"
shell_pid: "85538"
reviewed_by: "XIAYANG ZHANG"
review_status: "approved"
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP02 — assembleBlock4 升级为脑区专属路由

## 目标

在 `src/context/index.ts` 中新增 `AssembleBlock4Opts` 接口，升级 `assembleBlock4` 和 `assembleContext` 接受 opts 参数，按 brainType 路由到 WP01 新增的专属方法。旧的 fallback 行为（无 opts 时）必须完整保留，不破坏任何现有调用方。

## 实施命令

```bash
spec-kitty implement WP02 --base WP01
```

（WP01 的 worktree 分支作为 base，确保能调用新方法）

## 上下文

### 关键文件

- **修改**：`src/context/index.ts`（新增接口 + 升级两个函数）
- **修改**：`src/index.ts`（导出 `AssembleBlock4Opts`）
- **新建**：`tests/unit/context/assembleBlock4.test.ts`

### 现有 `assembleBlock4` 签名

```typescript
export async function assembleBlock4(
  brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  _threadId: string,
): Promise<{ text: string; injectedMemoryIds: string[] }>
```

### 现有 `assembleContext` 签名

```typescript
export async function assembleContext(
  brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  threadId: string,
  config: ContextAssemblerConfig,
  cachedBlock12: string,
): Promise<AssembledContext>
```

### 现有 Block 4 逻辑摘要

```typescript
// limbic: semantic(10) + episodic(5) via searchMemory
// cortex: procedural(10) + episodic(5) via searchMemory
// brainstem: procedural(10) via searchMemory
// 其他: results = [] (无内容，返回 empty)
// 最后去重 + 格式化为 "## Relevant Memory" 文本块
```

### CognitiveWorkspace 接口引用

`context/index.ts` 中用的是 `CognitiveWorkspace` 类型（`import type { CognitiveWorkspace } from '../workspace/index'`）。WP01 完成后，该类型上新增的三个方法自动可见。**无需修改 import**。

---

## 子任务

### T009 — `AssembleBlock4Opts` 接口定义

**位置**：在 `src/context/index.ts` 的 `// ─── Config Types` 区块末尾追加（在 `AssembledContext` 之后）。

**实现**：

```typescript
/**
 * Brain-specific context for Block 4 memory retrieval.
 * Each field is used by the corresponding brain type; unused fields are ignored.
 */
export interface AssembleBlock4Opts {
  /** limbic: entity to retrieve context for */
  entityId?: string
  /** brainstem: task type to look up procedures for */
  taskType?: string
  /** cortex: situation description for similarity matching */
  situation?: string
}
```

---

### T010 — `assembleBlock4` 签名扩展 + limbic 分支升级

**目的**：在 `assembleBlock4` 签名末尾新增 `opts?: AssembleBlock4Opts`，并升级 limbic 分支。

**新签名**：

```typescript
export async function assembleBlock4(
  brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  _threadId: string,
  opts?: AssembleBlock4Opts,
): Promise<{ text: string; injectedMemoryIds: string[] }>
```

**limbic 分支升级**：

```typescript
if (brain === 'limbic') {
  if (opts?.entityId) {
    // 专属路径：实体中心检索
    results = await workspace.getEntityContext(opts.entityId, { limit: 10 })
  } else {
    // Fallback：旧行为完整保留
    const semantic = await workspace.searchMemory({
      type: 'semantic',
      limit: 10,
      excludeInvalid: true,
    })
    const episodic = await workspace.searchMemory({
      type: 'episodic',
      limit: 5,
      excludeInvalid: true,
    } satisfies MemorySearchFilters)
    results = [...semantic, ...episodic]
  }
}
```

**关键**：fallback 路径的代码与改前完全相同，逐字复制，不做任何改动。

---

### T011 — cortex 分支升级

**目的**：当 `opts.situation` 存在时，调用 `findSimilarSituations` 并合并三组结果；否则保留旧行为。

**cortex 分支升级**：

```typescript
} else if (brain === 'cortex') {
  if (opts?.situation) {
    // 专属路径：情境匹配检索
    const { episodes, procedures, facts } = await workspace.findSimilarSituations(
      opts.situation,
      { limit: 5 },
    )
    results = [...episodes, ...procedures, ...facts]
  } else {
    // Fallback：旧行为完整保留
    const procedural = await workspace.searchMemory({
      type: 'procedural',
      limit: 10,
      excludeInvalid: true,
    })
    const episodic = await workspace.searchMemory({
      type: 'episodic',
      limit: 5,
      excludeInvalid: true,
    })
    results = [...procedural, ...episodic]
  }
}
```

**关键**：合并顺序是 episodes → procedures → facts（与 `results` 的后续去重逻辑一致）。

---

### T012 — brainstem 分支升级

**目的**：当 `opts.taskType` 存在时，调用 `getProcedure`；否则保留旧行为。

**brainstem 分支升级**：

```typescript
} else if (brain === 'brainstem') {
  if (opts?.taskType) {
    // 专属路径：过程检索
    results = await workspace.getProcedure(opts.taskType, { limit: 10 })
  } else {
    // Fallback：旧行为完整保留
    results = await workspace.searchMemory({ type: 'procedural', limit: 10, excludeInvalid: true })
  }
}
```

---

### T013 — `assembleContext` 透传 opts

**目的**：让 `assembleContext` 接受并透传 `opts` 到 `assembleBlock4`。

**新签名**：

```typescript
export async function assembleContext(
  brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  threadId: string,
  config: ContextAssemblerConfig,
  cachedBlock12: string,
  opts?: AssembleBlock4Opts,  // ← 新增，放在最后保证向后兼容
): Promise<AssembledContext>
```

**内部修改**（仅修改 `assembleBlock4` 调用处）：

```typescript
// 改前：
const { text: block4Text, injectedMemoryIds } = await assembleBlock4(brain, workspace, threadId)

// 改后：
const { text: block4Text, injectedMemoryIds } = await assembleBlock4(brain, workspace, threadId, opts)
```

**向后兼容**：`opts` 在签名末尾且为可选，所有现有调用方（不传 opts）无需修改。

---

### T014 — `src/index.ts` 导出 `AssembleBlock4Opts`

**目的**：让上层应用可以 import `AssembleBlock4Opts` 类型来构造正确的 opts 对象。

**修改**：在 `src/index.ts` 的 context 导出区块追加：

```typescript
// 改前：
export { assembleBlock12, assembleBlock3, assembleBlock4, assembleContext } from './context/index'
export type {
  AssembledContext,
  BrainIdentity,
  ContextAssemblerConfig,
} from './context/index'

// 改后（在 export type 中追加 AssembleBlock4Opts）：
export { assembleBlock12, assembleBlock3, assembleBlock4, assembleContext } from './context/index'
export type {
  AssembleBlock4Opts,   // ← 新增
  AssembledContext,
  BrainIdentity,
  ContextAssemblerConfig,
} from './context/index'
```

（字母顺序：`AssembleBlock4Opts` 排在 `AssembledContext` 前）

---

### T015 — 单元测试：`assembleBlock4` spy 路由

**文件**：`tests/unit/context/assembleBlock4.test.ts`（新建，需确认目录存在）

**测试策略**：不使用 mock DB，而是创建一个带 spy 方法的 workspace 对象，验证 `assembleBlock4` 调用了正确的方法。

**Workspace Spy 构造**：

```typescript
import { describe, expect, mock, test } from 'bun:test'
import { assembleBlock4 } from '../../../src/context/index'
import type { CognitiveWorkspace } from '../../../src/workspace/index'
import type { MemoryEntry } from '../../../src/types/index'

function makeMemoryEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem-1',
    type: 'semantic',
    content: 'test',
    entityId: null,
    segmentId: null,
    segmentSeq: null,
    tags: [],
    baseImportance: 0.5,
    usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
    sourceBrain: null,
    threadId: null,
    sessionId: null,
    supersedesId: null,
    tInvalid: null,
    lastAccessedAt: null,
    pinned: false,
    forgotten: false,
    expiresAt: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  }
}

function makeWorkspaceSpy(overrides?: Partial<CognitiveWorkspace>) {
  return {
    getEntityContext: mock(async () => [makeMemoryEntry()]),
    findSimilarSituations: mock(async () => ({
      episodes: [makeMemoryEntry({ type: 'episodic' })],
      procedures: [makeMemoryEntry({ type: 'procedural' })],
      facts: [makeMemoryEntry({ type: 'semantic' })],
    })),
    getProcedure: mock(async () => [makeMemoryEntry({ type: 'procedural' })]),
    searchMemory: mock(async () => [makeMemoryEntry()]),
    ...overrides,
  } as unknown as CognitiveWorkspace
}
```

**测试用例**：

```typescript
describe('assembleBlock4 — routing with opts', () => {
  test('limbic + entityId → calls getEntityContext, not searchMemory', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('limbic', ws, 'thread-1', { entityId: 'entity-abc' })
    expect(ws.getEntityContext).toHaveBeenCalledWith('entity-abc', { limit: 10 })
    expect(ws.searchMemory).not.toHaveBeenCalled()
  })

  test('limbic without entityId → falls back to searchMemory (twice)', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('limbic', ws, 'thread-1')
    expect(ws.getEntityContext).not.toHaveBeenCalled()
    expect(ws.searchMemory).toHaveBeenCalledTimes(2)
  })

  test('cortex + situation → calls findSimilarSituations, not searchMemory', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('cortex', ws, 'thread-1', { situation: '客户投诉' })
    expect(ws.findSimilarSituations).toHaveBeenCalledWith('客户投诉', { limit: 5 })
    expect(ws.searchMemory).not.toHaveBeenCalled()
  })

  test('cortex without situation → falls back to searchMemory (twice)', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('cortex', ws, 'thread-1')
    expect(ws.findSimilarSituations).not.toHaveBeenCalled()
    expect(ws.searchMemory).toHaveBeenCalledTimes(2)
  })

  test('brainstem + taskType → calls getProcedure, not searchMemory', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('brainstem', ws, 'thread-1', { taskType: '报销审批' })
    expect(ws.getProcedure).toHaveBeenCalledWith('报销审批', { limit: 10 })
    expect(ws.searchMemory).not.toHaveBeenCalled()
  })

  test('brainstem without taskType → falls back to searchMemory (once)', async () => {
    const ws = makeWorkspaceSpy()
    await assembleBlock4('brainstem', ws, 'thread-1')
    expect(ws.getProcedure).not.toHaveBeenCalled()
    expect(ws.searchMemory).toHaveBeenCalledTimes(1)
  })

  test('result text includes memory content when results are returned', async () => {
    const ws = makeWorkspaceSpy()
    const { text, injectedMemoryIds } = await assembleBlock4('limbic', ws, 't', {
      entityId: 'e1',
    })
    expect(text).toContain('## Relevant Memory')
    expect(injectedMemoryIds).toHaveLength(1)
  })

  test('result is empty when no memories returned', async () => {
    const ws = makeWorkspaceSpy({
      getEntityContext: mock(async () => []),
    })
    const { text, injectedMemoryIds } = await assembleBlock4('limbic', ws, 't', {
      entityId: 'e1',
    })
    expect(text).toBe('')
    expect(injectedMemoryIds).toHaveLength(0)
  })
})
```

---

## Definition of Done

- [ ] T009: `AssembleBlock4Opts` 接口已定义并导出（`entityId?`、`taskType?`、`situation?`）
- [ ] T010: limbic 分支：有 `entityId` 时调用 `getEntityContext`，无时走旧 fallback
- [ ] T011: cortex 分支：有 `situation` 时调用 `findSimilarSituations` 合并三组，无时走旧 fallback
- [ ] T012: brainstem 分支：有 `taskType` 时调用 `getProcedure`，无时走旧 fallback
- [ ] T013: `assembleContext` 新增末尾 `opts?` 参数，透传到 `assembleBlock4`
- [ ] T014: `src/index.ts` 已导出 `AssembleBlock4Opts`，字母序正确
- [ ] T015: 单元测试覆盖 6 个路由场景（3 brainType × 有/无 opts）+ 内容/空结果验证
- [ ] 现有调用方（runner、adapters）无需修改（opts 为可选末尾参数）
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过

## 完成命令

```bash
spec-kitty agent tasks move-task WP02 --to for_review --note "Ready: <summary>"
```

## 实施提示

1. **先读 `src/context/index.ts` 完整文件**，理解现有去重逻辑（`seen` Set）和格式化逻辑，升级时不要改动这些部分
2. `tests/unit/context/` 目录可能不存在，需要创建：`mkdir -p tests/unit/context`
3. `bun:test` 的 `mock()` 函数用于创建 spy，与 Jest 的 `jest.fn()` 对应，支持 `toHaveBeenCalled` / `toHaveBeenCalledWith`
4. 如果 `bun:test` 不支持 `toHaveBeenCalled`，改用计数器模式（spy 函数内部递增 callCount）

## Activity Log

- 2026-03-11T05:46:30Z – claude-sonnet-4-6 – shell_pid=85538 – lane=doing – Started implementation via workflow command
- 2026-03-11T05:48:50Z – claude-sonnet-4-6 – shell_pid=85538 – lane=for_review – Ready: AssembleBlock4Opts interface, brain-specific routing (limbic→getEntityContext, cortex→findSimilarSituations, brainstem→getProcedure), fallbacks preserved, exported from index.ts, 9 unit tests, 229 total passing, biome+typecheck clean.
- 2026-03-11T06:51:21Z – claude-sonnet-4-6 – shell_pid=85538 – lane=done – Merged to main: AssembleBlock4Opts, brain-specific routing with fallbacks, 9 unit tests
