# Feature Specification: AIMA Core — Workspace & Schema

**Feature Branch**: `001-aima-core-workspace-schema`
**Created**: 2026-03-10
**Status**: Draft
**Mission**: software-dev

---

## 背景

AIMA 框架的所有认知活动都发生在认知工作空间（Cognitive Workspace）中。五脑通过工作空间读写 Thread、Slot 状态；DMN 通过工作空间管理待调度的前瞻预测；Hippocampus 通过工作空间持久化记忆。本 Feature 建立 `@aima/core` 包的数据基础：PostgreSQL schema 定义和 CognitiveWorkspace DAO 层。

---

## User Scenarios & Testing

### User Story 1 — 初始化数据库 Schema（Priority: P1）

框架使用者（应用开发者）能够通过一条命令从零建立 AIMA 所需的全部数据库表，不需要手动编写 SQL。

**Why this priority**：没有 schema 就没有其他一切。这是整个框架的数据地基。

**Independent Test**：在一个空 PostgreSQL 数据库上运行迁移命令，验证所有表存在且字段类型正确。

**Acceptance Scenarios**:

1. **Given** 一个空 PostgreSQL 数据库，**When** 执行迁移命令，**Then** `threads`、`slots`、`memories` 以及 `pending_observations` 相关结构全部创建成功，无错误
2. **Given** 已迁移的数据库，**When** 重复执行迁移命令，**Then** 命令幂等完成，无重复创建错误
3. **Given** 已迁移的数据库，**When** 查看 slots 表，**Then** 存在外键约束将 slot 关联到对应 thread

---

### User Story 2 — Thread 生命周期管理（Priority: P1）

框架内部（Thread Runner）能够创建 Thread、更新其状态、以及按状态批量查询（用于崩溃恢复）。

**Why this priority**：Thread Runner 的路由逻辑完全依赖对 Thread 状态的可靠读写。

**Independent Test**：不启动任何 LLM，纯 DAO 测试：创建 Thread → 更新状态 → 查询 → 验证结果与预期一致。

**Acceptance Scenarios**:

1. **Given** 一个初始化好的工作空间，**When** 调用 `createThread({ trigger, initiated_by, source_channel })`，**Then** 返回带有 UUID 的 Thread 对象，状态为 `active`
2. **Given** 一个 active Thread，**When** 调用 `updateThreadState(id, 'complete')`，**Then** Thread 状态变为 `complete`，`updated_at` 刷新
3. **Given** 数据库中有多个 Thread，**When** 查询 `state != 'complete'` 的 Thread，**Then** 仅返回未完成的 Thread（崩溃恢复入口）

---

### User Story 3 — Slot 读写（Priority: P1）

框架内部（各脑区 BrainAdapter 和 Thread Runner）能够向特定 Thread 的特定脑区写入输入/输出，并读取 Slot 当前状态。

**Why this priority**：脑区间通信的唯一通道。

**Independent Test**：对一个 Thread 写入 Limbic Slot，再读取，验证内容完整。

**Acceptance Scenarios**:

1. **Given** 一个已存在的 Thread，**When** 调用 `writeSlot(thread_id, 'limbic', { input, status: 'done', output })`，**Then** Slot 持久化成功，可通过 `readSlot(thread_id, 'limbic')` 取回
2. **Given** 写入了 output 的 Cortex Slot，**When** output 包含 `intent` 和 `complexity_hint` 字段，**Then** 这两个字段可独立查询，用于 Thread Runner 路由判断
3. **Given** Brainstem Slot，**When** 写入 `execution_session_id`，**Then** 字段持久化；当写入 `null`，**Then** 字段清空

---

### User Story 4 — Pending Observations 管理（Priority: P2）

DMN 能够写入待调度的前瞻预测条目，Thread Runner 能够读取到期条目并清理过期条目，且并发写入不产生数据损坏。

**Why this priority**：DMN 的异步调度机制依赖此能力；并发安全是正确性前提。

**Independent Test**：写入多条 pending 条目（含已过期、未到期、立即触发），调用 `removeExpiredPending` 后验证只剩未过期条目。

**Acceptance Scenarios**:

1. **Given** 一个工作空间，**When** DMN 写入 pending 条目（含 `trigger_at`、`expires_at`、`base_importance`），**Then** 条目持久化，可被 `getPendingObservations()` 返回
2. **Given** 包含过期条目的工作空间，**When** 调用 `removeExpiredPending(now)`，**Then** 所有 `expires_at <= now` 的条目被删除，其余保留
3. **Given** 两个并发写入操作同时修改 pending 列表，**When** 事务完成，**Then** 结果一致，无丢失更新（SELECT FOR UPDATE 保证）
4. **Given** pending 条目数达到配置上限，**When** 写入新条目，**Then** 按 `base_importance` 最低的条目优先淘汰

---

### User Story 5 — 记忆基础读写（Priority: P2）

Hippocampus Encoding 能够写入记忆条目，Recall 能够按类型和标签检索记忆条目。

**Why this priority**：记忆读写是后续所有认知能力的数据基础，但复杂检索逻辑（向量、实体展开）放在后续 Feature。

**Independent Test**：写入多条不同类型的 MemoryEntry，按 type + tags 过滤查询，验证返回结果正确。

**Acceptance Scenarios**:

1. **Given** 一个初始化的工作空间，**When** 调用 `writeMemory(entry)` 写入 semantic 类型记忆，**Then** 条目持久化，包含所有字段（含 `segment_id`、`usage_outcomes`、`base_importance`）
2. **Given** 写入了多条记忆，**When** 调用 `searchMemory({ type: 'episodic', tags: ['contract'] })`，**Then** 仅返回类型和标签匹配的条目，按 `base_importance DESC` 排序
3. **Given** 一条带 `supersedes_id` 的记忆写入，**When** 写入成功，**Then** 被取代的旧记录 `t_invalid` 字段在同一事务内被设置

---

### Edge Cases

- 写入 Slot 时 Thread 不存在 → 外键约束报错，不静默失败
- `pending_observations` 超出容量上限时，若所有条目 `base_importance` 相同 → 按 `added_at` 最早优先淘汰（tie-breaking）
- `memories` 的 `usage_outcomes` 字段默认值为 `{ positive: 0, negative: 0, neutral: 0 }`，不允许 null
- Thread `state` 只允许枚举值：`active | waiting | complete | interrupted`
- Slot `brain` 只允许 BrainType 枚举值：`limbic | cortex | brainstem | amygdala | dmn`

---

## Requirements

### Functional Requirements

- **FR-001**：包必须以 `@aima/core` 为名，导出 `CognitiveWorkspace` 类及所有公共类型
- **FR-002**：`threads` 表必须包含字段：`id`（UUID PK）、`state`（枚举）、`source_channel`（nullable）、`initiated_by`、`created_at`、`updated_at`
- **FR-003**：`slots` 表必须包含字段：`id`、`thread_id`（FK）、`brain`（枚举）、`status`（枚举）、`input`（JSONB）、`output`（JSONB nullable）、`intent`（nullable）、`complexity_hint`（nullable）、`execution_session_id`（nullable）、`created_at`、`updated_at`；`(thread_id, brain)` 唯一约束
- **FR-004**：`memories` 表必须包含 `02-memory-architecture.md` §十一 MemoryEntry 定义的全部字段，含 `segment_id`、`segment_seq`、`usage_outcomes`（JSONB）、`t_invalid`（nullable）
- **FR-005**：Pending observations 存储必须支持并发写安全（实现层使用 SELECT FOR UPDATE 或等价机制）
- **FR-006**：`CognitiveWorkspace` 必须实现：`createThread`、`getThread`、`updateThreadState`、`getActiveThreads`
- **FR-007**：`CognitiveWorkspace` 必须实现：`writeSlot`、`readSlot`、`getSlotsByThread`
- **FR-008**：`CognitiveWorkspace` 必须实现：`writePending`、`getPendingObservations`、`removeExpiredPending`、`removePending`
- **FR-009**：`CognitiveWorkspace` 必须实现：`writeMemory`、`searchMemory`（ILIKE 全文 + type/tags 过滤，兜底检索）
- **FR-010**：`supersedes_id` 非空时，`writeMemory` 必须在同一事务内将旧记录的 `t_invalid` 设为当前时间
- **FR-011**：包必须提供 Drizzle ORM schema 定义和可执行的迁移文件
- **FR-012**：所有公共接口不得使用 `any` 类型；TypeScript strict 模式开启

### Key Entities

- **Thread**：认知工作单元。代表一次外部输入触发的完整认知过程，包含状态机（active/waiting/complete/interrupted）和关联的 Slot 集合
- **Slot**：单脑工作记录。记录某 Thread 中某个脑区的输入、输出和状态，是脑区间通信的持久化介质
- **MemoryEntry**：记忆条目。五类记忆（semantic/episodic/procedural/working/implicit）的统一存储格式，含重要度、使用反馈和生命周期字段
- **PendingObservation**：待调度条目。DMN 写入的未来行动预测，含触发时间、过期时间和优先级

---

## Success Criteria

### Measurable Outcomes

- **SC-001**：在空 PostgreSQL 数据库上执行迁移，全部表在 5 秒内创建完成，零错误
- **SC-002**：CognitiveWorkspace 所有方法有对应测试，测试覆盖率 ≥ 80%
- **SC-003**：并发写入 pending_observations 的集成测试：100 次并发写入后数据完整，无丢失更新
- **SC-004**：TypeScript 编译在 strict 模式下零错误，零 `any`
- **SC-005**：包可以通过 `import { CognitiveWorkspace } from '@aima/core'` 在外部项目中使用

---

## Assumptions

- 数据库为 PostgreSQL 14+，使用 Drizzle ORM
- 测试使用 vitest，集成测试使用真实 PostgreSQL（本地 Docker 或 CI 服务）
- Pending observations 的并发安全实现方式（JSONB 字段 + SELECT FOR UPDATE，或独立表）在 Plan 阶段决定
- `CognitiveWorkspace` 构造时接受 database connection 作为依赖注入，不自行管理连接池
- 本 Feature 不包含 Brain Event Bus（下一个 Feature）
- 本 Feature 不包含高级 Recall 检索（向量检索、`getEntityContext`、`findSimilarSituations`），只实现 `searchMemory` 兜底
