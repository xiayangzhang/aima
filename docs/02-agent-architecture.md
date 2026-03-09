# AIMA 架构设计

> **AIMA** = Artificial Intelligence: A Minded Architecture — 认知个体的核心框架
> **版本**: 3.0
> **状态**: 当前权威文档
> **上层应用**: secondfirst/employee（虚拟员工产品）基于 AIMA 构建

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

| 脑区 | 神经科学对应 | 职责 | 模型 |
|---|---|---|---|
| **Limbic** | 古哺乳脑 / 边缘系统 | 双向人类接口、社交、关系、对外人格 | Sonnet |
| **Cortex** | 新哺乳脑 / 新皮层 | 推理、规划、抽象、复杂判断 | Opus |
| **Brainstem** | 爬行脑 / 脑干 | 双向系统接口、执行、指令翻译 | Haiku |
| **Amygdala** | 杏仁核 | 执行前风险中断 | 规则优先 / Haiku 降级 |
| **DMN** | 默认模式网络 | 内省、纠错、预测、记忆管理 | Haiku |

### Limbic（古哺乳脑）
- 所有来自人类协作者的输入首先进入 Limbic；所有发向人类的输出由 Limbic 发出
- 维护关系上下文、语气调节、沟通节奏
- 判断当前输入是否需要 Cortex 参与，或直接调用 Brainstem 完成简单操作

### Cortex（新哺乳脑）
- 纯内部推理引擎，不直接与人类或系统交互
- 负责复杂任务的分解、规划、判断和研究
- 推理结果写入工作空间，由 Limbic 或 Brainstem 取用

### Brainstem（爬行脑）
- **系统输入**：监听系统事件（Webhook、Dataverse 变更、定时触发）
- **系统输出**：将抽象指令翻译为具体操作参数并执行（API 调用、CRUD、文件操作）
- 核心能力是**翻译**——将高层意图转化为精确的执行参数

### 两个接口原则

```
人类协作者 ←→ Limbic ←→ [认知工作空间] ←→ Cortex
                               ↕
系统 / 平台  ←→ Brainstem ←──────────────────┘
```

> **待讨论**：当系统 Hook 触发（无人类发起）时，Brainstem 收到事件后的激活路径

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

- Audit 系统：订阅 `COMPLIANCE` + `ALERT` → 写入 WORM
- 可观测性系统：订阅 `INFO` → OTel Span
- HR Alex：订阅 `ALERT`

AIMA 只保证事件的结构化发射，不关心谁在消费。

---

## 四、认知工作空间

### 模型：Thread + Slot

工作空间是 AIMA 实例内部的共享状态，支持多任务并行。

```
Workspace
├── session_id
├── threads[]              // 并行任务线程
│   ├── thread_id
│   ├── trigger            // 触发本线程的事件（人类输入 / 系统事件 / DMN 通知）
│   ├── priority           // 用于脑区在多 Thread 时决定处理顺序
│   ├── state              // active | waiting | complete | interrupted
│   └── slots              // 各脑区的输入/输出槽
│       ├── limbic:    { input, output, status }
│       ├── cortex:    { input, output, status }
│       ├── brainstem: { input, output, status }
│       └── ...
└── signals[]              // 横切信号（不属于任何 Thread）
    ├── Amygdala 中断信号
    └── DMN 纠错 / 预测通知
```

### 激活机制

每个脑区有一组**激活条件**——当工作空间中出现满足条件的状态时，脑区自行决定介入：

- **Limbic** 激活条件：有新的人类输入（任意 Thread），或 Cortex 输出了需要对外表达的内容
- **Cortex** 激活条件：Limbic Slot 写入了"需要推理"的标记，且 Cortex Slot 为空
- **Brainstem** 激活条件：Cortex 或 Limbic 的 Slot 包含具体操作指令，或有新的系统事件

各脑区读取自己关心的 Slot，处理后将结果写回对应 Slot，触发下一个脑区激活。这是**认知接力**而非显式委派。

### 信号优先级

Signals（横切信号）优先于 Thread 内的正常流程：
1. Amygdala 中断信号 → 立即停止当前 Brainstem 操作
2. DMN 纠错通知 → 中断当前 Thread，写入新的纠错 Thread
3. DMN 预测通知 → 插入新 Thread，优先级可配置

---

## 五、并行工作

AIMA 支持三个层级的并行：

### Level 1：Brain 级并行
不同脑区可同时处理不同 Thread：
- Cortex 在分析 Thread-A 的复杂问题
- Brainstem 同时在执行 Thread-B 的 API 调用
- Limbic 正在等待 Thread-C 的人类回复

各脑区的并发由工作空间中各自的 Slot 独立管理，互不阻塞。

### Level 2：Thread 级并行
一个 AIMA 实例可同时维护多个活跃 Thread：
- 同时处理来自不同协作者的消息
- 主线程等待人类回复时，后台 Thread 可预处理相关资料
- DMN 心跳作为独立 Thread 持续运行

Thread 数量上限是配置项，默认建议值待实测确定。

### Level 3：Instance 级并行
当任务真正独立、需要深度并行时，可以临时生成**子 AIMA 实例**：
- 子实例有完整五脑结构
- 与父实例共享同一记忆池（通过 `parent_session_id` 标签隔离 working 记忆）
- 子实例完成后，结果写回父实例的工作空间，子实例销毁
- 这不是义体——义体是永久扩展，子实例是临时计算分支

> **注**：子实例类似 Spacebot 的 Branch 模式（context.clone() → 独立运行 → 结果写回），但在 AIMA 架构中以完整实例而非 context 副本实现。

---

## 六、Amygdala（杏仁核）

执行前同步中断，速度优先于深度。

- 订阅 Event Bus 上的 `tool.pre_use` 事件
- **规则优先**：确定性规则（正则、金额阈值、黑名单）零 LLM 成本
- **Haiku 降级**：规则无法覆盖时快速评估
- 违规时向工作空间写入中断 Signal，优先级最高

### 与 DMN 的明确区分

| | Amygdala | DMN |
|---|---|---|
| 时序 | 执行**前**（pre-execution） | 执行**后**（post-action） |
| 性质 | 同步阻断 | 异步回顾 |
| 功能 | "这个不能做" | "刚才做错了" / "接下来应该做" |
| 触发 | `tool.pre_use` 事件 | Action Log（`INFO`+）+ 心跳 |

---

## 七、DMN（默认模式网络）

DMN 是 AIMA 的唯一主动性来源，三个核心脑区（Limbic / Cortex / Brainstem）是纯被动的。

### 触发源
1. **Event Bus 订阅触发**：`INFO` 级及以上事件写入 → 触发短期评估
2. **心跳触发**：定期唤醒 → 长期记忆整理 + 跨 Session 跟进

### 两大功能

**回溯纠错（优先）**：读取最新 Action Log 条目，判断是否有误。如需纠错，向工作空间写入中断 Signal，向对应脑区发出纠错通知。

**前瞻预测**：基于 Action Log 历史预测接下来需要的行为。无预测则跳过。

### Skill 生命周期管理（DMN 长期模式）
- 监控 Skill 使用频率和稳定性，触发固化流程
- 监控 Skill 有效性，发现失效时触发 Cortex 重新学习
- 生成 Memory Bulletin，注入下次 Session 的系统提示词

### Cache 效率
Event Bus 输出增量追加到 Action Log，DMN 每次调用只读取最新增量，历史已缓存。Session 越长，cache hit rate 越高。

---

## 八、习惯形成与技能内化

### Skill 三层分类

| 类型 | 来源 | 可修改 | 说明 |
|---|---|---|---|
| `reference` | 外部提供（Cloudflare、Vercel、TDP Hub 文档等） | 否 | 只读参考书，外部方维护和更新 |
| `adapted` | Alex 基于 `reference` 改编 | 是 | 保留对原始 `reference` 的引用，融入 Alex 自己的上下文和习惯 |
| `first-party` | Alex 从实践中生成 | 是 | 纯 Alex 经验，无外部来源 |

**学习原则**：对着菜谱做菜，而非照单全收。`adapted` Skill 保留菜谱引用，但加入了 Alex 自己的调味理解。外部 Skill 更新时，DMN 通知 Cortex 评估是否需要更新 `adapted` 版本。

### 技能模式

**泛化技能**（Generalizable Skill）
- 新任务首次出现 → Cortex 推理 → 提取可复用模式 → 写入 `adapted` 或 `first-party` Skill 文件
- Skill 是抽象的、参数化的，适用于同类任务的不同实例

**固化技能**（Consolidated Skill）
- Skill 重复使用 N 次且内容稳定 → DMN 判断已成熟 → 固化为更具体的操作映射
- 固化后直接由 Brainstem 执行，Cortex 退出该流程

### Skill 生命周期
```
外部 reference Skill ──→ Cortex 学习 ──→ adapted Skill
                                           ↕ 多次使用
新任务经验 ──→ Cortex 推理 ──→ first-party Skill
                                     ↕ 稳定后
                              DMN 固化 ──→ 直接执行
                                     ↕ 失效时
                              DMN 检测 ──→ Cortex 重新学习
```

> **待讨论**：`adapted` 和 `first-party` Skill 是否可在不同 Alex 实例间共享，以及共享的边界

---

## 九、记忆架构

### 统一记忆模型

五个脑区使用同一记忆池，通过 `partition_id` 和 `type` 区分用途。

### 记忆类型

| 类型 | 内容 | 主要写入方 | 主要读取方 |
|---|---|---|---|
| `semantic` | 事实、实体、关系（人、组织、系统、项目） | Limbic / Cortex | Limbic / Cortex |
| `episodic` | 发生过的事件序列（= Action Log） | Event Bus → DMN | DMN / Amygdala |
| `procedural` | Skill 化的流程模式 | Cortex | Limbic / Brainstem |
| `working` | 当前 Session 的临时状态 | 所有脑区 | 所有脑区（Session 结束清除） |
| `implicit` | 风险模式、危险行为历史 | Amygdala | Amygdala |

### 写入

每条记忆记录包含：`type`、`content`、`partition_id`、`importance`（初始值）、`source`（哪个脑区写的）、`session_id`、`expires_at`（可选）。

Importance 初始值：`episodic` = 0.3（高频低价值）、`procedural` = 0.8（Skill 是核心知识）、`semantic` = 0.6、`implicit` = 0.7。

### 读取与检索

当前实现：**全文搜索（ILIKE）**，按 importance DESC + created_at DESC 排序，返回 top-N 条渲染为 Markdown。

待演进方向：引入向量嵌入，实现语义相似度检索，替代纯关键词匹配。两者可并存，重排序后融合结果。

### Episodic 作为 Action Log

Event Bus 上的 `INFO` 级及以上事件由 DMN 消费，写入 `episodic` 记忆。这使得 Action Log、Memory 和审计原始数据统一为同一张表。外部审计系统直接消费 Event Bus（`COMPLIANCE` 级），不依赖数据库中的 `episodic` 记录。

### 涌现式文档结构

Alex 可通过 `create_document` 工具创建自己的知识文件，文件结构不由系统预定义。`knowledge-index.md` 是唯一约束：Alex 自建的所有文件必须在此索引。

---

## 十、Context Assembly（面向五脑）

各脑区的系统提示词组装策略不同，反映各脑的信息需求：

| Block | Limbic | Cortex | Brainstem |
|---|---|---|---|
| **身份** | Alex 人格 + 人际关系 + 沟通风格 | 推理角色 + 当前任务上下文 | 系统权限 + 可用 API 清单 |
| **Skill** | Skill Index + 固化/适配 Skill | 分析方法论 + 研究 Skill | 操作 Skill + 执行参数模板 |
| **状态** | 工作空间状态 + 待处理 Thread 列表 | 当前分析任务 + 中间结论 | 待执行指令队列 + 系统状态 |
| **记忆** | `semantic`（关系）+ `episodic`（近期互动） | `semantic`（领域知识）+ `procedural`（过往推理） | `implicit`（风险模式）+ `procedural`（操作序列） |

Block 4（记忆）使用原始消息/任务描述作为检索 query，无结果时省略整块。

---

## 十一、义体（Augmentations）

五个脑区是 AIMA 的固定核心。按业务需要可加装**义体**——额外的专职脑区，扩展能力边界但不改变核心架构。

**义体特征**：
- 有明确的激活条件（只在特定场景介入）
- 通过认知工作空间与核心脑区交互
- 也发射 Event Bus 事件（可被 Amygdala / DMN / 外部系统订阅）

**义体 vs 子实例**：
- 义体是**永久扩展**，随 AIMA 实例生命周期存在
- 子实例是**临时计算分支**，完成即销毁

---

## 十二、HR 作为外部 AIMA

HR 不是特殊接口，它是另一个 AIMA 实例——运行在独立 Runtime，订阅多个目标实例的 Event Bus（`ALERT` 级）。

HR AIMA 的脑区配置：
- **更强的 Amygdala**：对跨机构行为敏感
- **受限 Brainstem**：不操作业务系统，只通过管理 API 调整目标 AIMA 实例状态
- **Limbic 对接人类管理者**

---

## 十三、Runtime 边界

```
┌─────────────────────────────────── AIMA 实例（如 Alex） ────┐
│                                                               │
│  ┌─────────┐  ┌─────────┐  ┌───────────┐                    │
│  │ Limbic  │  │ Cortex  │  │ Brainstem │  [义体（可选）]     │
│  └────┬────┘  └────┬────┘  └─────┬─────┘                    │
│       │            │             │                            │
│       └────────────┴─────────────┘                           │
│                    │                                          │
│          ┌─────────▼──────────┐                              │
│          │   认知工作空间      │  ← Threads + Slots + Signals │
│          └─────────┬──────────┘                              │
│                    │                                          │
│         ┌──────────┴──────────┐                              │
│         │                     │                              │
│  ┌──────▼──────┐    ┌─────────▼───┐                         │
│  │  Amygdala   │    │     DMN     │                         │
│  └─────────────┘    └─────────────┘                         │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Brain Event Bus（事件总线 / 脑机接口）               │    │
│  │  TRACE / DEBUG / INFO / COMPLIANCE / ALERT           │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  记忆池（PostgreSQL）                                 │    │
│  │  semantic / episodic / procedural / working / implicit│    │
│  └──────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────┘

外部：
  HR AIMA（跨 Runtime，订阅 ALERT）
  Audit 系统（订阅 COMPLIANCE + ALERT → WORM）
  可观测性系统（订阅 INFO → OTel）
```
