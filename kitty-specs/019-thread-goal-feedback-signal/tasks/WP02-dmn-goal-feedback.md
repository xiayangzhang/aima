---
work_package_id: WP02
title: DMN Goal-Based Feedback Signal
lane: done
dependencies: []
subtasks:
- T004
- T005
- T006
phase: Phase 2 - DMN Upgrade
assignee: ''
agent: ''
shell_pid: ''
review_status: 'approved'
reviewed_by: 'claude'
history:
- timestamp: '2026-03-13T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via spec-kitty agent workflow
- timestamp: '2026-03-13T04:00:00Z'
  lane: done
  agent: claude
  shell_pid: ''
  action: 'Review passed: 019/020/021 reviewed together in single commit 0bc5c3d — 464/0 unit tests'
---

# Work Package Prompt: WP02 — DMN Goal-Based Feedback Signal

## Objectives & Success Criteria

升级 `src/dmn/reactive/index.ts` 的 `feedbackMemoryUsage` 方法，使其在 thread 有 goal 时调用 Haiku LLM 评估最终 reply 是否达成目标，以评估结果（positive/negative）替代启发式打标。评估失败时静默回退到现有 `evaluateOutcome` 逻辑。完成后：

- 携带 goal 且有 reply 的线程完成时，LLM 被调用，`markMemoryUsed` 以 positive/negative 调用
- thread.goal 为 null 时，行为与 Feature 019 前完全一致（无 LLM 调用，启发式打标）
- LLM 失败（任何异常）时，`markMemoryUsed` 仍被调用（以启发式结果），不抛未捕获异常
- 全量测试零回归

**To implement this WP**:
```bash
spec-kitty implement WP02
```

---

## Context & Constraints

- **Spec**: `kitty-specs/019-thread-goal-feedback-signal/spec.md`
- **Plan**: `kitty-specs/019-thread-goal-feedback-signal/plan.md` — 含完整实现代码草稿
- **Quickstart**: `kitty-specs/019-thread-goal-feedback-signal/quickstart.md` — 含 V1-V7 测试场景
- **Source files**:
  - `src/dmn/reactive/index.ts` — `feedbackMemoryUsage` 方法替换
- **Test file**: `tests/unit/dmn/dmn-reactive.test.ts`（现有，新增测试场景）
- **Depends on**: WP01（`Thread.goal` 字段必须已存在于 interface 和 workspace 实现中）
- **Constraints**:
  - 不改 `evaluateOutcome` 方法本身（逻辑不变）
  - 不新增 `ICognitiveWorkspace` 方法（`getThread`、`markMemoryUsed` 已有）
  - 不改 `handleBrainComplete`、`assignSegmentAndWriteEpisodic`、`retroactiveCorrection` 等其他方法
  - goal 评估是 fire-and-forget（已由 `inFlightHandlers` 隔离），不需要额外 spawn 或 Promise 包装
  - try/catch 必须覆盖整个 goal 评估路径（getThread + LLM + markMemoryUsed LLM 路径），catch 时执行启发式 markMemoryUsed

### Key background

**`feedbackMemoryUsage` 当前代码**（`src/dmn/reactive/index.ts` 第 249-255 行）：
```typescript
private async feedbackMemoryUsage(event: BrainEvent): Promise<void> {
  const injectedIds = event.payload.injectedMemoryIds as string[] | undefined
  if (!injectedIds || injectedIds.length === 0) return

  const outcome = this.evaluateOutcome(event)
  await this.config.workspace.markMemoryUsed(injectedIds, outcome)
}
```

**`evaluateOutcome` 规则**（第 257-268 行）：
```typescript
private evaluateOutcome(event: BrainEvent): UsageOutcome {
  const outputSlot = event.payload.outputSlot as Record<string, unknown> | undefined
  const output = outputSlot?.output as Record<string, unknown> | undefined

  if (outputSlot?.status === 'error') return 'negative'
  if (event.payload.stopReason === 'error') return 'negative'
  if (output?.reply != null) return 'positive'
  if (output?.next === 'brainstem') return 'positive'

  return 'neutral'
}
```

**已有 LLM 调用模式**（见 `isTopicSwitch`，第 207-228 行）：
```typescript
const response = await callLlm(prompt, this.config.llm)
const result = parseLlmJson<{ topic_switched: boolean }>(response, { topic_switched: false })
```

**`workspace.getThread` 签名**（`ICognitiveWorkspace`，`src/types/index.ts` 第 153 行）：
```typescript
getThread(id: string): Promise<Thread | null>
```

**`workspace.markMemoryUsed` 签名**（第 171 行）：
```typescript
markMemoryUsed(ids: string[], outcome: UsageOutcome): Promise<void>
```

---

## Subtasks & Detailed Guidance

### Subtask T004 — 升级 feedbackMemoryUsage

**Purpose**: 替换 `feedbackMemoryUsage` 方法，实现 goal-aware 反馈信号逻辑。

**Replace current implementation with**:

```typescript
private async feedbackMemoryUsage(event: BrainEvent): Promise<void> {
  const injectedIds = event.payload.injectedMemoryIds as string[] | undefined
  if (!injectedIds || injectedIds.length === 0) return

  // Pre-compute heuristic outcome — always available as fallback
  const fallbackOutcome = this.evaluateOutcome(event)

  // Goal-based evaluation: attempt quality signal if thread has a goal
  if (event.thread_id) {
    try {
      const thread = await this.config.workspace.getThread(event.thread_id)
      const goal = thread?.goal

      if (goal) {
        const outputSlot = event.payload.outputSlot as Record<string, unknown> | undefined
        const output = outputSlot?.output as Record<string, unknown> | undefined
        const reply = output?.reply as string | undefined

        if (reply) {
          const prompt = `You are evaluating whether an AI response achieved a stated goal.

Goal: ${goal}

Response: ${reply}

Did the response achieve the goal? Respond with JSON: {"achieved": boolean, "reason": string}`

          const llmResponse = await callLlm(prompt, this.config.llm)
          const result = parseLlmJson<{ achieved: boolean; reason: string }>(
            llmResponse,
            { achieved: false, reason: 'evaluation failed' },
          )
          const outcome: UsageOutcome = result.achieved ? 'positive' : 'negative'
          await this.config.workspace.markMemoryUsed(injectedIds, outcome)
          return
        }
      }
    } catch {
      // Goal evaluation failed — fall through to heuristic
    }
  }

  await this.config.workspace.markMemoryUsed(injectedIds, fallbackOutcome)
}
```

**Files**: `src/dmn/reactive/index.ts`

**Validation**:
- [ ] `grep -n "getThread" src/dmn/reactive/index.ts` → feedbackMemoryUsage 含 getThread 调用
- [ ] `grep -n "callLlm" src/dmn/reactive/index.ts` → goal 评估含 LLM 调用
- [ ] `grep -n "fallbackOutcome" src/dmn/reactive/index.ts` → fallback 变量存在
- [ ] `bun tsc --noEmit` → 零编译错误

**Notes**:
- `fallbackOutcome` 必须在 try 块之前计算（同步调用 `evaluateOutcome`），确保 catch 路径总有值
- `return` 语句在 LLM 路径成功后执行，防止重复调用 `markMemoryUsed`
- `goal` 存在但 `reply` 为 null 时，代码自然穿透到末尾的 `markMemoryUsed(injectedIds, fallbackOutcome)`
- `try/catch` 不包含末尾的 fallback `markMemoryUsed` 调用（它在 try/catch 外部）——这样既保证了异常静默，又保证了 fallback 总被执行

---

### Subtask T005 — 单元测试 V1-V7

**Purpose**: 在 DMN Reactive 测试文件中新增 goal 相关测试场景。

**Steps**:

1. 先阅读 `tests/unit/dmn/dmn-reactive.test.ts`，了解现有 mock 模式（`mockWorkspace`、`mockEventBus`、`mockCallLlm` 等）

2. 确认 `mockWorkspace` 是否已含 `getThread` mock。若不存在，添加：
```typescript
getThread: mock(() => Promise.resolve(null)),
```

3. 新增以下测试 describe 块：

```typescript
describe('feedbackMemoryUsage — goal-based evaluation', () => {
  // V1: goal + reply + achieved=true → positive
  it('calls markMemoryUsed with positive when LLM evaluates goal as achieved', async () => {
    const event = makeBrainCompleteEvent({
      threadId: 'thread-goal-1',
      injectedMemoryIds: ['mem-001', 'mem-002'],
      reply: 'I have sent the confirmation email.',
      outputStatus: 'done',
    })
    mockWorkspace.getThread.mockResolvedValue(
      makeThread({ id: 'thread-goal-1', goal: 'Send a confirmation email reply' })
    )
    mockCallLlm.mockResolvedValue('{"achieved": true, "reason": "reply confirms email sent"}')

    await dmnReactive['feedbackMemoryUsage'](event)

    expect(mockWorkspace.markMemoryUsed).toHaveBeenCalledWith(
      ['mem-001', 'mem-002'],
      'positive',
    )
    expect(mockCallLlm).toHaveBeenCalledTimes(1)
  })

  // V2: goal + reply + achieved=false → negative
  it('calls markMemoryUsed with negative when LLM evaluates goal as not achieved', async () => {
    const event = makeBrainCompleteEvent({
      threadId: 'thread-goal-2',
      injectedMemoryIds: ['mem-003'],
      reply: 'I need more information about your travel dates.',
      outputStatus: 'done',
    })
    mockWorkspace.getThread.mockResolvedValue(
      makeThread({ id: 'thread-goal-2', goal: 'Book the flight' })
    )
    mockCallLlm.mockResolvedValue('{"achieved": false, "reason": "no booking confirmation"}')

    await dmnReactive['feedbackMemoryUsage'](event)

    expect(mockWorkspace.markMemoryUsed).toHaveBeenCalledWith(['mem-003'], 'negative')
  })

  // V3: goal = null → heuristic, no LLM
  it('falls back to heuristic when thread.goal is null', async () => {
    const event = makeBrainCompleteEvent({
      threadId: 'thread-no-goal',
      injectedMemoryIds: ['mem-004'],
      reply: 'Hello, how can I help?',
      outputStatus: 'done',
    })
    mockWorkspace.getThread.mockResolvedValue(
      makeThread({ id: 'thread-no-goal', goal: null })
    )

    await dmnReactive['feedbackMemoryUsage'](event)

    expect(mockCallLlm).not.toHaveBeenCalled()
    // heuristic: has reply → positive
    expect(mockWorkspace.markMemoryUsed).toHaveBeenCalledWith(['mem-004'], 'positive')
  })

  // V4: getThread returns null → heuristic, no LLM
  it('falls back to heuristic when getThread returns null', async () => {
    const event = makeBrainCompleteEvent({
      threadId: 'missing-thread',
      injectedMemoryIds: ['mem-005'],
      reply: 'some reply',
      outputStatus: 'done',
    })
    mockWorkspace.getThread.mockResolvedValue(null)

    await dmnReactive['feedbackMemoryUsage'](event)

    expect(mockCallLlm).not.toHaveBeenCalled()
    expect(mockWorkspace.markMemoryUsed).toHaveBeenCalledTimes(1)
  })

  // V5: callLlm throws → markMemoryUsed with heuristic, no throw
  it('silently falls back to heuristic when callLlm throws', async () => {
    const event = makeBrainCompleteEvent({
      threadId: 'thread-llm-fail',
      injectedMemoryIds: ['mem-006'],
      reply: 'some reply',
      outputStatus: 'done',
    })
    mockWorkspace.getThread.mockResolvedValue(
      makeThread({ id: 'thread-llm-fail', goal: 'some goal' })
    )
    mockCallLlm.mockRejectedValue(new Error('llm timeout'))

    await expect(dmnReactive['feedbackMemoryUsage'](event)).resolves.toBeUndefined()
    expect(mockWorkspace.markMemoryUsed).toHaveBeenCalledTimes(1)
  })

  // V6: injectedMemoryIds empty → no calls at all
  it('returns early when injectedMemoryIds is empty', async () => {
    const event = makeBrainCompleteEvent({
      threadId: 'thread-abc',
      injectedMemoryIds: [],
      reply: 'some reply',
      outputStatus: 'done',
    })

    await dmnReactive['feedbackMemoryUsage'](event)

    expect(mockWorkspace.getThread).not.toHaveBeenCalled()
    expect(mockCallLlm).not.toHaveBeenCalled()
    expect(mockWorkspace.markMemoryUsed).not.toHaveBeenCalled()
  })

  // V7: goal exists but reply is null → heuristic (no LLM)
  it('falls back to heuristic when goal exists but reply is null', async () => {
    const event = makeBrainCompleteEvent({
      threadId: 'thread-no-reply',
      injectedMemoryIds: ['mem-007'],
      reply: undefined,  // no reply this turn (routing turn)
      outputStatus: 'done',
    })
    mockWorkspace.getThread.mockResolvedValue(
      makeThread({ id: 'thread-no-reply', goal: 'some goal' })
    )

    await dmnReactive['feedbackMemoryUsage'](event)

    expect(mockCallLlm).not.toHaveBeenCalled()
    // heuristic: no reply, no error → neutral
    expect(mockWorkspace.markMemoryUsed).toHaveBeenCalledWith(['mem-007'], 'neutral')
  })
})
```

**Helper functions** (添加到测试文件中，如不已存在):
```typescript
function makeThread(opts: {
  id: string
  goal: string | null
}): Thread {
  return {
    id: opts.id,
    state: 'complete',
    sourceChannel: null,
    initiatedBy: 'external:teams',
    trigger: null,
    goal: opts.goal,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeBrainCompleteEvent(opts: {
  threadId: string
  injectedMemoryIds: string[]
  reply?: string
  outputStatus?: string
}): BrainEvent {
  return {
    event_type: 'brain.complete',
    level: 'INFO',
    brain: 'limbic',
    thread_id: opts.threadId,
    session_id: null,
    payload: {
      injectedMemoryIds: opts.injectedMemoryIds,
      outputSlot: {
        status: opts.outputStatus ?? 'done',
        output: opts.reply !== undefined ? { reply: opts.reply } : {},
      },
      stopReason: 'end_turn',
    },
  }
}
```

**Files**: `tests/unit/dmn/dmn-reactive.test.ts`

**Validation**:
- [ ] V1-V7 七个 test case 存在
- [ ] `bun test tests/unit/dmn/` → 全通过

**Notes**:
- 先阅读测试文件，理解现有 `mockWorkspace`、`mockCallLlm` 的 mock 结构，再决定是否需要调整 helper 函数
- `makeThread` 需要包含 `goal` 字段（WP01 已添加到 `Thread` interface）
- V5 测试 `callLlm` 抛出时，`markMemoryUsed` 仍被调用——这验证了 try/catch 外部的 fallback 路径
- V3/V4 验证了 goal=null 和线程不存在两种回退路径都不调用 LLM

---

### Subtask T006 — 零回归验证

**Purpose**: 运行全量测试，确认无新增 failure。

```bash
cd /Volumes/leoyun/aima
bun tsc --noEmit
bun test
```

如有测试失败，分析原因并修复，确保新增的 goal 字段没有影响现有测试中的 `Thread` mock 对象（需补充 `goal: null` 字段）。

**Files**: 可能需要更新现有测试中的 `Thread` mock，添加 `goal: null`

**Validation**:
- [ ] `bun tsc --noEmit` → 零编译错误
- [ ] `bun test` → 零新增 failure

---

## Risks & Mitigations

| 风险 | 可能性 | 缓解方案 |
|---|---|---|
| 现有测试中 `Thread` mock 对象缺少 `goal` 字段，导致 TypeScript 编译错误 | 高 | T006 时扫描所有 mock Thread 对象，添加 `goal: null` |
| `mockWorkspace` 中无 `getThread` mock | 中 | T005 步骤 2 明确说明：若不存在则添加 `getThread: mock(() => Promise.resolve(null))` |
| LLM prompt 模板构造不当（目标/回复为空字符串边界）| 低 | `goal` 的 falsy check（`if (goal)`）已处理空字符串；`reply` 的 undefined check 已处理无回复情况 |
| `markMemoryUsed` 在 try/catch 内外各调用一次（重复调用 bug）| 低 | plan.md 草稿使用 `return` 语句在 LLM 路径成功后退出，防止执行到 fallback |

## Definition of Done Checklist

- [ ] `grep -n "getThread" src/dmn/reactive/index.ts` → `feedbackMemoryUsage` 含 getThread 调用
- [ ] `grep -n "fallbackOutcome" src/dmn/reactive/index.ts` → fallback 变量存在（在 try 块之前）
- [ ] `grep -n "callLlm" src/dmn/reactive/index.ts` → goal 评估含 LLM 调用
- [ ] `grep -n "achieved" src/dmn/reactive/index.ts` → LLM 结果解析含 achieved 字段
- [ ] V1-V7 七个 test case 通过
- [ ] `bun test tests/unit/dmn/` → 全通过
- [ ] `bun tsc --noEmit` → 零编译错误
- [ ] `bun test` → 全量零新增 failure

## Review Guidance

- 验证 T004：`fallbackOutcome` 在 try 块之前计算（同步调用，不在 try 内）
- 验证 T004：`return` 语句在 LLM 路径成功的 `markMemoryUsed` 之后（防止重复调用）
- 验证 T004：末尾的 `markMemoryUsed(injectedIds, fallbackOutcome)` 在 try/catch 完全外部
- 验证 T004：goal 为空字符串时 `if (goal)` 判断为 false，正确回退启发式
- 验证 T005：V5 测试验证的是 `callLlm` 抛出后 `markMemoryUsed` 仍被调用（fallback 路径生效）
- 验证 T005：V3 测试中 mock `callLlm` 的调用次数为 0（明确 assert `not.toHaveBeenCalled`）

## Activity Log

- 2026-03-13T00:00:00Z – system – lane=planned – Prompt generated via spec-kitty agent workflow
