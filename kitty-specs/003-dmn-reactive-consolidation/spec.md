# Feature Specification: DMN Reactive & Consolidation

**Feature**: 003-dmn-reactive-consolidation
**Status**: draft
**Mission**: software-dev
**Created**: 2026-03-11

---

## 概述

实现 AIMA 的 DMN（默认模式网络），这是框架中唯一能在没有外部触发的情况下主动分析并写入状态的脑区。

DMN 在工程上由两个独立运行单元组成：
- **DMN Reactive**：Event Bus 事件监听器，代码驱动，毫秒级响应，处理错误恢复/段分配/记忆反馈等实时职责；偶发一次性 LLM 调用（Haiku）
- **DMN Consolidation**：心跳批处理（30分钟-1小时间隔），读 episodic 增量，执行前瞻预测写 pending、维护现有 pending、implicit 记忆聚类合并

**核心约束**：DMN 从不调用 `activateBrain()`，只写状态（Slot / pending_observations / Memory / Signal），由 Thread Runner 决定路由。

完成后，AIMA 框架具备自发运作能力——错误自动恢复、记忆自动积累反馈、Agent 自主预判未来任务。

---

## 功能需求

### FR-01：DMN Reactive — 事件总线订阅

DMN Reactive 订阅 Brain Event Bus 的 INFO 级及以上事件，在独立的事件处理循环中运行（不阻塞主线程），实现以下职责：

**职责 1 — 错误恢复**

脑区发射 `ALERT` 事件（工具执行失败或 LLM 调用失败）时，DMN 立即介入：
- 可重试错误（超时、限流）→ 向对应 Thread Slot 写入 retry 指令，Thread Runner 下次轮询时重新激活
- 不可重试错误（权限拒绝、数据异常）→ 将 Thread 状态标记为 `interrupted`，发射 `ALERT` 给外部处理

重试次数上限可配置（默认 3 次），超出上限后降级为不可重试处理。

**职责 2 — 回溯纠错**

脑区完成（`brain.complete` 事件）后，DMN 读取最新 Action Log（最近 N 条事件），判断行为是否有误：
- 需要纠错 → 向工作空间写入 `dmn_correction` Signal，中断当前 Thread 并写入纠错 Thread
- 无问题 → 不写任何状态

此职责需要一次性 Haiku 调用进行语义判断（无对话历史，独立请求）。

**职责 3 — 段分配**

写入 episodic 记忆时，根据触发条件分配 `segment_id` 和 `segment_seq`：
- 新 Thread 开始 → 新 segment
- 目标变更（意图从 communicate 切换为 execute）→ 新 segment
- 错误恢复发生 → 新 segment
- 话题切换（语义不连续，Haiku 判断）→ 新 segment
- 同一 segment 内的事件按 `segment_seq` 递增排列

粗分由 DMN Reactive 在写入时完成；Hippocampus Consolidation（Feature 004）负责精修。

**职责 4 — 显著性处理**

事件携带 `significance_boost` 字段时（Amygdala 规则命中时携带），写 episodic 记忆时应用：
`base_importance = 初始值 + significance_boost`

使风险相关经历的 `base_importance` 更高，后续检索更容易命中，Hippocampus 回放更优先处理。

**职责 5 — 记忆使用反馈**

`brain.complete` 事件携带 `injectedMemoryIds`（来自 BrainRunResult），DMN 评估本次脑区执行结果：
- 执行成功且回复质量高 → 调用 `markUsed(ids, 'positive')`
- 执行失败或需要纠错 → 调用 `markUsed(ids, 'negative')`
- 无法判断 → 调用 `markUsed(ids, 'neutral')`

质量评估依赖确定性规则（无纠错 Signal → positive），必要时 Haiku 辅助。

**职责 6 — DEFER 超时调度**

检测到 Limbic 输出 `DEFER(timeout_ms)` 时（通过 Slot done 事件），写入 pending_observations：
- `target_brain = 'limbic'`
- `trigger_at = event.occurred_at + timeout_ms`
- `note` 包含原始 DEFER 原因

Thread Runner 的 `routePending()` 在到期后重新激活 Limbic 执行渠道降级。

**职责 7 — 信号捕获**

检测已知触发信号（确定性规则匹配 + Haiku fallback）→ 写入 `pending_observations`，由 Thread Runner 下次扫描路由执行。典型场景：跨 Thread 任务触发条件满足时。

---

### FR-02：DMN Consolidation — 心跳批处理

DMN Consolidation 以 30分钟-1小时间隔定期唤醒，读取 episodic 事件增量（`created_at > last_run_at`），使用 Haiku（复杂跨流程可升 Sonnet）执行以下职责：

**职责 1 — 前瞻预测（Predictive Activation）**

从三类记忆中读取模式（`episodic` + `procedural` + `semantic`），LLM 判断是否需要写入新的 `pending_observations`：

- 时间触发类（"合同签署 28 天后需要付款核查"）→ pending with `trigger_at`，`target_brain = brainstem`
- 协调准备类（"这个审批下一步需要多方协调"）→ pending with `target_brain = cortex`
- 响应预热类（"用户通常 10 分钟后追问"）→ pending with `target_brain = limbic`

每条 pending 包含足够的 context（`note` 字段），使 Thread Runner 路由后脑区能直接理解任务。

**职责 2 — Pending 维护**

读取当前全部 `pending_observations`，结合新 episodic 增量重新评估每条：
- 条件已满足/任务已完成 → 移除
- 条件继续等待 → 保留（不修改）
- 情况升级 → 更新 `note` 字段，Thread Runner 下次扫描以新描述路由

**职责 3 — Implicit 记忆聚类合并**

读取近期 Amygdala provisional 写入的 `implicit` 记忆，聚类合并为 canonical 记录：
- tag 取并集，`base_importance` 取较高值
- 被合并的旧记录通过 `supersedes_ids` 软删除（设置 `t_invalid`）
- LLM 判断语义重叠度（向量相似度或 Haiku 语义判断）

---

### FR-03：DMN Reactive 与 Consolidation 的隔离保证

两个运行单元互不阻塞：
- DMN Reactive：订阅 Event Bus，在事件 handler 内异步处理，不持久 LLM session
- DMN Consolidation：独立定时器/cron，在 Reactive 之外独立调度
- 数据并发：均在 PostgreSQL MVCC 下工作，短暂冗余可接受（最终一致）
- DMN Reactive 的写入对 Consolidation 立即可见（事务提交后），Consolidation 读的是最新快照

---

### FR-04：LLM 调用模型

DMN 的所有 LLM 调用均为一次性请求，不持有持久 session：
- 无对话历史，独立请求
- 不走 BrainAdapter，不在 Thread/Slot 体系内
- 不写 episodic（LLM 调用本身不是认知事件，其结论写入 Memory 或 Pending）
- 模型：默认 Haiku（速度/成本优先）；复杂跨流程判断可升 Sonnet（可配置）

---

### FR-05：DmnService 顶层接口

提供 `DmnService` 类，封装两个运行单元的生命周期：
- `start()` — 启动 Reactive 订阅 + Consolidation 定时器
- `stop()` — 停止订阅和定时器，等待进行中任务完成
- `runConsolidationNow()` — 立即触发一次 Consolidation（测试和手动触发用）
- `DmnConfig` 类型：consolidation interval、LLM 模型选择、重试上限等

---

## 边界说明

**Feature 003 包含**：
- DMN Reactive 全部 7 项职责（代码框架 + Haiku 偶发调用）
- DMN Consolidation 3 项职责（心跳触发 + Haiku/Sonnet 调用）
- `DmnService` 生命周期管理
- DMN 相关的单元测试和集成测试

**Feature 003 不包含（推后）**：
- Hippocampus Consolidation（每日 batch：段精修、序列回放、usage_outcomes 收敛、过期清理）→ Feature 004
- @aima/crew 的 anchor 衔接（`clear()`/`flush()`/`new()` 转换）→ Feature 005
- Skill Review 触发流程（Cortex 评估 Skill 健康度）→ 产品层

---

## 依赖

- **Feature 001**：CognitiveWorkspace（Thread/Slot/Memory/Pending CRUD、`markUsed`）
- **Feature 002**：Brain Event Bus（订阅 `subscribe`/`subscribeLevel`）、`BrainRunResult.injectedMemoryIds`、Workspace Signal 写入（`pushSignal`）

---

## 用户场景与测试

### 场景一：Brainstem 工具执行失败，DMN Reactive 自动重试

1. Brainstem 调用工具，工具返回 timeout 错误
2. Brainstem 发射 `ALERT` 事件（`reason: 'tool_error'`, `retryable: true`）
3. DMN Reactive 接收事件，判断可重试
4. DMN 向 Thread 写入 retry Slot 指令
5. Thread Runner 下次轮询重新激活 Brainstem
6. 重试成功，Thread 正常完成

**验收**：Brainstem 被重新激活一次；重试次数记录在事件中；超过 3 次后 Thread 标记为 interrupted。

---

### 场景二：Limbic DEFER → pending → 到期重新激活

1. Limbic 输出 `DEFER(timeout_ms=3600000)`（1小时后重试）
2. DMN Reactive 写入 pending（`trigger_at = now + 1h`, `target_brain = limbic`）
3. 1小时后 Thread Runner `routePending()` 扫描到到期项
4. Limbic 重新激活，执行渠道降级

**验收**：pending 写入正确 trigger_at；到期后 Limbic 确实被激活；激活后 pending 被移除。

---

### 场景三：brain.complete → episodic 写入 + 段分配 + 记忆反馈

1. Limbic 完成一次 RESPOND，发射 `brain.complete`（携带 injectedMemoryIds）
2. DMN Reactive 处理：
   - 写入 episodic 记忆（此 Thread 的完成事件）
   - 分配/延续 segment_id 和 segment_seq
   - 应用 significance_boost（如有）
   - 调用 `markUsed(injectedMemoryIds, 'positive')`
3. 数据库中 episodic 记录含正确 segment_id；被注入的 Memory 的 `usage_outcomes.positive` 递增

**验收**：episodic 记录有 segment_id / segment_seq；markUsed 被调用且 DB 计数正确。

---

### 场景四：Consolidation 心跳 → 前瞻预测写 pending

1. 从 episodic 增量中读到"合同签署"事件
2. 从 procedural 记忆中匹配到"采购合同 28 天后需要付款核查"流程
3. LLM（Haiku）判断：需要在 28 天后激活 Brainstem 执行付款检查
4. 写入 pending（`trigger_at = 签署时间 + 28天`, `target_brain = brainstem`, `note = ...`）

**验收**：pending 写入正确 trigger_at 和 target_brain；note 包含足够上下文。

---

### 场景五：Consolidation — implicit 记忆聚类合并

1. Amygdala 对同类工具调用连续写入 3 条 provisional implicit 记忆
2. Consolidation 心跳触发，读取近期 implicit 增量
3. LLM 判断三条语义重叠 → 合并为一条 canonical 记录（tag 并集，importance 取最高）
4. 三条旧记录设置 `t_invalid`（通过 `supersedes_ids` 关联）

**验收**：合并后 DB 中 canonical 记录数量正确；旧记录 `t_invalid != null`；`supersedes_ids` 关联正确。

---

## 成功标准

1. 脑区工具执行失败时，90% 以上可重试错误由 DMN Reactive 自动重试，无需人工介入
2. 每条 episodic 记忆在写入时有正确 `segment_id` 和 `segment_seq`，DMN 不遗漏任何 `brain.complete` 事件
3. 被注入记忆的 `usage_outcomes` 计数在每次脑区完成后正确递增，无丢失
4. Consolidation 心跳在配置间隔内触发，LLM 调用耗时不超过 30 秒（单次批处理）
5. DMN Reactive 事件处理不阻塞 Thread Runner 主循环（事件 handler 异步执行）
6. Reactive 和 Consolidation 并发写入时，数据库无死锁，最终一致

---

## 假设

- Event Bus 事件在同进程内传递（不跨进程），Reactive 监听是进程内同步回调
- PostgreSQL MVCC 提供足够的并发隔离，不需要额外应用层锁（除 Pending 写入的 Advisory Lock，已在 Feature 001 实现）
- Haiku 一次性调用延迟 < 5 秒（P95），不影响 Reactive 的整体响应时效
- DMN 不需要自己的数据库表——所有持久化通过 CognitiveWorkspace 接口（Slot/Memory/Pending）

---

## 局限与演进

| 局限 | 说明 |
|---|---|
| Reactive 回溯纠错深度有限 | 只读最近 N 条事件（无全链追溯），复杂多 Thread 关联场景可能误判 |
| Consolidation 前瞻预测质量依赖 episodic 覆盖率 | 早期 episodic 数据稀少时预测准确度低 |
| implicit 合并的语义相似度阈值需要调参 | 过激合并丢失信息，保守合并不减冗余 |
| 单进程部署假设 | Event Bus 是进程级单例，多实例部署需要替换为外部消息队列（Kafka/NATS）→ 演进方向 |
