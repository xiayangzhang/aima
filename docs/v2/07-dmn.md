# DMN — Reflector

> **版本**: v2.0
> **状态**: 草稿

---

## 一、角色定位

DMN（默认模式网络）是 AIMA 中**唯一能在没有外部触发的情况下主动分析并写入状态**的组件。Limbic 和 Brainstem 响应外部输入（人类消息、系统事件），DMN 通过两种机制自发运作。

### 核心原则

**DMN 从不调用 `activateBrain()`**。

DMN 只写状态——Slot、`pending_observations`、记忆。路由始终由 Thread Runner 发起。这个约束是刻意的：让 DMN 持有激活权限意味着在反思环路中引入新的控制流，违反"脑区间不直接互相调用"的设计原则。

### 两条写入路径

| 路径 | 写入目标 | 触发时效 | 典型场景 |
|---|---|---|---|
| **即时路由**（Slot Write） | 直接写目标 Thread 的 Slot | Thread Runner 下次轮询（毫秒级） | 错误恢复、Brainstem 重试、中断 Signal |
| **延迟路由**（Pending Write） | 写 `pending_observations` | Thread Runner 判断"成熟"时路由 | 前瞻预测、跨 Thread 任务创建、Skill Review 触发 |

两条路径都经过 Thread Runner 执行实际激活，DMN 是分析者，不是执行者。

---

## 二、工程实现说明

DMN 在概念上是一个脑区，**工程上由两种触发方式实现**：事件响应（Reactive）和心跳整合（Consolidation）。

两个运行单元各自独立调度，不共享运行时，不互相阻塞：

- **DMN Reactive**：代码驱动的事件监听器，不是 LLM 对话 Agent。订阅 Event Bus 事件，执行确定性逻辑；需要推理判断时发起一次性 LLM 调用（Haiku，无对话历史，独立请求）。跨 Thread 的全局视野来自直接查询数据库，而非 LLM context window。
- **DMN Consolidation**：定期唤醒的 batch 进程，不持有持久 LLM session，不走 BrainAdapter。

两个单元都不在 Thread/Slot 体系内，不持有持久 session——这与 Limbic/Cortex/Brainstem 三个认知脑区有本质区别。BrainAdapter 只服务于持有 LLM session 的三个认知脑区。

**最终一致性**：事件响应和心跳整合各自在 PostgreSQL MVCC 的一致性快照下工作，互不阻塞。任意时刻记忆库中可能存在短暂冗余（例如事件响应刚写入的 implicit 记录尚未被归并），心跳整合定期收敛。

---

## 三、事件响应（Reactive）

### 触发条件

`INFO` 级及以上事件写入 Event Bus → 毫秒级响应。

### 七项职责（按优先级）

**1. 错误恢复**

脑区遇到 LLM 调用失败或工具执行错误时，发射 `ALERT` 事件 → DMN 立即介入：

- 可重试错误（超时、限流）→ 写入 retry 指令到对应 Thread Slot
- 不可重试错误（权限拒绝、数据异常）→ 标记 Thread 为 `interrupted`，发射 `ALERT` 供外部处理

**2. 回溯纠错**

读取最新 Action Log，判断刚刚发生的行为是否有误；如需纠错，向工作空间写入中断 Signal。

> ⚠️ **P2-A 已知问题**：当前代码每次 `brain.complete` 无条件发起 LLM 调用检查是否需要纠错。一次 Limbic → Cortex → Brainstem = 3 次纠错 LLM call，大多数返回"不需要纠错"，是纯开销。
>
> **设计目标**：先做规则预检（`slot.status === 'error'`、停止原因异常、输出格式不符），只有规则触发时才调 LLM。

**3. 段分配**

写 episodic 事件时，根据触发条件分配 `segment_id` 和 `segment_seq`。每条 episodic 事件都标注所属事件段（粗分，Hippocampus Consolidation 每日精修）。

分段触发条件：
- Thread 边界（新 Thread → 新 Segment）
- 目标变更（工作空间主任务描述变化）
- 错误恢复（`ALERT` 事件后重新激活）
- 话题切换（Limbic 判断输入显著偏离当前上下文）

> ⚠️ **已知限制**：`DMN Reactive` 的 `threadSegments` Map 在进程重启后丢失，会导致同一 Thread 的段链断裂。需要在重要性超过可接受阈值前将 segment 状态持久化到 DB。

**4. 显著性处理**

若事件携带 Amygdala 发射的 `significance_boost` 字段，写 episodic 时对应增加 `base_importance`，使风险相关经历编码更深。

**5. 记忆使用反馈**

脑区完成（`brain.complete` 事件）后，评估执行结果，调用 `markUsed(injected_memory_ids, outcome)`，将反馈写入对应记忆条目的 `usage_outcomes` 计数器。`injected_memory_ids` 来自 `BrainRunResult`。

> ⚠️ **P2-C 已知问题（信号质量低）**：当前 `mode === 'RESPOND'` → `positive`。Limbic 可以 RESPOND 错误内容，这个信号不等于"决策质量好"。
>
> **设计目标**：Thread 创建时定义可评估的 `goal`，Thread 完成时 DMN 对比 actual output 与 goal 评估质量；对于 Teams 场景，用户的持续交互也是可采集的隐性信号。

**6. DEFER 超时调度**

检测到 Limbic 输出 DEFER 事件时，写入一条 `pending_observations`（`trigger_at = event.occurred_at + timeout`，`target_brain = 'limbic'`）。到期后由 Thread Runner `routePending()` 重新激活 Limbic 执行渠道降级。

Thread Runner 本身不内置定时器，DEFER 超时通过 pending 机制实现。

**7. 信号捕获**

检测到已知触发信号（确定性规则 + Haiku fallback）→ 写入 `pending_observations`，由 Thread Runner 下次扫描时路由执行。

---

## 四、Session Anchor（Context 边界管理）

当 LLM session 的 context 使用率接近阈值，DMN 事件响应触发 anchor：

```
Context 使用率接近阈值
  → DMN 检测到（通过 API usage 字段）
  → 触发 anchor：Thread Slot 状态已在 PostgreSQL
  → 向 episodic 写入 anchor 事件（kind=session_anchor，reason="context_limit"）
  → 当前 LLM session 关闭
  → 新 session 开启
  → Context Assembly 从 PostgreSQL + 记忆系统精准重建必要状态
  → Thread 继续执行（不是重新开始）
```

anchor 是 Thread 的无缝延续，不是重启。DMN 后续可从 episodic 读取 anchor 频率——若某类 Thread 频繁触发 `context_limit`，说明需要更激进的 Context Assembly 策略（更短的 Block 4 注入，或更早的 working memory 清理）。

anchor 事件 `reason` 枚举：`"context_limit" | "explicit_reset" | "new_thread"`。

---

## 五、心跳整合（Consolidation）

### 触发条件

定期唤醒（30 分钟—1 小时），不依赖外部事件。

### 三项职责

**1. 深度前瞻预测（Predictive Activation）**

这是 DMN 最核心也最独特的能力——**Agent 自己决定什么时候该做什么**，不依赖外部 cron 或人工触发。

预测来源：从三类记忆读取模式：

| 记忆类型 | 预测样例 |
|---|---|
| `episodic`（历史事件序列） | "合同签署后第 28-30 天总出现付款问题" |
| `procedural`（已知流程结构） | "采购审批在 PO 创建后进入等待审核状态" |
| `semantic`（领域知识） | "这类申请通常需要 48 小时处理" |

预测写入 `pending_observations`，Thread Runner 下次扫描时路由给对应脑区：

| 预测内容 | target_brain | Thread Runner 路由后的动作 |
|---|---|---|
| "这个审批流程下一步需要规划多方协调" | `cortex` | 预创建 Thread，context 已加载，等待触发即可开始推理 |
| "这个合同 28 天后需要付款核查" | `brainstem` | 在指定时间点注册定时执行任务 |
| "用户 X 通常在收到复杂回复 10 分钟后追问" | `limbic` | 预备追问处理逻辑，降低响应延迟 |

**为什么 cron 做不到**：cron 不能感知上下文，不能取消自己。

```
DMN pending：合同 C-2847 在第 28 天需要付款核查
→ 第 25 天，Brainstem 已执行付款确认，episodic 记录完成事件
→ 下一轮心跳整合读到"已完成"信号，pending 项自然移除
```

**精准落地依赖分工**：DMN 能写到正确的 `target_brain`，正是因为其他脑区职责边界清晰。all-in-one 单 Agent 的预测只能是"发一条消息进来"，精度全失。

**2. Pending 维护**

下一轮心跳整合时，新 episodic 增量覆盖进来，DMN 重新评估每条 pending 项：

- 已解决 → 移除
- 继续等待 → 保留
- 情况升级 → 更新 note，Thread Runner 下次扫描以新描述路由

pending 无需主动清理——若长期无法移除，说明任务本身未推进，是业务信号而非架构问题。

> **容量保护**：`pending_observations` 是 workspace 的 JSONB 字段，条目数量有上限（上层配置项）。超出时按 `base_importance` 最低的条目优先淘汰——长期预测（`trigger_at` 远）往往是最有价值的，不应因时间距离远而被优先丢弃。`time-to-trigger` 不是价值的代理指标。

> **并发写**：DMN Reactive 和 DMN Consolidation 可能同时写入 `pending_observations`。实现层使用 `SELECT FOR UPDATE` 锁定 workspace 行后再追加/删除条目，避免 JSONB 覆写竞态。

**3. implicit 记忆聚类合并**

将 Amygdala 写入的 provisional 条目聚类归并为 canonical 记录，消除冗余。

合并规则：tag 取并集，`base_importance` 取较高值，被合并的旧记录通过 `supersedes_ids` 软删除。

---

## 六、implicit 记忆写入权限

`implicit` 记忆（风险模式）由 Amygdala 和 DMN 共同写入：

- **Amygdala**：在拦截新风险时即时写入（provisional，不等锁）
- **DMN Reactive**：在事件响应模式发现行为错误模式后写入，同时也写 `episodic` 作为事件记录
- **DMN Consolidation**：负责定期聚类合并（canonical）

**写入语义**：Amygdala 写入是 best-effort，宁可多一条冗余记录也不能因等锁而延迟工具拦截决策。DMN 心跳整合是最终仲裁者。

**与 Hippocampus Consolidation 的分工**：

| | DMN 心跳整合 | Hippocampus Consolidation |
|---|---|---|
| 性质 | 事件驱动的行为聚类 | 数据驱动的数据库批处理 |
| 输入 | 近期 episodic 增量 | `usage_outcomes` 计数和 `base_importance` 统计 |
| 对 implicit 的作用 | 发现新模式，写入/调整 implicit 条目 | 条目合并、过期清理，不做行为语义判断 |

前者负责"发现"，后者负责"维护"。

---

## 七、预测反馈闭环

预测执行后，Hippocampus 在每日记忆整理时评估预测准确度：

- **准确** → 强化对应 `semantic` / `procedural` 记忆的 `base_importance`
- **偏差** → 修正模式，更新 `procedural` 记忆或标记该模式为"低可信度"

注：`episodic` 是原始事件流，不参与预测质量的权重调整。预测来源是 `semantic` / `procedural`，反馈也归还到这两类。
