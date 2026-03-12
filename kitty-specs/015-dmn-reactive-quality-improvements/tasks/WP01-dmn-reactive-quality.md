---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
  - "T003"
  - "T004"
title: "DMN Reactive Quality"
phase: "Phase 1 - Implementation"
lane: "done"
assignee: ""
agent: "claude"
shell_pid: ""
review_status: "approved"
dependencies: []
reviewed_by: "claude"
history:
  - timestamp: "2026-03-12T11:10:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
  - timestamp: "2026-03-13T00:10:00Z"
    lane: "done"
    agent: "claude"
    shell_pid: ""
    action: "Review passed: pre-check correctly placed before DB query with OR logic; || null normalization for handoff correct; T033 V1-V4 + T034 V5-V8 all scenarios covered; T036 integration tests solid; T029 updated correctly for error-status path."
---

# Work Package Prompt: WP01 — DMN Reactive Quality

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` field. If `has_feedback`, scroll to Review Feedback section.
- **Mark as acknowledged**: Update `review_status: acknowledged` when you begin addressing feedback.

---

## Review Feedback

*[Empty initially — reviewers populate if work is returned.]*

---

## Objectives & Success Criteria

在 `src/dmn/reactive/index.ts` 实现两处质量改进：

1. **P2-A** `retroactiveCorrection()` 加规则预检：正常 brain.complete 事件直接跳过 LLM 纠错调用
2. **P2-B** `buildEpisodicContent()` 加 `handoff` 字段：episodic 记录包含脑区认知摘要

完成后：
- 正常 brain.complete 路径：纠错 LLM call 次数 = 0
- 异常路径（status=error / stopReason=error / output=null）：纠错 LLM call 正常触发
- episodic content 包含 `handoff` 字段（有值时写入，无值时 null）
- 全量测试零回归

**⚠️ 前提**：本 WP 基于 Feature 013 完全合并后的代码。`buildEpisodicContent` 已改为 `{next, hasReply}` 格式（WP03 T016 完成后）。实现前先确认 `grep -n "output?.mode\|output?.intent" src/dmn/reactive/index.ts` 返回 0 matches。

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/015-dmn-reactive-quality-improvements/spec.md`
- **Plan**: `kitty-specs/015-dmn-reactive-quality-improvements/plan.md`
- **Source file**: `src/dmn/reactive/index.ts`
- **Test files**:
  - `tests/unit/dmn/dmn-reactive.test.ts`
  - `tests/unit/dmn/dmn-reactive-brain-complete.test.ts`
  - `tests/unit/dmn/dmn-comprehensive.test.ts`
- **Depends on**: Feature 013 fully merged (WP01-WP04 all done)
- **Constraints**: 不改方法签名；不改 `handleBrainComplete` 的 Promise.all 并行结构；不新增依赖

### Key background

`handleBrainComplete` 并行运行三个职责：
```typescript
await Promise.all([
  this.assignSegmentAndWriteEpisodic(event),  // Responsibility 3+4
  this.feedbackMemoryUsage(event),             // Responsibility 5
  this.retroactiveCorrection(event),           // Responsibility 2
])
```

T001 只改 `retroactiveCorrection` 内部（早期返回），T002 只改 `buildEpisodicContent`（被 `assignSegmentAndWriteEpisodic` 调用）。两者完全独立，可同时修改。

---

## Subtasks & Detailed Guidance

### Subtask T001 — retroactiveCorrection 规则预检

**Purpose**: 在 `retroactiveCorrection` 开头加三条规则判断。正常完成的 brain.complete 事件直接 return，避免 DB 查询和 LLM 调用。

**Location**: `src/dmn/reactive/index.ts`，`retroactiveCorrection` 方法，约第 269 行。

**Current code** (after Feature 013 WP03):
```typescript
private async retroactiveCorrection(event: BrainEvent): Promise<void> {
  const { brain, thread_id, payload } = event
  if (!thread_id) return

  const windowSize = this.config.retroactionWindowSize ?? 20

  const recentEvents = await this.config.workspace.searchMemory({
    type: 'episodic',
    tags: ['brain_complete', `thread:${thread_id}`],
    limit: windowSize,
    excludeInvalid: true,
  })

  if (recentEvents.length < 2) return

  // ... LLM call ...
```

**Change**: 在 `if (!thread_id) return` 之后，`windowSize` 定义之前，插入规则预检：

```typescript
private async retroactiveCorrection(event: BrainEvent): Promise<void> {
  const { brain, thread_id, payload } = event
  if (!thread_id) return

  // Rule pre-check: only run LLM correction if there's a clear anomaly signal
  const outputSlot = payload.outputSlot as Record<string, unknown> | undefined
  const output = outputSlot?.output as Record<string, unknown> | undefined

  const hasError = outputSlot?.status === 'error'
  const hasErrorStop = payload.stopReason === 'error'
  const hasNoOutput = output == null

  if (!hasError && !hasErrorStop && !hasNoOutput) return  // healthy output — skip

  const windowSize = this.config.retroactionWindowSize ?? 20
  // ... rest unchanged ...
```

**Files**: `src/dmn/reactive/index.ts`

**Validation**:
- [ ] `grep -n "hasError\|hasErrorStop\|hasNoOutput" src/dmn/reactive/index.ts` → 三个变量都有
- [ ] `grep -n "Rule pre-check" src/dmn/reactive/index.ts` → 有注释
- [ ] 逻辑：三条件 OR，任一满足则继续（不 return）；全不满足则跳过

**Notes**:
- 条件三 `hasNoOutput = output == null`：`==` 同时匹配 null 和 undefined，是正确的
- `outputSlot` 和 `output` 的 cast 模式与 `buildEpisodicContent` 一致，复用即可
- 规则预检在 DB 查询之前，正常路径连 searchMemory 都不调，零额外开销

---

### Subtask T002 — buildEpisodicContent 加 handoff 字段

**Purpose**: episodic content 中加入 `output.handoff` 字段，让 Hippocampus 回放时能读取脑区的认知摘要。

**Location**: `src/dmn/reactive/index.ts`，`buildEpisodicContent` 方法，约第 230 行。

**Current code** (after Feature 013 WP03 T016):
```typescript
private buildEpisodicContent(event: BrainEvent): string {
  const { brain, thread_id, payload } = event
  const outputSlot = payload.outputSlot as Record<string, unknown> | undefined
  const output = outputSlot?.output as Record<string, unknown> | undefined
  return JSON.stringify({
    brain,
    threadId: thread_id,
    status: outputSlot?.status,
    next: (output as Record<string, unknown> | undefined)?.next,
    hasReply: (output as Record<string, unknown> | undefined)?.reply != null,
    stopReason: payload.stopReason,
    timestamp: new Date().toISOString(),
  })
}
```

**Change**: 在 `hasReply` 行之后插入 `handoff` 字段：

```typescript
return JSON.stringify({
  brain,
  threadId: thread_id,
  status: outputSlot?.status,
  next: (output as Record<string, unknown> | undefined)?.next,
  hasReply: (output as Record<string, unknown> | undefined)?.reply != null,
  handoff: (output as Record<string, unknown> | undefined)?.handoff || null,  // ← NEW
  stopReason: payload.stopReason,
  timestamp: new Date().toISOString(),
})
```

**Files**: `src/dmn/reactive/index.ts`

**Validation**:
- [ ] `grep -n "handoff" src/dmn/reactive/index.ts` → 有输出
- [ ] 空字符串处理：`|| null` 确保空字符串变 null（不用 `??`，因为 `?? null` 不处理空字符串）
- [ ] cast 模式：`(output as Record<string, unknown> | undefined)?.handoff` 与同行其他字段一致

**Notes**:
- `output` 变量在 `buildEpisodicContent` 内已是 `Record<string, unknown> | undefined`，读 `.handoff` 类型安全
- `handoff` 是 Feature 013 引入的 BrainOutput 字段，上层脑区写入认知决策摘要时会设置它
- 如果脑区不写 handoff，值为 undefined → `|| null` → JSON 中出现 `"handoff": null`，正常

---

### Subtask T003 — 测试：纠错预过滤行为

**Purpose**: 验证规则预检的四种场景（V1 正常跳过 + V2/V3/V4 三种异常触发）。

**Location**: `tests/unit/dmn/dmn-reactive.test.ts` 或 `tests/unit/dmn/dmn-reactive-brain-complete.test.ts`

**Steps**:

1. 先 `grep -n "retroactive\|correction\|callLlm\|LLM" tests/unit/dmn/` 找到现有的纠错相关测试

2. 找到已有的纠错测试，理解 mock 模式（`callLlm` 如何被 mock）

3. 新增或修改以下四个测试：

**Test V1 — 正常输出：纠错不触发**:
```typescript
it('skips retroactive correction LLM call for healthy brain.complete', async () => {
  // mock callLlm to track calls
  const llmCallCount = { correction: 0 }
  // ... setup mock ...

  // 发送 brain.complete 事件：status='done', output={ next: null, reply: 'response text' }
  // event.payload.stopReason = undefined (no error)

  await dmn.handleEvent(healthyBrainCompleteEvent)

  // 断言：callLlm 未被调用（或被调用 0 次，用于纠错路径）
  expect(llmCallCount.correction).toBe(0)
})
```

**Test V2 — status=error：触发**:
```typescript
it('runs retroactive correction LLM when slot status is error', async () => {
  // 给 status='error' 的 brain.complete 事件
  // 断言：callLlm 被调用
})
```

**Test V3 — stopReason=error：触发**:
```typescript
it('runs retroactive correction LLM when stopReason is error', async () => {
  // status='done' 但 stopReason='error'
  // 断言：callLlm 被调用
})
```

**Test V4 — output=null：触发**:
```typescript
it('runs retroactive correction LLM when output is null', async () => {
  // status='done', output=null, stopReason=undefined
  // 断言：callLlm 被调用
})
```

4. 参考现有测试的 `callLlm` mock 方式。如果 `callLlm` 是 module-level import，可能需要用 `mock.module()` 或 spy。

**Files**: `tests/unit/dmn/dmn-reactive.test.ts` 或 `tests/unit/dmn/dmn-reactive-brain-complete.test.ts`

**Validation**:
- [ ] V1-V4 四个 test case 存在
- [ ] `bun test tests/unit/dmn/dmn-reactive*.test.ts` → 全通过

**Edge case — isTopicSwitch 也调 LLM**:
`isTopicSwitch` 也调用 `callLlm`（在 `shouldStartNewSegment` 内）。T003 的断言要区分"纠错 LLM"和"话题检测 LLM"。最简单的方式：在测试事件里设 `segState.nextSeq < 5`（避免触发 topic switch 路径），或检查 `callLlm` 的 prompt 内容（纠错 prompt 包含 "correction"，话题检测包含 "topic"）。

---

### Subtask T004 — 测试：episodic handoff 内容

**Purpose**: 验证 episodic content 中 handoff 字段的写入行为（V5-V8 四个场景）。

**Location**: `tests/unit/dmn/dmn-reactive-brain-complete.test.ts` 或 `tests/unit/dmn/dmn-comprehensive.test.ts`

**Steps**:

1. 找到现有的 episodic content 写入测试（`buildEpisodicContent` 相关或断言 `writeMemory` 的 content）

2. 新增/修改以下测试：

**Test V5 — handoff 内容写入**:
```typescript
it('includes handoff content in episodic record', async () => {
  const handoffText = 'User asked about billing; routing to execution layer'
  // 发送 brain.complete，output = { next: 'brainstem', reply: null, handoff: handoffText }

  // 获取 writeMemory 的调用参数（mock workspace.writeMemory）
  const episodicWrite = workspaceMock.writeMemory.mock.calls.find(
    call => call[0].type === 'episodic'
  )
  const content = JSON.parse(episodicWrite[0].content)

  expect(content.handoff).toBe(handoffText)
  expect(content.next).toBe('brainstem')
  expect(content.hasReply).toBe(false)
})
```

**Test V6 — 无 handoff：写入 null，不影响其他字段**:
```typescript
it('writes null for handoff when output has no handoff field', async () => {
  // output = { next: null, reply: 'Done' }（无 handoff）

  const content = JSON.parse(/* ... episodic content ... */)
  expect(content.handoff).toBeNull()
  expect(content.hasReply).toBe(true)
})
```

**Test V7 — 空字符串 handoff：写入 null**:
```typescript
it('treats empty string handoff as null', async () => {
  // output = { handoff: '' }

  const content = JSON.parse(/* ... */)
  expect(content.handoff).toBeNull()
})
```

**Test V8 — 并行职责独立性**:
```typescript
it('episodic write succeeds even when correction is skipped', async () => {
  // 正常 brain.complete（不触发纠错）
  // 断言：workspace.writeMemory 被调用（episodic 写入成功）
  // 断言：workspace.markMemoryUsed 被调用（如果 injectedMemoryIds 存在）
})
```

**Files**: `tests/unit/dmn/dmn-reactive-brain-complete.test.ts` 或 `tests/unit/dmn/dmn-comprehensive.test.ts`

**Validation**:
- [ ] V5-V8 四个 test case 存在
- [ ] `bun test tests/unit/dmn/` → 全通过

---

## Risks & Mitigations

| 风险 | 可能性 | 缓解方案 |
|---|---|---|
| Feature 013 WP03 未完成，buildEpisodicContent 还用旧 mode/intent | 高（WP03 仍在进行） | 实现前先确认 `grep -c "output?.mode" src/dmn/reactive/index.ts` 返回 0；若非 0 则等待 013 merge |
| callLlm mock 难以区分纠错调用和话题检测调用 | 中 | 检查 prompt 内容关键词，或设置 segState.nextSeq < 5 避免触发 topic switch |
| output == null 的判断 vs output === {} | 低 | 代码用 `== null`（JS 双等，匹配 null/undefined）；空对象 `{}` 不触发（设计意图） |

## Definition of Done Checklist

- [ ] `grep -n "hasError\|hasErrorStop\|hasNoOutput" src/dmn/reactive/index.ts` → 有规则变量
- [ ] `grep -n "handoff" src/dmn/reactive/index.ts` → 有 handoff 字段
- [ ] T003: V1（正常跳过）+ V2/V3/V4（三种触发）四个 test case 通过
- [ ] T004: V5（handoff 写入）+ V6（null）+ V7（空字符串 → null）+ V8（并行独立）四个 test case 通过
- [ ] `bun test tests/unit/dmn/` → 全通过
- [ ] `bun test` → 全量零新增 failure

## Review Guidance

- 验证 T001：规则预检在 `searchMemory` DB 查询之前（提前 return，连 DB 都不查）；条件是 OR 不是 AND
- 验证 T001：`!hasError && !hasErrorStop && !hasNoOutput` 时才 return（负逻辑，三条件都不满足才跳过）
- 验证 T002：`|| null` 而不是 `?? null`（确保空字符串也变 null）
- 验证 T003：V1 test 确认了纠错 LLM 不调用，区分了话题检测的 LLM
- 验证 T004：V7 验证空字符串行为（`|| null` vs `?? null` 的差异）

## Activity Log

- 2026-03-12T11:10:00Z – system – lane=planned – Prompt created.
