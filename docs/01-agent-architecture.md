# AIMA 架构设计

> **AIMA** = Artificial Intelligence: A Minded Architecture — 认知个体的核心框架
> **版本**: 3.3
> **记忆架构详见**: `02-memory-architecture.md`
> **状态**: 当前权威文档
> **上层应用**: secondfirst/employee（虚拟员工产品）基于 AIMA 构建

---

## 零、层次定位

AIMA 是一个**中间层行为框架**，位于 LLM 基础设施和具体应用之间：

```
┌─────────────────────────────────────────────┐
│  上层应用                                    │
│  （如 secondfirst/employee）                 │
│  决定：解决什么问题、装载哪些 Skill、          │
│        集成哪些外部系统                       │
├─────────────────────────────────────────────┤
│  AIMA                                        │
│  行为框架：认知如何运作                       │
│  五脑架构、认知工作区、记忆系统、              │
│  Skill 体系、Brain Event Bus                 │
├─────────────────────────────────────────────┤
│  pi-agent-core / pi-ai（pi-mono）            │
│  LLM 基础设施：解决机器问题                   │
│  Agent Loop、工具执行、多 Provider 抽象、      │
│  Session 管理、流式输出                       │
└─────────────────────────────────────────────┘
```

**pi-agent 解决的是 LLM 基础设施问题**：如何调用模型、如何管理 Session、如何执行工具——这是机器层面的问题。

**AIMA 解决的是行为层问题**：一个认知个体应该如何思考、如何分工、如何记忆、如何感知风险——这是行为框架层的问题。类比：OpenClaw 是同一层次的框架，但采用了不同的行为模型。

**上层应用决定的是领域问题**：用这套认知框架去做什么、服务什么业务场景、承担什么角色——AIMA 不内置任何领域知识，这些全部通过 Skill 和配置由上层注入。

### 底层适配器

AIMA 框架层（Thread Runner / Cognitive Workspace / MemoryService / Brain Event Bus）与底层 agent runtime 无关。官方提供两个适配器：

| 适配器 | 特点 | 适用场景 |
|---|---|---|
| **pi-agent-core** | 完全 provider 无关，支持 20+ LLM provider，完整控制 agent loop | 需要 GPT-4 / Gemini / 本地模型；需要精细控制每一步 |
| **Claude Agent SDK** | 内置 session 管理、MCP native、PreCompact hook、未来 Agent Teams | 快速上手；Claude 生态；开源用户的最低阻力入门路径 |

两个适配器暴露相同接口给 Thread Runner，框架层代码无需感知底层选型。详见 `03-implementation-guide.md`。

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

---

## 二、五脑架构

神经学名字是代号，功能角色是抽象职责描述。两者同等重要。

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
| `EXECUTE(intent)` | 操作意图明确且无需规划，Limbic 直接写入工作空间并激活 Brainstem。仅用于 Limbic 有足够信息编码操作意图的简单情况（如"发送你刚刚起草的邮件"）；有歧义或需要多步规划时应使用 `ROUTE` |
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
  - `"both"` → Limbic **先行**（试探性措辞，不说"已完成"），Brainstem 随后执行，DMN Reactive 检测执行结果后触发 Limbic 发出最终通知（成功确认或失败补偿）

### Brainstem — Executor + System Interface
- **系统输入**：监听系统事件（Webhook、Dataverse 变更、定时触发）
- **系统输出**：将抽象指令翻译为具体操作参数并执行（API 调用、CRUD、文件操作）
- **规则路由**（非 LLM）：收到系统事件后，用配置化规则判断处理方式：
  - 已知事件类型 → Brainstem 直接处理
  - 复杂 / 未知事件 → 写入工作空间并标记 `"needs_analysis"` → Cortex 激活
- 规则路由保持确定性和低延迟，与 Limbic 的 LLM 判断形成对称但不对等的设计

**双层执行模型**：Brainstem 采用主 session + 子执行 session 的两层结构，类似 Claude Code 的主进程/子进程模式：

| 层 | 模型 | 职责 | Session |
|---|---|---|---|
| **主 session** | Haiku | 任务协调、结果 review、写 Brainstem Slot | 持续，per-brain |
| **子执行 session** | Opus / Sonnet | 复杂多步执行的完整推理链 | 按任务独立，有自己的 session_id |

主 session 只看子执行 session 返回的结构化结果摘要，不将执行细节载入自身上下文，避免污染主 session 的 cache prefix。子执行 session 的完整推理链通过 Event Bus（`COMPLIANCE` 事件携带 `session_id`）保留，供审计和 DMN 学习使用——不写入 episodic 记忆，episodic 是认知衍生物，不存基础设施标识符。

### 两个接口原则

```
人类协作者 ←→ Limbic（LLM 判断路由）←→ [认知工作空间] ←→ Cortex
                                                ↕
系统 / 平台  ←→ Brainstem（规则路由）←─────────────────────┘
```

Limbic 用 LLM 判断社交情境，Brainstem 用规则处理系统事件——两者都做路由决策，但方式不同，因为各自面对的不确定性类型不同。

---

## 三、脑机接口（Brain Event Bus）

AIMA 实例不实现 Audit 逻辑。Audit 是外部关注点。取而代之的是一个结构化的**事件总线**，各脑区向其发射事件，外部系统按需订阅。

### 事件 Log Level

| Level | 含义 | 发射场景 |
|---|---|---|
| `TRACE` | 内部状态转换 | 工作空间 Slot 写入、脑区激活/完成（开发调试用） |
| `DEBUG` | 详细认知过程 | Cortex 推理步骤、Skill 加载 |
| `INFO` | 显著行为 | 工具调用、记忆写入、Skill 调用 |
| `COMPLIANCE` | 合规相关 | 有真实外部效果的动作（发送消息、修改数据、执行操作） |
| `ALERT` | 需要关注 | Amygdala 中断、Escalation、Cortex 判断失败 |

### 内部订阅

- **Amygdala** 订阅：`tool.pre_use`（`INFO` 级）
- **DMN** 订阅：`INFO` 及以上（作为 Action Log 来源）

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
| `schema_version` | string | 事件格式版本号 |
| `payload` | object | 事件内容（工具名、参数、结果等） |

`thread_id` 作为顶层关联 ID（一次外部输入触发的全部事件共享同一 `thread_id`）；`causation_id` 表达单步因果（哪个事件直接触发了本事件），两者独立，共同支撑可观测性和 replay。链条起点（外部输入触发的第一个事件、DMN 心跳自发触发的事件）`causation_id = null`。

---

## 四、认知工作空间

### 持久化模型

Cognitive Workspace **持久化到 PostgreSQL**（与 Memory 同库，独立表）。Thread/Slot 状态是数据库记录，不是纯内存结构。

Thread Runner 崩溃恢复流程：重启后加载所有 `state != complete` 的 Thread → 对每个 Thread 找到最后一个 `status = done` 的 Slot → 重新激活下一个应该激活的脑区 → 继续执行。这保证了 crash 不会导致 in-flight 工作丢失。

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
│   ├── source_external_id // 外部系统的消息/请求 ID（null 表示内部触发）
│   ├── initiated_by       // entity_id（发起方实体，人/系统/DMN 均可）
│   ├── trigger            // 触发事件原始内容摘要
│   ├── priority
│   ├── state              // active | waiting | complete | interrupted
│   └── slots
│       ├── limbic:    { input, output, status }
│       ├── cortex:    { input, output, status, intent }   // intent: communicate|execute|both
│       ├── brainstem: { input, output, status, execution_session_id }  // 子执行 session ID 三态：null+status≠done→未开始；non-null+status≠done→执行中；null+status=done→已完成（完成后清除 ID）
│       └── ...
└── signals[]              // 横切信号（优先于任何 Thread）
    ├── Amygdala 中断信号
    └── DMN 纠错 / 预测通知
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
| **Limbic** | 有新的人类输入；或 Cortex Slot 的 `intent` 包含 `"communicate"` |
| **Cortex** | 任意 Slot 写入了 `"needs_analysis"` 标记，且当前 Thread 的 Cortex Slot 为空 |
| **Brainstem** | Cortex Slot 的 `intent` 包含 `"execute"`；或 Limbic 输出 `EXECUTE(intent)`；或新系统事件到达 |

### 并发模型：Thread 间并行，Thread 内顺序

这是避免共享可变状态竞态的核心设计决策：

- **Thread 内**：任意时刻只有一个脑区持有写权限。流程沿 Slot 顺序推进（如 Limbic → Cortex → Brainstem），当前脑区写完并标记 `done` 后，下一个脑区才激活写入。读操作任意时刻均可进行。
- **Thread 间**：不同 Thread 的 Slot 集完全独立，多个脑区可同时处理不同 Thread，无需协调。

这意味着"Brain 级并行"的实质是：Cortex 处理 Thread-A，Brainstem 处理 Thread-B——并行发生在 Thread 维度，而非同一 Thread 内的多脑并发。无需锁，无需事务，竞态在设计层消除。

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

当任务真正独立、需要深度并行时，可以临时生成**子 AIMA 实例**：
- 子实例有完整五脑结构
- 与父实例共享同一记忆池（通过 `parent_session_id` 标签隔离 `working` 记忆）
- 子实例完成后，结果写回父实例的工作空间，子实例销毁

**子实例生命周期约束**：创建时必须声明 `timeout_ms`（无默认值，强制显式）。父实例持有 cancellation token，超时后调用 abort。子实例的 working Slot 标记为 `timed_out`，父 DMN 决定重试或上报。没有 timeout 的子实例是资源泄漏源，不允许创建。

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

### 与 DMN 的分工

| | Amygdala | DMN |
|---|---|---|
| 时序 | 执行**前**（pre-execution） | 执行**后**（post-action） |
| 性质 | 同步阻断 | 异步回顾 |
| 覆盖范围 | 工具调用风险 | 决策错误、行为偏差、长期模式 |
| 功能 | "这个不能做" | "刚才做错了" / "接下来应该做" |

---

## 七、DMN（默认模式网络）

DMN 是 AIMA 中**唯一能在没有外部触发的情况下自发启动行为**的脑区。Limbic 和 Brainstem 响应外部输入（人类消息、系统事件），DMN 通过心跳自发唤醒。

DMN 在概念上是一个脑区，**工程上由两个独立运行单元实现**——Reactive 和 Consolidation 各自独立调度，不共享运行时，不互相阻塞：

### 模式一：Reactive（Event Bus 触发）

**实现性质**：DMN Reactive 是**代码驱动的事件监听器**，不是持续运行的 LLM 对话 Agent。它订阅 Event Bus 事件，执行确定性逻辑；需要判断时发起**一次性** LLM 调用（非对话 session）。跨 Thread 的全局视野来自直接查询数据库（workspace 表、episodic 事件记录），而非 LLM context window。

**触发**：`INFO` 级及以上事件写入 → 毫秒级响应

**职责**（按优先级）：
1. **错误恢复**：脑区遇到 LLM 调用失败或工具执行错误时，发射 `ALERT` 事件 → DMN 立即介入，决策重试、换策略、还是上报。具体：
   - 可重试错误（超时、限流）→ 写入 retry 指令到对应 Thread Slot
   - 不可重试错误（权限拒绝、数据异常）→ 标记 Thread 为 `interrupted`，发射 `ALERT` 供外部处理
2. **回溯纠错**：读取最新 Action Log，判断刚刚发生的行为是否有误；如需纠错，向工作空间写入中断 Signal
3. **前瞻预测**：基于近期 Action Log 预测接下来需要的行为，无预测则跳过

**资源消耗**：轻量，每次只读最新增量（`created_at > last_anchor`）

### 模式二：Consolidation（心跳触发）

**触发**：定期心跳（分钟/小时级）

**职责**：
1. **Skill 生命周期**：监控使用频率，触发固化；检测失效，触发 Cortex 重新学习
2. **记忆整理**：清理过期 `episodic`，调整 importance 权重，生成 Memory Bulletin
3. **跨 Session 跟进**：检查上一 Session 未完成的 Thread

**资源消耗**：较重，逐行处理（非大批量事务），低优先级，应调度在低负载时段。PostgreSQL MVCC 保证 Consolidation 写操作不阻塞 Reactive 的读路径；I/O 压力层面的竞争通过调度时段隔离而非锁机制解决

**最终一致性声明**：Reactive 和 Consolidation 各自在 PostgreSQL MVCC 的一致性快照下工作，互不阻塞，但两者不协调写入顺序。任意时刻记忆库中可能存在短暂冗余（如 Reactive 刚写入的 implicit 记录尚未被 Consolidation 归并）。这是设计选择，不是缺陷——Consolidation 定期收敛，系统最终一致。

### implicit 记忆的写入权限

`implicit` 记忆（风险模式）允许 Amygdala 和 DMN 共同写入：
- Amygdala：在拦截新风险时写入
- DMN：在 Reactive 模式发现行为错误模式后写入（同时也写 `episodic` 作为事件记录）

---

## 八、习惯形成与技能内化

### Skill 三层分类

| 类型 | 来源 | 可修改 | 说明 |
|---|---|---|---|
| `reference` | 外部提供 | 否 | 只读参考书，外部方维护 |
| `adapted` | 基于 `reference` 改编 | 是 | 保留原始引用，融入实例自己的上下文 |
| `first-party` | 从实践中生成 | 是 | 纯实例经验，无外部来源 |

学习原则：观察→理解→在自己的上下文中重新表达，而非复制。

### Skill 生命周期

```
外部 reference ──→ Cortex 学习 ──→ adapted Skill
新任务经验 ──→ Cortex 推理 ──→ first-party Skill
                                  ↓ 重复使用、稳定
                           DMN Consolidation 固化
                                  ↓ 环境变化、失效
                           DMN 检测 → Cortex 重新学习
```

---

## 九、记忆架构

### 统一记忆模型

五个脑区使用同一记忆池，通过 `partition_id` 和 `type` 区分。

### 记忆类型

| 类型 | 内容 | 写入方 | 读取方 |
|---|---|---|---|
| `semantic` | 事实、实体、关系 | Limbic / Cortex | Limbic / Cortex |
| `episodic` | 事件序列（= Action Log） | DMN（消费 Event Bus） | DMN |
| `procedural` | Skill 化的流程模式 | Cortex | Limbic / Brainstem |
| `working` | 当前 Thread 临时状态 | 所有脑区 | 所有脑区（Thread 完成时清除） |
| `implicit` | 风险模式、危险行为历史 | Amygdala / DMN | Amygdala |

初始 `base_importance`：`episodic` = 0.3、`procedural` = 0.8、`semantic` = 0.6、`implicit` = 0.7。检索排序使用 `base_importance + recency_boost`（基于 `last_accessed_at` 动态计算）。详见 `02-memory-architecture.md`。

### 检索

当前：全文搜索（ILIKE），按 `base_importance DESC, last_accessed_at DESC` 排序。
演进方向：向量嵌入 + 语义相似度，两者并存后 RRF 融合重排。

### Episodic 与审计的分离

`episodic` 是认知衍生物——DMN 从 Event Bus 消费事件后写入的压缩表示，可以自由衰减和整理。外部审计系统直接订阅 Event Bus（`COMPLIANCE` 级），保证不可变的完整记录，不依赖 `episodic` 数据库记录。

**五种记忆类型的划分依据是访问模式，不是内容类型**：`episodic` 时序读取、`implicit` 每次工具执行前查、`procedural` Context Assembly 时加载、`working` 不持久化——四种不同的读写频率和检索策略，合并进同一接口会互相干扰。详见 `02-memory-architecture.md`。

### 实体模型与自我认知

AIMA 的 `semantic` 记忆以**实体**（entity）为基本单位对世界建模。实体分两个层级：

| 层级 | 归属 | 保留 `entity_type` 值 | 示例 |
|---|---|---|---|
| **AIMA 内部实体** | 框架定义 | `brain` / `skill` / `instance` | `brain:cortex`、`skill:procurement-approval`、`instance:self` |
| **应用层实体** | 上层应用定义 | 自由扩展 | 同事、供应商、内部系统、组织部门、其他 AIMA 实例 |

**大脑是实体**：每个脑区（Limbic/Cortex/Brainstem/Amygdala/DMN）在 `semantic` 记忆中有对应的实体记录。DMN 将观察到的脑区行为模式写入 `implicit` 记忆（如"Cortex 在多步数学任务上的可靠性较低"），使路由和风险评估能从自身历史中学习。这是 AIMA 元认知能力的底层机制。

**Skill 是实体**：每个 Skill 文件对应一个稳定的 `entity_id`（如 `skill:procurement-approval`）。Skill 实体（认知层）与 Skill 文件（操作层）分离：文件是 Agent 运行时读取的可执行知识，实体记录是 AIMA 对这个 Skill 的认知积累——使用历史、版本关系（`supersedes_ids`）、适用场景模式。DMN Consolidation 基于实体记录评估 Skill 的健康度和固化时机。

**实例自身是实体**：`entity_id = "instance:self"` 保留给实例的整体自我描述（能力边界、当前工作状态、已知局限）。

应用层在框架保留的三个 `entity_type` 值之外自由扩展，两者共存于同一记忆池，互不冲突。实体的具体属性模型（每类实体有哪些字段、关系）属于应用层定义，框架只提供 `entity_id` 和 `attribute` 两个索引字段。

### 涌现式文档结构

实例可通过 `create_document` 工具创建知识文件，结构不由系统预定义。`knowledge-index.md` 是唯一约束。

---

## 十、Context Assembly（面向五脑）

| Block | Limbic | Cortex | Brainstem |
|---|---|---|---|
| **身份** | 人格 + 人际关系 + 沟通风格 | 推理角色 + 当前任务 | 系统权限 + API 清单 |
| **Skill** | Skill Index + 固化/适配 Skill | 分析方法论 | 操作 Skill + 执行参数模板 |
| **状态** | 工作空间状态 + 待处理 Thread | 当前分析任务 + 中间结论 | 待执行队列 + 系统状态 |
| **记忆** | `semantic` + `episodic` | `semantic` + `procedural` | `implicit` + `procedural` |

Block 4 使用原始消息/任务描述作为检索 query，无结果时省略。

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

## 十一、Runtime 边界

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
│  │  pre-exec   │    │  Reactive | Consolidation   │          │
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
