# Feature Specification: DMN Reactive Quality Improvements

**Feature Branch**: `015-dmn-reactive-quality-improvements`
**Created**: 2026-03-12
**Status**: Draft
**Depends on**: Feature 013 (Brain Output Model Migration — BrainOutput `{next, reply, handoff}` 模型)

## Background

DMN Reactive 承担认知监控职责：每次脑区完成时检查是否需要纠错、记录 episodic 事件历史。当前有两个质量问题影响系统的运行效率和学习能力：

**问题一（效率）**：纠错检查无条件触发 LLM 调用。Limbic → Cortex → Brainstem 一次正常处理会产生 3 次 LLM 纠错调用，大多数返回"不需要纠错"。这是纯开销，还会给 DMN 监控本身引入延迟。

**问题二（质量）**：Episodic 记录只有执行状态，没有认知内容。当前每条 episodic 记录只包含 `{brain, status, next, hasReply, stopReason}`——这是"脑区做了什么操作"，但不是"脑区做了什么决策"。Hippocampus 回放这些记录时，无法提取跨轮次的认知模式。

---

## User Scenarios & Testing

### User Story 1 — 纠错检查只在有依据时触发 (Priority: P1)

系统中 Limbic、Cortex、Brainstem 完成正常处理后，DMN 不应发起无谓的 LLM 纠错调用。只有在存在明确异常信号时（脑区报错、执行中止、输出缺失），DMN 才应进入纠错评估流程。

**Why this priority**: 每轮对话产生 3+ 次无效 LLM call，直接影响成本和延迟。规则预检是零成本的，排除可判断的正常情况后再做 LLM 是正确的工程实践。

**Independent Test**: 触发一次正常的 brain.complete 事件（status=done，有 reply 输出，stopReason 正常），验证 DMN 没有发起纠错 LLM 调用。

**Acceptance Scenarios**:

1. **Given** 一次 brain.complete 事件，slot status 为 `done`，有正常 output，stopReason 不含错误标志，**When** DMN 处理该事件，**Then** 不发起纠错 LLM 调用（规则判断为"无需纠错"，直接跳过）。
2. **Given** 一次 brain.complete 事件，slot status 为 `error`，**When** DMN 处理该事件，**Then** 发起纠错 LLM 调用（错误是明确的异常信号）。
3. **Given** 一次 brain.complete 事件，stopReason 包含错误标志（如 `"error"`），**When** DMN 处理该事件，**Then** 发起纠错 LLM 调用。
4. **Given** 一次 brain.complete 事件，output 为空（脑区没有产生任何输出），**When** DMN 处理该事件，**Then** 发起纠错 LLM 调用（输出缺失是异常信号）。
5. **Given** 规则触发了纠错 LLM 调用，**When** LLM 判断需要纠错，**Then** 行为与修改前完全一致（发送纠错信号、发出合规事件）。

---

### User Story 2 — Episodic 记录承载认知决策摘要 (Priority: P1)

Hippocampus 在回放 episodic 事件序列时，需要了解每次脑区激活的认知内容——脑区在当前上下文下做了什么判断、产生了什么决策意图。这些内容由脑区本身通过 `handoff` 字段自然表达，DMN 负责将其记录到 episodic 中。

**Why this priority**: Episodic 记录的价值在于可回放性。没有认知内容的 episodic 只是操作日志，不是认知历史。`handoff` 字段是脑区对自身决策的自然语言描述，是最直接的认知摘要来源。

**Independent Test**: 触发一次 brain.complete 事件，output 中包含 `handoff` 内容，查询写入的 episodic 记录，验证记录的 content 中包含 handoff 内容。

**Acceptance Scenarios**:

1. **Given** 一次 brain.complete 事件，output 包含 `handoff` 字段，**When** DMN 处理该事件并写入 episodic，**Then** episodic content 中包含 handoff 内容。
2. **Given** 一次 brain.complete 事件，output 不包含 `handoff` 字段（只有 next/reply），**When** DMN 写入 episodic，**Then** episodic content 中 handoff 为 `null` 或缺失，不影响记录写入。
3. **Given** output 同时包含 `next`、`reply`、`handoff`，**When** DMN 写入 episodic，**Then** content 中三个字段都有记录。
4. **Given** 两个 Thread 各有不同的 handoff 内容，**When** 各自的 brain.complete 触发，**Then** 各 Thread 的 episodic 只记录自己的 handoff（Thread 隔离不受影响）。

---

### Edge Cases

- `handoff` 为空字符串 → 视同 `null`，不写入（不影响功能，但避免记录无意义的空字符串）。
- `retroactiveCorrection` 跳过后，正常的内存使用反馈（`feedbackMemoryUsage`）和 episodic 写入（`assignSegmentAndWriteEpisodic`）不受影响——这两个是独立的并行职责。
- 规则预检的三个触发条件只要满足其一即进入 LLM 纠错，三个条件是 OR 关系，不是 AND。

---

## Requirements

### Functional Requirements

- **FR-001**: 纠错检查必须先执行规则预检；若全部规则判断为"无需纠错"，则跳过 LLM 调用。
- **FR-002**: 规则预检的触发条件包含至少三项：(a) `slot.status === 'error'`，(b) `stopReason` 包含错误标志，(c) output 为空/null（当前脑区未产生任何输出）。
- **FR-003**: 规则触发后的 LLM 调用行为、纠错信号发送、合规事件发出必须与修改前完全一致。
- **FR-004**: episodic 内容中必须包含 `output.handoff` 字段的内容（当 handoff 存在时）。
- **FR-005**: 当 `handoff` 为空或 output 不含 `handoff` 时，episodic 内容中该字段为 `null`，不影响记录写入。
- **FR-006**: `assignSegmentAndWriteEpisodic`、`feedbackMemoryUsage`、`retroactiveCorrection` 三者的并行执行关系保持不变；`retroactiveCorrection` 的规则预检属于该方法内部的早期返回，不影响其他两个方法。
- **FR-007**: 全部现有测试继续通过，不引入回归。

### Key Entities

- **DMN Retroactive Correction**：当前脑区的纠错职责，输入是最近的 episodic 历史和当前 output，输出是可选的纠错信号。本 feature 在此流程前加规则门控。
- **Episodic Record**：DMN 对每次 brain.complete 写入的认知事件记录。本 feature 在其 content 中增加 `handoff` 字段。

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: 在正常 brain.complete 事件（status=done，有输出，无错误 stopReason）场景下，纠错 LLM 调用次数为 0 — 可通过单元测试 mock LLM 验证。
- **SC-002**: 在异常 brain.complete 事件（status=error 或 stopReason 含错误）场景下，纠错 LLM 调用次数为 1 — 可通过单元测试验证。
- **SC-003**: 包含 `handoff` 的 brain.complete 事件写入的 episodic content，100% 包含 handoff 内容 — 可通过单元测试验证。
- **SC-004**: 全部现有测试继续通过，零回归。

---

## Assumptions

- `handoff` 是 Feature 013 引入的 BrainOutput 字段之一（`{next?, reply?, handoff?}`），本 feature 依赖 Feature 013 已合并。
- `stopReason` 的错误标志定义为字符串值等于 `'error'`（与现有代码 `payload.stopReason === 'error'` 一致）。
- "output 为空"定义为 `output == null`（null 或 undefined），不包括 `output === {}`（空对象仍视为有输出）。
- 规则预检的三个触发条件是当前已知的需要纠错的信号；未来可扩展，不需要在本 feature 内穷举。
