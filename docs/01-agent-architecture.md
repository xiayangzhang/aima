# AIMA 架构设计

> **AIMA** = Artificial Intelligence: A Minded Architecture — 认知个体的核心框架
> **版本**: 3.2
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

---

## 一、核心设计哲学

### AIMA 实例是最小认知个体

一个 AIMA 实例（如 Alex）是系统的最小可运行单元——一个完整的认知个体，有自己的职责、记忆和工作风格。它在组织中扮演什么角色是配置层的事，不是架构层的定义。架构中没有"用户"这个概念。

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

### Cortex — Planner + Reasoner
- 纯内部推理引擎，不直接与人类或系统交互
- 负责复杂任务的分解、规划、判断和研究
- 推理完成后，在 Cortex Slot 的 `intent` 字段标记结果归属：
  - `"communicate"` → Limbic 激活，组织对外表达
  - `"execute"` → Brainstem 激活，执行具体操作
  - `"both"` → 两者均激活

### Brainstem — Executor + System Interface
- **系统输入**：监听系统事件（Webhook、Dataverse 变更、定时触发）
- **系统输出**：将抽象指令翻译为具体操作参数并执行（API 调用、CRUD、文件操作）
- **规则路由**（非 LLM）：收到系统事件后，用配置化规则判断处理方式：
  - 已知事件类型 → Brainstem 直接处理
  - 复杂 / 未知事件 → 写入工作空间并标记 `"needs_analysis"` → Cortex 激活
- 规则路由保持确定性和低延迟，与 Limbic 的 LLM 判断形成对称但不对等的设计

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

---

## 四、认知工作空间

### 模型：Thread + Slot

工作空间是 AIMA 实例内部的共享状态，支持多任务并行。

```
Workspace
├── session_id
├── threads[]
│   ├── thread_id
│   ├── trigger            // 触发事件（人类输入 / 系统事件 / DMN 通知）
│   ├── priority
│   ├── state              // active | waiting | complete | interrupted
│   └── slots
│       ├── limbic:    { input, output, status }
│       ├── cortex:    { input, output, status, intent }   // intent: communicate|execute|both
│       ├── brainstem: { input, output, status }
│       └── ...
└── signals[]              // 横切信号（优先于任何 Thread）
    ├── Amygdala 中断信号
    └── DMN 纠错 / 预测通知
```

### 激活机制

每个脑区有一组**激活条件**，当工作空间出现满足条件的状态时，脑区自行介入：

- **Limbic**：有新的人类输入，或 Cortex Slot 的 `intent` 包含 `"communicate"`
- **Cortex**：Limbic 或 Brainstem Slot 写入了 `"needs_analysis"` 标记，且 Cortex Slot 为空
- **Brainstem**：Cortex Slot 的 `intent` 包含 `"execute"`，或 Limbic Slot 包含直接操作指令，或收到新系统事件

各脑区读取自己关心的 Slot，处理后写回结果，触发下一个脑区激活。

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

### Level 2：Instance 级并行（原 Level 3）

### Level 3：Instance 级并行
当任务真正独立、需要深度并行时，可以临时生成**子 AIMA 实例**：
- 子实例有完整五脑结构
- 与父实例共享同一记忆池（通过 `parent_session_id` 标签隔离 `working` 记忆）
- 子实例完成后，结果写回父实例的工作空间，子实例销毁
- 义体是永久扩展，子实例是临时计算分支，两者不同

---

## 六、Amygdala（杏仁核）

执行前同步中断，速度优先于深度。职责边界清晰：**只拦截工具调用层面的风险**，不涉及决策/推理层面的错误（后者归 DMN）。

- 订阅 Event Bus 上的 `tool.pre_use` 事件
- **规则优先**：确定性规则（正则、金额阈值、黑名单）零 LLM 成本
- **Haiku 降级**：规则无法覆盖时快速评估
- 违规时向工作空间写入中断 Signal，优先级最高
- 发现新风险模式时，写入 `implicit` 记忆（供未来检测）

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

DMN 运行在两个截然不同的模式下：

### 模式一：Reactive（Event Bus 触发）

**触发**：`INFO` 级及以上事件写入 → 毫秒级响应

**职责**（按优先级）：
1. **错误恢复**：脑区遇到 LLM 调用失败或工具执行错误时，发射 `ALERT` 事件 → DMN 立即介入，决策重试、换策略、还是上报。具体：
   - 可重试错误（超时、限流）→ 写入 retry 指令到对应 Thread Slot
   - 不可重试错误（权限拒绝、数据异常）→ 标记 Thread 为 `interrupted`，发射 `ALERT` 供外部处理
2. **回溯纠错**：读取最新 Action Log，判断刚刚发生的行为是否有误；如需纠错，向工作空间写入中断 Signal
3. **前瞻预测**：基于近期 Action Log 预测接下来需要的行为，无预测则跳过

**资源消耗**：轻量，每次只读最新增量（历史已缓存，cache hit rate 随 Session 增长趋近 100%）

### 模式二：Consolidation（心跳触发）

**触发**：定期心跳（分钟/小时级）

**职责**：
1. **Skill 生命周期**：监控使用频率，触发固化；检测失效，触发 Cortex 重新学习
2. **记忆整理**：清理过期 `episodic`，调整 importance 权重，生成 Memory Bulletin
3. **跨 Session 跟进**：检查上一 Session 未完成的 Thread

**资源消耗**：较重，批量处理，低优先级，不与 Reactive 模式竞争资源

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
| `working` | 当前 Session 临时状态 | 所有脑区 | 所有脑区（Session 结束清除） |
| `implicit` | 风险模式、危险行为历史 | Amygdala / DMN | Amygdala |

Importance 初始值：`episodic` = 0.3、`procedural` = 0.8、`semantic` = 0.6、`implicit` = 0.7。

### 检索

当前：全文搜索（ILIKE），按 importance DESC + created_at DESC 排序。
演进方向：向量嵌入 + 语义相似度，两者并存后融合重排。

### Episodic = Action Log = 审计原始数据

`INFO` 级及以上 Event Bus 事件由 DMN 写入 `episodic`。外部审计系统直接订阅 Event Bus（`COMPLIANCE` 级），不依赖数据库记录。

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

---

## 十一、义体（Augmentations）

五个脑区是固定核心。按需加装**义体**——额外专职脑区，扩展能力边界但不改变核心架构。

- 有明确激活条件，只在特定场景介入
- 通过认知工作空间交互，也发射 Event Bus 事件
- 义体是永久扩展；子实例是临时计算分支——两者不同

---

## 十二、Runtime 边界

```
┌─────────────────────────────────── AIMA 实例 ───────────────┐
│                                                               │
│  ┌─────────┐  ┌─────────┐  ┌───────────┐  [义体（可选）]    │
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
