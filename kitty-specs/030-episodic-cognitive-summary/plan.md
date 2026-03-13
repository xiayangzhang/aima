# Implementation Plan: Episodic Cognitive Summary

**Branch**: `030-episodic-cognitive-summary` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

---

## Summary

`brain.complete` 事件 payload 从不携带 Slot 数据，导致 DMN Reactive 所有依赖 `payload.outputSlot` 的逻辑（episodic 写入、记忆反馈、纠错预检、分段判断）全部读取 `undefined`。

修复：`handleBrainComplete` 在分发前并发获取 Slot + Thread，构造 enriched event。同时在 `buildEpisodicContent` 加入 `situation:` 字段，让 episodic 记录从执行状态升级为认知摘要。

---

## Technical Context

- **受影响文件**：`src/dmn/reactive/index.ts`（唯一改动文件）
- **依赖的 workspace 方法**：`getSlotsByThread(threadId)` + `getThread(threadId)`——两者均已存在
- **Slot schema**：`slot.input = { handoff?: string }`，`slot.output = BrainOutput`，`slot.status = SlotStatus`
- **Thread schema**：`thread.trigger = string | null`
- **事件契约不变**：enrichment 在 DMN 内部完成，`brain.complete` payload 结构不变

---

## Implementation Plan

### 步骤 1：`handleBrainComplete` 获取 enriched data

```typescript
private async handleBrainComplete(event: BrainEvent): Promise<void> {
  const { brain, thread_id } = event
  if (!thread_id) return

  const [slots, thread] = await Promise.all([
    this.config.workspace.getSlotsByThread(thread_id),
    this.config.workspace.getThread(thread_id),
  ])
  const outputSlot = slots.find((s) => s.brain === brain) ?? null

  const enrichedEvent: BrainEvent = {
    ...event,
    payload: { ...event.payload, outputSlot, thread },
  }

  await Promise.all([
    this.assignSegmentAndWriteEpisodic(enrichedEvent),
    this.feedbackMemoryUsage(enrichedEvent),
    this.retroactiveCorrection(enrichedEvent),
  ])
}
```

所有子职责的 `payload.outputSlot` 读取无需修改——数据到位后自然生效。

### 步骤 2：`buildEpisodicContent` 加入 `situation:`

从 enriched payload 提取 situation，插入格式字符串第一位：

```typescript
// 新增 situation 提取
const slotInput = outputSlot?.input as Record<string, unknown> | null | undefined
const handoffIn = (slotInput?.handoff as string | undefined) ?? null
const thread = (payload.thread as { trigger?: string | null } | undefined) ?? null
const situation = handoffIn ?? thread?.trigger ?? null

// 新格式
const parts: string[] = [`[${brain}]`]
if (situation) parts.push(`situation: "${situation.slice(0, 200)}"`)
parts.push(`decided: ${decision}`)
// ... 其余字段不变
```

### 步骤 3：更新测试

- `tests/unit/dmn-reactive.test.ts`：新增 Scenarios A-E（mock workspace 返回 slot+thread）
- `tests/integration/dmn/dmn.test.ts`：更新 episodic content 格式断言（加 `situation:`，`decided:` 变为真实值）

---

## 改动范围

| 文件 | 改动类型 | 预估行数 |
|---|---|---|
| `src/dmn/reactive/index.ts` | 修改 `handleBrainComplete` + `buildEpisodicContent` | ~20 行 |
| `tests/unit/dmn-reactive.test.ts` | 新增单元测试 Scenarios A-E | ~100 行 |
| `tests/integration/dmn/dmn.test.ts` | 更新断言 | ~10 行 |

---

## 测试策略

单元测试（mock workspace）：
- **Scenario A**：Cortex slot 含 `input.handoff` → situation 来自 handoff
- **Scenario B**：Limbic slot input = null，thread.trigger 非 null → situation 来自 trigger
- **Scenario C**：两者均为 null → situation 字段省略
- **Scenario D**：feedbackMemoryUsage outcome（error/reply/neutral 三种）
- **Scenario E**：retroactiveCorrection 正常完成不触发 LLM

集成测试：
- **Scenario F**：更新 `dmn.test.ts` 中 episodic content 的格式断言

---

## 风险

- **并发 DB 查询**：`getSlotsByThread` + `getThread` 并发调用，每次 `brain.complete` 多 2 次 DB query。对于高频激活场景有轻微开销，可接受（DMN Reactive 是异步后台处理）。
- **Slot 找不到**：`slots.find(s => s.brain === brain) ?? null`，降级为 null，所有子职责已有 `outputSlot?.xxx` 的 optional chaining，不会崩溃。
