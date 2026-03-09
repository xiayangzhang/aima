# AIMA — 项目概览

> **AIMA** = Artificial Intelligence: A Minded Architecture
> 认知个体的核心框架，面向内部团队的入门文档。

---

## 一、AIMA 是什么

AIMA 是一个**开源中间层框架**，用于构建具备持续认知能力的自主 Agent。

它处于 LLM 和应用之间：

```
上层应用（secondfirst/employee、@aima/crew 等）
        ↕
      AIMA
        ↕
LLM（Claude、GPT 等）+ 工具（Dataverse、Teams、邮件...）
```

AIMA 不决定"解决什么问题"——那是上层应用的事。AIMA 负责"Agent 如何思考、记忆、决策、执行"。

---

## 二、AIMA 不是什么

这些边界很重要，因为容易被误解：

| 常见误解 | 实际情况 |
|---|---|
| AIMA 是编排框架（LangGraph/CrewAI） | 否。AIMA 不做任务分配，Agent 自主决策 |
| AIMA 是 MoE / 多专家路由 | 否。五脑是一个认知个体的不同侧面，不是多个 Agent |
| AIMA 是流水线（步骤 A → B → C） | 否。路由是动态的，由 Limbic 实时判断 |
| AIMA 保证零错误 | 否。Agent 会犯错，AIMA 提供审计追溯，不承诺完美 |
| AIMA 是 RPA 工具 | 否。RPA 执行固定脚本，AIMA 处理需要判断的场景 |

---

## 三、与 pi / pi-coding-agent / OpenClaw 的关系

AIMA 建立在 pi-mono 生态之上，但设计哲学有根本性差异。理解这些差异，才能知道 AIMA 加了什么、为什么这样加。

### pi-agent-core

**哲学**：最小化、可组合的 Agent 循环。给工具，跑起来，其他你自己搭。

- 无状态：每个 session 从零开始，关闭即消失
- 无内置记忆、无安全层、无审计
- 极轻量，适合用作底层构件

AIMA **统一使用 `pi-coding-agent`** 作为每个脑区的 LLM 对话引擎底层。当前实现暂时使用 `pi-agent-core`（已完成，18/18 测试通过），迁移到 `pi-coding-agent` 是已决定的下一步。

> **为什么统一用 pi-coding-agent 而不是 pi-agent-core？**
> pi-coding-agent 的内置工具（bash、文件读写）与外部工具走同一 `AgentTool` 注册路径，Amygdala 可以通过 Extension API 的 `tool_call` 事件统一拦截。于是我们可以用一个 adapter，通过 Amygdala 策略控制工具权限——默认禁用危险工具，`role.md` 按需解锁——而不需要维护两个不同的 adapter。

### pi-coding-agent

**哲学**：在 pi-agent-core 基础上，预置编程工具（bash、文件读写）。

- 仍然无状态
- 内置工具与外部工具走同一 `AgentTool` 注册路径，且 Extension API 提供 pre-tool hook（`tool_call` 事件，可返回 `{ block: true }` 阻断）
- 这两点使 Amygdala 可以覆盖所有工具，无例外

**AIMA 的工具权限模型**（基于 pi-coding-agent 单 adapter）：

```
虚拟员工（默认）     虚拟程序员（role.md 解锁）
────────────────    ────────────────────────
bash     → BLOCK    bash     → ALLOW（沙盒内）
file_write→ BLOCK   file_write→ ALLOW（workspace 内）
file_read → BLOCK   file_read → ALLOW
memory_search→ALLOW memory_search→ ALLOW
```

Amygdala 读取 `role.md` 中的 `permissions` 字段决定放行策略，不需要切换 adapter。

### OpenClaw

**哲学**：多通道部署平台。一个 Agent，连通多个通道（Teams、Telegram、Discord...）。

- 你把应用**部署进** OpenClaw，OpenClaw 是框架
- Session 持久化靠文件（`SessionManager.open(sessionFile)`），本质上仍是每次请求重建 Agent
- 通道插件机制设计良好（`ChannelPlugin`: agentTools / outbound / agentPrompt）
- 无认知架构、无内置安全层、无合规审计

**AIMA 与这三者的核心差异**：

| 维度 | pi / pi-coding | OpenClaw | AIMA |
|---|---|---|---|
| 认知持久性 | 无（session 结束即忘） | 文件级 session 历史 | PostgreSQL Thread/Slot，跨 session 持续 |
| 记忆系统 | 无 | 无 | 五类记忆，各自访问模式设计 |
| 工具安全 | 无 | 无 | Amygdala 同步拦截，all tools 覆盖 |
| 合规审计 | 无 | 无 | COMPLIANCE 事件 → WORM，内置 |
| 认知结构 | 单一 Agent 循环 | 单一 Agent 循环 | 五脑路由，不同认知功能分区 |
| 使用方式 | 库（你 build on top） | 框架（你 deploy into） | 库（你 build on top） |
| 错误哲学 | 无内置处理 | 无内置处理 | DMN 错误恢复 + at-most-once 安全语义 |

---

## 四、五脑模型（60 秒版）

AIMA 把一个认知个体的能力分为五个功能区：

```
外部世界
    ↕
  Limbic（对话/路由）     ← 唯一对外的人类接口
    ↕
  Cortex（推理/规划）     ← 内部思考引擎，不对外
    ↕
  Brainstem（工具执行）   ← 唯一操作外部系统的脑区
    ↕
外部系统（API、数据库、文件...）

横切两个脑区：
  Amygdala（安全底线）   ← 所有工具调用前同步拦截
  DMN（反思/记忆整合）   ← 无触发自发运行，管理长期记忆
```

**一条消息的典型流程**：

```
用户消息
  → Limbic 判断：直接回复？还是需要规划/执行？
      → 简单回复：Limbic RESPOND → 结束
      → 需要规划：Limbic ROUTE → Cortex 分析 → Brainstem 执行 → Limbic 最终回复
      → 需要追问：Limbic DEFER → 等待用户补充 → 继续
```

每次工具调用前，Amygdala 拦截检查。DMN 在后台持续整理记忆、发现错误、生成 Memory Bulletin。

---

## 五、核心概念速查

| 概念 | 一句话 |
|---|---|
| **Thread** | 一件正在处理的事（一段对话、一个任务）的认知上下文边界 |
| **Slot** | 每个脑区在某次 Thread 中的输入/输出/状态记录 |
| **CognitiveWorkspace** | Thread + Slot 的持久化层（PostgreSQL），支持崩溃恢复 |
| **Session** | 某脑区在某 Thread 内的 LLM 对话历史（key = `brain:thread_id`） |
| **Memory** | 五类持久记忆（semantic/episodic/procedural/working/implicit），跨 Thread 流通 |
| **Skill** | Markdown 文件，Agent 读取后获得领域操作能力 |
| **Event Bus** | 只读可观测性接口，五个级别（COMPLIANCE/ALERT/INFO/DEBUG/TRACE） |
| **Amygdala** | 内置安全层，基于 `risk_level` 和 `implicit` 记忆做 pre-execution 检查 |
| **DMN** | 工程上两个独立单元：Reactive（准实时事件监听）+ Consolidation（后台批处理） |

---

## 六、上层应用

AIMA 当前有两个主要上层，**相互独立，互不依赖**。

---

### secondfirst/employee — 虚拟员工产品

**定位**：面向政府和企业的虚拟员工平台，目标客户是使用 Microsoft Power Platform / Dynamics 365 的组织。虚拟员工像真实同事一样工作——在 Teams 里对话、处理 Dataverse 里的审批、生成报表、协调任务——而不是一个"AI 助手"。

**典型员工角色**：

| 角色 | 做什么 |
|---|---|
| 流程执行员 | 审批工作流、状态更新、异常路由（如采购审批、风险评审） |
| 数据录入员 | Dataverse 数据录入、报表生成、数据核对 |
| 项目协调员 | 进度跟踪、资源协调、状态汇报（如项目周报、变更请求） |

**技术选型**：
- 直接依赖 `@aima/core`，不经过 @aima/crew
- 通道：Microsoft Teams（DM + 群组）+ 邮件 + Dataverse Webhook
- 权限：Microsoft Entra Agent ID（员工级权限）
- 审计：双层（Inboard + Outboard WORM + Confidential Ledger）

**部署阶段**（每个客户的标准导入路径）：

```
Shadow Mode（只观察不执行）
    → 协同模式（建议 + 人工确认）
        → 自主模式（完整执行权限）
```

Shadow Mode 期间，Agent 观察人类如何处理同类任务，差异经人工标注后写入记忆。这是 Skill 积累的主要来源。

**仓库**：`/Volumes/leoyun/agentic/`（私有）

---

### @aima/crew — OpenClaw Fork

**定位**：OpenClaw 的 fork 版本，将 OpenClaw 内部的 `pi-coding-agent` 替换为 AIMA 五脑架构。面向已经在用 OpenClaw 的场景，让它无感获得 AIMA 的认知能力。

**为什么是 fork 而不是兼容层**：我们需要控制演进路径，不受 OpenClaw 原版设计决策约束。替换是一次性的底层换芯，上层通道插件完全复用。

**换芯后得到什么**：

| OpenClaw 原版 | @aima/crew |
|---|---|
| 文件 session（每次重建 Agent） | PostgreSQL Thread/Slot（跨 session 持续） |
| 无记忆系统 | AIMA 五类记忆（免费获得） |
| 无安全拦截 | Amygdala 覆盖所有工具（含内置工具） |
| 无合规审计 | COMPLIANCE 事件 + WORM |
| pi-coding-agent 单循环 | 五脑路由 |

**工具分工**：OpenClaw 传入的所有通道工具（sendMessage、addReaction 等）全部注册到 Brainstem。Cortex 通过 Block 3 注入的 `toolIndex`（Markdown 工具清单）理解可用工具并做规划。Amygdala 通过 `pi-coding-agent` Extension API 的 `tool_call` 事件拦截所有工具调用（含 bash、文件 I/O 等内置工具）。

**OpenClaw gateway 改动量极小**：

```typescript
// 原来：
const session = await createAgentSession({ sessionManager, tools, model })
// 改为：
const session = await createAIMASession({ instance, sessionKey, tools, toolIndex, channelContext })
```

返回值实现相同的 `Agent` 接口，OpenClaw 其余代码不变。

**状态**：规划中，`@aima/core` 稳定后开始实现。

---

## 七、文档地图

| 文档 | 内容 | 读者 |
|---|---|---|
| **00-overview.md**（本文） | 项目概览，入门导读 | 所有人 |
| **01-agent-architecture.md** | 五脑架构、Thread/Slot 模型、Event Bus、崩溃恢复 | 架构师、后端工程师 |
| **02-memory-architecture.md** | 五类记忆、MemoryService API、检索策略、数据库 schema | 后端工程师 |
| **03-implementation-guide.md** | 实现状态、适配器选择、ThreadRunner、Context Assembly | 实现工程师 |
| **04-sdk-api.md** | 公共 API（只记录 AIMA 在 pi 之上额外提供的接口） | 集成方、应用开发者 |

**阅读顺序建议**：00 → 01 → 04（快速了解能做什么）→ 02 + 03（深入实现）

---

## 八、实现状态

`@aima/core` v0.1.1（`main` 分支）

| 模块 | 状态 |
|---|---|
| Thread/Slot 持久化（PostgreSQL） | ✅ |
| ThreadRunner + 五脑路由 | ✅ |
| PiAgentAdapter（pi-agent-core） | ✅ |
| Event Bus（五级订阅） | ✅ |
| 崩溃恢复 | ✅ |
| 测试覆盖（39 个 unit + integration smoke） | ✅ |
| `continue()`（多轮对话续接） | ⏳ |
| `memory.search()`（只读接口） | ⏳ |
| `identityDir` 身份文件加载 | ⏳ |
| ClaudeSDKAdapter | ⏳ |
| `@aima/crew`（OpenClaw fork） | ⏳ |

---

## 九、设计哲学（一读必知）

**分工使能协同**：五脑的价值不在单个脑区，而在分工产生的互相使能。Limbic 能大胆忽略无关消息，是因为有 Brainstem 托底执行、有 Cortex 处理复杂判断；DMN 的预测能精准送达正确的脑区，是因为每个脑区的职责边界清晰；Amygdala 能保持轻量，是因为有 DMN 在后台持续学习风险模式。单独拆出任何一个脑区，它的能力都会退化。

**Agent 是自己的调度器**：DMN 向后整合过去（从 Event Bus 蒸馏 episodic 记忆、聚类风险模式、评估 Skill 健康度），向前预测未来（基于积累的模式主动激活脑区、发起 Thread、取消已失效的预测）。区别于 cron 或外部触发：是 Agent 自己决定什么时候该做什么，而不是系统时钟或外部事件决定。这是 AIMA 和其他框架最本质的分野之一。

**治理而非约束**：给 Agent 目标和政策，不给操作手册。Amygdala 守住硬底线，其余信任 Agent 判断。

**事后审计 > 事前拦截**：不追求零错误，追求完整可追溯。COMPLIANCE 事件 → WORM 存储是不可变的审计底座。

**Context 精准注入**：Block 1/2 静态身份走 prompt cache，Block 3/4 每轮动态注入工作空间状态和记忆检索结果。不压缩 context 换 token 省钱。

**最终一致性**：DMN Reactive 和 Consolidation 各自独立运行，不互相阻塞。任意时刻记忆库可能存在短暂冗余，Consolidation 定期收敛。

**at-most-once 语义**：非幂等工具（发送消息、写数据）在崩溃歧义情况下不重试，escalate 给人工。宁可少做一次，不接受重复执行。
