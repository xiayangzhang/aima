# Feature Specification: Thread Goal Feedback Signal

**Feature Branch**: `019-thread-goal-feedback-signal`
**Created**: 2026-03-13
**Status**: Draft

## Background

AIMA 的 DMN Reactive 当前使用启发式规则（`evaluateOutcome`）为注入记忆打标：`output.reply != null` → positive，`outputSlot.status === 'error'` → negative，其余 → neutral。设计评审将这个方案标记为 P2-C（噪音问题）：产生了 reply 不等于回复质量好，导致 positive 标记被滥用，记忆重要性的演化信号失真。

修复方案：为 Thread 添加可选的 `goal` 字段。当线程携带 goal 完成时，DMN 调用 Haiku 评估最终回复是否达成目标，并以评估结果（positive/negative）代替启发式规则标记注入记忆。没有 goal 的线程维持旧行为，不引入任何回归。

触发逻辑与现有 `feedbackMemoryUsage` 挂钩——已在 `brain.complete` 事件中调用，注入 memory ID 来自 `event.payload.injectedMemoryIds`。目标评估在 goal 存在时异步执行，评估失败回退旧启发式。

---

## User Scenarios & Testing

### User Story 1 — 携带 goal 的线程在完成时获得基于质量的反馈信号 (Priority: P1)

当一个 Thread 创建时设置了 `goal`，且线程完成（`brain.complete` 事件 + injectedMemoryIds 非空），DMN Reactive 应：
1. 从 workspace 拉取该线程的 goal
2. 从 output slot 取最终 reply
3. 调用 Haiku LLM 评估 reply 是否达成 goal
4. 根据评估结果调用 `markMemoryUsed(injectedIds, 'positive' | 'negative')`

**Why this priority**: 这是本 feature 的核心价值——用真实质量信号替代噪声启发式，使记忆重要性能够准确反映哪些记忆对最终输出有贡献。

**Independent Test**: Mock `workspace.getThread` 返回含 goal 的 thread；mock `workspace.readSlot` 返回含 reply 的 output slot；mock `callLlm` 返回 `{"achieved": true, "reason": "replied correctly"}`；验证 `markMemoryUsed` 被以 `'positive'` 调用。

**Acceptance Scenarios**:

1. **Given** thread 有 goal，output slot 有 reply，LLM 评估 `achieved=true`，**When** `brain.complete` 事件触发，**Then** `markMemoryUsed(ids, 'positive')` 被调用。
2. **Given** thread 有 goal，output slot 有 reply，LLM 评估 `achieved=false`，**When** `brain.complete` 事件触发，**Then** `markMemoryUsed(ids, 'negative')` 被调用。
3. **Given** thread 有 goal，但 output slot 没有 reply（`reply == null`），**When** 事件触发，**Then** 回退启发式，`markMemoryUsed` 以 `evaluateOutcome` 结果调用。
4. **Given** thread 有 goal 且 LLM 评估已执行，**When** 结果写入，**Then** 事件不阻塞（fire-and-forget 模式，评估在后台完成）。

---

### User Story 2 — 没有 goal 的线程回退到启发式，无回归 (Priority: P1)

当一个 Thread 没有设置 `goal`（即 `goal` 为 null 或未传入），`feedbackMemoryUsage` 的行为必须与 Feature 019 之前完全一致：使用 `evaluateOutcome` 启发式规则打标。

**Why this priority**: goal 是可选字段，所有现有测试和线程创建路径必须零回归。

**Independent Test**: Mock `workspace.getThread` 返回 `goal: null` 的 thread；验证 `callLlm` 未被调用，且 `markMemoryUsed` 以 `evaluateOutcome(event)` 的结果被调用（与旧行为一致）。

**Acceptance Scenarios**:

1. **Given** thread.goal 为 null，**When** `brain.complete` 触发，**Then** LLM 不被调用，`markMemoryUsed` 使用启发式结果（`'positive'`/`'negative'`/`'neutral'`）。
2. **Given** `workspace.getThread` 返回 null（线程不存在），**When** 事件处理，**Then** 回退启发式，无未捕获异常。
3. **Given** 现有 `evaluateOutcome` 逻辑（error → negative，reply → positive，next=brainstem → positive，其余 → neutral），**When** goal 为 null，**Then** 这些规则全部保持不变。

---

### User Story 3 — goal 评估失败不阻塞线程完成 (Priority: P1)

当 `workspace.getThread` 失败、`workspace.readSlot` 失败、或 `callLlm` 失败（抛出异常或返回无法解析的 JSON），DMN 必须静默回退到启发式，不抛未捕获异常，不阻塞事件处理器。

**Why this priority**: DMN Reactive 的所有 handler 已有 fire-and-forget 隔离（`handleEvent` 错误被捕获并发 `dmn.handler_error` 事件），goal 评估失败应在此隔离之内进一步做到静默回退，而非以 `dmn.handler_error` 的形式出现（评估失败是预期情况，不是告警）。

**Independent Test**: Mock `callLlm` 抛出 `new Error('llm timeout')`；thread 有 goal；验证 `markMemoryUsed` 仍被调用（以启发式结果），且不抛出异常。

**Acceptance Scenarios**:

1. **Given** `callLlm` 抛出异常，**When** goal 评估，**Then** 异常被静默捕获，回退启发式，`markMemoryUsed` 以启发式结果调用。
2. **Given** `callLlm` 返回无法解析的 JSON（如 `"not json"`），**When** 解析，**Then** `parseLlmJson` 回退默认值 `{ achieved: false }`，触发 negative 标记。
3. **Given** `workspace.readSlot` 抛出异常，**When** goal 评估，**Then** 异常被静默捕获，回退启发式。
4. **Given** LLM 返回 `{"achieved": true, "reason": "ok"}`（valid JSON），**When** 解析，**Then** 使用 `achieved` 字段值，不触发回退。

---

### Edge Cases

- `injectedMemoryIds` 为空数组 → `feedbackMemoryUsage` 提前 return，不做任何评估（已有行为，不变）。
- goal 存在但 reply 为 null → 视为无有效输出，回退启发式（`evaluateOutcome` 返回 `'neutral'`）。
- `thread.goal` 字段为空字符串 `''` → 视为无 goal（falsy check），回退启发式。
- LLM 评估结果中 `achieved` 字段缺失 → `parseLlmJson` 返回默认值 `{ achieved: false }`，视为 negative。

---

## Requirements

### Functional Requirements

**Part A — Thread.goal 字段（DB + API）**:

- **FR-001**: `threads` 表新增 `goal text` 列（可为 null，无默认值，不影响现有行）。
- **FR-002**: `CreateThreadParams` interface 新增可选字段 `goal?: string`。
- **FR-003**: `Thread` interface（entity 类型）新增字段 `goal: string | null`。
- **FR-004**: `CognitiveWorkspace.createThread` 将 `params.goal ?? null` 写入 DB。
- **FR-005**: `mapThreadRow` 将 DB row 的 `goal` 字段映射到 `Thread.goal`。
- **FR-006**: `ICognitiveWorkspace.createThread` 签名使用更新后的 `CreateThreadParams`（含 `goal?`）——接口通过 `CreateThreadParams` 类型自动更新。
- **FR-007**: 生成 Drizzle migration 文件（schema change only，无数据迁移）。

**Part B — 基于 goal 的反馈信号（DMN）**:

- **FR-008**: `feedbackMemoryUsage` 在 `injectedIds` 非空时，先调用 `workspace.getThread(thread_id)` 获取 goal。
- **FR-009**: 若 `thread.goal` 为 null、空字符串、或 getThread 返回 null，使用现有 `evaluateOutcome(event)` 启发式。
- **FR-010**: 若 `thread.goal` 存在，读取 `event.payload.outputSlot` 中的 reply 作为最终输出。
- **FR-011**: 若 reply 为 null，回退启发式（不调用 LLM）。
- **FR-012**: 若 reply 存在，构建 Haiku prompt，调用 `callLlm`，提示词要求返回 JSON `{"achieved": boolean, "reason": string}`。
- **FR-013**: 使用 `parseLlmJson` 解析 LLM 响应，默认值为 `{ achieved: false, reason: 'evaluation failed' }`。
- **FR-014**: 根据 `achieved` 调用 `workspace.markMemoryUsed(injectedIds, achieved ? 'positive' : 'negative')`。
- **FR-015**: 整个 goal 评估逻辑（FR-008 到 FR-014）包裹在 `try/catch` 中；catch 时回退 `evaluateOutcome` 启发式并调用 `markMemoryUsed`。
- **FR-016**: goal 评估不得阻塞 `brain.complete` 事件处理器（已由 `inFlightHandlers` 隔离，无需额外 spawn）。
- **FR-017**: 全部现有测试继续通过，不引入回归。

### Key Entities

- **Thread.goal**: `threads` 表的新增 nullable text 列；对应 `Thread` interface 的 `goal: string | null` 字段。
- **Goal evaluation**: DMN Reactive 内部逻辑，读取 thread + output slot，LLM 判断是否达成目标。
- **markMemoryUsed**: `ICognitiveWorkspace` 已有方法，签名为 `markMemoryUsed(ids: string[], outcome: UsageOutcome): Promise<void>`——不需要新增。
- **getThread**: `ICognitiveWorkspace` 已有方法，签名为 `getThread(id: string): Promise<Thread | null>`——不需要新增。
- **readSlot**: `ICognitiveWorkspace` 已有方法，签名为 `readSlot(threadId: string, brain: BrainType): Promise<Slot | null>`——不需要新增。

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: `threads` 表含 `goal text` 列（nullable）— Drizzle migration 文件存在可验证。
- **SC-002**: `CreateThreadParams.goal` 是可选字段，现有调用不传 goal 时仍编译通过 — TypeScript 编译验证。
- **SC-003**: `Thread.goal` 字段存在于 interface 和 `mapThreadRow` — 代码可 grep 验证。
- **SC-004**: 携带 goal 的线程完成时，LLM 被调用，`markMemoryUsed` 以正确 outcome 调用 — 单元测试 mock 验证。
- **SC-005**: `thread.goal` 为 null 时，LLM 不被调用，`markMemoryUsed` 使用启发式结果 — 单元测试验证。
- **SC-006**: LLM 失败时，`markMemoryUsed` 仍被调用（启发式回退），不抛异常 — 单元测试注入错误验证。
- **SC-007**: `bun test` 全量零回归。

---

## Assumptions

- `feedbackMemoryUsage` 接收 `BrainEvent`，其中 `event.thread_id` 非空时可信（DMN 在 `brain.complete` 路径中已有 `thread_id`）。
- `workspace.getThread` 是 `ICognitiveWorkspace` 已有方法（已确认存在）——不需要新增。
- `markMemoryUsed` 已存在于 `ICognitiveWorkspace`——不需要新增。
- `readSlot` 已存在于 `ICognitiveWorkspace`——但 DMN Reactive 当前通过 `event.payload.outputSlot` 直接取 slot 数据，不一定需要调用 `readSlot`；优先用 payload 中已有数据，减少 DB 查询。
- `callLlm` 和 `parseLlmJson` 已从 `../../llm` 导入（DMN Reactive 已有用法）——不需要新增 import。
- Haiku 模型通过 `this.config.llm` 传入，DMN Reactive 已有 LLM 调用先例。
- goal 评估是 fire-and-forget，被 `inFlightHandlers` 追踪，和现有 handler 并行，不需要特殊处理。
