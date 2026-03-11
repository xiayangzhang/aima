---
work_package_id: WP03
title: Extension Factory Tool Permission Override
lane: "done"
dependencies: ["WP01"]
subtasks:
- T008
- T009
phase: Phase 2 - Core Features
assignee: ''
agent: "claude-sonnet-4-6"
shell_pid: "3887"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-11T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP03 – Extension Factory Tool Permission Override

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, scroll to Review Feedback section.

---

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

修改 `src/adapters/pi-coding-agent/extension.ts`，为 `createAimaExtension` 新增 `allowedTools?: string[]` 参数，实现每脑区级别的工具权限覆盖：

- `allowedTools` 中列出的工具从 `DEFAULT_BLOCKED_TOOLS` 的封锁中豁免
- 豁免的工具继续走 Stage 2（DEFAULT_ALLOWED_TOOLS）或 Stage 3（amygdala.check()）
- 未在 `allowedTools` 中的工具行为不变
- 不传 `allowedTools` 时行为与修改前完全一致（向后兼容）

**Success criteria**:
- `bun run typecheck` 零错误
- `biome check` 通过
- 所有现有 extension 测试零失败（向后兼容）
- 新增测试：bash 按脑区解锁/保持拦截

---

## Implementation Context

### 当前 extension.ts 核心逻辑

```typescript
// src/adapters/pi-coding-agent/extension.ts

const DEFAULT_BLOCKED_TOOLS = new Set(['bash', 'edit', 'write'])
const DEFAULT_ALLOWED_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

export function createAimaExtension(
  brain: CognitiveBrainType,
  threadId: string,
  amygdala: Amygdala,
  eventBus: BrainEventBus,
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event: ToolCallEvent) => {
      const { toolCallId, toolName } = event
      const input = event.input as Record<string, unknown>

      // Stage 1: Default policy — block high-risk tools
      if (DEFAULT_BLOCKED_TOOLS.has(toolName)) {
        // ... emit tool.pre_use + tool.blocked, return { block: true }
      }

      // ... Stage 2 (DEFAULT_ALLOWED_TOOLS) + Stage 3 (amygdala.check())
    })
  }
}
```

### 设计原则

覆盖发生在 **Extension 层**（per-brain, per-session），而非 Amygdala 层。原因：
- `amygdala.check()` 不接收 brain 参数，无法实现脑区级别策略
- Extension Factory 在创建时已绑定 `brain` 参数，是实现脑区差异的正确位置
- Amygdala 保持框架级通用守卫不变

### 豁免逻辑

豁免工具（在 `allowedTools` 中）从 DEFAULT_BLOCKED_TOOLS 检查跳过后，继续走正常流程：

```
bash (in DEFAULT_BLOCKED_TOOLS AND in allowedTools)
  → 跳过 Stage 1 封锁
  → 不在 DEFAULT_ALLOWED_TOOLS → 走 Stage 3 amygdala.check()

bash (in DEFAULT_BLOCKED_TOOLS AND NOT in allowedTools)
  → Stage 1 封锁，return { block: true }
```

即：`allowedTools` 只解除 DEFAULT_BLOCKED_TOOLS 的硬封锁，后续策略照常执行。

---

## Subtask Guidance

### T008 — 修改 `src/adapters/pi-coding-agent/extension.ts`

**Purpose**: 新增 `allowedTools` 参数，修改 Stage 1 封锁逻辑。

**Steps**:

1. **读取 `src/adapters/pi-coding-agent/extension.ts`** 确认当前实现细节

2. **修改函数签名**：
   ```typescript
   export function createAimaExtension(
     brain: CognitiveBrainType,
     threadId: string,
     amygdala: Amygdala,
     eventBus: BrainEventBus,
     allowedTools?: string[],  // 新增：来自 {brain}.md allowed_tools frontmatter
   ): ExtensionFactory {
   ```

3. **在函数体顶部（return (pi) => { 之前）构建 allowedSet**：
   ```typescript
   const allowedSet = new Set(allowedTools ?? [])
   ```

4. **修改 Stage 1 判断条件**：
   ```typescript
   // 修改前：
   if (DEFAULT_BLOCKED_TOOLS.has(toolName)) {

   // 修改后：
   if (DEFAULT_BLOCKED_TOOLS.has(toolName) && !allowedSet.has(toolName)) {
   ```

5. Stage 2、Stage 3、事件 emit 逻辑**完全不变**

**完整修改后的 tool_call handler（示意）**：
```typescript
return (pi) => {
  const allowedSet = new Set(allowedTools ?? [])

  pi.on('tool_call', async (event: ToolCallEvent) => {
    const { toolCallId, toolName } = event
    const input = event.input as Record<string, unknown>

    // Stage 1: Default policy — block high-risk tools (unless role overrides)
    if (DEFAULT_BLOCKED_TOOLS.has(toolName) && !allowedSet.has(toolName)) {
      const reason = `${toolName} blocked by default policy`
      eventBus.emit({ event_type: 'tool.pre_use', ... })
      eventBus.emit({ event_type: 'tool.blocked', ... })
      return { block: true, reason }
    }

    // Emit tool.pre_use for non-blocked tools (同前)
    eventBus.emit({ event_type: 'tool.pre_use', ... })

    // Stage 2: Default allow (同前)
    if (DEFAULT_ALLOWED_TOOLS.has(toolName)) {
      return undefined
    }

    // Stage 3: Amygdala check (同前)
    const result = await amygdala.check(toolName, input)
    // ... 同前处理
  })

  // tool_execution_end + agent_end handlers 完全不变
}
```

**注意**：
- `allowedSet` 构建放在 `return (pi) => {` **之后**（闭包内），确保每个 ExtensionFactory 实例独立持有自己的 Set
- 不要修改 `DEFAULT_BLOCKED_TOOLS` 常量（它是模块级共享的 Set）

**Files**: `src/adapters/pi-coding-agent/extension.ts`（修改，约 5-8 行变动）

**Validation**:
- [ ] 函数签名新增 `allowedTools?: string[]` 第 5 参数
- [ ] Stage 1 判断改为 `DEFAULT_BLOCKED_TOOLS.has(toolName) && !allowedSet.has(toolName)`
- [ ] 不传 `allowedTools` 时行为与修改前完全一致（`allowedSet` = 空 Set）

---

### T009 — 扩展 Extension 测试

**Purpose**: 新增测试验证 `allowedTools` 覆盖逻辑，确保现有测试零回归。

**先定位现有测试文件**：用 `Glob 'tests/**/*.test.ts'` 找到 extension 相关测试，读取后再添加。

**新增测试场景**：

```typescript
describe('createAimaExtension with allowedTools', () => {
  // Mock setup（参考现有测试的 mock 模式）
  const makeMocks = () => {
    const amygdala = { check: mock(() => Promise.resolve({ decision: 'allow' as const })) }
    const eventBus = { emit: mock(() => {}) }
    const events: Record<string, Function[]> = {}
    const pi = {
      on: mock((event: string, handler: Function) => {
        events[event] = events[event] ?? []
        events[event].push(handler)
      }),
    }
    const trigger = async (eventName: string, payload: object) => {
      for (const handler of events[eventName] ?? []) {
        return await handler(payload)
      }
    }
    return { amygdala, eventBus, pi, trigger }
  }

  test('allowedTools 中的 bash 不被 DEFAULT_BLOCKED_TOOLS 拦截', async () => {
    const { amygdala, eventBus, pi, trigger } = makeMocks()
    const factory = createAimaExtension('brainstem', 'thread-1', amygdala as any, eventBus as any, ['bash'])
    factory(pi as any)

    const result = await trigger('tool_call', {
      toolCallId: 'tc-1',
      toolName: 'bash',
      input: { command: 'ls' },
    })

    // bash 在 allowedTools 中，不应返回 block: true
    // (会走到 amygdala.check，mock 返回 allow)
    expect(result).toBeUndefined() // undefined = allowed
    // tool.blocked 事件不应 emit
    const blockedEmits = (eventBus.emit as any).mock.calls.filter(
      ([e]: [{ event_type: string }]) => e.event_type === 'tool.blocked'
    )
    expect(blockedEmits).toHaveLength(0)
  })

  test('不在 allowedTools 中的 bash 仍被拦截', async () => {
    const { amygdala, eventBus, pi, trigger } = makeMocks()
    // allowedTools 为空（或不传）
    const factory = createAimaExtension('limbic', 'thread-2', amygdala as any, eventBus as any)
    factory(pi as any)

    const result = await trigger('tool_call', {
      toolCallId: 'tc-2',
      toolName: 'bash',
      input: { command: 'rm -rf' },
    })

    expect(result).toEqual({ block: true, reason: expect.stringContaining('bash') })
  })

  test('edit 在 allowedTools 中时放行', async () => {
    const { amygdala, eventBus, pi, trigger } = makeMocks()
    const factory = createAimaExtension('brainstem', 'thread-3', amygdala as any, eventBus as any, ['edit'])
    factory(pi as any)

    const result = await trigger('tool_call', {
      toolCallId: 'tc-3',
      toolName: 'edit',
      input: {},
    })

    expect(result).toBeUndefined() // allowed
  })

  test('不在 DEFAULT_BLOCKED_TOOLS 中的工具不受 allowedTools 影响', async () => {
    const { amygdala, eventBus, pi, trigger } = makeMocks()
    const factory = createAimaExtension('cortex', 'thread-4', amygdala as any, eventBus as any, ['custom_tool'])
    factory(pi as any)

    // custom_tool 不在 DEFAULT_BLOCKED_TOOLS，不受影响
    // 走 Stage 3 amygdala.check (mock 返回 allow)
    const result = await trigger('tool_call', {
      toolCallId: 'tc-4',
      toolName: 'custom_tool',
      input: {},
    })

    expect(result).toBeUndefined()
    expect(amygdala.check).toHaveBeenCalledWith('custom_tool', {})
  })
})
```

**注意**：上述是参考骨架，实际应参考现有测试的 mock 模式（`pi-coding-agent` SDK 的 Extension API 可能有不同的 mock 结构）。先读取现有 extension 测试，复用相同 mock 设置。

**Files**: 现有 extension 测试文件（新增 describe block）

---

## Definition of Done

- [ ] `src/adapters/pi-coding-agent/extension.ts` — 函数签名新增 `allowedTools?: string[]`
- [ ] `src/adapters/pi-coding-agent/extension.ts` — Stage 1 添加 `!allowedSet.has(toolName)` 条件
- [ ] 所有现有 extension 测试零失败
- [ ] ≥4 个新测试通过（bash 解锁、bash 保持拦截、edit 解锁、非 DEFAULT_BLOCKED 工具不受影响）
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过

---

## Risks

- **allowedSet 作用域**：必须在 `return (pi) => {` 内部（或其之前但每次调用独立），确保闭包正确。若放在模块顶层，多个 Extension 实例会共享 Set，产生污染。
- **现有测试 mock 结构**：实际测试文件可能使用 `spy` 或其他模式，先读后写
- **amygdala.check 调用时机**：豁免工具（bash in allowedTools）不在 DEFAULT_ALLOWED_TOOLS 中，会走到 Stage 3 amygdala.check — 这是正确行为。测试中需 mock amygdala.check 返回 `allow` 才能看到 `undefined` 返回值。

---

## Implementation Command

```bash
spec-kitty implement WP03 --base WP01
```

## Activity Log

- 2026-03-11T11:56:52Z – claude-sonnet-4-6 – shell_pid=3887 – lane=doing – Started implementation via workflow command
- 2026-03-11T11:58:04Z – claude-sonnet-4-6 – shell_pid=3887 – lane=for_review – Ready for review: allowedTools param added to createAimaExtension, Stage 1 bypassed for listed tools, backwards compatible. 25 tests passing (20 existing + 5 new). typecheck clean, biome clean.
