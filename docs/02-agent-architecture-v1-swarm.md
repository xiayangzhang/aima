# Agent 架构文档（已归档 — v1 Swarm 设计）

> **[已过时 — 见 docs/02-agent-architecture.md v2.0 三重脑架构]**
> **归档日期**: 2026-03-09
> **原范围**：认知分区 Swarm 设计、框架选型、业务逻辑原则、记忆架构
> **平台集成、安全合规、部署运维**见 `docs/08-platform-integration.md`

## 1. 系统架构概览

### 设计理念

虚拟员工平台将**做什么**（业务流程逻辑）与**如何思考**（LLM推理）与**如何执行**（系统集成）分离。这种分离确保：

- 业务逻辑在 LLM 供应商变更时仍然存续
- 集成层可以适应 API 变更而不影响业务规则
- LLM 只处理它擅长的事：判断、沟通、歧义消解

### 分层架构

```
+-----------------------------------------------------+
|  CHANNEL ADAPTER LAYER                               |
|  Email (Graph) | Teams (M365 Agents SDK) |           |
|  Dataverse Webhook | SharePoint                      |
|  → 统一事件格式 (CloudEvents) → Event Grid/Bus        |
+-----------------------------------------------------+
|  COGNITIVE PARTITION SWARM（对等分区网络）              |
|  无固定指挥链；任何分区可委派其他分区                     |
|                                                     |
|  ┌──────────┐  ┌──────────┐  ┌─────────────┐       |
|  │ Analyst  │  │ Executor │  │Communicator │       |
|  │ /Sonnet  │  │ /Sonnet  │  │   /Sonnet   │       |
|  └──────────┘  └──────────┘  └─────────────┘       |
|  ┌──────────┐  ┌──────────┐                         |
|  │ Planner  │  │ Auditor  │ （按需激活 / 每工具后触发）  |
|  │  /Opus   │  │  /Haiku  │                         |
|  └──────────┘  └──────────┘                         |
|                                                     |
|  入口分区由事件类型决定；记忆（PostgreSQL → Markdown）共享 |
+-----------------------------------------------------+
|  AGENT RUNTIME (pi-agent-core + pi-ai)               |
|  Agent Loop | Tool Execution | 4 Hooks               |
|  transformContext | getSteeringMessages | ...         |
+-----------------------------------------------------+
|  SKILL / TOOL LAYER (可插拔 + MCP)                    |
|  Dataverse CRUD | Graph API | Power Automate         |
|  Email | Teams | Calendar | SharePoint               |
+-----------------------------------------------------+
|  AUDIT & OBSERVABILITY LAYER（双层）                   |
|  Inboard Hook（硬底线） + Outboard Audit Service       |
|  → PostgreSQL（热）+ Immutable Blob（冷）+ Ledger      |
+-----------------------------------------------------+
|  LLM PROVIDER (pi-ai — 23 providers)                 |
|  Anthropic | OpenAI | Google | Azure OpenAI          |
|  AWS Bedrock | Mistral | 自托管                       |
+-----------------------------------------------------+
```

### 核心架构理念：认知分区 Swarm

一个虚拟员工 = 一个 Agent Swarm，**对等分区模型**（非团队，非 MoE/Coordinator 编排）：

```
虚拟员工 "Alex"（对外是单一实体）
  ├── Analyst（内部名）   — 数据读取、规律分析、合规核查 / Sonnet
  ├── Executor（内部名）  — 系统操作、状态更新、工具执行 / Sonnet
  ├── Communicator（对外）— 邮件、Teams 消息、统一对外输出 / Sonnet
  ├── Planner（内部名）   — 复杂任务规划、风险判断（按需激活）/ Opus
  └── Auditor（内部名）   — 合规验证、操作后核查（每工具后触发）/ Haiku

分区间共享：组织记忆（PostgreSQL → Markdown 只读层）+ 规则 + 共识
分区各自有：专项经验记忆 + 内部名（便于日志调试）
```

**设计哲学：治理而非约束 — "新员工"模型**

我们的目标是替代员工，不是构建程序。类比真实的员工入职：
- 给新员工目标和公司政策，不给每个任务的操作手册
- 不确定时主动与同事确认（Agent 的升级机制）
- 所有沟通和决策可被观察（审计 trail）
- 犯了错误：通过观察发现、纠正、必要时清理记忆 — 与管理真人员工一样
- **不可逆决策（批准大额合同、签署法律文件）本来就不是初级员工的职责** — 也不是我们的目标替代层级

**合规论点：** 虚拟员工的每个操作都有完整记录、可回溯、可 revert（可逆操作）。真人员工的出错率（尤其是实习生/新员工）并不低，但出错后追溯困难。如果我们能达到"有经验实习生"级别的准确率，叠加完整审计能力，实际合规风险**低于**无约束的真人员工。

**面对政府审计员的辩护框架：**

审计员的核心诉求是"可证明合规"，而非"确定性代码"。我们的回应分四层：

1. **分层确定性**：硬规则（PII、金额阈值、操作日志）是确定性代码，可现场跑单元测试演示。LLM 只处理人类员工也在用判断做的事（评估上下文、决定是否升级）——这部分本来就不存在"确定性"。
2. **透明度倒置**：传统软件只记录输入和输出。Alex 的每一步决策都有完整推理链写入不可篡改日志。审计员能看到 Alex 为什么批准某个 PO——这比审计人类员工的决策过程透明得多。
3. **Skill 文档作为政策制品**：Skill 文档版本控制、经审批流程、可提交审计员正式审查。Agent 读的是审计员事先批准的规则文本，变更需走变更管理流程。
4. **执行后合规验证门**：Auditor 分区作为确定性后置检查——每次 Agent 行动后，代码层验证是否违反任何硬规则，违反则拒绝并告警。LLM 判断 + 代码合规后门，两层保障。

**核心论点**：我们不声称"系统总是做 X"，我们声称"每个决策都有完整记录、每个硬规则都有代码保障、可审计程度超越人类员工"。这是政府合规的正确论述框架。

硬底线（仅限这 3 项）：
- PII 保护 — 代码层强制，任何 Agent 不可覆盖
- 金额阈值上限 — 代码层强制（如单次操作 >$10K 必须升级人工）
- 操作日志 — Outboard 强制写入，失败则拒绝执行

**模型分层（成本控制）：**
- 不需要单独的 Smart Router 组件 — 不同认知分区直接指定不同模型
  - 规划脑：Opus（深度推理）
  - 执行脑/分析脑/沟通脑：Sonnet（效率均衡）
  - 审计脑/快速探索：Haiku（低成本）
- 工作日高负载（保活策略：每 4 分钟 Haiku ping 维持 cache TTL，成本可忽略）/ 非工作时间低功耗待命
- 精算 LLM 成本：**$130-230/agent/月**（1 小时 cache，30 任务/天，Opus 含自身前缀 cache）；总 COGS 含基础设施约 **$245-425 USD/月/agent**（见 `docs/01-business-strategy.md` 单位经济）
- 整体平台预算 $2-3K/月，支持 5-10 个并发虚拟员工

**Prompt Cache 策略（成本关键）：**

不同模型**不共享** cache（各自独立缓存桶）；同一模型在同一 **workspace** 内，相同前缀内容可跨 session 共享 cache。

> **重要**：2026-02-05 起，cache 隔离范围从 org 级别收窄为 **workspace 级别**（Claude API + Azure AI Foundry）。AWS Bedrock / Google Vertex AI 维持 org 级别。每个客户租户 = 一个 workspace，对我们的多租户设计无影响。

```
最优前缀结构（每个认知分区 API 调用）：
  [Block 1: 组织/角色 context 4K] ← cache_control 断点（workspace 内跨 session 共享）
  [Block 2: 分区专属 prompt 2K]   ← 不缓存（各分区唯一）
  [Block 3: 动态 context]         ← 不缓存（任务数据、历史）
```

- Sonnet 分区（Analyst/Executor/Communicator）之间**能共享** workspace 前缀 cache
- Planner（Opus）有自己独立的 cache 桶，与 Sonnet 不共享，但自身跨 session 可命中
- 推荐使用 **1 小时扩展 TTL**（2x write，0.1x read），适合任务间隔 >5 分钟的场景
- Cron/维护任务使用 **Batch API**（50% 折扣）

**关键设计决策：**
- **不使用固定编排**（如 LangGraph/CrewAI），而是动态自适应
- **新岗位入职包**：YAML/MD 配置 + 入职文件复制，或硬编码入职流程 — 具体形式待原型验证
- **只有审计基础设施是确定性代码**（硬底线：PII/金额/操作日志），其余信任 Agent
- **每个认知分区有各自内部名和专项经验**，便于定位调试；所有分区共享组织记忆
- **Shadow Mode 支持**：Executor 分区禁用，Agent 只观察 + 输出判断；差异经人工标注后才进入记忆。详见 `docs/09-shadow-mode.md`

---

## 2. Agent 框架选型

详细评估见：`research/architecture/14-microsoft-agent-framework-evaluation.md`、`research/architecture/17-pi-mono-ecosystem-update.md`、`research/architecture/18-claude-agent-sdk-ecosystem.md`

**✅ 已决定（2026-03-07）：方案 A — pi-mono（pi-ai + pi-agent-core）+ 自研编排层**

排除方案 D/E — 完整归档见 `docs/archive/excluded-frameworks.md`。

---

### 方案 A：pi-mono-like 架构（已选定）

| 组件 | TypeScript 选项 | 备注 |
|------|---------------|------|
| LLM 抽象 | pi-ai（23 providers，MIT） | 多供应商，关键需求 |
| Agent Loop | pi-agent-core（4 hooks） | 轻量、可控 |
| 编排层 | 自研 | 多认知分区协调、记忆、任务生命周期 |

**Rust 评估结论**：维持 TypeScript。Rust 可选做 MCP Server 性能优化层（性能 16x，内存 50x），Runtime 不变。详见 `research/architecture/21-rust-agent-frameworks.md`。

**pi-agent-core 的 4 个 hooks 映射：**
- `transformContext` — 注入组织记忆 + 分区专项经验 + 规则
- `convertToLlm` — 多 Provider 适配（pi-ai 处理）
- `getSteeringMessages` — 实时治理事件注入（合规触发器、人工升级）
- `getFollowUpMessages` — 异步任务排队（Reflexion 学习循环）

**优势**：多 LLM 支持、完全可控、MIT 开源
**风险**：编排层需要自研；`getSteeringMessages` 在工具执行后触发，无原生 PreToolUse — 通过 MCP Proxy 层缓解（见 `docs/08-platform-integration.md` Audit 章节）

### 从 OpenClaw 生态借鉴

- **Skill 选择性注入**：运行时按需发现注入，不全塞进 prompt
- **ChannelPlugin 组合式接口**：20+ 可选 adapter，泛型类型安全
- **7 层优先级路由引擎**：`resolveAgentRoute()` 设计模式

**不采用 OpenClaw 本身**（安全问题：CVE-2026-25253 RCE 漏洞，不适合企业级）

---

## 3. 业务流程引擎（核心 IP）

### 角色定义结构

```
VirtualEmployeeRole
  |-- name: "Purchase Order Approver"
  |-- domain: "procurement"
  |-- capabilities: [approve_po, reject_po, request_info, escalate]
  |
  |-- WorkflowRules[]
  |     |-- trigger: "new_po_submitted"
  |     |-- conditions: [amount < threshold, supplier_approved, budget_available]
  |     |-- actions: [auto_approve, route_to_manager, flag_for_review]
  |     |-- escalation: {timeout: 4h, escalate_to: "human_supervisor"}
  |
  |-- ComplianceRules[]
  |     |-- rule: "dual_approval_required_above_50k"
  |     |-- enforcement: "hard" (不可被 LLM 覆盖)
  |
  |-- CommunicationTemplates[]
        |-- scenario: "requesting_additional_info"
        |-- tone: "professional_government"
        |-- required_fields: [reference_number, deadline, contact]
```

### 关键原则：只有 Auditing 是代码，其余用 Skill 实现

| 关注点 | 实现方式 | 原因 |
|--------|---------|------|
| **操作日志** | **代码（确定性）** | 审计记录必须不可绕过、不可篡改 |
| **PII 保护** | **代码（基础设施层）** | 硬底线，任何 Agent 不能覆盖 |
| **金额上限** | **代码（基础设施层）** | 政府合规要求，不可 LLM 决策 |
| 审批规则 | Skill（结构化定义） | Agent 读取 skill 理解规则，灵活可配 |
| 合规检查 | Skill（规则文档） | 合规策略以自然语言/结构化描述，Agent 自行应用 |
| 升级路径 | Skill（升级策略） | 描述升级条件，由 Agent 判断是否满足 |
| 数据验证 | Skill（Schema 说明） | Agent 理解 schema 做验证，异常时询问澄清 |
| 沟通风格 | Skill（语气模板） | 自然语言是 Agent 的强项 |
| 异常处理 | Agent 自主判断 | 给 Agent 目标和政策，它自行决定如何处理 |

**架构含义：**
- 代码量大幅减少（只维护 audit 基础设施）
- 新业务规则 = 新 Skill，无需改代码
- Agent 会犯错，但错误可通过 audit 发现，而不是通过复杂规则引擎预防

---

## 4. 记忆架构（两层设计）

详细设计见 `research/architecture/22-orchestration-layer-design.md`（第 3 节）。

### 两层设计原则

```
READ LAYER（只读，Agent 从这里消费）
  partitions/{partition_name}/experience.md
  partitions/{partition_name}/diary.md
  shared/team_rules.md
  shared/process_patterns.md
  ↑ 由渲染管道从 WRITE LAYER 按需生成（写入触发 + 周期维护），Agent 不能直接修改

WRITE LAYER（结构化存储，写入目标）
  PostgreSQL memories 表
  ↑ 两个写入来源：行为系统自动写 + Agent 主动写入
```

**为什么不直接用 Markdown 写入**：写入有 Schema 验证（防格式错误）、可机器查询（SQL 过滤、重要性排序）、可清理（过期/矛盾检测）、可追溯（task_id、source 字段）。

### 记忆类型

> **原始设计（保留供参考）**：下方为初版类型体系，在原型验证前不删除，因其包含尚未在 research/ 记录的领域设计考量。

| 类型 | 描述 | 归属 | 典型过期 |
|------|------|------|---------|
| `entity_knowledge` | 供应商、项目、人的事实 | shared | 无 |
| `process_pattern` | 工作流中观察到的规律 | shared | 无 |
| `exception_playbook` | 特定异常的处理方案 | shared | 1 年 |
| `stakeholder_profile` | 沟通对象的偏好和风格 | shared | 无 |
| `team_consensus` | 分区间达成的共识 | shared | 无 |
| `task_reflection` | 单次任务的反思和学习 | partition | 6 个月 |
| `critical_lesson` | 已知重大错误的防范规则（最高权重，永久）— 具体涌现机制待原型验证 | shared | 无 |
| `rule` | 组织规则/政策 | shared | 无（只读） |

**更新（2026-03-08）：原型阶段简化类型体系**

从 8 种精简为 4 种起步，避免过度设计——类型在实际使用中涌现：

| 类型 | importance 默认值 | 说明 | 原类型对应 |
|------|-----------------|------|-----------|
| `entity` | 0.6 | 供应商/项目/合同的客观事实 | entity_knowledge |
| `process` | 0.8 | 工作流规律 + 例外处理方案 | process_pattern + exception_playbook |
| `stakeholder` | 0.7 | 人的偏好、权限、沟通风格 | stakeholder_profile |
| `event` | 0.3（可覆盖） | 发生过的事，重要事件可手动打高分 | task_reflection 部分 |

暂缓加入（待原型验证后按需引入）：`identity`、`goal`、`decision`（来自 Spacebot，适合自我模型）

类型合并决策：
- `exception_playbook` → `process`（本质是流程知识的一种）
- `team_consensus` → `decision`（用 partition_id 字段区分分区级 vs 全局）
- `task_reflection` → `event`（行为系统自动写入）+ Agent Reflexion 时主动写 `process`
- `critical_lesson` → `process`（importance 手动设为 1.0）
- `rule` → **Skill 文件**（不进记忆库，静态知识由 Skill 层管理）

> 详见 `research/architecture/24-agent-loop-design-reference.md` Section 18.2

### 写入来源

**行为系统自动写入**（代码层，无额外 LLM）：任务完成 → `task_reflection`；异常发生 → `exception_playbook`；人工升级 → 升级原因 + 经理决策；首次遇到实体 → `entity_knowledge`。

**Agent 主动写入**：Agent 在 Reflexion 步骤中**主动调用** `memory_write` 工具，记录自己观察到的规律、修正旧记忆，或在任务中途判断某个发现值得保留。这不是工具执行时的自动副作用，而是 Agent 有意识的记录行为。

### Memory Agent（周期维护）

使用 Batch API（50% 折扣）独立运行：每日夜间清理过期记忆 + 重要性衰减；每周将多条 `task_reflection` 提炼为 `process_pattern` + 重新渲染 Markdown。

### Context 策略

**不压缩，不用摘要替换原文**。通过精准的记忆筛选控制注入量（按 entities/tags 过滤 + importance × recency 排序），而非压缩 context 本身。能力上限比 token 成本更重要。

---

## 5. HR Agent（行为监察，独立于虚拟员工）

**已验证模式**（来自 OpenClaw 实践）。

HR Agent 是独立运行的监察 Agent，不参与任何业务工作流执行，专职观察虚拟员工的行为模式：

- **跨任务行为分析**：识别某类任务的系统性错误、决策偏差、升级率异常
- **绩效评估**：生成虚拟员工的"绩效报告"（自主率趋势、错误类型分布、学习速度）
- **记忆质量审查**：检测记忆库中低质量/矛盾条目，提出更新建议
- **Manager 辅助**：将原始 audit 日志翻译为"员工行为摘要"，管理层无需看日志

```
HR Agent（独立进程，Batch API）
  输入：audit 日志 + memories 表 + task_reflection 记录
  输出：绩效摘要 MD / 记忆更新建议 / 异常告警
  频率：每日或每周，非实时
```

HR Agent 使用 Batch API（50% 折扣），成本可忽略。与 Memory Agent（负责记忆维护）职责不同：Memory Agent 管数据，HR Agent 管行为洞察。

**重要区分（2026-03-08 确认）**：

- **HR Agent** = 行为分析师。只读审计日志和记忆，输出报告和建议，不直接写记忆库，不是记忆的守门人
- **Memory Agent** = 数据管理员。负责去重、过期清理、周期提炼（`task_reflection` → `process_pattern`）、重新渲染 Markdown 只读层
- **分区自己** = 通过 `memory_write` 工具写 DB，Reflexion 阶段主动记录

HR Agent 可以向人工运营者建议"将某条经验提升进 Block 1 文件"，但执行是人工决策，不自动发生。

---

## 6. Context Assembly（System Prompt 组成）

> 详见 `research/architecture/24-agent-loop-design-reference.md` Section 18

每次 LLM 调用前，system prompt 由四块按顺序组装：

```
Block 1: 身份层 [静态文件，session 级缓存]
  - identity.md    — Alex 是谁、所在组织、长期使命、核心关系、已固化的关键经验
  - partition.md   — 这个分区的职责边界、工具 allow/deny 列表、硬底线规则
  大小目标：~2-4K tokens
  缓存：是（workspace 级，跨 session 命中）

Block 2: Skill 层 [半静态，按需选择]
  - skill-index.md — 所有可用 Skill 的名称 + 一行描述（始终注入，~1K tokens）
  - 具体 Skill 文件 — Agent 通过 get_skill(name) 工具按需拉取
  Skill 层级：
    系统级 Skill（合规原则、升级流程）→ 固化进 identity.md 或单独系统 Skill 区
    分区级 Skill（Communicator 沟通模板、Executor 操作规程）→ index 按分区过滤
    高频 Skill 自动晋升 → 经多次使用后提升进 partition.md，不再走 index 查找
  缓存：skill-index 可缓存；具体 Skill 文件内容可缓存

Block 3: Working State [程序化，DB-backed，每次事件重建]
  见第 7 节

Block 4: 记忆层 [工具调用，Agent 主动]
  - Agent 将 memory_search(query) 作为常规工具使用
  - Agent 自己决定何时搜索、搜什么（OpenClaw 模式：不预设召回时机）
  - transformContext 做初始轻量注入（基于事件 payload 提取实体），作为起点
  - 后续由 Agent 工具调用补充（迭代而非单次）
  大小：~4-8K tokens，由 Agent 控制
  缓存：否
```

**设计哲学**：Block 1 定义"Alex 始终是谁"，Block 3 定义"Alex 现在在做什么"，Block 4 定义"Alex 在这个情境下知道什么"。三者互不替代。

---

## 7. Working State（跨事件工作状态）

> 解决问题：事件驱动系统中，Alex 如何在两次事件之间保持工作连续性？

### 层级结构

```
/state/{agent-id}/
  team.md                    ← 虚拟员工整体视图（所有分区启动时加载）
  partitions/
    communicator.md          ← Communicator 当前状态（仅 Communicator 加载）
    executor.md              ← Executor 当前状态（仅 Executor 加载）
    planner.md               ← Planner 激活时的状态（按需）
```

**`team.md` 内容（示例）**：
```
## 活跃承诺
- 供应商 ABC 入驻流程（开始：2026-03-01，下一步：等待 ABN 核实）
- Q1 采购积压处理（优先级：高，截止：2026-03-31）

## 待人工决策
- PO #4421（Finance 部门），等待 Director Chen 审批，已发送 2026-03-07

## 本周重点
- 处理 Finance 部门积压的 3 个高优先级 PO
```

### 写入权限

| 层级 | 写入者 | 触发时机 |
|------|--------|---------|
| `team.md` | 代码（行为系统） | 重要承诺开始/结束、人工审批请求发出/收到 |
| `partitions/*.md` | 代码 + 分区自己 | 任务边界（代码）+ Reflexion 时（Agent） |
| HR Agent | **只读**所有层 | 不写 Working State |

**Agent 写自己的 partition state**：分区在 Reflexion 步骤可调用 `state_update` 工具更新自己的 `partitions/{name}.md`，记录当前任务进度、下一步计划、需要协调的事项。

### 与 Claude Code Agent Teams 的对应

| Claude Code Teams | 我们的设计 |
|------------------|-----------|
| `team_goals.json`（所有 agent 加载）| `team.md`（所有分区加载）|
| 个人 agent status 文件 | `partitions/{name}.md` |
| OS flock 防竞态 | DB 原子写入（AKS 多节点）|
