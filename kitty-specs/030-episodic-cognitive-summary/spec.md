# Feature Specification: Episodic Cognitive Summary

**Feature**: 030-episodic-cognitive-summary
**Status**: draft
**Created**: 2026-03-13
**Depends on**: Feature 015 (DMN Reactive), Feature 024 (buildEpisodicContent template format)

---

## Overview

`brain.complete` 事件的 payload 不携带 Slot 数据。DMN Reactive 的三个核心职责——episodic 写入（Responsibility 3/4）、记忆使用反馈（Responsibility 5）、回溯纠错（Responsibility 2）——全部依赖 `payload.outputSlot`，而这个字段在事件里永远是 `undefined`。

结果：

- `buildEpisodicContent` 产生 `[cortex] decided: complete | status: unknown | thread: 123`——`handoff`、`reply`、`next`、`status` 全是空值
- `feedbackMemoryUsage` 的 outcome 判断基于 `undefined`，总是返回 `neutral`
- `retroactiveCorrection` 的异常检测基于 `undefined`，`hasNoOutput` 始终为 true，预检失效
- `shouldStartNewSegment` 的分段判断同样读取 `undefined`

本 feature 修复根因，并在修复基础上补充 `situation:` 字段，让 episodic 记录成为真正的认知摘要。

---

## Actors

- **`ThreadRunner.activateBrain()`**：触发 `brain.complete` 事件，payload 不含 Slot 数据
- **`DmnReactive.handleBrainComplete()`**：分发给三个子职责，是插入 Slot 数据的最佳位置
- **`buildEpisodicContent()`**：当前产出空洞内容，修复后产出认知摘要
- **`feedbackMemoryUsage()`**：outcome 判断依赖 Slot 状态，当前失效
- **`retroactiveCorrection()`**：异常检测依赖 Slot 状态，当前失效
- **`shouldStartNewSegment()`**：分段判断依赖 Slot 输出，当前失效

---

## Root Cause

Runner 的 `activateBrain()` 只在 payload 里放了 `{brain, threadId, stopReason, injectedMemoryIds}`。DMN Reactive 的所有子职责读取 `payload.outputSlot`，但该字段从未写入，始终为 `undefined`。

---

## Functional Requirements

### FR-01：handleBrainComplete 在分发前获取 Slot + Thread 数据

`DmnReactive.handleBrainComplete()` 在调用三个子职责之前，从 workspace 获取完整 Slot 数据和 Thread 数据，构造 enriched event 传递：

- 并发获取 `getSlotsByThread(thread_id)` 和 `getThread(thread_id)`
- 找到 brain 对应的 Slot，注入 enriched payload 作为 `outputSlot`
- Thread 数据同样注入，供 `buildEpisodicContent` 获取 `trigger`
- `outputSlot` 找不到时降级为 `null`，子职责不崩溃

**Acceptance criteria**：
- 三个子职责接收的 payload 中 `outputSlot` 是真实 Slot 对象（含 input、output、status）
- 降级场景不抛出异常

### FR-02：buildEpisodicContent 加入 situation 字段

从 enriched payload 提取 situation：

- Cortex / Brainstem：`outputSlot.input?.handoff`
- Limbic：slot input 无 handoff 时回退到 `thread?.trigger`
- 超过 200 字符时截断；无来源时省略

新格式示例：
```
[cortex] situation: "需要分析：用户询问发票 X" | decided: route → brainstem | handoff: "任务：查找发票 X" | thread: 123
[limbic] situation: "批准预算" | decided: route → cortex | handoff: "需要分析：预算审批请求" | thread: 456
[brainstem] situation: "任务：查找发票 X" | decided: complete | reply: "找到 3 条发票记录" | thread: 123
```

**Acceptance criteria**：
- Cortex/Brainstem episodic 含 `situation:` 来自上一脑区 handoff
- Limbic episodic 含 `situation:` 来自 thread.trigger
- 无来源时字段省略
- `decided:` 反映真实路由决策

### FR-03：feedbackMemoryUsage 基于真实 Slot 状态判断 outcome

- `slot.status === 'error'` → `negative`
- `output.reply != null` → `positive`
- 其他 → `neutral`

### FR-04：retroactiveCorrection 基于真实 Slot 状态触发异常检测

- 正常完成（output 非 null，status = 'done'）→ 跳过，不触发 LLM
- `slot.status === 'error'` 或 output == null → 触发 LLM 纠错

### FR-05：shouldStartNewSegment 读取真实 Slot 数据

使用 enriched event，error slot 正确触发新 segment，`needs_analysis` 正确检测。

---

## User Scenarios & Testing

### Scenario A：Cortex episodic 包含真实 situation 和 handoff

1. Limbic 产出 `handoff: "需要分析：用户询问发票"`，写入 Cortex slot input
2. Cortex 产出 `handoff: "任务：查找发票"`, `next: 'brainstem'`
3. DMN Reactive 获取 enriched slot 后写入 episodic
4. 结果: `[cortex] situation: "需要分析：用户询问发票" | decided: route → brainstem | handoff: "任务：查找发票" | ...`

**Test** (unit): mock workspace 返回含 input.handoff 的 Cortex slot，assert episodic content。

### Scenario B：Limbic situation 来自 thread.trigger

Thread trigger = '批准预算'，Limbic slot input = null → episodic 含 `situation: "批准预算"`。

**Test** (unit): mock thread.trigger，slot input = null。

### Scenario C：无 situation 来源时省略字段

trigger = null，slot input = null → episodic 不含 `situation:` 字段。

**Test** (unit): assert content 不含 `situation:`。

### Scenario D：feedbackMemoryUsage outcome 正确

三个 mock 场景（error / reply / neutral），spy `markMemoryUsed`，assert 正确 outcome。

### Scenario E：retroactiveCorrection 正常完成不触发 LLM

mock 正常 slot（status='done'，output 非 null），spy LLM call，assert 未调用。

### Scenario F：integration test 断言更新

`tests/integration/dmn/dmn.test.ts` 的 episodic content 断言更新为新格式。

---

## Key Entities

- **`src/dmn/reactive/index.ts`**：`handleBrainComplete`、`buildEpisodicContent`、及其他使用 outputSlot 的子职责
- **`tests/unit/dmn-reactive.test.ts`**：新增 Scenarios A-E 单元测试
- **`tests/integration/dmn/dmn.test.ts`**：更新 episodic content 格式断言

---

## Assumptions

- `getSlotsByThread` 和 `getThread` 并发调用安全（只读查询）
- Slot input 结构为 `{ handoff?: string }`（已有 schema）
- Limbic 首次激活的 slot input 为 null——architecture design，非 bug
- `brain.complete` 事件的公开契约不变（enrichment 在 DMN 内部完成）

---

## Success Criteria

1. DMN Reactive 所有 `brain.complete` 子职责收到真实 Slot + Thread 数据
2. episodic 记录的 `decided:` 反映真实路由决策
3. episodic 记录包含 `situation:` 字段
4. `feedbackMemoryUsage` outcome 在 error 场景为 `negative`，reply 场景为 `positive`
5. `retroactiveCorrection` 在正常完成时不触发 LLM 调用
6. 所有现有测试通过，typecheck + biome 干净

---

## Out of Scope

- 修改 `brain.complete` 事件的公开 payload 结构
- Segment 持久化（threadSegments Map 重启丢失）——独立 feature
- retroactiveCorrection LLM prompt 内容优化
