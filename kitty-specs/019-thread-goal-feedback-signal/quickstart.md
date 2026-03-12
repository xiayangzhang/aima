# Quickstart & Validation: Thread Goal Feedback Signal

## 构建验证

```bash
cd /Volumes/leoyun/aima
bun tsc --noEmit
bun test tests/unit/dmn/
bun test
```

## 验证场景

### V1 — 携带 goal 的线程，LLM 评估 achieved=true → positive

```typescript
// mock workspace.getThread → { goal: 'Send a confirmation email reply', ...}
// mock callLlm → '{"achieved": true, "reason": "reply confirms email sent"}'
// event.payload.injectedMemoryIds = ['mem-001', 'mem-002']
// event.payload.outputSlot.output.reply = 'I have sent the confirmation email.'

const event = makeBrainCompleteEvent({
  threadId: 'thread-123',
  injectedMemoryIds: ['mem-001', 'mem-002'],
  reply: 'I have sent the confirmation email.',
})
mockWorkspace.getThread.mockResolvedValue({ id: 'thread-123', goal: 'Send a confirmation email reply', ... })
mockCallLlm.mockResolvedValue('{"achieved": true, "reason": "reply confirms email sent"}')

await dmnReactive['feedbackMemoryUsage'](event)

expect(mockMarkMemoryUsed).toHaveBeenCalledWith(['mem-001', 'mem-002'], 'positive')
expect(mockCallLlm).toHaveBeenCalledTimes(1)
```

### V2 — 携带 goal 的线程，LLM 评估 achieved=false → negative

```typescript
// mock workspace.getThread → { goal: 'Book the flight', ... }
// mock callLlm → '{"achieved": false, "reason": "no booking confirmation"}'
// reply = 'I need more information about your travel dates.'

mockWorkspace.getThread.mockResolvedValue({ id: 'thread-456', goal: 'Book the flight', ... })
mockCallLlm.mockResolvedValue('{"achieved": false, "reason": "no booking confirmation"}')

await dmnReactive['feedbackMemoryUsage'](event)

expect(mockMarkMemoryUsed).toHaveBeenCalledWith(['mem-001'], 'negative')
```

### V3 — thread.goal 为 null → 回退启发式，LLM 不被调用

```typescript
// mock workspace.getThread → { goal: null, ... }
// event has output.reply = 'Hello, how can I help?' (→ evaluateOutcome = 'positive')

mockWorkspace.getThread.mockResolvedValue({ id: 'thread-789', goal: null, ... })

await dmnReactive['feedbackMemoryUsage'](event)

expect(mockCallLlm).not.toHaveBeenCalled()
expect(mockMarkMemoryUsed).toHaveBeenCalledWith(expect.any(Array), 'positive')
```

### V4 — workspace.getThread 返回 null → 回退启发式

```typescript
// mock workspace.getThread → null (thread not found)

mockWorkspace.getThread.mockResolvedValue(null)

await dmnReactive['feedbackMemoryUsage'](event)

expect(mockCallLlm).not.toHaveBeenCalled()
expect(mockMarkMemoryUsed).toHaveBeenCalledWith(
  expect.any(Array),
  expect.stringMatching(/positive|negative|neutral/),
)
```

### V5 — callLlm 抛出异常 → 回退启发式，markMemoryUsed 仍被调用

```typescript
// mock workspace.getThread → { goal: 'some goal', ... }
// mock callLlm → throws new Error('llm timeout')
// event outputSlot has reply

mockWorkspace.getThread.mockResolvedValue({ id: 'thread-abc', goal: 'some goal', ... })
mockCallLlm.mockRejectedValue(new Error('llm timeout'))

// should not throw
await expect(dmnReactive['feedbackMemoryUsage'](event)).resolves.toBeUndefined()

// markMemoryUsed should still be called with heuristic result
expect(mockMarkMemoryUsed).toHaveBeenCalledTimes(1)
expect(mockCallLlm).toHaveBeenCalledTimes(1)
```

### V6 — injectedMemoryIds 为空 → 提前 return，无任何调用

```typescript
// event.payload.injectedMemoryIds = []

const eventNoIds = makeBrainCompleteEvent({ threadId: 'thread-abc', injectedMemoryIds: [] })

await dmnReactive['feedbackMemoryUsage'](eventNoIds)

expect(mockWorkspace.getThread).not.toHaveBeenCalled()
expect(mockCallLlm).not.toHaveBeenCalled()
expect(mockMarkMemoryUsed).not.toHaveBeenCalled()
```

### V7 — goal 存在但 reply 为 null → 回退启发式

```typescript
// mock workspace.getThread → { goal: 'some goal', ... }
// event outputSlot.output.reply = undefined (no reply, e.g. routing turn)

mockWorkspace.getThread.mockResolvedValue({ id: 'thread-abc', goal: 'some goal', ... })

await dmnReactive['feedbackMemoryUsage'](event)

expect(mockCallLlm).not.toHaveBeenCalled()
expect(mockMarkMemoryUsed).toHaveBeenCalledWith(expect.any(Array), 'neutral') // evaluateOutcome → neutral when no reply and no error
```

### V8 — 零回归（所有现有测试通过）

```bash
bun test
# 全部现有测试通过，无新 failure
```

## Definition of Done

- [ ] `grep -n "goal" src/schema/threads.ts` → `goal: text('goal')` 存在
- [ ] `grep -n "goal" src/types/index.ts` → `Thread.goal` 和 `CreateThreadParams.goal` 均存在
- [ ] `grep -n "goal" src/workspace/index.ts` → `mapThreadRow` 和 `createThread` 均含 goal 映射
- [ ] Drizzle migration 文件已生成（`drizzle/migrations/` 新增文件含 `goal` 列）
- [ ] `grep -n "getThread" src/dmn/reactive/index.ts` → feedbackMemoryUsage 含 goal 获取逻辑
- [ ] `grep -n "callLlm" src/dmn/reactive/index.ts` → goal 评估含 LLM 调用
- [ ] V1-V7 场景均有对应 test case
- [ ] `bun test tests/unit/dmn/` → 全通过
- [ ] `bun tsc --noEmit` → 无编译错误
- [ ] `bun test` → 全量零新增 failure
