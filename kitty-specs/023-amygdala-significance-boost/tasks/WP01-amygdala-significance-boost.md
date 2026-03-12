---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
  - "T003"
title: "Amygdala Significance Boost — Emit + DMN Episodic Encoding + Tests"
phase: "Phase 1 - Full Implementation"
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

# Work Package Prompt: WP01 — Amygdala Significance Boost

## Objectives & Success Criteria

当 Amygdala 的 `startListening()` 拦截到 block 或 escalate 决策时，在发出的 `amygdala.interrupt`
事件 payload 中加入 `significance_boost` 字段；DMN Reactive 订阅到该事件后，将其编码为带有更高
`baseImportance` 的 episodic 记忆和 `significance_mark` 记录。完成后：

- `amygdala.interrupt` payload 含 `significance_boost: 0.4`（block）或 `significance_boost: 0.2`（escalate）
- DMN Reactive 在收到 `amygdala.interrupt` ALERT 事件时写入 episodic memory，
  `baseImportance = Math.min(1.0, 0.5 + significance_boost)`
- DMN Reactive 同时写入 `significance_mark` episodic 记录（boost 始终 > 0 for interrupt events）
- `bun tsc --noEmit` 零编译错误
- 新增单元测试全部通过，现有测试零回归

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/023-amygdala-significance-boost/spec.md`
- **Plan**: `kitty-specs/023-amygdala-significance-boost/plan.md` — 含完整实现草稿和代码片段
- **Source files**:
  - `src/amygdala/index.ts` — `startListening()` method at line 191；修改 line 208 附近的 emit 调用
  - `src/dmn/reactive/index.ts` — `handleEvent()` at line 97；新增 routing clause 和 `handleAmygdalaInterrupt()` method
  - `tests/unit/amygdala.test.ts` — 在 `Amygdala.startListening` describe block 末尾新增 2 个测试
  - `tests/unit/dmn/dmn-reactive.test.ts` — 新增 describe block for amygdala interrupt path
- **Depends on**: 无（amygdala 和 DMN Reactive 均已存在，无接口变更依赖）
- **Constraints**:
  - 不修改 `Amygdala.check()` — check() 不发送事件，这一行为不变
  - amygdala interrupt 的 episodic 记录不包含 `segmentId`/`segmentSeq` — 这类事件是跨线程信号，不属于 brain 执行 segment
  - 不改动 `brain.complete` significance boost 路径（line 152–183，已实现）
  - 字段名使用 `significance_boost`（snake_case），与 `brain.complete` 路径的已有约定一致

---

## Subtasks & Detailed Guidance

### Subtask T001 — 在 `amygdala.interrupt` payload 加入 `significance_boost`

**Purpose**: Amygdala 对外广播其决策强度，让 DMN Reactive 和未来的任何订阅方都能读取 boost 值，
无需自行推断决策类型。

**Steps**:

1. 打开 `src/amygdala/index.ts`，找到 `startListening()` 方法（line 191）。

当前 emit 代码（约 line 208）：
```typescript
this.eventBus.emit({
  event_type: 'amygdala.interrupt',
  level: 'ALERT',
  brain: 'amygdala',
  thread_id: event.thread_id,
  session_id: event.session_id,
  causation_id: event.event_id,
  payload: { tool: toolName, decision, reason },
})
```

在 emit 调用前添加 boost 计算，并扩展 payload：
```typescript
const significanceBoost = decision === 'block' ? 0.4 : 0.2

this.eventBus.emit({
  event_type: 'amygdala.interrupt',
  level: 'ALERT',
  brain: 'amygdala',
  thread_id: event.thread_id,
  session_id: event.session_id,
  causation_id: event.event_id,
  payload: { tool: toolName, decision, reason, significance_boost: significanceBoost },
})
```

注意：`allow` 不会到达这个分支（guard 是 `if (decision === 'block' || decision === 'escalate')`），
所以不需要处理 allow 的情况。

**Files**: `src/amygdala/index.ts`（约 +2 行）

**Validation**:
- [ ] `grep "significance_boost" src/amygdala/index.ts` → 1 处 match

---

### Subtask T002 — DMN Reactive 处理 `amygdala.interrupt` 并写入 episodic 记忆

**Purpose**: 将 Amygdala 的 block/escalate 决策编码为 episodic 记忆，使 Hippocampus replay
能够识别并优先处理高风险 tool 相关的历史片段。

**Steps**:

1. 打开 `src/dmn/reactive/index.ts`，在 `handleEvent()` 方法（line 97）末尾，在 `brain.complete`
   routing block 之后，添加新的 routing clause：

```typescript
// Responsibility 8: Amygdala interrupt → episodic encoding
if (event_type === 'amygdala.interrupt' && level === 'ALERT') {
  await this.handleAmygdalaInterrupt(event)
}
```

2. 在类的末尾（`handleSignalCapture` 之后）添加新的 private method：

```typescript
// ── Responsibility 8: Amygdala interrupt episodic encoding ─────────────────

private async handleAmygdalaInterrupt(event: BrainEvent): Promise<void> {
  const { thread_id, payload } = event
  const workspace = this.config.workspace

  const toolName = payload.tool as string | undefined
  const decision = payload.decision as string | undefined
  const significanceBoost = (payload.significance_boost as number | undefined) ?? 0
  const baseImportance = Math.min(1.0, 0.5 + significanceBoost)

  const tags = [
    'amygdala_interrupt',
    ...(decision ? [decision] : []),
    ...(toolName ? [toolName] : []),
    ...(thread_id ? [`thread:${thread_id}`] : []),
  ]

  await workspace.writeMemory({
    type: 'episodic',
    sourceBrain: 'amygdala',
    threadId: thread_id ?? undefined,
    content: JSON.stringify({
      event_type: 'amygdala_interrupt',
      tool: toolName,
      decision,
      reason: payload.reason,
      significance_boost: significanceBoost,
      timestamp: new Date().toISOString(),
    }),
    baseImportance,
    tags,
  })

  // significance_mark: always written for interrupt events (boost > 0)
  if (significanceBoost > 0) {
    await workspace.writeMemory({
      type: 'episodic',
      sourceBrain: 'amygdala',
      threadId: thread_id ?? undefined,
      content: JSON.stringify({
        event_type: 'significance_mark',
        boost: significanceBoost,
        trigger: 'amygdala',
        tool: toolName,
        decision,
      }),
      baseImportance: Math.min(1.0, 0.7 + significanceBoost),
      tags: ['significance_mark', 'amygdala', ...(thread_id ? [`thread:${thread_id}`] : [])],
    })
  }
}
```

关键约束：
- 不使用 `segmentId` / `segmentSeq` — amygdala interrupt 不属于 brain 执行 segment
- `significance_boost` 缺失时 default 为 0（向后兼容）
- `significance_mark` 只在 `significanceBoost > 0` 时写入（interrupt 事件始终满足，但 guard 保持安全）

**Files**: `src/dmn/reactive/index.ts`（约 +45 行）

**Validation**:
- [ ] `grep "handleAmygdalaInterrupt" src/dmn/reactive/index.ts` → 2 处 match（定义 + 调用）
- [ ] `bun tsc --noEmit` → 零编译错误

---

### Subtask T003 — 单元测试

**Purpose**: 验证 T001/T002 的行为，并确保 allow 决策不触发错误 boost、backward compatibility 有效。

**Steps**:

#### 3a. `tests/unit/amygdala.test.ts` — 在现有 `Amygdala.startListening` describe block 末尾追加 2 个测试

```typescript
test('emits significance_boost: 0.4 in amygdala.interrupt payload on block', async () => {
  const { eventBus, amygdala } = makeSetup()
  const captured: Record<string, unknown>[] = []
  eventBus.subscribeLevel('ALERT', (e) => {
    if (e.event_type === 'amygdala.interrupt') captured.push(e.payload)
  })
  amygdala.startListening()
  eventBus.emit({
    event_type: 'tool.pre_use',
    level: 'INFO',
    brain: 'brainstem',
    thread_id: 'thread-1',
    payload: { tool: 'bash', args: {} },
  })
  await new Promise((r) => setTimeout(r, 10))
  expect(captured).toHaveLength(1)
  expect(captured[0]?.significance_boost).toBe(0.4)
  expect(captured[0]?.decision).toBe('block')
})

test('emits significance_boost: 0.2 in amygdala.interrupt payload on escalate', async () => {
  const { eventBus, amygdala } = makeSetup({
    rules: [{ toolName: 'some_tool', decision: 'escalate', reason: 'test escalate' }],
  })
  const captured: Record<string, unknown>[] = []
  eventBus.subscribeLevel('ALERT', (e) => {
    if (e.event_type === 'amygdala.interrupt') captured.push(e.payload)
  })
  amygdala.startListening()
  eventBus.emit({
    event_type: 'tool.pre_use',
    level: 'INFO',
    brain: 'brainstem',
    thread_id: 'thread-1',
    payload: { tool: 'some_tool', args: {} },
  })
  await new Promise((r) => setTimeout(r, 10))
  expect(captured).toHaveLength(1)
  expect(captured[0]?.significance_boost).toBe(0.2)
  expect(captured[0]?.decision).toBe('escalate')
})
```

#### 3b. `tests/unit/dmn/dmn-reactive.test.ts` — 追加 describe block

使用与 `tests/unit/dmn/dmn-reactive-brain-complete.test.ts` 相同的 `makeConfig()` helper 模式。
如果 `dmn-reactive.test.ts` 不存在或已有独立 helper，参考 `dmn-reactive-brain-complete.test.ts`
的完整 helper 定义复制到新 describe 块所在文件。

```typescript
describe('DmnReactive — amygdala.interrupt handler', () => {
  function makeAmygdalaInterruptEvent(overrides: Partial<BrainEvent> = {}): BrainEvent {
    return {
      event_id: 'amyg-test-id',
      event_type: 'amygdala.interrupt',
      level: 'ALERT',
      occurred_at: new Date(),
      brain: 'amygdala',
      thread_id: 'thread-1',
      session_id: null,
      causation_id: null,
      schema_version: '1.0',
      payload: {
        tool: 'bash',
        decision: 'block',
        reason: 'blocked by policy',
        significance_boost: 0.4,
      },
      ...overrides,
    }
  }

  it('writes episodic memory with boosted baseImportance on block interrupt', async () => {
    const { config, bus, ws } = makeConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(makeAmygdalaInterruptEvent())
    await new Promise((r) => setTimeout(r, 20))

    expect(ws.writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'episodic',
        sourceBrain: 'amygdala',
        baseImportance: 0.9,   // Math.min(1.0, 0.5 + 0.4)
        tags: expect.arrayContaining(['amygdala_interrupt', 'block', 'bash']),
      }),
    )
  })

  it('writes significance_mark record on amygdala.interrupt', async () => {
    const { config, bus, ws } = makeConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(makeAmygdalaInterruptEvent())
    await new Promise((r) => setTimeout(r, 20))

    const calls = (ws.writeMemory as ReturnType<typeof mock>).mock.calls.map(
      (c) => c[0] as { tags: string[] },
    )
    expect(calls.some((c) => c.tags.includes('significance_mark'))).toBe(true)
  })

  it('uses baseImportance=0.5 when significance_boost absent (backward compat)', async () => {
    const { config, bus, ws } = makeConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(
      makeAmygdalaInterruptEvent({
        payload: { tool: 'bash', decision: 'block', reason: 'test' }, // no significance_boost
      }),
    )
    await new Promise((r) => setTimeout(r, 20))

    const episodicCall = (ws.writeMemory as ReturnType<typeof mock>).mock.calls
      .map((c) => c[0] as { type: string; baseImportance: number; tags: string[] })
      .find((c) => c.type === 'episodic' && c.tags.includes('amygdala_interrupt'))

    expect(episodicCall?.baseImportance).toBe(0.5)
  })

  it('does not write episodic for amygdala.interrupt at non-ALERT level', async () => {
    const { config, bus, ws } = makeConfig()
    const reactive = new DmnReactive(config)
    await reactive.start()

    bus._dispatch(
      makeAmygdalaInterruptEvent({ level: 'INFO' }),  // wrong level — should not trigger
    )
    await new Promise((r) => setTimeout(r, 20))

    const amygdalaCalls = (ws.writeMemory as ReturnType<typeof mock>).mock.calls
      .map((c) => c[0] as { tags?: string[] })
      .filter((c) => c.tags?.includes('amygdala_interrupt'))

    expect(amygdalaCalls).toHaveLength(0)
  })
})
```

**Files**:
- `tests/unit/amygdala.test.ts` (edit, +50 lines)
- `tests/unit/dmn/dmn-reactive.test.ts` (edit or new sibling file, +80 lines)

**Validation**:
- [ ] `bun test tests/unit/amygdala.test.ts` → all tests pass (existing + 2 new)
- [ ] `bun test tests/unit/dmn/` → all tests pass (existing + 4 new)
- [ ] `bun test` → zero regressions

---

## Risks & Mitigations

| 风险 | 可能性 | 缓解方案 |
|---|---|---|
| `dmn-reactive.test.ts` 不存在或 `makeConfig()` helper 不可复用 | 低 | 从 `dmn-reactive-brain-complete.test.ts` 复制 helper；或新建 `dmn-reactive-amygdala-interrupt.test.ts` |
| `handleEvent()` 中新 routing clause 与 `handleSignalCapture` 的 ALERT 路由重复处理 | 低 | `handleSignalCapture` 先走 signal rules（无 amygdala.interrupt rule）→ 再走 Haiku fallback；两者独立，不冲突，但会触发两次处理。考虑在 `handleSignalCapture` 跳过已由 `handleAmygdalaInterrupt` 处理的事件类型 |
| `baseImportance = 0.9`（0.5 + 0.4）被错误断言为其他值 | 低 | plan.md 中公式明确，测试断言 `0.9`，与 `brain.complete` 路径的 `0.7` base 对齐（amygdala 中断更高优先级）|

## Definition of Done Checklist

- [ ] `grep "significance_boost" src/amygdala/index.ts` → 1 处 match
- [ ] `grep "handleAmygdalaInterrupt" src/dmn/reactive/index.ts` → 2 处 match（定义 + 调用）
- [ ] `bun tsc --noEmit` → 零编译错误
- [ ] `bun test tests/unit/amygdala.test.ts` → 全部通过（含 2 个新测试）
- [ ] `bun test tests/unit/dmn/` → 全部通过（含 4 个新测试）
- [ ] `bun test` → 零回归

## Review Guidance

- T001：确认 `significance_boost` 在 payload 中，key 名用 snake_case（`significance_boost`），与 `brain.complete` 路径一致
- T002：确认 `handleAmygdalaInterrupt` 没有 `segmentId`/`segmentSeq` 字段；确认 backward-compat guard（`?? 0`）存在
- T003：检查 `baseImportance: 0.9` 断言（block boost = 0.4，公式 0.5 + 0.4 = 0.9）；escalate 断言为 `0.7`（0.5 + 0.2）

## Activity Log

- 2026-03-13T00:00:00Z – system – lane=planned – Prompt generated via spec-kitty agent workflow
