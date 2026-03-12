# Feature Specification: P1 Safety & State Persistence Fixes

**Feature Branch**: `012-p1-safety-and-state-persistence-fixes`
**Created**: 2026-03-12
**Status**: Draft

## Background

AIMA 的认知框架依赖三项核心正确性保证才能在生产环境中可靠运行：

1. **DEFER 状态一致性**：当某个任务主动进入等待状态时，系统必须在持久化层正确记录这一状态，否则进程重启后的崩溃恢复机制会错误地重新激活正在等待的任务。
2. **Safety Signal 线程隔离**：系统中并发运行的多个任务共享同一个 Signal 通道，若某任务触发的安全拦截信号未绑定到具体任务，其他正在执行的任务可能被错误中断。
3. **记忆分段状态持久化**：DMN（默认模式网络）在运行时追踪每个任务的记忆事件属于哪个认知分段。若此追踪状态只存在内存中，进程重启后历史分段链断裂，导致 Hippocampus 的记忆回放和模式提取功能失效。

这三个 bug 均已在代码审查中确认，属于 P1 级——不会导致即时崩溃，但会在并发负载或进程重启后引发静默的行为错误，难以排查。

---

## User Scenarios & Testing

### User Story 1 — DEFER 状态崩溃恢复 (Priority: P1)

一个任务正在等待用户补充信息（DEFER 状态），此时进程重启。系统重启后，该任务应继续保持等待状态，直到预设超时到期后才被重新激活；不应该在重启后立即被触发执行。

**Why this priority**: DEFER 是系统正常运作中频繁发生的状态（任何需要等待用户回复的场景都会触发）。在当前实现下，每次进程重启都会错误地立即重新激活所有 DEFER 中的任务，产生幽灵回复（用户尚未回复就被催促或二次处理）。

**Independent Test**: 创建一个 DEFER 状态的任务，重启进程，确认任务仍处于等待状态；等待超时到期后任务才被重新激活。

**Acceptance Scenarios**:

1. **Given** 一个任务因等待用户补充信息而进入 DEFER 状态，**When** 进程重启，**Then** 该任务的状态仍为 `waiting`，不会被立即重新激活。
2. **Given** 一个 DEFER 任务的超时时间尚未到达，**When** 进程重启，**Then** 崩溃恢复机制跳过该任务，不尝试路由。
3. **Given** 一个 DEFER 任务的超时时间已到达，**When** Pending Observation 调度器运行，**Then** 任务被重新激活并执行渠道降级逻辑。

---

### User Story 2 — Safety Signal 线程隔离 (Priority: P1)

系统同时处理两个任务 A 和 B。任务 A 的某个工具调用触发了安全拦截（Amygdala 中断）。该拦截信号只应影响任务 A，任务 B 应不受干扰地继续执行。

**Why this priority**: AIMA 设计上支持并发多任务（多 Thread），这是生产场景的正常状态。当前实现中信号按全局类型存储，一个任务的安全事件可以"污染"另一个任务，导致任务 B 在没有任何安全问题的情况下被中断或进入错误状态。随着并发任务数增加，此问题的触发概率线性上升。

**Independent Test**: 并发运行两个任务，对其中一个注入安全拦截信号，确认另一个任务的执行不受影响。

**Acceptance Scenarios**:

1. **Given** 任务 A 和任务 B 并发运行，**When** 任务 A 的工具调用触发 Amygdala 中断，**Then** 任务 A 的当前工具操作被中断，任务 B 继续正常执行。
2. **Given** 系统中只有任务 A 有未消费的安全信号，**When** 任务 B 的执行单元检查是否有信号，**Then** 任务 B 看不到属于任务 A 的信号。
3. **Given** 任务 A 的安全信号已被任务 A 消费，**When** 任务 A 重新尝试执行，**Then** 信号已被正确清除，不会被二次消费。

---

### User Story 3 — 记忆分段状态跨重启持久化 (Priority: P1)

系统运行一段时间后积累了多个认知分段（episodic segments）。进程重启后，系统应能正确继续在已有分段上写入新的记忆事件，而不是从零开始创建全新的分段链，导致历史分段与新记录之间的连续性断裂。

**Why this priority**: 记忆分段是 Hippocampus 段序列回放的基础数据结构。分段链断裂意味着回放时只能看到重启后写入的记录，重启前的历史事件序列变成"孤立"记录，无法参与模式提取。在容器化环境中（Kubernetes），进程重启是常态，此问题影响是持续且累积的。

**Independent Test**: 运行系统直到某个任务有多条 episodic 记录归属同一分段，重启进程，继续执行同一任务，确认新写入的 episodic 记录正确归属到原有分段而非新分段。

**Acceptance Scenarios**:

1. **Given** 一个任务已有归属到分段 S1 的 episodic 记录，**When** 进程重启后该任务继续执行，**Then** 新写入的 episodic 记录仍归属到分段 S1（或其延续分段），而非新建的孤立分段。
2. **Given** 进程重启，**When** DMN 事件响应器启动，**Then** 它能从持久化存储中恢复所有活跃任务的分段追踪状态。
3. **Given** 一个任务在进程重启前处于分段序号 N，**When** 重启后写入新 episodic 记录，**Then** 新记录的分段序号从 N+1 开始，保持单调递增。

---

### Edge Cases

- 进程重启时，某些任务已完成（state=complete）——恢复时应跳过，不重建其分段状态。
- 多个 DEFER 任务同时存在，部分超时已到期，部分尚未到期——恢复后仅触发超时已到期的任务，未到期的继续等待。
- 并发任务数量为 1 时（无并发）——信号隔离机制不影响单任务场景的行为，不引入额外开销。
- DMN 在首次启动时（没有任何历史分段）——应从空状态正常初始化，不报错。
- 同一任务的多个信号同时存在——每个信号应独立排队，按顺序被该任务消费，不丢失。

---

## Requirements

### Functional Requirements

- **FR-001**: 当任务进入 DEFER 状态时，系统必须在持久化层将任务状态标记为 `waiting`，确保重启后崩溃恢复机制不会重新激活该任务。
- **FR-002**: 崩溃恢复机制必须识别并跳过状态为 `waiting` 的任务，仅处理状态为 `active` 的任务。
- **FR-003**: 每个 Safety Signal 必须携带其所属任务的标识符；系统必须确保信号只能被正确所属的任务消费。
- **FR-004**: 信号的存储和查询接口必须支持按任务隔离——查询某任务的信号不返回其他任务的信号。
- **FR-005**: DMN 事件响应器在每次启动时，必须从持久化存储中恢复活跃任务的分段追踪状态；重启后继续使用已有分段 ID 和序号。
- **FR-006**: 分段追踪状态的写入与对应 episodic 记录的写入必须保持一致——不出现 episodic 已写入但分段状态未更新的情况。
- **FR-007**: 三项修复均不破坏现有的 Signal 消费接口和 DMN 事件处理接口的对外行为。

### Key Entities

- **Thread**：认知任务的生命周期单元，持有 `state` 字段（`active` / `waiting` / `complete` / `interrupted`）。FR-001/002 影响其状态转换逻辑。
- **BrainSignal**：脑区间安全通信的信号载体，当前仅有 `type` 标识符。FR-003/004 需要为其增加任务归属标识。
- **SegmentTrackingState**：DMN 对每个活跃任务当前所在分段的追踪记录（分段 ID + 下一条序号）。FR-005/006 将此状态从内存移至持久化层。

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: 进程重启后，所有处于 `waiting` 状态的任务保持 `waiting` 状态，崩溃恢复扫描不触发这些任务——重启测试 100% 通过。
- **SC-002**: 并发任务场景下，一个任务的 Amygdala 中断信号不影响其他任务的执行——并发测试零跨任务信号泄漏。
- **SC-003**: 进程重启后，DMN 写入的 episodic 记录分段序号与重启前连续——分段序号单调性测试 100% 通过。
- **SC-004**: 三项修复不破坏现有测试套件——Feature 002 的全部测试（单元 + 集成）继续通过。

---

## Assumptions

- 三个 bug 的修复相互独立，可在同一 PR 内分别实现，实现层面无依赖关系。
- SegmentTrackingState 持久化到已有的 PostgreSQL 数据库，复用现有 workspace 表或 threads 表的 JSONB 字段扩展，不引入新的存储依赖。
- 并发任务基准为 2-5 个并发 Thread，不需要为极高并发（100+）做特殊优化。
- 本 Feature 不包含 P2 级问题（DMN Correction 无条件 LLM 调用、Feedback 信号质量等），这些在 Feature 014 处理。
- Output Model 迁移（mode 枚举 → {next, reply, handoff}）不在本 Feature 范围，在 Feature 013 处理。
