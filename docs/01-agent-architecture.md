# AIMA 架构设计

> **AIMA** = Artificial Intelligence: A Minded Architecture — 认知个体的核心框架
> **版本**: 3.4
> **记忆架构详见**: `02-memory-architecture.md`
> **实现细节详见**: `03-implementation-guide.md`
> **公共 API 详见**: `04-sdk-api.md`
> **状态**: 当前权威文档
> **上层应用**: secondfirst/employee（虚拟员工产品）基于 AIMA 构建
>
> **跨文档同步**：01/02/03/04 作为一个文档集合维护。修改任一文档中的接口、脑区职责或数据模型时，需同步检查其他三份文档。以 git commit hash 作为同步基准点。

---

## 零、层次定位

AIMA 是一个**中间层行为框架**，位于 LLM 基础设施和具体应用之间：

```
┌─────────────────────────────────────────────────────────────┐
│  上层应用（两类，相互独立）                                   │
│                                                             │
│  secondfirst/employee（直接基于 AIMA 构建）                  │
│  决定：解决什么问题、装载哪些 Skill、集成哪些外部系统           │
│                                                             │
│  @aima/crew（OpenClaw 兼容层，仅此用途）                      │
│  实现 pi-agent-core Agent 接口，使 OpenClaw 可将 pi 替换为    │
│  AIMA，获得五脑认知能力；secondfirst 不使用此层               │
├─────────────────────────────────────────────────────────────┤
│  AIMA                                                        │
│  行为框架：认知如何运作                                       │
│  五脑架构、认知工作区、Hippocampus、Skill 体系、Brain Event Bus│
├─────────────────────────────────────────────────────────────┤
│  pi-agent-core / pi-ai（pi-mono）                            │
│  LLM 基础设施：解决机器问题                                   │
│  Agent Loop、工具执行、多 Provider 抽象、Session 管理、流式输出│
└─────────────────────────────────────────────────────────────┘
```

**pi-agent 解决的是 LLM 基础设施问题**：如何调用模型、如何管理 Session、如何执行工具——这是机器层面的问题。

**AIMA 解决的是行为层问题**：一个认知个体应该如何思考、如何分工、如何记忆、如何感知风险——这是行为框架层的问题。类比：OpenClaw 是同一层次的框架，但采用了不同的行为模型。

**上层应用决定的是领域问题**：用这套认知框架去做什么、服务什么业务场景、承担什么角色——AIMA 不内置任何领域知识，这些全部通过 Skill 和配置由上层注入。

### 底层适配器

AIMA 框架层（Thread Runner / Cognitive Workspace / MemoryService / Brain Event Bus）与底层 agent runtime 无关。适配器对上层透明，当前决策：

| 适配器 | 状态 | 说明 |
|---|---|---|
| **pi-coding-agent** | ✅ 当前决策（默认） | pi-agent-core 超集，内置工具与外部工具走同一路径，Amygdala 覆盖无缺口 |
| **Claude Agent SDK** | ⏳ 未来选项 | 内置 session 管理、MCP native、PreCompact hook；需要多云部署（Azure/Bedrock）时启用 |

两个适配器暴露相同 `BrainAdapter` 接口给 Thread Runner，框架层代码无需感知底层选型。详见 `03-implementation-guide.md`。

---

## 一、核心设计哲学

### AIMA 实例是最小认知个体

一个 AIMA 实例（如 Alex）是系统的最小可运行单元——一个完整的认知个体，有自己的职责、记忆和工作风格。它在组织中扮演什么角色是配置层的事，不是架构层的定义。架构中没有"用户"这个概念，也没有预设输入来源的形态——来自 Teams 消息、邮件、Webhook、调度器或其他 AIMA 实例的刺激，在框架层面是等价的。

### Loop 是基础设施，不是业务逻辑

每个脑区的 Agent Loop 只做三件事：组装系统提示词、执行工具调用、终止并返回结构化结果。所有业务逻辑、行为规则、判断依据均通过 Skill（Markdown 文件）和记忆注入。

### 能力边界的三层模型

| 层 | 内容 | 实现方式 |
|---|---|---|
| **基础设施层** | 执行、I/O、工具注册、事件总线 | 代码 |
| **配置层** | 超时阈值、重试次数、模型选择、log level | 环境变量 |
| **认知层** | 业务规则、行为模式、判断依据、知识 | Skill（Markdown） |

判断标准：这是一个**动作**（执行）还是一个**判断**（推理）？动作留在代码，判断留在 Skill。

### 分工的代价

五脑分工带来的互相使能是真实的，但代价也是真实的：一条消息从输入到最终动作，经过 Thread Runner 路由、Context Assembly 重组、Amygdala 拦截、DMN 异步观察、Hippocampus 读写——每一步的 LLM 偏差都可能被下游放大。Event Bus 的 `causation_id` 提供单步因果链，全链追溯需要应用层自行重建。**这个架构适合"需要深度推理且对可观测性有要求"的场景，不适合"需要极低延迟的简单操作"**——后者应该用 Limbic EXECUTE 直通或 Brainstem 规则路由绕过 Cortex。分工的目的是让复杂情况不退化，不是让所有情况都复杂。

**不确定时走保守路径**：各决策点的 LLM 偏差若在不确定情况下选择激进路径，下游放大效应最严重。因此每个脑区在不确定时应默认走保守路径：Limbic 不确定意图时 `ROUTE` 给 Cortex 而非直接 `EXECUTE` 或 `RESPOND`；Amygdala 无法判断风险时 `ESCALATE` 而非放行。DMN 通过 `usage_outcomes` 追踪各脑区决策反馈，持续低于阈值时写 `pending_observations`（ALERT）给上层应用，由上层决定是否介入。

---

## 二、五脑架构

**命名约定**：神经学名（Limbic、Cortex 等）是这些组件的正式标识符，方便人类沟通。括号内的功能角色是每个组件的工程语义——这是它"实际上在做什么"。神经学名只做命名，不暗示生物学实现；功能角色才是设计约束的来源。

| 脑区 | 功能角色 | 神经科学对应 | 模型 |
|---|---|---|---|
| **Limbic** | Communicator + Router | 古哺乳脑 / 边缘系统 | Sonnet |
| **Cortex** | Planner + Reasoner | 新哺乳脑 / 新皮层 | Opus |
| **Brainstem** | Executor + System Interface | 爬行脑 / 脑干 | Haiku |
| **Amygdala** | GuardRail | 杏仁核 | 规则优先 / Haiku 降级 |
| **DMN** | Reflector + Consolidator | 默认模式网络 | Haiku |

### Limbic — Communicator + Router
- 所有来自人类协作者的输入首先进入 Limbic；所有发向人类的输出由 Limbic 发出
- **直接处理**简单对话（问候、确认、记忆中能直接回答的问题），不经过 Cortex
- 维护关系上下文、语气调节、沟通节奏
- 用 LLM 判断复杂输入是否需要 Cortex 参与，或是否需要 Brainstem 执行操作

**Limbic 输出模式**（每次激活只产生一种输出）：

| 输出 | 含义 |
|---|---|
| `RESPOND(content)` | 直接回复，简单对话不经过 Cortex |
| `ROUTE(needs_analysis)` | 写入工作空间，等待 Cortex 处理后再响应 |
| `EXECUTE(intent)` | 操作意图明确且无需规划，Limbic 写入工作空间 Slot（EXECUTE 模式），Thread Runner 检测到后路由至 Brainstem。仅用于 Limbic 有足够信息编码操作意图的简单情况（如"发送你刚刚起草的邮件"）；有歧义或需要多步规划时应使用 `ROUTE` |
| `NO_REPLY` | 接收但不响应——群聊场景、信息积累中、不需要当轮回复时 |
| `DEFER` | 确认收到，等待更多输入再决策（必须携带超时时长，由 Thread Runner 计时） |

`DEFER` 超时降级行为按渠道配置：群聊 → `NO_REPLY`（上下文已过去）；DM → `RESPOND`（说明需要更多信息）；异步频道 → `RESPOND`（书面确认）。不允许无限等待。

**群聊场景**：Limbic 不需要对每条提到自己的消息都响应。Limbic 积累同一对话线程的上下文，综合判断后决定是否介入，以及以何种方式介入。频繁的 `NO_REPLY` 比低质量的即时回复更像真实的人类协作者行为。

### Cortex — Planner + Reasoner
- 纯内部推理引擎，不直接与人类或系统交互
- 负责复杂任务的分解、规划、判断和研究
- 推理完成后，在 Cortex Slot 的 `intent` 字段标记结果归属：
  - `"communicate"` → Limbic 激活，组织对外表达
  - `"execute"` → Brainstem 激活，执行具体操作
  - `"both"` → Limbic **先行**（试探性措辞，不说"已完成"），Brainstem 随后执行，DMN Reactive 检测执行结果后触发 Limbic 发出最终通知（成功确认或失败补偿）。**Limbic 阶段区分机制**：Context Assembly Block 3 包含完整 Slot 状态——Limbic 第一次被激活时 Brainstem Slot 不存在（或 `status ≠ done`），应给试探性回复；第二次被激活时 Brainstem Slot `status = done`（含执行结果），应给最终确认。Limbic 读 Slot 状态即可区分，无需额外字段。**执行失败补偿**：Brainstem 失败时发射 `ALERT`，DMN 错误恢复路径（职责1）立即介入，写 Slot 标记失败 + 写 pending 触发 Limbic 发出失败通知——补偿路径与正常结束路径对称，语义统一在 DMN 事件响应中。

### Brainstem — Executor + System Interface
- **系统输入**：监听系统事件（Webhook、Dataverse 变更、定时触发）
- **系统输出**：将抽象指令翻译为具体操作参数并执行（API 调用、CRUD、文件操作）
- **规则路由**（非 LLM）：收到系统事件后，用 `event-routing.md` Skill 中的事件类型对照表判断处理方式：
  - 已知事件类型（在对照表中）→ Brainstem 按 Skill 指令直接处理
  - 未知 / 复杂事件（不在对照表中）→ 写入工作空间并标记 `"needs_analysis"` → Cortex 激活
- 规则路由保持确定性和低延迟，与 Limbic 的 LLM 判断形成对称但不对等的设计。事件类型对照表放 Skill 而非 hardcode，符合"判断=Skill"原则——新事件类型无需改代码，只需更新 `event-routing.md`
- **`event-routing.md` 是 `reference` 类型 Skill**（见§十 Skill 三层分类）：由应用层外部维护，Cortex 不能直接覆写。Cortex Skill Review 可建议更新（生成 `adapted` 版本 + 写 pending 等待人工审核合并），但不能自动替换生效——路由规则错误会影响所有后续事件处理且难以自动检测（事件按错误规则被"正确地"路由），属于高风险静默故障。

**执行模型**：大多数情况 Brainstem 主 session（Haiku）直接执行任务（单层，默认）。对于大型复杂任务（多步骤、需要深度推理、可并行的子操作），主 session 调用 `spawn_execution_session` 工具，启动独立的子执行 session（Opus / Sonnet），获得完整推理链后以结构化结果返回——类比 Claude Code 的 Task 工具：

| 层 | 模型 | 职责 | Session |
|---|---|---|---|
| **主 session**（默认+协调） | Haiku | 任务判断、简单任务直接执行、复杂任务按需 spawn、结果写 Brainstem Slot | 持续，per-brain |
| **子执行 session**（opt-in） | Opus / Sonnet | 复杂多步执行的完整推理链 | 按任务独立，有自己的 session_id |

子执行 session 的结果作为 **tool_result** 注入回主 session（主 session 只看结构化摘要，不见完整推理链），保护主 session 的 cache prefix 不被污染。子执行 session 的完整推理链通过 Event Bus（`COMPLIANCE` 事件携带子 `session_id`）保留，供审计和 DMN 学习使用。子执行结果不写入 episodic 记忆——episodic 是认知衍生物，不存基础设施标识符。

**spawn 判断机制**：Haiku 做的是**结构性判断**（工具调用数量、依赖链深度、是否需要中间推理），不是语义复杂度判断——这对 Haiku 是可靠的。Cortex 在规划时可选注解 `complexity_hint: 'simple' | 'complex'` 写入 Brainstem Slot；Haiku 优先使用此提示，无提示时独立判断。Cortex 有更完整的任务上下文，能在规划阶段预判执行复杂度。

**spawn 决策的反馈**：DMN 通过 `usage_outcomes` 追踪 spawn 决策质量——子执行 session 完成后的结果质量（由 DMN 评估）与"是否 spawn"的决策形成反馈对，持续偏差时写 pending 给 Cortex，建议更新 `complexity_hint` 的判断标准（作为 Skill 更新）。

完整系统图见 `00-overview.md` §四。

Limbic 用 LLM 判断社交情境，Brainstem 用规则处理系统事件——两种路由方式对称但不对等，各自面对不同类型的不确定性。Amygdala 和 DMN 不持有 LLM session，通过 Event Bus 横切介入：前者同步拦截工具调用，后者异步观察和整合。

---

## 三、脑机接口（Brain Event Bus）

AIMA 实例不实现 Audit 逻辑。Audit 是外部关注点。取而代之的是一个结构化的**事件总线**，各脑区向其发射事件，外部系统按需订阅。

### 事件 Log Level

| Level | 含义 | 发射场景 |
|---|---|---|
| `TRACE` | 内部状态转换 | 工作空间 Slot 写入（开发调试用） |
| `DEBUG` | 详细认知过程 | Cortex 推理步骤、Skill 加载 |
| `INFO` | 显著行为 | 工具调用、记忆写入、Skill 调用、**脑区激活/完成** |
| `COMPLIANCE` | 合规相关 | 有真实外部效果的动作（发送消息、修改数据、执行操作） |
| `ALERT` | 需要关注 | Amygdala 中断、Escalation、Cortex 判断失败 |

### 内部订阅

- **Amygdala** 订阅：`tool.pre_use`（`INFO` 级）— 拦截时序依赖适配器实现，见下方 ⚠️
- **DMN** 订阅：`INFO` 及以上（作为 Action Log 来源）

> ⚠️ **P0 已知限制（Amygdala 拦截时序）**：Amygdala 的"执行前拦截"设计假设适配器在工具**执行前**同步回调（如 `pi-coding-agent` Extension API 的 `tool_call` 事件，可返回 `{ block: true }`）。当前暂用的 `pi-agent-core` 适配器的 `getSteeringMessages` 在工具调用**之间**触发，不是执行前同步——Amygdala 的阻断可能晚到一步，工具已开始执行。**在迁移到 `pi-coding-agent` 之前，Amygdala 对单次工具调用的实时拦截不可依赖**。迁移优先级：P0。
>
> **过渡期临时缓解措施（迁移完成前强制执行）**：
> 1. 高风险工具（`bash`、`file_write`、`file_delete`、任何有真实外部效果的 API 工具）**默认 BLOCK**，且不允许 `role.md` 解锁——必须等到 `pi-coding-agent` 迁移完成后才可配置为 ALLOW。
> 2. 中等风险工具（`file_read` 等）可通过 `role.md` 解锁，但需在 Skill 中写明使用约束，由 Limbic/Cortex 在 Context Assembly 阶段判断是否适合发起操作。
> 3. 只有无外部效果的只读工具（`memory_search`、`workspace_read`）默认 ALLOW。
>
> 实质：在 `pi-agent-core` 下，Amygdala 的"执行前拦截"退化为"启动前静态配置"——用工具注册白名单替代运行时动态判断。

### 外部订阅（由集成方实现）

- Audit 系统：订阅 `COMPLIANCE` + `ALERT`
- 可观测性系统：订阅 `INFO`
- 其他 AIMA 实例：订阅 `ALERT`，实现跨实例协调

AIMA 只保证事件的结构化发射，不关心谁在消费。

### 事件字段规范

每个事件必须包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `event_id` | UUID | 事件唯一标识 |
| `event_type` | string | 如 `tool.pre_use`, `brain.complete`, `memory.write` |
| `level` | Level | TRACE/DEBUG/INFO/COMPLIANCE/ALERT |
| `occurred_at` | timestamp | 事件发生时间 |
| `brain` | BrainType | 发射脑区 |
| `thread_id` | string | 所属 Thread（横切信号时为 null） |
| `session_id` | string | 当前脑区 Session ID |
| `causation_id` | UUID \| null | 直接触发本事件的上一个事件 ID |
| `schema_version` | string | 事件格式版本号（**框架自动注入**，调用方不设置；用于 WORM 存储的长期解析和滚动升级期间的消费者版本协商） |
| `payload` | object | 事件内容（工具名、参数、结果等） |

`thread_id` 作为顶层关联 ID（一次外部输入触发的全部事件共享同一 `thread_id`）；`causation_id` 表达单步因果（哪个事件直接触发了本事件），两者独立，共同支撑可观测性和 replay。链条起点（外部输入触发的第一个事件、DMN 心跳自发触发的事件）`causation_id = null`。

---

## 四、认知工作空间

### 持久化模型

Cognitive Workspace **持久化到 PostgreSQL**（与 Memory 同库，独立表）。Thread/Slot 状态是数据库记录，不是纯内存结构。

Thread Runner 崩溃恢复流程：重启后加载所有 `state != complete` 的 Thread → 对每个 Thread 找到最后一个 `status = done` 的 Slot → 重新激活下一个应该激活的脑区 → 继续执行。这保证了 crash 不会导致 in-flight 工作丢失。

**Brainstem 子执行的崩溃恢复（at-most-once 语义）**

Brainstem 崩溃时，`execution_session_id` 为 non-null 且 `status ≠ done`。Thread Runner 重启后的判断流程：

1. 查询 Event Bus：是否存在该 `execution_session_id` 对应的 COMPLIANCE 完成事件？
   - **有** → 子执行已完成，Slot 状态未及时写入。标记 Slot 为 done，继续下一步骤。
   - **没有** → 子执行中断，进入步骤 2。

2. 判断操作幂等性（来自工具注册时声明的 `idempotent` 标志）：
   - **幂等操作**（查询、读取、状态检查）→ 安全重试，生成新的 `execution_session_id` 重跑。
   - **非幂等操作**（发送消息、写入数据、外部 API 调用）→ **不重试，标记 Thread 为 interrupted，escalate 给人工**。宁可中断，不接受重复执行。

这是 at-most-once 语义的实现底线：非幂等操作在崩溃歧义情况下，系统选择"可能少做一次"而非"可能多做一次"。

**`intent=both` 崩溃场景的额外处理**：崩溃恢复时若检测到 `interrupted` Thread 且 Cortex Slot `intent=both`，需要检查 Limbic 是否已发出了试探性消息（通过 Event Bus 查询该 Thread 的 COMPLIANCE 事件是否有 Limbic 发消息记录）。若已发消息，Thread Runner 在 escalate 的同时触发 Limbic 的补偿激活，发出失败通知——避免用户停留在"正在处理"的悬挂状态。

### 模型：Thread + Slot

工作空间是 AIMA 实例内部的共享状态，支持多任务并行。

**Thread 是认知上下文的边界单元**：一个 Thread 对应一件正在处理的事（一段对话、一个任务、一次事件响应）。各脑区的 LLM session 以 Thread 为粒度——同一 Thread 内的多次脑区激活共享同一 session（对话历史得以延续）；不同 Thread 之间不共享 session（上下文完全隔离）。跨 Thread 的知识通过记忆系统（Block 4）流通，而非 session 历史。

**Thread 的创建是应用层决策**：AIMA 提供 Thread 数据结构和调度机制，但"什么触发新 Thread、什么消息归并进已有 Thread"由上层（如 Alex）的配置规则决定。例如：同一 Teams 对话中的连续消息合并进同一 Thread；一封新邮件可能按邮件 thread-id 归入已有 Thread 或新建；Webhook 触发的操作通常是短生命周期的独立 Thread。AIMA 不预设这些规则。

```
Workspace
├── session_id
├── threads[]
│   ├── thread_id
│   ├── source_channel     // "teams_dm" | "email" | "webhook" | "scheduler" | "internal" | ...
│   ├── source_account_id  // 通道内的账户/Bot ID，null 表示单账户（多账户场景：如同时运行两个 Teams Bot）
│   ├── source_external_id // 外部系统的消息/请求 ID（null 表示内部触发）
│   ├── initiated_by       // entity_id（发起方实体，人/系统/DMN 均可）
│   ├── trigger            // 触发事件原始内容摘要
│   ├── priority
│   ├── state              // active | waiting | complete | interrupted
│   └── slots
│       ├── limbic:    { input, output, status }
│       ├── cortex:    { input, output, status, intent, complexity_hint? }
│       │              // intent: communicate|execute|both
│       │              // complexity_hint (optional): 'simple'|'complex' — Cortex 可选注解执行复杂度
│       │              // Brainstem 优先使用；无则 Haiku 自行判断是否 spawn 子执行 session
│       ├── brainstem: { input, output, status, execution_session_id }  // 子执行 session ID 四态：
│       │              // null   + status≠done → 未开始
│       │              // non-null + status≠done → 执行中（或崩溃中断，见下方崩溃恢复）
│       │              // null   + status=done  → 已完成（完成后清除 ID，正常路径）
│       │              // non-null + status=done → 已完成且保留 ID（审计需要时由 Slot 写入方主动保留，非默认）
│       └── ...
└── signals[]              // 横切信号（优先于任何 Thread）
    ├── Amygdala 中断信号
    └── DMN 纠错 / 预测通知

// pending_observations 条目结构（存储在 workspace JSONB 字段）
{
  id:           UUID
  target_brain: BrainType
  note:         string           // LLM 生成的自然语言描述，供 Cortex 理解上下文
  trigger_at:   timestamp | null // null = 立即路由；non-null = 不早于此时刻路由
  expires_at:   timestamp        // 必填。DMN 写入时设置 TTL（如 trigger_at + 7天）；
                                 // Thread Runner routePending() 自动跳过并删除已过期条目。
                                 // 防止冷启动阶段低质量预测无限积累，也防止全量扫描退化
  added_at:     timestamp
}
// 容量保护：JSONB 字段中的 pending 条目数应有上限（上层配置项）。
// 超出时按 base_importance 最低的条目优先淘汰——长期预测（trigger_at 远）往往是
// 最有价值的，不应因时间距离远而被优先丢弃。time-to-trigger 不是价值的代理指标。
```

### 脑区间通信：Thread Runner 路由

脑区之间**不直接互相调用**。通信通过工作空间 Slot + Thread Runner 完成：

1. 当前脑区完成处理，将结构化结果写入自己的 Slot，Loop 终止并返回
2. **Thread Runner**（AIMA 框架层组件，与底层适配器无关）读取 Slot 的状态字段（`intent`、`needs_analysis` 等）
3. Thread Runner 决定下一步激活哪个脑区，启动其 Loop

各脑区对彼此的存在保持不知情——Cortex 不知道 Limbic，它只写 Slot。路由逻辑全部在 Thread Runner，与业务无关，不需要修改脑区代码。

Thread Runner 自身需要处理若干边界情况：`intent=both` 时两个脑区的协调顺序、Brainstem 执行失败后 Limbic 已发消息的补偿、Thread 被中断时正在运行的 Loop 的 cooperative cancellation。这些属于实现层细节，实现阶段应为 Thread Runner 单独编写规范文档。

**激活触发条件**（由 Thread Runner 检测）：

| 脑区 | 激活条件 |
|---|---|
| **Limbic** | 有新的人类输入；或 Cortex Slot 的 `intent` 包含 `"communicate"`；或 `intent=both` 且 Brainstem Slot `status=done`（触发最终通知） |
| **Cortex** | 任意 Slot 写入了 `"needs_analysis"` 标记，且当前 Thread 的 Cortex Slot 为空 |
| **Brainstem** | Cortex Slot 的 `intent` 包含 `"execute"`；或 Limbic 输出 `EXECUTE(intent)`；或新系统事件到达 |

### 并发模型：Thread 间并行，Thread 内顺序

这是避免共享可变状态竞态的核心设计决策：

- **Thread 内**：任意时刻只有一个脑区持有写权限。流程沿 Slot 顺序推进（如 Limbic → Cortex → Brainstem），当前脑区写完并标记 `done` 后，下一个脑区才激活写入。读操作任意时刻均可进行。
- **Thread 间**：不同 Thread 的 Slot 集完全独立，多个脑区可同时处理不同 Thread，无需协调。

这意味着"Brain 级并行"的实质是：Cortex 处理 Thread-A，Brainstem 处理 Thread-B——并行发生在 Thread 维度，而非同一 Thread 内的多脑并发。无需锁，无需事务，竞态在设计层消除。

**`intent=both` 并发安全**：`both` 模式下 Limbic 先行、Brainstem 随后——这是 Thread 内的顺序执行（Limbic 写 Slot done → Thread Runner 激活 Brainstem），不违反单脑写权限规则。若 Brainstem 执行期间用户发来新消息，该消息触发的是**独立的新 Thread**（上层路由规则决定），不会注入当前 Thread——原 Thread 保持 Brainstem 独占写权限直到完成。两个 Thread 并行处理，不相互阻塞。

### 信号优先级

Signals 优先于 Thread 内的正常流程：
1. Amygdala 中断信号 → 立即停止当前 Brainstem 操作
2. DMN 纠错通知 → 中断当前 Thread，写入新的纠错 Thread
3. DMN 预测通知 → 插入新 Thread，优先级可配置

---

## 五、并行工作

AIMA 支持两个层级的并行（并发模型详见第四节）：

### Level 1：Thread 级并行（主要并行层）
一个 AIMA 实例可同时维护多个活跃 Thread，不同脑区同时处理不同 Thread：
- Cortex 分析 Thread-A，Brainstem 执行 Thread-B，Limbic 等待 Thread-C 的人类回复
- 各 Thread 的 Slot 集完全独立，无竞态

Thread 数量上限是配置项。

### Level 2：Instance 级并行

暂缓。Level 1 Thread 并行覆盖绝大多数场景；跨 AIMA 实例的协调（如 @aima/crew 中多个 OpenClaw 实例）在应用层处理，不是 AIMA 框架内的子实例。

---

## 六、Amygdala（杏仁核）

执行前同步中断，速度优先于深度。职责边界清晰：**只拦截工具调用层面的风险**，不涉及决策/推理层面的错误（后者归 DMN）。

- 订阅 Event Bus 上的 `tool.pre_use` 事件
- **规则优先**：确定性规则（正则、金额阈值、黑名单）零 LLM 成本
- **Haiku 降级**：规则无法覆盖时快速评估
- 违规时向工作空间写入中断 Signal，优先级最高
- 发现新风险模式时，写入 `implicit` 记忆（供未来检测）

### 工具风险分级

工具注册时声明 `risk_level`，决定 Amygdala 的介入程度：

| 风险等级 | 典型工具 | Amygdala 行为 |
|---|---|---|
| `low` | 文件读、记忆读、状态查询 | 仅静态规则检查（注册时预计算，零运行时成本） |
| `medium` | 写操作、发送通知 | 静态规则 + `implicit` 记忆匹配 |
| `high` | 外部 API 调用、金融操作、删除操作 | 完整 Amygdala 评估（含 Haiku 降级） |

大多数工具是 `low`，Amygdala 的 LLM 成本只在 `high` 级别工具上发生。

**Amygdala 决策骨架**（框架定义三段式，具体阈值和规则集由应用层配置）：

```
tool.pre_use 事件到达
  1. 静态规则匹配（零 LLM）
     命中 BLOCK 规则 → 立即拦截，写 Signal
     命中 ALLOW 规则 → 放行
     无命中 → 进入第 2 步

  2. implicit 记忆检索（getByTags，按工具类型 + 操作参数匹配）
     命中高置信度风险模式 → 拦截
     命中低置信度 → 进入第 3 步（参考但不决定）
     无命中 → 按 risk_level 决定是否进入第 3 步

  3. Haiku 一次性评估（仅 medium/high 工具，含 implicit 检索摘要作为上下文）
     → ALLOW / BLOCK / ESCALATE
     ESCALATE = 不自动拦截，写 pending 给 DMN，人工或更高权限脑区决定
```

`implicit` 记忆匹配在步骤 2 中作为参考输入，命中后的拦截判断可以是纯规则（高置信度）或交给 Haiku（低置信度）——应用层可配置边界。

**implicit 记忆的反向反馈路径**：静态规则命中的 BLOCK 是权威判断，不需要反馈校正。LLM 评估产生的 BLOCK/ESCALATE 存在误判可能：
- ESCALATE → 人工放行：DMN 事件响应捕获"人工覆盖"事件，对触发该次 ESCALATE 的 implicit 记忆调用 `markUsed(ids, 'negative')`
- ESCALATE → 人工拒绝：强化信号，`markUsed(ids, 'positive')`
- BLOCK（LLM 评估）→ 相同操作随后由更高权限成功执行：DMN 心跳整合检测此模式，写 negative 反馈

Hippocampus Consolidation 在 `usage_outcomes` 收敛时对 `implicit` 记忆同样适用——如果一条模式持续获得 negative，`base_importance` 下降，检索命中率降低，避免误判积累。

### 与 DMN 的分工

| | Amygdala | DMN |
|---|---|---|
| 时序 | 执行**前**（pre-execution） | 执行**后**（事件响应）/ 定期前瞻（心跳整合） |
| 关注点 | 这个行为**该不该做** | 这个行为**做没做成** |
| 性质 | 同步阻断 | 异步回顾 |
| 覆盖范围 | 工具调用风险 | 决策错误、行为偏差、长期模式 |
| 功能 | "这个不能做" | "刚才做错了" / "接下来应该做" |

---

## 七、DMN（默认模式网络）

DMN 是 AIMA 中**唯一能在没有外部触发的情况下主动分析并写入状态**的脑区。Limbic 和 Brainstem 响应外部输入（人类消息、系统事件），DMN 通过两种机制自发运作。

**核心原则：DMN 从不调用 `activateBrain()`。** DMN 只写状态，路由始终由 Thread Runner 发起。DMN 有两条写入路径，对应不同的响应时效：

| 路径 | 写入目标 | 触发时效 | 典型场景 |
|---|---|---|---|
| **即时路由**（Slot Write） | 直接写目标 Thread 的 Slot | Thread Runner 下次轮询（毫秒级） | 错误恢复、Brainstem 重试、中断 Signal |
| **延迟路由**（Pending Write） | 写 `pending_observations` | Thread Runner 判断"成熟"时路由 | 前瞻预测、跨 Thread 任务创建、Skill Review 触发 |

两条路径都经过 Thread Runner 执行实际激活，DMN 是分析者，不是执行者。

DMN 在概念上是一个脑区，**工程上由两种触发方式实现**——事件响应和心跳整合各自独立调度，不共享运行时，不互相阻塞：

### 事件响应（Event Bus 触发）

**实现性质**：代码驱动的事件监听器，不是持续运行的 LLM 对话 Agent。订阅 Event Bus 事件，执行确定性逻辑；需要判断时发起**一次性** LLM 调用（Haiku，非对话 session）。跨 Thread 的全局视野来自直接查询数据库，而非 LLM context window。

**触发**：`INFO` 级及以上事件写入 → 毫秒级响应

**职责**（按优先级）：
1. **错误恢复**：脑区遇到 LLM 调用失败或工具执行错误时，发射 `ALERT` 事件 → DMN 立即介入，决策重试、换策略、还是上报：
   - 可重试错误（超时、限流）→ 写入 retry 指令到对应 Thread Slot
   - 不可重试错误（权限拒绝、数据异常）→ 标记 Thread 为 `interrupted`，发射 `ALERT` 供外部处理
2. **回溯纠错**：读取最新 Action Log，判断刚刚发生的行为是否有误；如需纠错，向工作空间写入中断 Signal
3. **段分配**：写 episodic 事件时，根据 Thread 边界/目标变更/错误恢复/话题切换等触发条件分配 `segment_id` 和 `segment_seq`；每条 episodic 事件都标注所属事件段（粗分，Hippocampus 精修）
4. **显著性处理**：若事件携带 Amygdala 发射的 `significance_boost`，写 episodic 时对应增加 `base_importance`，使风险相关经历编码更深
5. **记忆使用反馈**：脑区完成（`brain.complete` 事件）后，评估执行结果，调用 `markUsed(injected_memory_ids, outcome)`，将反馈写入对应记忆条目的 `usage_outcomes` 计数器；`injected_memory_ids` 来自 `BrainRunResult`
6. **DEFER 超时调度**：检测到 Limbic 输出 `DEFER(timeout)` 事件时，写入一条 `pending_observations`（`trigger_at = event.occurred_at + timeout`，`target_brain = limbic`），到期后由 Thread Runner routePending() 重新激活 Limbic 执行渠道降级。Thread Runner 本身不内置定时器，DEFER 超时通过 pending 机制实现。
7. **信号捕获**：检测到已知的触发信号（确定性规则 + Haiku fallback）→ 写入 `pending_observations`，由 Thread Runner 下次扫描时路由执行

**资源消耗**：轻量，每次只读最新增量（`created_at > last_processed`）

### Session Anchor（Context 边界管理）

当 LLM session 的 context 使用率接近阈值，DMN 事件响应触发 **anchor**：

```
Context 使用率接近阈值
  → DMN 检测到（通过 API usage 字段）
  → 触发 anchor：Thread Slot 状态已在 PG；写入 anchor 事件到 episodic
  → 当前 LLM session 关闭
  → 新 session 开启，Context Assembly 从 PG + 记忆系统精准重建必要状态
  → Thread 继续执行，不是重新开始
```

anchor 事件记录触发原因（`reason: "context_limit" | "explicit_reset" | "new_thread"`）。DMN 后续可从 episodic 中读取 anchor 频率——若某类 Thread 频繁触发 `context_limit`，说明需要更激进的 Context Assembly 策略。

**与 @aima/crew 的衔接**：OpenClaw 层有 `clear()` / `flush()` / `new()` 操作，@aima/crew 在 fork 层重写这些方法，不 call super，转换为 AIMA anchor 语义：

| @aima/crew 调用 | OpenClaw 原意 | AIMA 实际执行 |
|---|---|---|
| `clear()` | 清空 LLM context window | anchor 当前状态 → 新 LLM session，精准重建 context（历史保留，session 重置） |
| `flush()` | 提交 pending 消息并清空队列 | 同 `clear()`——在 AIMA 语义下等价，区别在 OpenClaw 底层，@aima/crew 统一转换为 anchor |
| `new()` | 新建一个全新 Agent session | anchor 当前 Thread → 创建新 Thread，新 session 空白启动 |

对调用方效果一致，Thread 状态和 episodic 记录不丢失。

### 心跳整合（30分钟-1小时触发）

**实现性质**：定期唤醒，读取 episodic 事件增量 + 当前 `pending_observations` 列表，LLM 辅助分析（Haiku 为主，复杂跨流程可升 Sonnet）。

**职责**：

1. **深度前瞻预测（Predictive Activation）**：这是 DMN 最核心也最独特的能力——**Agent 自己决定什么时候该做什么**，不依赖外部 cron 或人工触发。

   预测来源：从三类记忆中读取模式：
   - `episodic`：历史事件序列（"合同签署后第 28-30 天总出现付款问题"）
   - `procedural`：已知流程结构（"采购审批在 PO 创建后进入等待审核状态"）
   - `semantic`：领域知识（"这类申请通常需要 48 小时处理"）

   预测写入 `pending_observations`，极简结构（`entity_ref` + `note` + `target_brain` + `added_at`）。`pending_observations` 是 `CognitiveWorkspace` 状态的一部分（JSONB 字段），写入时触发 `workspace.changes()` 事件，Thread Runner 的事件循环感知后将成熟的项路由给对应脑区执行。

   | 预测内容 | pending 的 target_brain | Thread Runner 路由后的动作 |
   |---|---|---|
   | "这个审批流程下一步需要规划多方协调" | cortex | 预创建 Thread，context 已加载，等待触发即可开始推理 |
   | "这个合同 28 天后需要付款核查" | brainstem | 在指定时间点注册一个定时执行任务 |
   | "用户 X 通常在收到复杂回复 10 分钟后追问" | limbic | 预备追问处理逻辑，降低响应延迟 |
   | "周一早上这个频道流量高，需要预热 Skill" | cortex | 提前加载常用 Skill 到 working 记忆 |

   **精准落地依赖分工**：DMN 能写到正确的 target_brain，正是因为其他脑区职责边界清晰。all-in-one 单 Agent 的预测只能是"发一条消息进来"，精度全失。

2. **pending 维护**：下一轮心跳整合时，新 episodic log 覆盖进来，DMN 重新评估每条 pending 项：已解决 → 移除；继续等待 → 保留；情况升级 → 更新 note，Thread Runner 下次扫描以新描述路由。pending 无需主动清理——若长期无法移除，说明任务本身未推进，是业务信号而非架构问题。

3. **implicit 记忆聚类合并**：将 Amygdala 写入的 provisional 条目聚类归并为 canonical 记录，消除冗余。

**预测取消**：当预测条件已不成立，pending 项在下一轮自然移除：
```
DMN pending：合同 C-2847 在第 28 天需要付款核查
→ 第 25 天，Brainstem 已执行付款确认，episodic 记录完成事件
→ 下一轮心跳整合读到"已完成"信号，pending 项移除
```
这是 cron 做不到的——cron 不能感知上下文，不能取消自己。

**预测反馈闭环**：预测执行后，Hippocampus 在每日记忆整理时评估预测准确度：
- 准确 → 强化对应 `semantic` / `procedural` 记忆的 `base_importance`（预测来源是这两类，episodic 是原始事件流，不调整）
- 偏差 → 修正模式，更新 `procedural` 记忆或标记该模式为"低可信度"

**最终一致性**：事件响应和心跳整合各自在 PostgreSQL MVCC 的一致性快照下工作，互不阻塞。任意时刻记忆库中可能存在短暂冗余（如事件响应刚写入的 implicit 记录尚未被归并）。这是设计选择，不是缺陷——心跳整合定期收敛，系统最终一致。

### implicit 记忆的写入权限

`implicit` 记忆（风险模式）允许 Amygdala 和 DMN 共同写入：
- **Amygdala**：在拦截新风险时即时写入（provisional）
- **DMN**：在事件响应模式发现行为错误模式后写入（同时也写 `episodic` 作为事件记录）；心跳整合负责定期聚类合并（canonical）

**写入语义与冲突解决**：Amygdala 写入是 provisional——即时生效，best-effort，不持锁，不等待 DMN。DMN 心跳整合是最终仲裁者，负责将语义重叠的条目合并为 canonical 记录。冲突合并规则：tag 取并集，`base_importance` 取较高值，被合并的旧记录通过 `supersedes_ids` 软删除。

Amygdala 宁可多一条冗余记录也不能因等锁而延迟工具拦截决策。

**DMN 心跳整合与 Hippocampus Consolidation 的分工**：两者都涉及 `implicit` 记忆，但机制与触发方式不同，互补而非竞争。DMN 心跳整合是**事件驱动的行为聚类**——读取近期 episodic 增量，检测行为偏差或固化模式，通过 LLM 推断"是否要写入或调整 implicit 记录"，结论以 pending 或直接写入形式落地。Hippocampus Consolidation 是**数据驱动的数据库批处理**——按 `usage_outcomes` 计数和 `base_importance` 统计，执行条目合并、段精修和过期清理，不做行为语义判断。前者负责"发现新模式"，后者负责"维护现有数据质量"。

---

## 八、记忆系统 — Hippocampus

Hippocampus 是 AIMA 的**完整记忆实体**，不是"记忆数据库旁边的一个批处理进程"。它统一拥有数据、读写接口和巩固逻辑，内含三个子模块：

| 子模块 | 性质 | 职责 |
|---|---|---|
| **Encoding** | 实时同步 | 所有记忆写入的唯一入口；持久化 DMN 传入的 segment_id/segment_seq；significance_boost 应用 |
| **Recall** | 实时同步 | 所有记忆读取的唯一入口；脑区专属检索策略（见§九） |
| **Consolidation** | 批量异步 | 每日低负载时段运行；段精修 → 段序列回放 → 使用反馈收敛 → 过期清理 |

**Consolidation 执行顺序约束**：段精修必须先于段序列回放——精修更新 `segment_id`，回放依赖正确的段边界读数据。

**Consolidation 的 LLM 调用模型**：段序列回放需要 LLM 做因果分析和模式提取。Consolidation 不是脑区，不持有持久 LLM session，不走 BrainAdapter——每次回放任务发起**一次性 LLM 调用**（Haiku，无对话历史，独立请求），与 DMN Reactive 的"偶发 LLM 调用"性质相同。调用结果直接写入 Hippocampus，不经过 Thread Runner。

**不走 BrainAdapter 的进程**：DMN Reactive（事件处理器）、DMN Consolidation（心跳 batch）、Hippocampus Consolidation（每日 batch）均不走 BrainAdapter，不在 Thread/Slot 体系内，不持有持久 session。BrainAdapter 只服务于持有 LLM session 的三个认知脑区：Limbic、Cortex、Brainstem。

**Skill Review 归属 Cortex**：评估 Skill 质量需要认知判断，不属于记忆基础设施。Hippocampus 只维护 Skill 的索引元数据（`entity_id`、使用统计）。DMN 心跳整合检测到固化模式后写 `pending_observations` 给 Cortex，由 Cortex 决定是否固化、更新或废弃 Skill。

**SDK 暴露参数**：
- `hippocampus.runAt`：Consolidation 每天运行的时间窗口
- `hippocampus.consolidation.*`：段回放 top-K、usage_outcomes 收敛阈值等（上层配置，框架不锁定默认值）

详见 `02-memory-architecture.md`。

---

## 九、记忆架构

### 统一记忆模型

五个脑区使用同一记忆池，通过 `partition_id` 和 `type` 区分。

### 记忆类型

五类记忆（semantic / episodic / procedural / working / implicit）的完整定义、写入方、读取方、初始权重详见 `02-memory-architecture.md` §二/§三（权威来源）。

本文仅列与架构路由相关的要点：episodic 由 DMN 写入，procedural 由 Cortex 写入供 Limbic/Brainstem 读取，implicit 由 Amygdala 写入供 Amygdala 读取，working 是所有脑区的临时状态（Thread 完成时清除）。

### 三轴组织

记忆通过三种轴进行组织，靠检索策略实现（不改变底层数据模型）：

| 轴 | 概念 | 实现方式 |
|---|---|---|
| **因果链** | 段内事件因果序列 | `segment_id` + `segment_seq` 字段 |
| **时间容器** | Thread → Segment 两层时间层级 | `thread_id` + `segment_id`，见 `02-memory-architecture.md` 第三节 |
| **实体驱动** | 以实体为中心的星形拓扑 | `entity_id` + `getEntityContext()` 深度展开 |

底层存储永远保持扁平完整——审计系统直接读扁平表，不需要理解认知层抽象。

### 脑区专属检索（Context Assembly Block 4）

各脑区使用专属检索方法，通用 `search()` 保留为兜底：

| 脑区 | 主检索方法 | 生物学类比 |
|---|---|---|
| **Limbic** | `getEntityContext(entityId)` | 语义网络扩散激活 |
| **Cortex** | `findSimilarSituations(situation)` | 前额叶经验检索 |
| **Brainstem** | `getProcedure(taskType)` | 程序性记忆直接调取 |
| **Amygdala** | `getByTags(tags, timeRange)` | 杏仁核危险识别 |
| **DMN** | `getSessionContext(sessionId)` | 海马体工作记忆 |
| **所有脑区（兜底）** | `search(query)` | 非特异性联想激活 |

### 检索

场景 A（通用兜底）：全文搜索（ILIKE），按 `base_importance DESC, last_accessed_at DESC` 排序。
场景 D-G：脑区专属方法，见 `02-memory-architecture.md` 第四节。
演进方向：向量嵌入 + 语义相似度，两者并存后 RRF 融合重排。

### Episodic 与审计的分离

`episodic` 是认知衍生物——DMN 从 Event Bus 消费事件后写入的压缩表示，可以自由衰减和整理。外部审计系统直接订阅 Event Bus（`COMPLIANCE` 级），保证不可变的完整记录，不依赖 `episodic` 数据库记录。

**五种记忆类型的划分依据是访问模式，不是内容类型**：`episodic` 时序读取、`implicit` 每次工具执行前查、`procedural` Context Assembly 时加载、`working` 有限生命周期（Thread 完成时清除）——四种不同的读写频率和检索策略，合并进同一接口会互相干扰。详见 `02-memory-architecture.md`。

### 实体模型与自我认知

AIMA 的 `semantic` 记忆以**实体**（entity）为基本单位对世界建模。实体分两个层级：

| 层级 | 归属 | 保留 `entity_type` 值 | 示例 |
|---|---|---|---|
| **AIMA 内部实体** | 框架定义 | `brain` / `skill` / `instance` | `brain:cortex`、`skill:procurement-approval`、`instance:self` |
| **应用层实体** | 上层应用定义 | 自由扩展 | 同事、供应商、内部系统、组织部门、其他 AIMA 实例 |

**大脑是实体**：每个脑区（Limbic/Cortex/Brainstem/Amygdala/DMN）在 `semantic` 记忆中有对应的实体记录。DMN 将观察到的脑区行为模式写入 `implicit` 记忆（如"Cortex 在多步数学任务上的可靠性较低"），使路由和风险评估能从自身历史中学习。这是 AIMA 元认知能力的底层机制。

**Skill 是实体**：每个 Skill 文件对应一个稳定的 `entity_id`（如 `skill:procurement-approval`）。Skill 实体（认知层）与 Skill 文件（操作层）分离：文件是 Agent 运行时读取的可执行知识，实体记录是 AIMA 对这个 Skill 的认知积累——使用历史、版本关系（`supersedes_ids`）、适用场景模式。Hippocampus 维护这些实体记录（Skill Index）；Cortex 基于实体记录评估 Skill 的健康度和固化时机（DMN 触发，见§十）。

**实例自身是实体**：`entity_id = "instance:self"` 保留给实例的整体自我描述（能力边界、当前工作状态、已知局限）。

应用层在框架保留的三个 `entity_type` 值之外自由扩展，两者共存于同一记忆池，互不冲突。实体的具体属性模型（每类实体有哪些字段、关系）属于应用层定义，框架只提供 `entity_id` 和 `attribute` 两个索引字段。

### 涌现式文档结构

实例可通过 `create_document` 工具创建知识文件，结构不由系统预定义。`knowledge-index.md` 是唯一约束。

---

## 十、习惯形成与技能内化

### Skill 三层分类

| 类型 | 来源 | 可修改 | 说明 |
|---|---|---|---|
| `reference` | 外部提供 | 否 | 只读参考书，外部方维护 |
| `adapted` | 基于 `reference` 改编 | 是 | 保留原始引用，融入实例自己的上下文；文件头必须声明 `derived_from: <reference_skill_id>` |
| `first-party` | 从实践中生成 | 是 | 纯实例经验，无外部来源 |

学习原则：观察→理解→在自己的上下文中重新表达，而非复制。`adapted` Skill 在 Cortex Skill Review 时应与原始 `reference` 对照，检查边界条件是否完整保留（LLM 改写容易引入语义漂移，如"超过 50 万需二级审批"变成"大额采购需二级审批"）。`derived_from` 引用是对照的锚点。

**Skill 最小 header 规范**（框架建议，应用层执行）：

```markdown
---
type: reference | adapted | first-party
scope: <适用场景一句话>
derived_from: <reference_skill_id>   # adapted 类型必填
version: <语义版本号>
---
```

header 是 Cortex Skill Review 和 `derived_from` 对照的前提。"涌现式结构"是内容区域的灵活性，不是 header 的灵活性——没有结构化 header，LLM 对 Skill 的元认知质量会显著下降。

### Skill 生命周期

```
外部 reference ──→ Cortex 学习 ──→ adapted Skill
新任务经验 ──→ Cortex 推理 ──→ first-party Skill
                                  ↓ 重复使用、稳定
                    DMN 心跳整合检测到固化模式
                    → pending_observations 给 Cortex
                    → Cortex Skill Review：评估、固化或废弃
                                  ↓ 环境变化、失效
                    DMN 检测漂移 → Cortex 重新学习
```

Skill Review 由 **Cortex** 执行——评估 Skill 质量是认知判断，不是数据维护。Hippocampus 维护 Skill 实体记录（Index），提供 `usage_outcomes` 等统计数据供 Cortex 判断；Cortex 读这些数据并决策。

**Skill 文件并发语义**：Skill Review 是 Cortex 受 DMN pending 触发的独立 Thread，与其他 Thread 中 Brainstem 读取 Skill 文件的 I/O 并发无锁。Skill 文件在 Cortex 写入前对读者不可见（文件系统原子替换），Brainstem 读到的永远是完整的某一版本，不会读到写到一半的状态。`adapted` / `first-party` Skill 的更新频率远低于 Brainstem 的读频率，实际并发冲突概率极低。`reference` 类 Skill（如 `event-routing.md`）由外部维护，不参与 Cortex 自动写入路径，并发更安全。

---

## 十一、Context Assembly（面向五脑）

| Block | Limbic | Cortex | Brainstem |
|---|---|---|---|
| **身份** | 人格 + 人际关系 + 沟通风格 | 推理角色 + 当前任务 | 系统权限 + API 清单 |
| **Skill** | Skill Index + 固化/适配 Skill | 分析方法论 | 操作 Skill + 执行参数模板 |
| **状态** | 工作空间状态 + 待处理 Thread | 当前分析任务 + 中间结论 | 待执行队列 + 系统状态 |
| **记忆** | `semantic` + `episodic` + `procedural` | `semantic` + `episodic` + `procedural` | `procedural` |

Block 4 使用原始消息/任务描述作为检索 query，无结果时省略。

**实体检索的两步模式**：`getEntityContext(entityId)` 要求已知 `entity_id`，但 Block 4 执行时可能只有实体名称（如"客户 A"）。标准解法：先用 `search("客户 A")` 找到包含该实体的记忆记录，从结果中读取 `entity_id`，再调用 `getEntityContext()` 展开完整上下文。对 Limbic 而言，这是两次 Hippocampus.Recall 调用——先发现实体，再展开实体。current ILIKE 实现对姓名文字匹配已足够；向量检索上线后语义发现能力进一步增强。

### 时间感知

脑区的时间感知（当前时间、时区、星期几）通过 **Block 3** 注入，不得出现在 Block 1/2：

```
## Current Context
- local_time: 2026-03-10T14:23:45+11:00
- timezone: Australia/Sydney
```

Block 1/2 内禁止出现任何时间戳或日期——哪怕是 `last_updated` 这类字段也会导致 cache 永远 miss。时区配置属于应用层（如 Alex）的配置项，AIMA 框架不内置时区假设。时间在单次脑区激活期间保持"冻结"：Cortex 14:00 被激活、15:00 完成推理，它看到的始终是激活时注入的 14:00——这是正确行为，推理过程中时间不应跳变。

### Context Assembly 的缓存效率

Block 1（身份）和 Block 2（Skill Index）内容稳定，构成 LLM prompt cache 的固定前缀。同一 Session 内这两块几乎零成本（cache hit）。每轮的真实开销只在 Block 3/4：工作空间状态读取（内存操作）和记忆检索（数据库查询），体量远小于全量重组。

这是持久化历史不允许重写的另一个原因：重写会使 Block 1/2 之后的 cache 前缀失效，导致全量重新计费。

---

## 十二、Runtime 边界

```
┌─────────────────────────────────── AIMA 实例 ───────────────┐
│                                                               │
│  ┌─────────┐  ┌─────────┐  ┌───────────┐                     │
│  │ Limbic  │  │ Cortex  │  │ Brainstem │                     │
│  │ LLM路由 │  │ intent  │  │ 规则路由  │                     │
│  └────┬────┘  └────┬────┘  └─────┬─────┘                    │
│       │            │             │                            │
│       └────────────┴─────────────┘                           │
│                    │                                          │
│          ┌─────────▼──────────┐                              │
│          │   认知工作空间      │  Threads + Slots + Signals   │
│          └─────────┬──────────┘                              │
│                    │                                          │
│         ┌──────────┴──────────┐                              │
│  ┌──────▼──────┐    ┌─────────▼──────────────────┐          │
│  │  Amygdala   │    │  DMN                        │          │
│  │  pre-exec   │    │  事件响应 | 心跳整合        │          │
│  └─────────────┘    └─────────────────────────────┘          │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Brain Event Bus  TRACE|DEBUG|INFO|COMPLIANCE|ALERT  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  记忆池  semantic|episodic|procedural|working|implicit│    │
│  └──────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────┘

外部（订阅 Event Bus）：
  Audit 系统（COMPLIANCE + ALERT）
  可观测性系统（INFO）
  其他 AIMA 实例（ALERT，跨实例协调）
```
