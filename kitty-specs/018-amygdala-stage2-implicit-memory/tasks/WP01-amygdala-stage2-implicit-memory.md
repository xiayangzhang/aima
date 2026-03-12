---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
  - "T003"
title: "Amygdala Stage 2 Implicit Memory"
phase: "Phase 1 - Implementation"
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

# Work Package Prompt: WP01 — Amygdala Stage 2 Implicit Memory

## Objectives & Success Criteria

替换 `src/amygdala/index.ts` 中 Stage 2 的 `const memoryResult = null` 存根，实现真实的隐性记忆检索快速路径。同时在 `ICognitiveWorkspace` interface 和 `CognitiveWorkspace` 实现中新增 `getByTags` 方法。完成后：

- Stage 2 对有历史记录的工具直接返回记忆中的决策，跳过 LLM 调用
- `getByTags` 查询失败时静默穿透到 Stage 3，不抛出未捕获异常
- `ICognitiveWorkspace` interface 和 `CognitiveWorkspace` 均实现 `getByTags`
- 全量测试零回归

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/018-amygdala-stage2-implicit-memory/spec.md`
- **Plan**: `kitty-specs/018-amygdala-stage2-implicit-memory/plan.md` — 含完整实现代码草稿
- **Source files**:
  - `src/types/index.ts` — ICognitiveWorkspace interface
  - `src/workspace/index.ts` — CognitiveWorkspace 实现
  - `src/amygdala/index.ts` — Stage 2 存根替换
- **Test file**: `tests/unit/amygdala/amygdala.test.ts`（现有，新增测试场景）
- **Depends on**: 无（Feature 016 已合并到 main，`implicit` 记忆写入链路就绪）
- **Constraints**:
  - 不改 `check()` 方法签名
  - 不改 Stage 1 逻辑
  - Stage 2 失败必须静默穿透到 Stage 3
  - Stage 2 不写入任何新记忆（只读取）
  - `haiku_enabled=false` 时：Stage 2 可以命中并返回，但若无历史则穿透到默认 allow

### Key background

`src/amygdala/index.ts` 的三阶段结构（`check()` 方法）：
```
Stage 1: checkStaticRules()    ← 已实现，不动
Stage 2: implicit memory       ← 本 WP 替换存根
Stage 3: haiku_enabled=true    ← Feature 016 已实现，不动
Default: allow
```

Feature 016 每次 Stage 3 评估后写入 `implicit` 记忆：
- `tags`: `['amygdala_eval', toolName, decision]`（如 `['amygdala_eval', 'spawn_execution_session', 'block']`）
- `content`: `JSON.stringify({ tool: toolName, decision, reason })`
- `type`: `'implicit'`

`getByTags` 使用 AND tag 匹配查询（`arrayContains`），与 `searchMemory` 的 `filters.tags` 逻辑完全一致。

---

## Subtasks & Detailed Guidance

### Subtask T002 — 新增 `getByTags` 到 ICognitiveWorkspace 和 CognitiveWorkspace

**执行顺序**: T002 先于 T001，因为 T001 的 amygdala 代码依赖 `getByTags` 方法存在。

**Purpose**: 在 `ICognitiveWorkspace` interface 新增 `getByTags` 方法签名，在 `CognitiveWorkspace` 类新增对应实现。

**Steps**:

1. 打开 `src/types/index.ts`，在 `ICognitiveWorkspace` interface 的 `// ── Memory ──` 区块末尾（`getProcedure` 下方）新增：

```typescript
  getByTags(
    tags: string[],
    timeRange?: { after?: Date; before?: Date },
    limit?: number,
  ): Promise<MemoryEntry[]>
```

2. 打开 `src/workspace/index.ts`，在 `CognitiveWorkspace` 类的 Memory 相关方法区域（`getProcedure` 方法之后）新增实现：

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

**Files**: `src/types/index.ts`, `src/workspace/index.ts`

**Validation**:
- [ ] `grep -n "getByTags" src/types/index.ts` → ICognitiveWorkspace 含 getByTags
- [ ] `grep -n "getByTags" src/workspace/index.ts` → CognitiveWorkspace 含 getByTags 实现
- [ ] TypeScript 无编译错误（`bun tsc --noEmit`）

**Notes**:
- `arrayContains`、`isNull`、`gt`、`lt`、`and`、`desc` 均已在 workspace/index.ts 顶部 import，无需新增 import
- `mapMemoryRow` 是同文件内已有的行映射函数
- `timeRange` 为可选参数，Stage 2 调用时传 `undefined`

---

### Subtask T001 — 实现 Stage 2 `getByTags` 检索（替换 check() 中的存根）

**Purpose**: 替换 `check()` 中的 Stage 2 存根，调用 `this.workspace.getByTags` 拉取最近评估历史，取最新一条记录作为快速决策。

**Current code** (lines ~74-77 in `src/amygdala/index.ts`):
```typescript
// Stage 2: Implicit memory match (medium/high tools)
// Stub for Feature 002 transition period — full implementation in DMN Reactive feature
const memoryResult: { decision: AmygdalaDecision; reason: string } | null = null
if (memoryResult) return memoryResult
```

**Replace with**:
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

**Files**: `src/amygdala/index.ts`

**Validation**:
- [ ] `grep -n "memoryResult = null" src/amygdala/index.ts` → 0（存根已删除）
- [ ] `grep -n "getByTags" src/amygdala/index.ts` → 至少 1 match
- [ ] `grep -n "\[memory\]" src/amygdala/index.ts` → reason 前缀逻辑存在
- [ ] TypeScript 无编译错误

**Notes**:
- `getByTags` 返回的结果已按 `createdAt DESC` 排序（数据库层），但代码中仍显式 sort 以保证正确性（防御性编程）
- `JSON.parse` 可能抛出（content 格式错误）— 这会被外层 `catch` 捕获，穿透到 Stage 3，行为正确
- `validDecisions.includes` 检查防止非法 decision 值污染决策

---

### Subtask T003 — 单元测试

**Purpose**: 在 `tests/unit/amygdala/amygdala.test.ts` 新增 Stage 2 相关测试（V1-V6）。

**Steps**:

1. 先阅读 `tests/unit/amygdala/amygdala.test.ts` 了解现有 mock 模式（`mockWorkspace`、`mockEventBus` 等）

2. 在 mock workspace 对象中新增 `getByTags` mock 方法（若还不存在）

3. 新增以下测试场景（参考 quickstart.md 的场景描述）：

```typescript
describe('Stage 2 — Implicit memory match', () => {
  // V1: 记忆命中，返回 block，无 LLM 调用
  it('returns block from memory when recent history shows block', async () => {
    mockWorkspace.getByTags.mockResolvedValue([
      makeMemoryEntry({ decision: 'block', reason: 'dangerous spawn', toolName: 'spawn_execution_session' })
    ])
    const amygdala = new Amygdala(
      { haiku_enabled: true, riskLevels: { spawn_execution_session: 'medium' } },
      mockWorkspace,
      mockEventBus,
    )
    const result = await amygdala.check('spawn_execution_session', {})
    expect(result.decision).toBe('block')
    expect(result.reason).toBe('[memory] dangerous spawn')
    expect(mockCallLlm).not.toHaveBeenCalled()
  })

  // V2: 记忆命中，返回 allow
  it('returns allow from memory when recent history shows allow', async () => {
    mockWorkspace.getByTags.mockResolvedValue([
      makeMemoryEntry({ decision: 'allow', reason: 'safe context', toolName: 'spawn_execution_session' })
    ])
    const result = await amygdala.check('spawn_execution_session', {})
    expect(result.decision).toBe('allow')
    expect(result.reason.startsWith('[memory]')).toBe(true)
  })

  // V3: 多条记录，取最新一条
  it('uses most recent record when multiple history entries exist', async () => {
    const older = makeMemoryEntry({ decision: 'allow', reason: 'old', toolName: 'spawn_execution_session', createdAt: new Date(Date.now() - 10000) })
    const newer = makeMemoryEntry({ decision: 'block', reason: 'new', toolName: 'spawn_execution_session', createdAt: new Date() })
    mockWorkspace.getByTags.mockResolvedValue([older, newer])
    const result = await amygdala.check('spawn_execution_session', {})
    expect(result.decision).toBe('block')
  })

  // V4: 无历史，穿透到 Stage 3
  it('falls through to Stage 3 when no memory history exists', async () => {
    mockWorkspace.getByTags.mockResolvedValue([])
    mockCallLlm.mockResolvedValue('{"decision":"allow","reason":"llm ok"}')
    const amygdala = new Amygdala(
      { haiku_enabled: true, riskLevels: { custom_tool: 'high' } },
      mockWorkspace,
      mockEventBus,
    )
    await amygdala.check('custom_tool', {})
    expect(mockCallLlm).toHaveBeenCalledTimes(1)
  })

  // V5: getByTags 抛出，穿透，不抛异常
  it('silently falls through when getByTags throws', async () => {
    mockWorkspace.getByTags.mockRejectedValue(new Error('db error'))
    mockCallLlm.mockResolvedValue('{"decision":"escalate","reason":"fallback"}')
    const amygdala = new Amygdala(
      { haiku_enabled: true, riskLevels: { custom_tool: 'high' } },
      mockWorkspace,
      mockEventBus,
    )
    const result = await amygdala.check('custom_tool', {})
    expect(result.decision).toBeDefined()
    expect(mockCallLlm).toHaveBeenCalledTimes(1)
  })

  // V6: content 解析失败，穿透
  it('falls through when memory content is invalid JSON', async () => {
    mockWorkspace.getByTags.mockResolvedValue([
      makeMemoryEntry({ rawContent: 'not valid json', toolName: 'spawn_execution_session' })
    ])
    const result = await amygdala.check('spawn_execution_session', {})
    expect(result.reason.startsWith('[memory]')).toBe(false)
  })
})
```

**Helper function** (可加在 describe 外或 beforeEach 中):
```typescript
function makeMemoryEntry(opts: {
  decision?: string
  reason?: string
  toolName?: string
  rawContent?: string
  createdAt?: Date
}): MemoryEntry {
  const content = opts.rawContent ?? JSON.stringify({
    tool: opts.toolName ?? 'test_tool',
    decision: opts.decision ?? 'allow',
    reason: opts.reason ?? 'test reason',
  })
  return {
    id: 'test-id-' + Math.random(),
    type: 'implicit',
    content,
    entityId: null,
    segmentId: null,
    segmentSeq: null,
    tags: ['amygdala_eval', opts.toolName ?? 'test_tool', opts.decision ?? 'allow'],
    baseImportance: 0.4,
    usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
    sourceBrain: 'amygdala',
    threadId: null,
    sessionId: null,
    supersedesId: null,
    tInvalid: null,
    lastAccessedAt: null,
    pinned: false,
    forgotten: false,
    expiresAt: null,
    createdAt: opts.createdAt ?? new Date(),
    updatedAt: new Date(),
  }
}
```

**Files**: `tests/unit/amygdala/amygdala.test.ts`

**Validation**:
- [ ] V1-V6 六个 test case 存在并通过
- [ ] `bun test tests/unit/amygdala/` → 全通过

**Notes**:
- `spawn_execution_session` 是 `medium` risk 工具（见 `DEFAULT_RISK_LEVELS`）— 需要通过 `riskLevels` override 或使用自定义工具名绕过 Stage 1（`spawn_execution_session` 不在 `DEFAULT_BLOCK_TOOLS` 中，所以可以直接用）
- 参考现有测试文件中 `mockWorkspace` 的定义方式添加 `getByTags` mock
- V4/V5 的工具必须是 `high` risk 且不在 `DEFAULT_BLOCK_TOOLS` 中（`bash`、`file_write` 等在 Stage 1 就被 block，永远不进入 Stage 2）

---

## Risks & Mitigations

| 风险 | 可能性 | 缓解方案 |
|---|---|---|
| `mockWorkspace` 已有定义，需添加 `getByTags` mock | 高 | 先读测试文件，找到 mock 定义位置，补充 `getByTags: mock(() => [])` |
| `spawn_execution_session` 有静态规则覆盖 | 低 | 检查 DEFAULT_BLOCK_TOOLS 和 DEFAULT_ALLOW_TOOLS_PREFIX，`spawn_execution_session` 不在其中 |
| T001 依赖 T002（getByTags 必须先存在） | 确定 | 严格按 T002 → T001 → T003 顺序执行 |

## Definition of Done Checklist

- [ ] `grep -n "getByTags" src/types/index.ts` → ICognitiveWorkspace 含 getByTags
- [ ] `grep -n "getByTags" src/workspace/index.ts` → CognitiveWorkspace 含 getByTags 实现
- [ ] `grep -n "memoryResult = null" src/amygdala/index.ts` → 0 matches（存根已删除）
- [ ] `grep -n "\[memory\]" src/amygdala/index.ts` → Stage 2 含 reason 前缀逻辑
- [ ] V1-V6 六个 test case 通过
- [ ] `bun test tests/unit/amygdala/` → 全通过
- [ ] `bun test` → 全量零新增 failure

## Review Guidance

- 验证 T001：`try/catch` 覆盖整个 `getByTags` + JSON.parse 调用（两者均可抛出）
- 验证 T001：`validDecisions.includes` 检查在返回前执行（防止非法 decision 污染）
- 验证 T001：reason 前缀为 `[memory] `（注意尾随空格）
- 验证 T002：`getByTags` 使用 `isNull(memories.tInvalid)` 过滤软删除记录
- 验证 T002：`limit ?? 20` 提供默认值（Stage 2 调用时传 5）
- 验证 T003：V3 测试验证了正确的排序逻辑（newer 在 older 之后，但结果应取 newer）

## Activity Log

- 2026-03-13T00:00:00Z – system – lane=planned – Prompt generated via spec-kitty agent workflow
