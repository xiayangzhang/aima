# Feature Specification: Session Context Retrieval

**Feature Branch**: `014-session-context-retrieval`
**Created**: 2026-03-12
**Status**: Draft

## Background

AIMA 的 DMN Reactive 需要了解当前 Thread 的历史脉络，才能做出合理的段分配（segment）和干预决策。`getSessionContext()` 接口方法已声明，但当前实现始终返回空结果（`anchor: null, events: []`），相当于 DMN 在"无记忆"状态下工作——每次 brain.complete 事件到来时，DMN 无法判断"这是一个新话题还是延续"，段分配始终靠猜测。

实现该方法后，DMN 可以通过锚点（anchor）了解 Thread 起点，通过事件列表（events）了解 Thread 内的完整活动历史，从而做出更准确的认知判断。

---

## User Scenarios & Testing

### User Story 1 — DMN 能获取 Thread 的历史事件序列 (Priority: P1)

DMN Reactive 在处理 `brain.complete` 事件时调用 `getSessionContext(threadId)`，希望获得该 Thread 内所有已记录的 episodic 事件，按时间顺序排列，以判断当前处理是该 Thread 的第几轮活动、话题是否发生变化。

**Why this priority**: 这是功能的核心。没有事件列表，DMN 的段分配（`shouldStartNewSegment`）只能依赖单次输出内容，无法跨轮次比较，导致段边界判断不准确。

**Independent Test**: 在一个 Thread 中依次写入 3 条 episodic 记忆，调用 `getSessionContext(threadId)`，验证 `events` 列表包含 3 条记录且按 `createdAt` 升序排列。

**Acceptance Scenarios**:

1. **Given** 一个 Thread 有 N 条 episodic 记忆（N ≥ 1），**When** 调用 `getSessionContext(threadId)`，**Then** 返回的 `events` 包含该 Thread 的全部 N 条 episodic 记忆，按时间升序排列。
2. **Given** 一个 Thread 有 episodic 记忆，**When** 调用 `getSessionContext(threadId)`，**Then** 返回的记忆条目只属于该 Thread，不混入其他 Thread 的记忆。
3. **Given** 一个 Thread 有已软删除（`t_invalid` 非空）的 episodic 记忆，**When** 调用 `getSessionContext(threadId)`，**Then** 软删除条目不出现在 `events` 列表中。

---

### User Story 2 — DMN 能获取 Thread 的起始锚点 (Priority: P1)

DMN 需要知道一个 Thread "从哪里开始"——即该 Thread 内时间最早的 episodic 记忆，作为认知的起点参照。有了锚点，DMN 可以判断当前事件与起点是否在同一话题链上。

**Why this priority**: 锚点和事件列表是同一次调用的两个输出维度，实现成本相同，且锚点对 `isTopicSwitch` 判断有直接价值。

**Independent Test**: 在一个 Thread 中写入多条 episodic 记忆，调用 `getSessionContext(threadId)`，验证 `anchor` 是时间最早的那条记忆。

**Acceptance Scenarios**:

1. **Given** 一个 Thread 有多条 episodic 记忆，**When** 调用 `getSessionContext(threadId)`，**Then** `anchor` 是该 Thread 中 `createdAt` 最早的 episodic 记忆。
2. **Given** 一个 Thread 有且仅有 1 条 episodic 记忆，**When** 调用 `getSessionContext(threadId)`，**Then** `anchor` 等于该条记忆，`events` 列表也包含该条记忆（两者都指向同一条）。
3. **Given** 一个全新的 Thread，尚未产生任何 episodic 记忆，**When** 调用 `getSessionContext(threadId)`，**Then** 返回 `{ anchor: null, events: [] }`。

---

### User Story 3 — 跨 Thread 隔离：不同 Thread 的上下文互不干扰 (Priority: P1)

系统中同时存在多个并发 Thread，每个 Thread 有各自的 episodic 历史。`getSessionContext` 必须严格按 Thread 隔离，不能把其他 Thread 的记忆混入结果。

**Why this priority**: 并发安全是正确性的基础要求。若 Thread 间记忆混入，DMN 会对错误的 Thread 做出干预决策，造成严重认知错误。

**Independent Test**: 创建两个 Thread，各写入不同内容的 episodic 记忆，分别调用 `getSessionContext`，验证各自只返回属于自己 Thread 的记忆。

**Acceptance Scenarios**:

1. **Given** Thread A 和 Thread B 各自有 episodic 记忆，**When** 调用 `getSessionContext(threadA_id)`，**Then** 结果中不包含任何属于 Thread B 的记忆条目。
2. **Given** 一个 Thread 只有 working memory 类型的记忆（无 episodic），**When** 调用 `getSessionContext(threadId)`，**Then** 返回 `{ anchor: null, events: [] }`（只查 episodic，不查其他类型）。

---

### Edge Cases

- Thread ID 不存在（从未创建过）→ 返回 `{ anchor: null, events: [] }`，不报错。
- Thread 有 episodic 记忆但全部已软删除 → 返回 `{ anchor: null, events: [] }`。
- 极高频 Thread（episodic 记忆条数非常多）→ `events` 返回所有条目，不做截断；实现需考虑查询性能。

---

## Requirements

### Functional Requirements

- **FR-001**: `getSessionContext(threadId)` 必须返回该 Thread 内所有有效（未软删除）的 episodic 类型记忆，按 `createdAt` 升序排列，作为 `events` 字段。
- **FR-002**: `getSessionContext(threadId)` 必须将时间最早的记录作为 `anchor` 字段返回；若无记忆，`anchor` 为 `null`。
- **FR-003**: 查询必须严格按 Thread ID 过滤，不得返回其他 Thread 的记忆条目。
- **FR-004**: 查询必须排除软删除条目（失效时间非空的记录）。
- **FR-005**: Thread ID 不存在或该 Thread 无 episodic 记忆时，必须返回 `{ anchor: null, events: [] }`，不得抛出异常。
- **FR-006**: 实现必须满足现有接口签名，不修改接口定义，仅填充空实现。
- **FR-007**: 现有所有测试必须继续通过，不引入回归。

### Key Entities

- **Session Context**：`getSessionContext` 的返回结果，包含 `anchor`（最早的 episodic 记忆或 null）和 `events`（该 Thread 全部有效 episodic 记忆，按时间升序）。
- **Episodic Memory**：类型为 episodic、属于指定 Thread、且未被软删除的记忆条目。

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: `getSessionContext(threadId)` 在有 episodic 记忆的 Thread 上，返回的 `events` 数量与该 Thread 有效 episodic 条数 100% 一致——可通过单元测试验证。
- **SC-002**: `getSessionContext(threadId)` 在空 Thread 或不存在的 Thread 上，100% 返回 `{ anchor: null, events: [] }`，不抛出任何异常——可通过边界测试验证。
- **SC-003**: 多 Thread 场景下，各 Thread 的 `getSessionContext` 调用结果互不干扰——可通过隔离测试验证。
- **SC-004**: 全部现有测试继续通过，零回归。

---

## Assumptions

- `getSessionContext` 的参数在语义上等同于 Thread ID，用于查询该 Thread 内的 episodic 记忆。
- `events` 不做条数上限截断——调用方负责决定使用多少条。如需分页，由后续 feature 处理。
- 本 feature 仅填充 `CognitiveWorkspace` 的实现，不修改接口签名，不新增任何公共 API。
- 前置依赖：无（不依赖其他未合并 feature）。
