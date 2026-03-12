# Brainstem — Executor + System Interface

> **版本**: v2.0
> **状态**: 草稿

---

## 角色定位

Brainstem 是 AIMA 的执行层，也是系统感知层。它负责两件事：将抽象指令翻译为具体操作并执行；以及监听和处理外部系统事件（Webhook、Scheduler、Dataverse 变更等）。

Brainstem 是系统方向的 AIMA 对外接口——就像 Limbic 是人类方向的对外接口一样，Brainstem 是系统方向的入口和出口。系统事件不经过 Limbic，直接进入 Brainstem。

**Brainstem 的核心特征**是确定性优先：已知的事件类型按规则路由（`event-routing.md` Skill），无需 LLM 参与；只有在规则无法覆盖时才升级到 Cortex。这保持了系统集成的低延迟和高确定性，同时保留了面对未知情况的认知能力。

**双层执行架构**让 Brainstem 同时具备"快速轻量"和"深度推理"两种执行模式——大多数情况下主 session（Haiku）直接处理，复杂多步任务按需 spawn 子执行 session（Opus/Sonnet）。

---

## 触发方式

Brainstem 有两种完全不同的触发来源，都是合法的 Thread 入口：

### 触发方式一：内部路由

- **来自 Limbic**：用户明确要求执行某个操作（如"帮我发这封邮件"）
- **来自 Cortex**：规划完成，Cortex 的 `handoff` 包含具体执行步骤

### 触发方式二：系统事件直接触发

- **Webhook 到达**：外部系统推送事件（如 GitHub PR、Jira 更新）
- **Scheduler 触发**：DMN 预测写入的定时任务到期
- **Dataverse 变更**：Microsoft Dataverse 记录创建/更新/删除
- **其他平台事件**：任何注册在 Brainstem 上的系统级事件订阅

系统事件进入后，Brainstem **优先用规则判断**如何处理（见"规则路由"部分），而不是先调用 LLM。

---

## Input

Brainstem 激活时，Thread Slot 的 input 区域包含：

- **执行任务描述**：来自 Limbic/Cortex 的 `handoff`，或系统事件的原始内容
- **`complexity_hint`**（可选）：来自 Cortex 的执行复杂度预判（`'simple'` 或 `'complex'`），Brainstem 优先使用
- **工作空间状态**（Block 3）：当前 Thread 历史 Slot 状态
- **系统权限与 API 清单**（Block 1）：来自 role 文件，定义可用工具集和操作权限范围
- **执行 Skill**（Block 2）：操作 Skill 和执行参数模板，如 `event-routing.md`（系统事件路由规则）
- **冷启动记忆**（Block 4，可选）：Thread Runner 预注入的程序性记忆（`procedural`），作为执行前的流程引导

---

## Output Model

```typescript
{
  next:    'limbic' | 'cortex' | null
  result?: string
}
```

| `next` | `result` | 含义 |
|---|---|---|
| `null` | — | 执行完成，无需通知任何人，流程结束 |
| `'limbic'` | 有 | 执行完成，结果需要告知人类（由 Limbic 组织回复） |
| `'limbic'` | 无 | 执行完成，需要 Limbic 处理某个后续（如确认或追问） |
| `'cortex'` | — | 执行中发现问题需要重新规划，升级给 Cortex 处理 |

`result` 是执行结果的摘要，供 Limbic 组织人类回复时使用。不需要包含完整技术细节，只需包含人类关心的结果信息。

---

## 规则路由（系统事件处理）

Brainstem 收到系统事件时，**首先用 `event-routing.md` Skill 中的事件类型对照表判断**，而不是调用 LLM：

```
系统事件到达
  → 查 event-routing.md 对照表
  → 命中已知事件类型？
    是 → 按 Skill 中的指令直接处理（确定性，低延迟）
    否 → 写入工作空间并标记 needs_analysis → 激活 Cortex
```

`event-routing.md` 是 `reference` 类型 Skill，由应用层外部维护。Cortex 的 Skill Review 可以建议更新（生成 `adapted` 版本 + 写 pending 等待人工审核），但不能自动替换生效——路由规则错误会导致所有后续事件被静默地错误处理，是高风险操作。

这一设计的意义：Brainstem 的系统感知能力是**可编程的**（更新 Skill 即可扩展支持新事件类型），但仍然维持**确定性和低延迟**（不依赖 LLM 做规则性判断）。

---

## 双层执行模型

### 主 session（默认，Haiku）

大多数情况下，Brainstem 主 session 直接处理任务：

- 简单的单步操作（查询记录、发送通知、更新字段）
- Cortex 标注 `complexity_hint: 'simple'` 的任务
- 规则路由判断为已知处理方式的系统事件

主 session 持续运行，session key 为 `brainstem:{thread_id}`，跨同一 Thread 内的多次激活共享历史。

### 子执行 session（opt-in，Opus/Sonnet）

对于复杂任务，主 session 调用 `spawn_sub_execution` 工具，启动独立的子执行 session：

| 层 | 模型 | 职责 |
|---|---|---|
| **主 session** | Haiku | 任务判断、协调、简单任务直接执行、复杂任务 spawn、结果写 Slot |
| **子执行 session** | Opus / Sonnet | 复杂多步执行的完整推理链，有独立的 `session_id` |

子执行结果以 **tool_result** 形式注入主 session（主 session 只看结构化摘要，不见完整推理链），保护主 session 的 cache prefix 不被污染。子执行 session 的完整推理链通过 Event Bus（`COMPLIANCE` 事件携带子 `session_id`）保留，供审计和 DMN 学习使用。

### spawn 判断机制

Haiku 做的是**结构性判断**，不是语义复杂度判断——这对 Haiku 是可靠的：

- 工具调用数量是否超过阈值？
- 是否存在依赖链（步骤 B 需要步骤 A 的结果）？
- 是否需要中间推理来决定下一步？

Cortex 在规划阶段能看到任务全貌，因此优先使用 `complexity_hint`：

- `complexity_hint: 'simple'` → Haiku 倾向于直接执行
- `complexity_hint: 'complex'` → Haiku 倾向于 spawn
- 无提示 → Haiku 独立进行结构性判断

---

## LLM Session 模型

- **主 session key 格式**：`brainstem:{thread_id}`
- **子执行 session**：每次 spawn 生成独立 `session_id`，存入 Slot 的 `execution_session_id` 字段
- **跨激活持久化**：主 session 在同一 Thread 内持续，子执行 session 按任务生命周期管理
- **崩溃恢复**：Thread Runner 重启后通过 `execution_session_id` 状态判断恢复路径：
  - `execution_session_id` 为空 + status 非 done → 未开始，重新执行
  - `execution_session_id` 非空 + status 非 done → 检查 Event Bus 确认是否已完成；幂等操作可重试，非幂等操作标记 `interrupted` 并上报
- **模型**：
  - 主 session：Haiku（协调和简单执行，速度优先）
  - 子执行 session：Opus（需要深度推理的复杂多步任务）或 Sonnet（中等复杂度）

---

## 工具集

Brainstem 拥有最广泛的工具访问权限——所有 MCP 工具都对 Brainstem 可用（受 Amygdala 风险拦截）。

### Hippocampus 工具（推理中主动拉取）

| 工具 | 用途 |
|---|---|
| `memory_get_procedure(taskType)` | 执行任务前确认标准操作流程。Brainstem 的首要记忆工具——"上次执行这类任务的步骤是什么？" |
| `memory_search(query)` | 通用检索兜底 |

### 执行工具

| 工具 | 用途 |
|---|---|
| `spawn_sub_execution(taskDescription, model)` | 创建子执行 session，用于复杂多步任务的深度推理 |
| 所有注册的 MCP 工具 | Dataverse CRUD、文件操作、邮件发送、Teams 消息、外部 API 调用等——具体工具集由应用层配置 |

**工具访问原则**：工具调用前经过 Amygdala 的风险评估。高风险工具（外部 API 调用、金融操作、删除操作）会触发完整的 Amygdala 三阶段评估；低风险工具（只读查询）直接放行。Brainstem 不绕过 Amygdala。

---

## 典型轨迹

### 轨迹一：简单执行，无需通知

```
触发：Cortex handoff "在 Dataverse 中将采购单 PO-2847 状态更新为 approved"
Brainstem 主 session 直接执行更新操作
输出：{ next: null }
```

流程结束，无需告知任何人。

### 轨迹二：执行完成，告知用户

```
触发：Limbic handoff "发送会议邀请给 Alice 和 Bob，明天下午 2 点"
Brainstem 执行日历 API 调用，创建会议邀请
输出：{ next: 'limbic', result: '已向 Alice 和 Bob 发送明天下午 2 点的会议邀请，会议 ID：MTG-9234' }
```

Limbic 接收 result，组织人类可读的确认回复。

### 轨迹三：复杂多步执行，spawn 子 session

```
触发：Cortex handoff "生成过去90天采购报告并发邮件给财务部", complexity_hint: 'complex'
Brainstem 主 session 判断：多步骤，有依赖链，spawn 子执行 session
子执行 session（Opus）执行：查询 Dataverse → 汇总数据 → 生成 Excel → 发邮件
子执行结果作为 tool_result 返回主 session
输出：{ next: 'limbic', result: '采购报告已生成并发送给财务部（finance@company.com），附件大小 2.3MB，覆盖 2025-12-12 至 2026-03-12' }
```

### 轨迹四：系统事件，规则路由直接处理

```
触发：Dataverse 变更事件，记录类型：PurchaseOrder，变更字段：status = 'pending_approval'
Brainstem 查 event-routing.md：已知事件类型 "PurchaseOrder.pending_approval"
→ 规则：通知采购经理 Alex 审批
Brainstem 执行：发送 Teams 通知给采购经理
输出：{ next: null }
```

无需 LLM 参与，纯规则路由，低延迟。

### 轨迹五：系统事件，未知类型，升级 Cortex

```
触发：Webhook 事件，payload 类型为 "vendor.compliance_alert"（不在 event-routing.md 中）
Brainstem：未知事件类型，写入工作空间标记 needs_analysis
输出（内部）：激活 Cortex，handoff 包含事件原始内容
```

Cortex 分析后决定如何处理，完成后通知 Limbic 或再次路由 Brainstem 执行。

### 轨迹六：执行中发现问题，升级 Cortex

```
触发：Cortex handoff "处理供应商 Contoso 的合同续签"
Brainstem 执行中发现：Contoso 在黑名单列表中（最近有合规争议）
输出：{ next: 'cortex', handoff: '执行合同续签时发现 Contoso（vendor_id: V-4421）在合规争议列表中（添加于 2026-01-15）。需要 Cortex 重新评估是否继续续签，以及是否需要升级审批。' }
```

---

## 边界：不做什么

- **不直接与人类输出 reply**：Brainstem 没有 `reply` 字段，任何需要发给人类的内容必须通过 `next: 'limbic'` + `result` 传递，由 Limbic 组织表达
- **不进行社交判断**：判断语气、关系、沟通节奏——这些是 Limbic 的职责
- **不进行深度规划**：多步骤任务的拆解和规划由 Cortex 完成；Brainstem 执行 Cortex 已经规划好的步骤，或执行规则明确的系统操作
- **不自行覆写 `event-routing.md`**：`event-routing.md` 是 `reference` 类 Skill，Brainstem 只读取，不修改。若发现规则不足，通过 pending 触发 Cortex Skill Review，人工审核后才可更新
- **不绕过 Amygdala**：所有工具调用经过正常的 Event Bus 路径，Amygdala 的风险评估不可跳过
- **不持有跨 Thread 的全局视野**：Brainstem 只处理当前 Thread 的任务；跨 Thread 的模式感知（如"这类事件上周也出现过"）是 DMN 的职责
