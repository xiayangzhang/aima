# Quickstart & Validation: DMN Reactive Quality Improvements

## 构建验证

```bash
cd /Volumes/leoyun/aima
bun test tests/unit/dmn/
bun test  # 全量零回归
```

## 验证场景

### V1 — 正常输出：纠错 LLM 不触发

**目的**：验证 FR-001 + SC-001（规则预检跳过正常路径）

```typescript
// Mock callLlm 记录调用次数
// 发送 brain.complete 事件：status='done', output={ next: null, reply: 'Hello' }, stopReason=undefined
// 等待 DMN 处理完成

// 断言：callLlm 的纠错调用次数 = 0
// （isTopicSwitch 中的 callLlm 调用可能发生，不计入此断言）
```

**期望**：pass（callLlm 纠错调用次数 = 0）

---

### V2 — status=error：纠错 LLM 触发

**目的**：验证 FR-002 条件 A + SC-002

```typescript
// 发送 brain.complete 事件：status='error', output=null, stopReason='error'

// 断言：callLlm 纠错调用次数 = 1（且传入的 prompt 包含 "correction"）
```

**期望**：pass

---

### V3 — stopReason=error：纠错 LLM 触发

**目的**：验证 FR-002 条件 B

```typescript
// 发送 brain.complete 事件：status='done', output={ next: null }, stopReason='error'

// 断言：callLlm 纠错调用次数 = 1
```

**期望**：pass

---

### V4 — output 为 null：纠错 LLM 触发

**目的**：验证 FR-002 条件 C

```typescript
// 发送 brain.complete 事件：status='done', output=null, stopReason=undefined

// 断言：callLlm 纠错调用次数 = 1
```

**期望**：pass

---

### V5 — Episodic 包含 handoff 内容

**目的**：验证 FR-004 + SC-003

```typescript
// 发送 brain.complete 事件：
//   output = { next: 'brainstem', reply: null, handoff: 'User asked about billing; routing to execution' }

// 查询写入的 episodic 记录（searchMemory type=episodic）
// 解析 content JSON

// 断言：parsedContent.handoff === 'User asked about billing; routing to execution'
// 断言：parsedContent.next === 'brainstem'
// 断言：parsedContent.hasReply === false
```

**期望**：pass

---

### V6 — handoff 为 undefined：episodic 写 null，不影响写入

**目的**：验证 FR-005

```typescript
// 发送 brain.complete 事件：output = { next: null, reply: 'Done' }（无 handoff）

// 查询写入的 episodic，解析 content JSON
// 断言：parsedContent.handoff === null（不是 undefined，JSON.stringify 行为）
// 断言：parsedContent.hasReply === true
```

**期望**：pass

---

### V7 — handoff 为空字符串：视同 null

**目的**：验证 spec Assumptions（空字符串不记录）

```typescript
// 发送 brain.complete 事件：output = { handoff: '' }

// 查询写入的 episodic，解析 content JSON
// 断言：parsedContent.handoff === null（空字符串经 || null 处理）
```

**期望**：pass

---

### V8 — 并行职责不受影响

**目的**：验证 FR-006（retroactiveCorrection 跳过不影响其他两个 Promise.all 项）

```typescript
// 发送 brain.complete 事件：status='done'，有正常 output，有 injectedMemoryIds

// 断言：episodic 记录写入成功（assignSegmentAndWriteEpisodic 正常运行）
// 断言：markMemoryUsed 被调用（feedbackMemoryUsage 正常运行）
// 断言：callLlm 纠错调用次数 = 0（retroactiveCorrection 跳过）
```

**期望**：pass

---

### V9 — 零回归

```bash
cd /Volumes/leoyun/aima && bun test
```

**期望**：全部现有测试继续通过，无新 failure。

## Definition of Done

- [ ] `grep -n "retroactiveCorrection\|hasError\|hasErrorStop\|hasNoOutput" src/dmn/reactive/index.ts` → 含规则预检变量
- [ ] `grep -n "handoff" src/dmn/reactive/index.ts` → 含 handoff 字段
- [ ] V1-V8 场景在测试中均有对应 test case
- [ ] `bun test tests/unit/dmn/` → 全通过
- [ ] `bun test` → 全量零新增 failure
