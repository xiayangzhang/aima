# pi-mono 生态更新与 Claude Agent SDK 对比评估

> 研究目标: 更新 pi-mono 的最新状态，澄清与 Claude Code/OpenClaw 的关系，评估 Claude Agent SDK 作为替代选项，以及对我们"认知分区 Swarm"架构的适用性
> 前置报告: `research/architecture/06-pi-mono-deep-dive.md`（源码级分析，仍然有效）
> 日期: 2026-03-06

---

## 目录

1. [关键澄清：pi-mono 不是 Anthropic 的项目](#1-关键澄清pi-mono-不是-anthropic-的项目)
2. [pi-mono / Claude Code / OpenClaw 三者关系](#2-pi-mono--claude-code--openclaw-三者关系)
3. [pi-mono 社区与生态现状](#3-pi-mono-社区与生态现状)
4. [Claude Agent SDK：新的竞争选项](#4-claude-agent-sdk新的竞争选项)
5. [pi-mono vs Claude Agent SDK 对比](#5-pi-mono-vs-claude-agent-sdk-对比)
6. [对"认知分区 Swarm"的适用性评估](#6-对认知分区-swarm的适用性评估)
7. [选型建议与决策框架](#7-选型建议与决策框架)

---

## 1. 关键澄清：pi-mono 不是 Anthropic 的项目

**这是最重要的一个澄清**：pi-mono 不是 Anthropic 内部开发的 Agent 基础设施。

### 实际情况

| 属性 | 事实 |
|------|------|
| 创建者 | **Mario Zechner**（badlogic），libGDX 游戏框架的创造者 |
| 关系 | 与 Anthropic **无官方关系**，是完全独立的开源项目 |
| 动机 | 对 Claude Code 日益复杂感到不满，决定构建一个极简替代品 |
| 许可证 | MIT 开源 |
| 仓库 | `github.com/badlogic/pi-mono` |

### 为什么会有误解

1. pi-mono 支持 Anthropic Claude 作为 LLM provider（以及其他 20+ provider）
2. pi-mono 是 OpenClaw 的底层引擎，而 OpenClaw 常被拿来与 Claude Code 做对比
3. pi-mono 的设计参考了 Claude Code 的部分接口约定（如 `file_path`、`old_string` 等参数命名）
4. 某些文章的标题容易造成混淆

**结论**：之前文档中对 pi-mono 的定位（"Anthropic 内部的 Agent 基础设施"）需要纠正。pi-mono 是一个**独立的第三方开源项目**。

---

## 2. pi-mono / Claude Code / OpenClaw 三者关系

### 2.1 关系图谱

```
┌──────────────────────────────────────────────────┐
│              Anthropic（公司）                     │
│                                                  │
│  Claude Code (CLI)                               │
│  ├── 闭源的 agentic loop                         │
│  ├── 专用于 Claude 模型                           │
│  └── 2025/09 重命名为 Claude Agent SDK            │
│      ├── Python: claude-agent-sdk (MIT)           │
│      ├── TypeScript: @anthropic-ai/claude-agent-sdk│
│      └── 提供与 Claude Code 相同的工具和 loop       │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│         Mario Zechner (badlogic)                 │
│                                                  │
│  pi-mono (独立开源项目)                            │
│  ├── pi-ai: 统一 LLM API (20+ providers)         │
│  ├── pi-agent-core: 通用 Agent Loop               │
│  ├── pi-coding-agent: 编码 Agent CLI               │
│  └── pi-tui / pi-web-ui / pi-mom / pi-pods       │
└────────────────────┬─────────────────────────────┘
                     │ 底层引擎
                     ▼
┌──────────────────────────────────────────────────┐
│           OpenClaw (社区项目)                      │
│  ├── 原名 Clawdbot → Moltbot → OpenClaw          │
│  │   (因 Anthropic 商标投诉多次改名)                │
│  ├── 自托管 AI Agent，145,000+ GitHub Stars        │
│  ├── 使用 pi-mono 作为核心引擎                     │
│  └── 特色：持久记忆、主动触发、自主行动              │
└──────────────────────────────────────────────────┘
```

### 2.2 关键区别

| 维度 | Claude Code / Agent SDK | pi-mono | OpenClaw |
|------|------------------------|---------|----------|
| 所有方 | Anthropic | Mario Zechner | 社区 |
| LLM 支持 | **仅 Claude** | 20+ providers | 20+ providers (via pi-mono) |
| 开源程度 | Python MIT / TS 商业许可 | 完全 MIT | 开源 |
| 设计哲学 | 深度整合 Claude 能力 | 极简主义、4 个核心工具 | 自主性、持久性 |
| Subagent | **原生支持**，独立上下文 | 通过 tool 嵌套实现 | 扩展支持 |
| Hooks | PreToolUse/PostToolUse/Stop | transformContext/convertToLlm/steer/followUp | 继承 pi-mono |
| MCP | 原生支持 | 扩展支持 | 原生支持 |

### 2.3 不是同一个项目

- pi-mono **不是** Claude Code 的底层
- pi-mono **不是** Claude Code 的 fork
- pi-mono **独立于** Anthropic，只是使用 Claude 作为 LLM provider 之一
- 基于 pi-mono 构建**不会自动兼容** Claude Code 生态
- Claude Agent SDK 是 Anthropic **官方的**、**独立的**编程接口

---

## 3. pi-mono 社区与生态现状

### 3.1 项目活跃度（截至 2026-03-06）

| 指标 | 数值 |
|------|------|
| GitHub Stars | ~17.4k（快速增长中，2026年初约 2.9k → 现在 17.4k） |
| Contributors | 134 |
| 发布次数 | 151+ releases |
| npm 包 | `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent` |
| 社区 | Discord 活跃社区 |
| 维护频率 | 每周多次发布 |

### 3.2 生态系统

**Fork/衍生项目：**

| 项目 | 描述 | Stars |
|------|------|-------|
| **OpenClaw** | 自托管 AI Agent，pi-mono 最知名的下游用户 | 145,000+ |
| **oh-my-pi** (can1357) | 增强版 fork：LSP、Python、浏览器、subagents | 活跃 |
| **pi-mono-py** | Python 移植版 | 早期 |
| **pi-collaborating-agents** | 多 Agent 消息协作扩展 | 活跃 |
| **pi-messenger** | Agent 间聊天室通信扩展 | 活跃 |
| **pi-subagents** | 异步子 Agent 委派扩展 | 活跃 |
| **awesome-pi-agent** | 扩展/插件索引 | 活跃 |

**多 Agent 通信生态（新发展）：**

pi-mono 社区已经自发形成了丰富的多 Agent 扩展：

1. **pi-collaborating-agents**：通过 Pi 的消息队列实现 Agent 间通信，normal/urgent 优先级，嵌套深度控制（默认最大 2 层）
2. **pi-messenger**：文件系统为基础的 Agent 间通信，多终端多 Agent 共享文件夹即可"聊天"，无需 daemon/server
3. **pi-subagents**：异步子 Agent 委派，支持 truncation、artifacts、session sharing

### 3.3 社区风险评估

| 风险 | 级别 | 说明 |
|------|------|------|
| 项目停止维护 | **低** | 活跃度极高，有大量社区贡献者；OpenClaw 的成功为其提供了持续动力 |
| API 不兼容升级 | **中** | 快速迭代意味着 API 可能频繁变化；但核心 loop 已趋稳定 |
| 生态碎片化 | **低** | npm packages 清晰分层，Extension 系统统一 |
| 个人项目风险 | **中→低** | 134 位贡献者已降低了 bus factor；核心代码 <2000 行可 fork |

**与 06 号报告时的变化**：pi-mono 的社区状况比预期好得多。从 2.9k → 17.4k stars 的增长说明项目正在成为 agentic AI 领域的重要工具。多 Agent 扩展的出现说明社区需求与我们的架构方向一致。

---

## 4. Claude Agent SDK：新的竞争选项

### 4.1 概述

Anthropic 于 2025 年 9 月将 "Claude Code SDK" 重命名为 "Claude Agent SDK"，标志着从编码工具到通用 Agent 运行时的转变。

| 属性 | 值 |
|------|-----|
| Python 包 | `claude-agent-sdk` (MIT, v0.1.34) |
| TypeScript 包 | `@anthropic-ai/claude-agent-sdk` (商业许可, v0.2.37) |
| npm 周下载 | 1.85M+ |
| 核心能力 | 与 Claude Code 相同的工具、agent loop、context 管理 |

### 4.2 核心架构

```
Claude Agent SDK
├── Agent Loop（gather context → take action → verify → repeat）
├── Built-in Tools（Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch）
├── Hooks System
│   ├── PreToolUse   — 工具调用前拦截/修改/阻止
│   ├── PostToolUse  — 工具调用后处理
│   └── Stop         — Agent 停止时拦截
├── Subagent System
│   ├── 每个 subagent 独立上下文窗口
│   ├── 支持并行 subagent
│   └── 主 agent 做 orchestrator
├── Session Persistence
├── MCP Integration（原生）
└── Claude-Specific Features
    ├── Extended Thinking
    ├── Computer Use
    └── 深度 prompt 优化
```

### 4.3 Hooks 系统详解

```python
# Claude Agent SDK 的 Hook 模式
from claude_agent_sdk import Hook, HookEvent

class ComplianceHook(Hook):
    """合规检查 Hook"""

    async def pre_tool_use(self, event: HookEvent):
        """工具调用前检查"""
        if event.tool_name == "Write" and is_sensitive_path(event.args["path"]):
            return {"block": True, "reason": "敏感文件需要人工确认"}
        return {"allow": True}

    async def post_tool_use(self, event: HookEvent):
        """工具调用后审计"""
        audit_log(event.tool_name, event.args, event.result)

    async def stop(self, event: HookEvent):
        """Agent 停止前检查"""
        if not all_tasks_completed():
            return {"continue": True, "message": "还有未完成的任务"}
```

### 4.4 Subagent 系统

```python
# Claude Agent SDK 的 Subagent（原生支持）
from claude_agent_sdk import Agent, Subagent

primary = Agent(
    system_prompt="You are an orchestrator...",
    tools=[...],
)

# Subagent 自动获得独立上下文窗口
# 主 agent 不会被 subagent 的工作细节污染
result = await primary.run("Analyze this codebase and refactor the auth module")
# 主 agent 会自动创建 subagents 来分工
```

### 4.5 限制

| 限制 | 影响 |
|------|------|
| **仅支持 Claude 模型** | 无法使用 GPT-4o、Gemini 等；Smart Router 不可能 |
| **TypeScript 版是商业许可** | 我们用 TS 会受许可约束 |
| **与 Anthropic 深度绑定** | 如果 Anthropic 政策变化（如 API 定价），无替代方案 |
| **不支持自托管模型** | 政府离线环境无法使用 |
| **Hooks 有限** | 只有 PreToolUse/PostToolUse/Stop，不如 pi-mono 的 4 个钩子灵活 |

---

## 5. pi-mono vs Claude Agent SDK 对比

### 5.1 核心维度对比

| 维度 | pi-mono | Claude Agent SDK | 对我们的影响 |
|------|---------|-------------------|------------|
| **LLM 灵活性** | 20+ providers，一行切换 | 仅 Claude | **关键**：我们需要 Smart Router 按复杂度分配模型 |
| **Agent Loop** | 4 个 hook，极简可控 | Hooks 系统 + 原生 Subagent | Claude SDK 的 subagent 更成熟 |
| **多 Agent** | 社区扩展 (pi-subagents 等) | **原生支持**，独立上下文 | Claude SDK 更完善 |
| **MCP** | 扩展支持 | **原生支持** | Claude SDK 更好 |
| **许可证** | 完全 MIT | Python MIT / **TS 商业许可** | 如果用 TS，pi-mono 更安全 |
| **Extended Thinking** | 统一接口，支持多 provider | Claude 深度集成 | 差别不大 |
| **社区规模** | 17.4k stars，134 贡献者 | 1.85M 周下载，Anthropic 官方 | Claude SDK 更大但受限于 Claude |
| **自托管** | 支持 Ollama/vLLM/LM Studio | **不支持** | 政府离线场景 pi-mono 必须 |
| **代码量** | agent core <1000 行 | 不透明（闭源 loop） | pi-mono 更可控 |
| **成本控制** | 内置 usage/cost tracking | 内置 | 差别不大 |
| **政府云** | Azure/Bedrock/自定义 endpoint | 仅 Anthropic API | pi-mono 更灵活 |

### 5.2 对我们核心需求的覆盖度

| 我们的需求 | pi-mono 覆盖度 | Claude Agent SDK 覆盖度 |
|-----------|---------------|----------------------|
| 动态 Multi-Agent Swarm | 通过 tool 嵌套 + 社区扩展 (**80%**) | 原生 Subagent (**90%**) |
| Smart Router（模型按任务分配） | pi-ai 多 provider (**100%**) | 仅 Claude (**0%**) |
| 认知分区（专项经验注入） | transformContext + convertToLlm (**90%**) | Hooks + system prompt (**70%**) |
| 统一意识共享 | 需自行实现 (**60%**) | 需自行实现 (**60%**) |
| 断点续传 | replaceMessages + 序列化 (**80%**) | Session persistence (**80%**) |
| 政府云 | Bedrock/Azure/自定义 endpoint (**95%**) | 仅 Anthropic API (**30%**) |
| 多租户 | Proxy 架构 (**70%**) | 不支持 (**20%**) |
| 审计 | 事件系统 + subscribe (**85%**) | Hooks (**75%**) |
| MCP 工具集成 | 扩展 (**70%**) | 原生 (**95%**) |
| 合规（数据主权） | 自托管 LLM (**90%**) | 不支持 (**10%**) |

### 5.3 关键发现

**Claude Agent SDK 的致命限制是单一 LLM 绑定**。在我们的架构中：

1. **Smart Router 是核心差异化**：按任务复杂度动态分配模型（Haiku 处理简单查询、Sonnet 处理常规任务、Opus 处理复杂推理）是成本控制和性能优化的关键。Claude Agent SDK 不支持这一点。

2. **政府云部署**：许多政府环境要求使用 Azure OpenAI 或 AWS Bedrock，而不是直接调用 Anthropic API。Claude Agent SDK 在这些环境中无法使用。

3. **供应商锁定**：我们的架构哲学是"LLM 可插拔替换"。Claude Agent SDK 直接违反这一原则。

---

## 6. 对"认知分区 Swarm"的适用性评估

### 6.1 认知分区模式回顾

```
虚拟员工 = Agent Swarm (认知分区)
├── 意识中枢 (Coordinator) — 统一意识、任务分配
├── 审批认知区 — 专项审批经验
├── 数据处理认知区 — 专项数据处理经验
├── 沟通认知区 — 专项沟通经验
└── 学习认知区 — 从反馈中学习、优化行为

共享: 统一意识（组织知识、角色认知、行为规范）
隔离: 每个认知区有独立的专项经验和工具集
```

### 6.2 用 pi-mono 实现认知分区的具体方案

#### 6.2.1 统一意识层（Shared Consciousness）

```typescript
import { Agent, AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

// 统一意识 = 共享的 transformContext
function createSharedConsciousness(config: VirtualEmployeeConfig) {
    return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
        // 1. 注入组织知识
        const orgContext = await fetchOrganizationContext(config.tenantId);

        // 2. 注入角色认知（"我是谁"）
        const roleIdentity = buildRoleIdentity(config.role);

        // 3. 注入行为规范（治理政策）
        const governance = await fetchGovernancePolicies(config.tenantId);

        // 4. 注入长期记忆（之前的经验）
        const longTermMemory = await fetchRelevantMemories(
            config.employeeId,
            messages[messages.length - 1] // 最新消息
        );

        // 5. 组装上下文
        const contextMessage: AgentMessage = {
            role: "user",
            content: [
                `[组织背景] ${orgContext}`,
                `[角色认知] ${roleIdentity}`,
                `[行为规范] ${governance}`,
                `[相关经验] ${longTermMemory}`,
            ].join("\n\n"),
            timestamp: Date.now(),
        };

        // 注入到消息列表开头（在 system prompt 之后）
        return [contextMessage, ...messages];
    };
}
```

#### 6.2.2 认知分区实现（Cognitive Partitions）

```typescript
// 每个认知分区 = 一个配置化的 Agent 实例
interface CognitivePartition {
    name: string;
    systemPrompt: string;           // 专项角色定义
    model: Model<any>;              // 可以不同分区用不同模型
    tools: AgentTool[];             // 专属工具集
    experienceStore: ExperienceDB;  // 专项经验存储
}

// 认知分区工厂
function createPartitionAgent(
    partition: CognitivePartition,
    sharedConsciousness: ReturnType<typeof createSharedConsciousness>
): Agent {
    const agent = new Agent({
        convertToLlm: (messages) => {
            // 过滤掉内部消息类型，转为 LLM 可理解的格式
            return messages.flatMap(m => {
                if (m.role === "experience_injection") return [];
                if (m.role === "governance_alert") {
                    return [{ role: "user", content: `[治理警告] ${m.text}`, timestamp: m.timestamp }];
                }
                return [m];
            });
        },
        transformContext: async (messages, signal) => {
            // 1. 应用统一意识
            let enriched = await sharedConsciousness(messages, signal);

            // 2. 注入专项经验
            const task = extractCurrentTask(messages);
            const experience = await partition.experienceStore.findRelevant(task);
            if (experience.length > 0) {
                const expMessage: AgentMessage = {
                    role: "user",
                    content: `[专项经验 — ${partition.name}]\n${experience.map(e =>
                        `- ${e.scenario}: ${e.lesson} (置信度: ${e.confidence})`
                    ).join("\n")}`,
                    timestamp: Date.now(),
                };
                enriched = [enriched[0], expMessage, ...enriched.slice(1)];
            }

            return enriched;
        },
    });

    agent.setSystemPrompt(partition.systemPrompt);
    agent.setModel(partition.model);
    agent.setTools(partition.tools);

    return agent;
}
```

#### 6.2.3 Smart Router（模型按任务复杂度分配）

```typescript
import { getModel, Model } from "@mariozechner/pi-ai";

// 模型路由策略
interface ModelTier {
    name: string;
    model: Model<any>;
    costPerMToken: number;
    suitableFor: string[];
}

const MODEL_TIERS: ModelTier[] = [
    {
        name: "fast",
        model: getModel("anthropic", "claude-haiku-4-5")!,
        costPerMToken: 0.8,
        suitableFor: ["简单查询", "格式转换", "数据提取"],
    },
    {
        name: "balanced",
        model: getModel("anthropic", "claude-sonnet-4-6")!,
        costPerMToken: 3.0,
        suitableFor: ["业务判断", "文档分析", "沟通草拟"],
    },
    {
        name: "reasoning",
        model: getModel("anthropic", "claude-opus-4-6")!,
        costPerMToken: 15.0,
        suitableFor: ["复杂推理", "合规分析", "异常处理"],
    },
    {
        name: "gov-fallback",
        model: getModel("amazon-bedrock", "anthropic.claude-3-5-sonnet-20241022-v2:0")!,
        costPerMToken: 3.0,
        suitableFor: ["政府云环境", "数据主权要求"],
    },
];

// Smart Router：在 Coordinator 中根据任务选模型
async function routeToModel(task: string, complexity: TaskComplexity): Promise<Model<any>> {
    switch (complexity) {
        case "simple": return MODEL_TIERS[0].model;   // Haiku
        case "normal": return MODEL_TIERS[1].model;   // Sonnet
        case "complex": return MODEL_TIERS[2].model;  // Opus
        case "gov-restricted": return MODEL_TIERS[3].model; // Bedrock
    }
}

// 在 Coordinator Agent 的 tool 中使用
const delegateTool: AgentTool = {
    name: "delegate_to_partition",
    description: "将子任务委派给指定的认知分区处理",
    parameters: Type.Object({
        partition: Type.String({ description: "认知分区名称" }),
        task: Type.String({ description: "任务描述" }),
        complexity: Type.Union([
            Type.Literal("simple"),
            Type.Literal("normal"),
            Type.Literal("complex"),
        ]),
    }),
    execute: async (toolCallId, params, signal) => {
        const partition = partitions.get(params.partition);
        if (!partition) throw new Error(`认知分区 ${params.partition} 不存在`);

        // Smart Router：根据复杂度选模型
        const model = await routeToModel(params.task, params.complexity);
        partition.agent.setModel(model);

        // 运行子 Agent
        await partition.agent.prompt(params.task);
        await partition.agent.waitForIdle();

        // 提取结果 + 记录经验
        const result = extractResult(partition.agent.state.messages);
        await partition.experienceStore.recordExperience({
            task: params.task,
            result: result,
            model: model.id,
            tokensUsed: extractUsage(partition.agent.state.messages),
        });

        return { content: [{ type: "text", text: result }], details: {} };
    },
};
```

#### 6.2.4 治理层（Governance via Hooks）

```typescript
// 治理 = 通过 steer/followUp 注入治理消息
function createGovernanceLayer(agent: Agent, policies: GovernancePolicy[]) {
    // 监听事件，在违规时通过 steering 中断
    agent.subscribe(async (event) => {
        if (event.type === "tool_execution_end") {
            // 检查 tool 结果是否违反治理政策
            for (const policy of policies) {
                const violation = policy.check(event.toolName, event.result);
                if (violation) {
                    // 通过 steering 中断当前执行
                    agent.steer({
                        role: "user",
                        content: `[治理警告] ${violation.message}\n请停止当前操作并采取以下措施：${violation.remediation}`,
                        timestamp: Date.now(),
                    });
                    break;
                }
            }
        }

        if (event.type === "agent_end") {
            // 在 Agent 完成后，注入反思提示
            const reflection = await generateReflection(event.messages);
            if (reflection.hasLessons) {
                // 通过 followUp 触发学习
                agent.followUp({
                    role: "user",
                    content: `[反思学习] 请总结你在这次任务中学到了什么，以及下次可以如何改进。`,
                    timestamp: Date.now(),
                });
            }
        }
    });
}
```

### 6.3 pi-mono 的 4 个钩子与认知分区的映射

| 钩子 | 认知分区用途 | 实现说明 |
|------|-----------|---------|
| `transformContext` | **统一意识注入** + **专项经验注入** | 在每次 LLM 调用前注入组织知识、角色认知、长期记忆 |
| `convertToLlm` | **消息类型转换** | 将内部消息类型（governance_alert、experience_injection）转为 LLM 可理解的格式 |
| `getSteeringMessages` | **治理中断** + **Coordinator 指令** | 在检测到违规时中断执行；Coordinator 向子 Agent 发送紧急指令 |
| `getFollowUpMessages` | **反思学习** + **多步工作流** | Agent 完成后触发学习；一个步骤完成后注入下一步 |

**评估结论**：4 个钩子**基本足够**实现认知分区模式的核心功能。唯一不足是缺少"Agent 间通信"的原生支持，但可以通过以下方式弥补：

1. **Tool 嵌套**：Coordinator 通过 tool 调用 Sub-Agent（已验证可行）
2. **共享状态**：通过数据库/Redis 实现认知分区间的状态共享
3. **社区扩展**：pi-collaborating-agents 提供了 Agent 间消息通信

---

## 7. 选型建议与决策框架

### 7.1 三个选项对比

| 选项 | 描述 | 适用场景 |
|------|------|---------|
| **A. pi-ai + pi-agent-core** | 使用 pi-mono 底层两个包 + 自研上层 | 我们的核心需求匹配度最高 |
| **B. Claude Agent SDK** | 使用 Anthropic 官方 SDK | 如果只用 Claude 且不需要政府云 |
| **C. pi-ai + 自研 Agent Loop** | 只用 pi-ai 做 LLM 抽象，自研 loop | 如果 pi-agent-core 的 loop 不够用 |
| **D. 混合方案** | pi-ai 做 LLM 抽象 + Claude Agent SDK 做 Agent 运行时 | 不现实，架构冲突 |

### 7.2 推荐：方案 A（pi-ai + pi-agent-core）

**理由：**

1. **Smart Router 是核心差异化**。Claude Agent SDK 不支持多 provider，这直接排除了它作为核心底层的可能性。pi-ai 的 20+ provider 支持是不可替代的。

2. **政府云是硬性需求**。Azure Government、AWS GovCloud、自托管 LLM 等场景，只有 pi-ai 能覆盖。

3. **核心代码可控**。pi-agent-core 不到 1000 行，完全理解、可 fork、可自维护。Claude Agent SDK 的核心 loop 是闭源的。

4. **社区趋势向好**。17.4k stars、134 贡献者、丰富的多 Agent 扩展——pi-mono 不再是一个"个人项目"风险。

5. **4 个钩子足够**。经过本次详细评估，transformContext + convertToLlm + steer + followUp 组合可以实现认知分区的所有核心功能。

6. **MIT 许可**。无许可风险，与我们的商业模式完全兼容。

### 7.3 不推荐 Claude Agent SDK 的原因

- 单一 LLM 绑定违反"供应商无关"原则
- TypeScript 商业许可有法律风险
- 不支持政府云场景
- 无法实现 Smart Router
- Anthropic 的 API 使用条款限制了第三方产品构建

### 7.4 与 14 号报告（MS Agent Framework）的关系

14 号报告评估了 AutoGen 0.4 + Semantic Kernel 作为替代选项。两者的定位不同：

| 维度 | pi-mono (方案 A) | MS Agent Framework (14号方案 D) |
|------|-----------------|-------------------------------|
| LLM 抽象 | pi-ai (20+ providers) | Semantic Kernel (多 provider) |
| Agent Loop | pi-agent-core (4 hooks) | AutoGen 0.4 (Agent Runtime) |
| MS 集成 | 需自行实现 | 原生支持 |
| 代码风格 | TypeScript | Python/C# |
| 社区 | 17.4k stars (快速增长) | Microsoft 官方支持 |
| 控制度 | 源码透明可控 | 框架较重，隐含约束多 |

**建议**：用户需要在 review 完本报告和 14 号报告后，做出 pi-mono vs MS Agent Framework 的最终选型决策。两者各有优势，选择取决于：

- 如果**灵活性和控制度**优先 → pi-mono
- 如果 **MS 生态深度集成**优先 → MS Agent Framework
- 如果**两者兼顾** → pi-ai（LLM 抽象）+ Semantic Kernel（编排）+ 自研 Agent Loop

### 7.5 下一步行动

1. **纠正文档**：修正 `docs/02-technical-architecture.md` 中关于 pi-mono 的定位描述
2. **Review 14 号报告**：对比 pi-mono 和 MS Agent Framework，做最终选型
3. **POC 验证**：无论选哪个，都需要做一个最小 POC 来验证认知分区 Swarm
4. **更新 05-open-questions.md**：记录选型决策

---

## 附录：数据来源

- [pi-mono GitHub](https://github.com/badlogic/pi-mono)
- [pi-mono DeepWiki](https://deepwiki.com/badlogic/pi-mono)
- [How to Build a Custom Agent Framework with PI](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)
- [What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- [Pi vs Claude Agent SDK](https://agentlas.pro/compare/pi-vs-claude-agent-sdk/)
- [Claude Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Anthropic: Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [OpenClaw vs Claude Code](https://www.analyticsvidhya.com/blog/2026/03/openclaw-vs-claude-code/)
- [pi-collaborating-agents](https://github.com/baochunli/pi-collaborating-agents)
- [pi-subagents](https://github.com/nicobailon/pi-subagents)
- [Pi: The Minimal Agent Within OpenClaw](https://lucumr.pocoo.org/2026/1/31/pi/)
- [Pi Monorepo Review (2026)](https://www.toolworthy.ai/tool/pi-mono)
- 本地仓库：`/Volumes/leoyun/agentic/ref-repos/pi-mono/` 源码分析
