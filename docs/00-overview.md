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

## 三、五脑模型（60 秒版）

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

## 四、核心概念速查

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

## 五、上层应用

AIMA 当前有两个主要上层：

**secondfirst/employee**（私有，主线产品）
- 虚拟员工，集成 Microsoft Power Platform / Dataverse
- 直接依赖 `@aima/core`
- 仓库：`/Volumes/leoyun/agentic/`

**@aima/crew**（OpenClaw fork，规划中）
- 将 OpenClaw 内部的 `pi-coding-agent` 替换为 AIMA 五脑
- 面向希望获得 AIMA 认知能力的 OpenClaw 部署
- 不影响 secondfirst/employee，两者独立

---

## 六、文档地图

| 文档 | 内容 | 读者 |
|---|---|---|
| **00-overview.md**（本文） | 项目概览，入门导读 | 所有人 |
| **01-agent-architecture.md** | 五脑架构、Thread/Slot 模型、Event Bus、崩溃恢复 | 架构师、后端工程师 |
| **02-memory-architecture.md** | 五类记忆、MemoryService API、检索策略、数据库 schema | 后端工程师 |
| **03-implementation-guide.md** | 实现状态、适配器选择、ThreadRunner、Context Assembly | 实现工程师 |
| **04-sdk-api.md** | 公共 API（只记录 AIMA 在 pi 之上额外提供的接口） | 集成方、应用开发者 |

**阅读顺序建议**：00 → 01 → 04（快速了解能做什么）→ 02 + 03（深入实现）

---

## 七、实现状态

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

## 八、设计哲学（一读必知）

**治理而非约束**：给 Agent 目标和政策，不给操作手册。Amygdala 守住硬底线，其余信任 Agent 判断。

**事后审计 > 事前拦截**：不追求零错误，追求完整可追溯。COMPLIANCE 事件 → WORM 存储是不可变的审计底座。

**Context 精准注入**：Block 1/2 静态身份走 prompt cache，Block 3/4 每轮动态注入工作空间状态和记忆检索结果。不压缩 context 换 token 省钱。

**最终一致性**：DMN Reactive 和 Consolidation 各自独立运行，不互相阻塞。任意时刻记忆库可能存在短暂冗余，Consolidation 定期收敛。

**at-most-once 语义**：非幂等工具（发送消息、写数据）在崩溃歧义情况下不重试，escalate 给人工。宁可少做一次，不接受重复执行。
