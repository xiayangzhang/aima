# OpenClaw 生态系统深度研究

> **研究日期**：2026-03-06
> **研究目的**：研究 OpenClaw（Claude Code 开源社区版本）及其生态系统，挖掘可借鉴的设计模式、工具和社区资源
> **关联报告**：[06-pi-mono-deep-dive.md](06-pi-mono-deep-dive.md)、[07-openclaw-architecture.md](07-openclaw-architecture.md)、[16-token-rich-autonomous-agent.md](16-token-rich-autonomous-agent.md)、[17-claude-agent-sdk-ecosystem.md](17-claude-agent-sdk-ecosystem.md)
> **核心结论**：pi-mono 作为我们的候选核心引擎，其生态已通过 OpenClaw 得到大规模验证；MCP 协议已进入企业就绪阶段，微软官方提供 25+ MCP 服务器覆盖全部 M365/Dataverse 场景；Smart Router 模式可直接借鉴实现成本优化

---

## 目录

1. [OpenClaw 最新架构分析（2026年现状）](#1-openclaw-最新架构分析)
2. [MCP 生态系统](#2-mcp-生态系统)
3. [可借鉴的设计模式](#3-可借鉴的设计模式)
4. [生态便利](#4-生态便利)
5. [对我们架构的适配分析](#5-对我们架构的适配分析)
6. [关键发现总结](#6-关键发现总结)

---

## 1. OpenClaw 最新架构分析

### 1.1 项目概况

| 属性 | 详情 |
|------|------|
| **创建者** | Peter Steinberger（奥地利开发者，2026年2月加入 OpenAI） |
| **原名** | Clawdbot → Moltbot → OpenClaw |
| **首次发布** | 2025年11月 |
| **GitHub Stars** | 247,000+（截至2026年3月2日） |
| **Forks** | 47,700+ |
| **许可证** | MIT |
| **定位** | 通用 AI 助手，通过消息平台（WhatsApp、Telegram、Discord、Slack）交互 |
| **当前治理** | 转移至开源基金会，OpenAI 提供资金支持 |
| **技术栈** | TypeScript，基于 pi-mono SDK |

**与 Claude Code 的关键区别**：OpenClaw 是通用 AI 助手（多消息平台），Claude Code 专注软件开发（终端 CLI）。两者共享 pi-mono 底层，但面向完全不同的用例。

### 1.2 核心架构

OpenClaw 遵循 **Local Gateway + Agentic Loop + Skills + Persistent Memory** 架构：

```
┌─────────────────────────────────────────────┐
│                OpenClaw 架构                 │
├─────────────┬───────────────────────────────┤
│   Channels  │ Discord / Telegram / Slack /  │
│  (消息通道)  │ WhatsApp / iMessage / Web     │
├─────────────┼───────────────────────────────┤
│   Gateway   │ 消息路由 → Agent 分发          │
├─────────────┼───────────────────────────────┤
│  pi-coding  │ createAgentSession()          │
│  -agent     │ SessionManager / AuthStorage  │
├─────────────┼───────────────────────────────┤
│  pi-agent   │ Agent Loop / Tool Registry    │
│  -core      │ AgentState / Extensions       │
├─────────────┼───────────────────────────────┤
│  pi-ai      │ LLM 抽象层 / Provider APIs    │
│             │ 多模型支持 / 流式输出          │
├─────────────┼───────────────────────────────┤
│   Skills    │ MCP Servers / Custom Tools    │
│  (技能系统)  │ ClawHub Registry (13,729+)    │
├─────────────┼───────────────────────────────┤
│   Memory    │ Markdown 文件 (~/.openclaw/)   │
│  (持久记忆)  │ JSONL Session Persistence     │
└─────────────┴───────────────────────────────┘
```

### 1.3 与 pi-mono 的关系

**OpenClaw 直接内嵌 pi-mono SDK**，而非作为子进程或 RPC 调用。这是关键的架构决策：

| pi-mono 包 | 职责 | OpenClaw 使用方式 |
|------------|------|------------------|
| `pi-ai` | LLM 通信抽象、Model 类型、Provider APIs | 直接 import，多 Provider 路由 |
| `pi-agent-core` | Agent Loop、Tool 执行、AgentMessage 类型 | 核心运行时，Agent 状态管理 |
| `pi-coding-agent` | `createAgentSession()`、SessionManager、AuthStorage | **主要入口**，会话创建与管理 |
| `pi-tui` | 终端 UI 组件 | 仅本地 TUI 模式使用 |

**嵌入式集成的关键代码路径**：

```typescript
// OpenClaw 的主入口：pi-embedded-runner/run.ts
async function runEmbeddedPiAgent() {
  // 1. ResourceLoader 初始化工作区资源
  const resources = new ResourceLoader(workspace);

  // 2. 创建 Agent Session（核心）
  const session = await createAgentSession({
    tools: buildToolPipeline(),      // 自定义工具管线
    authStorage: authStore,           // 多账户认证
    modelRegistry: registry,          // 模型注册表
    thinkingLevel: config.thinking,   // 思考深度
  });

  // 3. 系统提示词覆盖
  applySystemPromptOverrideToSession(session, buildAgentSystemPrompt());

  // 4. 事件订阅
  subscribeEmbeddedPiSession(session, {
    onMessageStart, onToolExecution, onTurnEnd, // ...
  });

  // 5. 触发 Agent Loop
  await session.prompt(userMessage);
}
```

### 1.4 pi-mono 的 4 个核心 Hooks

pi-agent-core 定义了 4 个在 Agent Loop 中调用的核心 hooks，这是我们最需要关注的扩展点：

| Hook | 调用时机 | 职责 | 我们的对应需求 |
|------|---------|------|--------------|
| `transformContext` | LLM 调用前，在消息序列上 | 裁剪旧消息、注入外部上下文、pruning | 认知分区的上下文隔离 |
| `convertToLlm` | transformContext 之后 | 将内部 `AgentMessage[]` 转换为 LLM API 格式；过滤图片、转换自定义类型 | 多 Provider 适配 |
| `getSteeringMessages` | Agent 空闲检查时 | 中断当前操作的紧急消息队列，当前 tool 执行完毕后立即处理 | 实时事件注入（如用户紧急指令） |
| `getFollowUpMessages` | Agent 完全空闲时 | 等待 Agent 空闲后处理的后续消息队列 | 异步任务排队（如后台监控告警） |

```typescript
// pi-agent-core Agent 配置中的 hooks
interface AgentConfig {
  transformContext: (messages: AgentMessage[], signal: AbortSignal) => Promise<AgentMessage[]>;
  convertToLlm: (messages: AgentMessage[]) => LlmMessage[];
  getSteeringMessages: () => SteeringMessage[];
  getFollowUpMessages: () => FollowUpMessage[];
}
```

### 1.5 Claude Code 的 Sub-Agent 架构（v2.1+）

Claude Code 的 sub-agent 系统在 2026 年 2 月随 Opus 4.6 推出了重大升级：

**内置 Sub-Agents**：

| Sub-Agent | 模型 | 工具权限 | 用途 |
|-----------|------|---------|------|
| **Explore** | Haiku（快速低延迟） | 只读（无 Write/Edit） | 文件发现、代码搜索、代码库探索 |
| **Plan** | 继承主会话 | 只读 | Plan Mode 下的代码库研究 |
| **General-purpose** | 继承主会话 | 全部工具 | 复杂研究、多步操作、代码修改 |
| **Bash** | 继承主会话 | 终端命令 | 独立上下文中运行命令 |

**Agent Teams（实验性）**：2-16 个 Agent 协作，每个有独立上下文窗口。由 Team Lead 协调，通过 Shared Task List 和 Mailbox System（SendMessage 工具）实现 peer-to-peer 通信。

**Sub-Agent vs Agent Teams 的关键区别**：
- Sub-Agent：单会话内运行，只能向主 Agent 报告结果，不能互相通信
- Agent Teams：跨会话协调，独立上下文，可直接互相发消息

**自定义 Sub-Agent 配置格式**（Markdown + YAML frontmatter）：

```yaml
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
permissionMode: default
maxTurns: 50
memory: user           # 跨会话持久记忆
background: false      # 前台/后台运行
isolation: worktree    # Git worktree 隔离
mcpServers:            # 指定 MCP 服务器
  - slack
hooks:                 # 生命周期钩子
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate.sh"
---

你是一个代码审查专家。当被调用时，分析代码并提供反馈。
```

### 1.6 Claude Agent SDK 的 Hooks 体系

Claude Agent SDK（官方 SDK）提供了更丰富的 hooks，与 pi-mono 的 4 hooks 互补：

| Hook 事件 | Python SDK | TypeScript SDK | 触发时机 |
|-----------|-----------|---------------|---------|
| `PreToolUse` | Yes | Yes | 工具调用前（可阻止/修改） |
| `PostToolUse` | Yes | Yes | 工具执行后（可追加上下文） |
| `PostToolUseFailure` | Yes | Yes | 工具执行失败 |
| `UserPromptSubmit` | Yes | Yes | 用户提交提示词 |
| `Stop` | Yes | Yes | Agent 停止 |
| `SubagentStart` | Yes | Yes | Sub-Agent 启动 |
| `SubagentStop` | Yes | Yes | Sub-Agent 完成 |
| `PreCompact` | Yes | Yes | 上下文压缩前 |
| `PermissionRequest` | Yes | Yes | 权限对话框 |
| `SessionStart` | No | Yes | 会话初始化 |
| `SessionEnd` | No | Yes | 会话终止 |
| `Notification` | Yes | Yes | Agent 状态通知 |
| `TeammateIdle` | No | Yes | 队友空闲 |
| `TaskCompleted` | No | Yes | 后台任务完成 |

**Hook 回调输出结构**：

```typescript
// PreToolUse hook 输出示例
return {
  // 顶级字段：控制对话
  systemMessage: "Remember: system directories are protected.",
  continue: true,

  // hookSpecificOutput：控制当前操作
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny" | "allow" | "ask",
    permissionDecisionReason: "Writing to /etc is not allowed",
    updatedInput: { /* 修改后的工具输入 */ },
  },
};
```

---

## 2. MCP 生态系统

### 2.1 MCP 协议成熟度

| 维度 | 状态 | 评估 |
|------|------|------|
| **协议规范** | Stable（1.0+） | 生产就绪 |
| **传输层** | stdio / SSE（已废弃）/ HTTP（推荐） | HTTP 为主流 |
| **认证** | OAuth 2.0 / Bearer Token / 自定义 Header | 企业就绪 |
| **工具发现** | `list_changed` 动态更新 | 支持运行时动态注册 |
| **社区规模** | 8,600+ MCP 服务器（PulseMCP 目录）/ 1,200+ 质量验证 | 爆发式增长 |
| **企业支持** | 微软、GitHub、Sentry、Notion、Stripe 等官方维护 | 大厂全面入局 |
| **治理管控** | 管理式 MCP（`managed-mcp.json`）/ 允许/拒绝列表 | 组织级管控就绪 |

### 2.2 微软官方 MCP 服务器全景

微软在 `github.com/microsoft/mcp` 仓库提供了完整的官方 MCP 服务器目录，对我们来说这是**最关键的发现**：

#### 2.2.1 核心基础设施

| MCP 服务器 | 状态 | 描述 | 对我们的价值 |
|-----------|------|------|------------|
| **Azure MCP Server** | GA | 所有 Azure 工具合一 | Agent 部署/监控/资源管理 |
| **Microsoft Foundry MCP** | GA | 模型、知识、评估工具集 | AI 模型管理与评估 |
| **Azure DevOps MCP** | GA | DevOps 全功能 | CI/CD 集成 |
| **AKS MCP** | GA | Kubernetes 管理 | Agent 部署到客户 AKS |

#### 2.2.2 Microsoft 365 生产力（Agent 365 系列）

| MCP 服务器 | 类型 | 能力 | 对我们的价值 |
|-----------|------|------|------------|
| **M365 Calendar** | Remote（Agent 365） | 事件 CRUD、邀请管理、可用性查询 | 虚拟员工日程管理 |
| **M365 Mail** | Remote（Agent 365） | 邮件创建/发送/回复/搜索 | 虚拟员工邮件处理 |
| **M365 Copilot Chat** | Remote（Agent 365） | 搜索文档/邮件/站点/聊天 | 知识检索 |
| **M365 User** | Remote（Agent 365） | 用户详情/经理/团队信息 | 组织结构查询 |
| **Microsoft Admin Center** | Remote（Agent 365） | 管理操作 | IT 管理自动化 |
| **Teams** | Remote（Agent 365） | Teams 消息/频道 | 通信通道 |
| **SharePoint/OneDrive** | Remote（Agent 365） | 文档管理 | 文件存取 |
| **Microsoft Word** | Remote（Agent 365） | 文档处理 | 报告生成 |

#### 2.2.3 数据与分析

| MCP 服务器 | 状态 | 描述 | 对我们的价值 |
|-----------|------|------|------------|
| **Dataverse MCP** | GA | 自然语言查询业务数据 | **核心** — 直接操作 CRM/ERP 数据 |
| **Dynamics 365 ERP MCP** | 动态版 Public Preview | 自适应 ERP 数据访问 | ERP 集成 |
| **Microsoft Fabric MCP** | Public Preview | Fabric 公共 API 全访问 | 数据分析 |
| **Microsoft Clarity** | GA | 网站分析数据 | 用户行为分析 |

#### 2.2.4 Agent 365 架构（企业治理层）

**Agent 365 Tooling Gateway** 是微软为企业级 MCP 提供的治理层：

```
┌──────────────────────────────────────────┐
│           Agent 365 Control Plane         │
├──────────────────────────────────────────┤
│  ● 服务器注册与生命周期管理               │
│  ● Microsoft Entra ID 范围强制执行        │
│  ● DLP / MIP 策略执行                    │
│  ● Microsoft Sentinel + Defender 可观测性 │
│  ● M365 Admin Center 集中管控            │
├──────────────────────────────────────────┤
│         Tooling Gateway（MCP 网关）       │
├──────┬──────┬──────┬──────┬──────────────┤
│ Mail │ Cal  │Teams │ SP   │ Dataverse... │
└──────┴──────┴──────┴──────┴──────────────┘
```

**当前状态**：Agent 365 处于 Frontier Preview 阶段，需要完整 M365 Copilot 许可证。

### 2.3 社区 MCP 服务器亮点

| 类别 | 典型服务器 | 状态 |
|------|-----------|------|
| **数据库** | PostgreSQL（只读安全+Schema 内省）、SQLite | 生产就绪 |
| **文件系统** | Filesystem（细粒度访问控制+审计日志） | 生产就绪 |
| **监控** | Sentry、Datadog、PagerDuty | 企业维护 |
| **项目管理** | JIRA、Linear、Asana、Notion | 官方维护 |
| **通信** | Slack、Gmail | 官方维护 |
| **设计** | Figma | 社区维护 |
| **浏览器** | Playwright | 微软维护 |
| **支付** | Stripe | 官方维护 |

### 2.4 自建 MCP Server 难度评估

| 维度 | 评估 |
|------|------|
| **SDK 支持** | TypeScript SDK（@modelcontextprotocol/sdk）、Python SDK 均成熟 |
| **传输层** | stdio（本地开发最简单）/ HTTP（生产推荐） |
| **开发周期** | 简单工具包装：1-2 天；复杂业务逻辑：1-2 周 |
| **认证集成** | OAuth 2.0 / API Key / Entra ID 均有标准模式 |
| **测试** | 可直接用 Claude Code 的 `/mcp` 命令测试 |
| **分发** | npm 包 / Docker 容器 / 直接部署 |

```typescript
// 最简 MCP Server 示例（TypeScript）
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "dataverse-query", version: "1.0.0" });

server.tool(
  "query_records",
  "Query Dataverse records using FetchXML",
  { entity: z.string(), filter: z.string().optional() },
  async ({ entity, filter }) => {
    const result = await dataverseClient.query(entity, filter);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## 3. 可借鉴的设计模式

### 3.1 Context Management / Pruning 策略

OpenClaw/pi-mono 的上下文管理分为三层：

| 层级 | 机制 | 持久性 | 触发条件 |
|------|------|--------|---------|
| **Pruning（裁剪）** | 内存中裁剪旧 tool results | 非持久化，每次请求 | 上下文接近限制 |
| **Compaction（压缩）** | 将对话历史总结为摘要 | 持久化到 JSONL | 上下文超过 95% 容量 |
| **Memory Flush（记忆冲刷）** | 压缩前将重要内容存入长期记忆 | 持久化到 Markdown | 压缩前自动触发 |

**关键设计决策**：
- Pruning 只裁剪 tool results（不碰用户消息和关键代码片段）
- Compaction 后通常只占原始 token 数的 40% 以下
- `transformContext` hook 是自定义 pruning 策略的切入点
- Claude Code 支持 `/compact focus on the API changes` 定向压缩

**对我们的启发**：认知分区 Swarm 中，每个分区维护独立上下文，分区间通过压缩摘要通信，与此模式天然契合。

### 3.2 Session 管理和持久化

| 特性 | 实现方式 | 启发 |
|------|---------|------|
| **JSONL 格式** | 每个 session 一个 JSONL 文件，tree 结构（id/parentId） | 轻量、可追溯、支持 fork |
| **Session Fork** | `--fork-session` 创建新 session ID，保留历史 | 分支探索不影响主线 |
| **Sub-Agent Transcript** | 独立存储在 `subagents/agent-{agentId}.jsonl` | 隔离且可恢复 |
| **Auto-Memory** | Claude 自动学习并存储用户偏好和项目模式 | 跨会话知识积累 |
| **Sub-Agent Memory** | `memory: user|project|local` 三种范围 | 分区级持久知识 |

**Sub-Agent 持久记忆模式（直接可借鉴）**：

```yaml
---
name: crm-specialist
description: CRM 数据分析和操作专家
memory: project  # 项目级记忆，可版本控制
---

你是 CRM 专家。在分析数据时，将发现的模式、约定和常见问题
更新到你的 agent memory 中。下次被调用时先查阅记忆。
```

### 3.3 多通道事件路由

OpenClaw 的通道架构：

```
用户消息 → Channel Adapter → Gateway Router → Agent Session
                                   ↓
                          Channel-specific tools
                          (Discord/Telegram/Slack/WhatsApp)
```

- 每个通道有独立的 Channel Adapter（消息格式标准化）
- Gateway Router 按账户/群组/优先级分发到 Agent Session
- 群组消息 vs DM 有不同的历史记录限制
- 支持消息回复格式定制（按通道）

### 3.4 Permission 和 Governance 模型

Claude Code 的权限模型是多层分级的，直接对应我们的"治理而非约束"哲学：

```
组织策略 (managed-mcp.json / managed settings)
    ↓ 覆盖
项目策略 (.claude/settings.json)
    ↓ 覆盖
用户偏好 (~/.claude/settings.json)
    ↓ 覆盖
会话级权限 (运行时批准)
```

**允许/拒绝列表模式**：

```json
{
  "allowedMcpServers": [
    { "serverName": "dataverse" },
    { "serverUrl": "https://mcp.company.com/*" },
    { "serverCommand": ["npx", "-y", "approved-package"] }
  ],
  "deniedMcpServers": [
    { "serverUrl": "https://*.untrusted.com/*" }
  ]
}
```

**关键原则**：Deny 绝对优先于 Allow — 如果一个服务器同时匹配 allow 和 deny，一定被阻止。

### 3.5 Tool Registration 和 Discovery 机制

**MCP Tool Search**：当 MCP 工具定义超过上下文窗口 10% 时，自动切换为按需加载模式：

1. MCP 工具描述不预加载到上下文
2. Agent 使用搜索工具按需发现相关 MCP 工具
3. 只加载实际需要的工具
4. 用户体验无感知

**配置方式**：

```bash
# 自定义阈值
ENABLE_TOOL_SEARCH=auto:5 claude  # 超过 5% 就启用

# 始终启用/禁用
ENABLE_TOOL_SEARCH=true claude
ENABLE_TOOL_SEARCH=false claude
```

### 3.6 Error Recovery 和 Retry 策略

**"Ralph Wiggum" 模式（2026 年最重要的 Agent 模式之一）**：

Agent 在自主循环中持续迭代直到满足明确的成功标准，将失败转化为结构化反馈而非终止错误。

OpenClaw 的具体实现：
- **Auth Profile Rotation**：认证失败时自动轮换到下一个 API key，含冷却追踪
- **Auto-Compaction Retry**：上下文溢出时自动压缩并重试原始请求
- **Tool Result Safety**：`guardSessionManager()` 包装 SessionManager，确保 tool 结果安全
- **AbortSignal Wrapping**：所有工具执行支持取消信号

---

## 4. 生态便利

### 4.1 围绕 pi-mono 的第三方工具

| 资源 | 描述 | URL |
|------|------|-----|
| **awesome-pi-agent** | pi agent 的 add-ons、hooks、tools、skills 集合 | github.com/qualisero/awesome-pi-agent |
| **pi-messenger** | pi 的多 Agent 通信扩展 | github.com/nicobailon/pi-messenger |
| **pi-coding-agent npm** | npm 包，可直接 `npm install` | @mariozechner/pi-coding-agent |
| **pi-ai npm** | LLM 抽象层 npm 包 | @mariozechner/pi-ai |
| **pi-agent-core npm** | Agent 核心 npm 包 | @mariozechner/pi-agent-core |

### 4.2 OpenClaw Skills 生态

| 指标 | 数据 |
|------|------|
| **ClawHub 注册技能数** | 13,729+（截至2026年2月28日） |
| **awesome-openclaw-skills** | 5,400+ 过滤分类后的技能 |
| **MCP 技能占比** | 65%+ 活跃技能基于 MCP |
| **安装方式** | 一键安装，无需 Docker 或依赖管理 |

**技能分类**：Channels（消息平台连接）、Tools（Agent 能力）、Providers（AI 模型推理）、Memory Backends（持久上下文）。

### 4.3 Smart Router（模型路由器）

OpenClaw 生态中最成熟的成本优化工具：

| 路由器 | Stars | 特点 |
|--------|-------|------|
| **iblai-openclaw-router** | 热门 | 14 维度加权评分，<1ms 路由延迟 |
| **ClawRouter** | 活跃 | 41+ 模型支持，原生 Agent 路由 |
| **openclaw-model-router** | 官方 Skill | 内置三层路由 |

**三层路由架构**：

| 层级 | 模型 | 成本（/1M tokens） | 适用场景 |
|------|------|-------------------|---------|
| LIGHT | Haiku | $1 / $5 | 简单查询、状态检查、消息转发 |
| MEDIUM | Sonnet | $3 / $15 | 结构化任务、问题分类、中等推理 |
| HEAVY | Opus | $15 / $75 | 深度推理、架构分析、复杂决策 |

**14 维度评分器**：token 数量、代码存在、推理复杂度、技术深度、创造性标记、简单指标、多步模式、问题复杂度、祈使动词、约束条件、输出格式、领域特异性、agentic 任务、relay 指标。

**成本节省**：balanced 模式约 78%，aggressive 模式约 92%。

### 4.4 监控和日志工具

| 工具 | 集成方式 | 用途 |
|------|---------|------|
| **Sentry MCP** | 官方 MCP 服务器 | 错误监控 |
| **Datadog MCP** | 企业维护 | APM / 指标 |
| **PagerDuty MCP** | 企业维护 | 告警管理 |
| **Notification Hooks** | SDK 原生 | 转发到 Slack/PagerDuty |
| **PostToolUse Hooks** | SDK 原生 | 审计日志、Webhook |

### 4.5 测试和开发工具

| 工具 | 描述 |
|------|------|
| **claude mcp serve** | Claude Code 自身作为 MCP 服务器 |
| **/mcp 命令** | 在 Claude Code 内部测试 MCP 连接 |
| **claude agents** | 列出所有配置的 sub-agents |
| **/doctor** | 诊断安装问题 |
| **Session Fork** | 分支测试不影响主会话 |

---

## 5. 对我们架构的适配分析

### 5.1 认知分区 Swarm 与 MCP 协议的集成

我们的认知分区 Swarm 架构可以直接利用 MCP 协议作为工具层：

```
┌─────────────────────────────────────────────────┐
│              虚拟员工（认知分区 Swarm）            │
├─────────┬─────────┬─────────┬──────────────────┤
│ CRM 分区 │ 邮件分区 │ 日程分区 │ 文档分区         │
│(Dataverse│(M365    │(M365    │(SharePoint      │
│ MCP)     │ Mail    │ Calendar│ MCP)            │
│          │ MCP)    │ MCP)    │                  │
├─────────┴─────────┴─────────┴──────────────────┤
│            MCP Tool Search（按需加载）            │
├─────────────────────────────────────────────────┤
│            Agent 365 Tooling Gateway            │
│    (Entra ID / DLP / MIP / Sentinel 治理)       │
├─────────────────────────────────────────────────┤
│         微软 M365 / Dataverse / Azure            │
└─────────────────────────────────────────────────┘
```

**关键设计**：
1. 每个认知分区配置自己的 MCP 服务器集合（通过 sub-agent 的 `mcpServers` 字段）
2. 利用 MCP Tool Search 避免上下文膨胀（当工具超过 10% 上下文时自动启用）
3. Agent 365 Tooling Gateway 提供企业级治理（Entra ID 范围、DLP、审计）
4. 自建 MCP 服务器处理 Agent 365 未覆盖的场景

### 5.2 pi-mono Hooks 与 OpenClaw 生态的对接

| pi-mono Hook | 认知分区 Swarm 中的应用 | 对接的生态工具 |
|-------------|----------------------|--------------|
| `transformContext` | 分区间上下文隔离；pruning 策略按分区定制 | OpenClaw 的 Context Pruning 扩展可直接复用 |
| `convertToLlm` | 多模型适配（分区可用不同 Provider） | Smart Router 的 14 维度评分器集成于此 |
| `getSteeringMessages` | 紧急事件注入（用户中断、系统告警） | 通道适配器产生的实时消息 |
| `getFollowUpMessages` | 异步任务排队（后台监控、定时检查） | Cron 技能、Notification hooks |

**具体集成示例**：

```typescript
// 在 transformContext 中实现认知分区隔离
const crmPartitionTransform: TransformContext = async (messages, signal) => {
  // 1. 裁剪超过 TTL 的旧消息
  const pruned = pruneByTTL(messages, { maxAge: '2h' });

  // 2. 注入分区特定上下文（从 Dataverse MCP 获取的最新数据）
  const crmContext = await fetchLatestCrmContext();
  pruned.push({
    role: 'system',
    content: `[CRM 上下文更新] ${crmContext}`,
  });

  // 3. 确保总 token 数在预算内
  return fitTokenBudget(pruned, { maxTokens: 80000 });
};

// 在 convertToLlm 中集成 Smart Router
const smartRouterConvert: ConvertToLlm = (messages) => {
  const complexity = scoreComplexity(messages); // 14 维度评分
  const targetModel = routeToModel(complexity); // LIGHT/MEDIUM/HEAVY

  return convertMessages(messages, {
    model: targetModel,
    filterImages: targetModel === 'haiku', // Haiku 不处理图片
  });
};
```

### 5.3 Smart Router 实现方案

基于 OpenClaw 生态的 Smart Router 模式，我们可以为认知分区 Swarm 实现分层路由：

```typescript
interface RoutingConfig {
  tiers: {
    light: { model: 'haiku'; maxComplexity: 30; costPer1M: [1, 5] };
    medium: { model: 'sonnet'; maxComplexity: 70; costPer1M: [3, 15] };
    heavy: { model: 'opus'; maxComplexity: 100; costPer1M: [15, 75] };
  };

  // 按认知分区定制路由阈值
  partitionOverrides: {
    'crm-query': { defaultTier: 'light'; escalateOn: ['complex_filter', 'analysis'] };
    'email-draft': { defaultTier: 'medium'; escalateOn: ['negotiation', 'legal'] };
    'strategy-planning': { defaultTier: 'heavy'; alwaysHeavy: true };
  };

  // 渐进式升级：先用便宜模型尝试，失败后升级
  progressiveEscalation: boolean;
}
```

**预期成本优化**：大部分虚拟员工日常任务（CRM 查询、邮件回复、日程安排）可路由到 LIGHT/MEDIUM 层，仅复杂决策升级到 HEAVY，整体成本降低 60-80%。

### 5.4 政府云 / 数据主权约束

| 约束 | 应对方案 | 2026 年状态 |
|------|---------|------------|
| **数据驻留** | 微软在 15 个国家提供本地数据处理（2026年底） | 澳/印/日/英已就绪，11 国年内上线 |
| **断网运行** | Azure Local 断网模式（2026年初 GA） | Exchange/SharePoint/Skype 可本地部署 |
| **机密计算** | Confidential Computing + 客户管理密钥 | Azure 原生支持 |
| **MCP 部署** | stdio 模式 MCP 服务器可完全本地运行 | 无外部依赖 |
| **模型部署** | Azure AI Foundry + vLLM on AKS | 支持完全私有部署 |
| **合规认证** | FedRAMP / IRAP / CSA STAR | 微软云已具备 |

**关键策略**：
1. **MCP 服务器选择 stdio 传输**：避免外部网络依赖，完全在客户租户内运行
2. **Azure Local 部署选项**：为断网政府客户提供 M365 Local + 本地 MCP 方案
3. **Entra ID 强制执行**：所有 MCP 调用通过 Entra ID 认证，继承客户既有 IAM 策略
4. **Agent 365 治理层**：利用微软原生的 DLP/MIP/Sentinel 满足合规要求

### 5.5 推荐架构集成路径

```
Phase 1: 基础层
├── 采用 pi-mono (pi-ai + pi-agent-core + pi-coding-agent) 作为核心引擎
├── 实现认知分区 Sub-Agent（复用 Claude Code 的 sub-agent 配置格式）
├── 集成微软官方 MCP 服务器（Dataverse + M365 Mail + Calendar）
└── 实现基本的 transformContext（分区隔离）

Phase 2: 优化层
├── 集成 Smart Router（基于 iblai-openclaw-router 14 维度评分）
├── 实现 MCP Tool Search（按需工具加载，控制上下文成本）
├── 添加 Sub-Agent 持久记忆（memory: project）
└── 接入 Agent 365 Tooling Gateway（企业治理）

Phase 3: 生产化
├── 自建政府专用 MCP 服务器（Power Platform + 自定义业务逻辑）
├── 实现 Hook 链（审计日志 → 权限验证 → 输入清洗 → 速率限制）
├── 部署多通道事件路由（Teams + Email + Power Automate）
└── Azure Local 断网部署方案
```

---

## 6. 关键发现总结

### 6.1 最重要的 5 个发现

1. **pi-mono 已通过大规模验证**：OpenClaw 247K stars 证明 pi-mono 的 AgentSession 架构可以支撑海量并发，是我们核心引擎的可靠选择

2. **微软 MCP 服务器已覆盖全栈**：25+ 官方 MCP 服务器覆盖 M365、Dataverse、Azure、DevOps 全场景，Agent 365 Tooling Gateway 提供企业级治理，我们无需从零构建集成层

3. **Smart Router 可节省 60-80% 成本**：OpenClaw 生态的模型路由器已验证 14 维度评分 + 三层路由的有效性，可直接借鉴到我们的认知分区架构

4. **Sub-Agent + Memory 模式是认知分区的天然映射**：Claude Code 的 sub-agent 配置格式（Markdown + YAML frontmatter）+ 持久记忆可直接复用为认知分区定义

5. **MCP Tool Search 解决了工具膨胀问题**：当虚拟员工有大量 MCP 工具时，按需加载机制避免上下文窗口被工具定义占满

### 6.2 对 docs/02-technical-architecture.md 的建议更新

以下结论应合并到架构决策文档：

| 决策项 | 建议 |
|--------|------|
| 工具集成层 | 采用 MCP 协议 + 微软官方 MCP 服务器为主，自建服务器为辅 |
| 上下文管理 | 采用三层策略（Pruning → Compaction → Memory Flush），通过 `transformContext` hook 定制 |
| 成本优化 | 实现 Smart Router（14 维度评分 + 三层模型路由），目标成本降低 60%+ |
| 认知分区定义 | 采用类 Claude Code sub-agent 格式（YAML frontmatter + System Prompt） |
| 企业治理 | 利用 Agent 365 Tooling Gateway（Entra ID + DLP + Sentinel），补充自建审计层 |
| 政府部署 | stdio MCP + Azure Local 断网模式 + Confidential Computing |

---

## 参考来源

- [OpenClaw GitHub](https://github.com/openclaw/openclaw) — 247K+ stars 开源项目
- [pi-mono GitHub](https://github.com/badlogic/pi-mono) — AI agent toolkit 核心
- [Claude Code 官方文档](https://code.claude.com/docs/en/how-claude-code-works) — 架构和工具文档
- [Claude Code Sub-Agents](https://code.claude.com/docs/en/sub-agents) — 子代理配置完整指南
- [Claude Code MCP](https://code.claude.com/docs/en/mcp) — MCP 集成详细文档
- [Claude Agent SDK Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks) — SDK hooks 完整参考
- [microsoft/mcp GitHub](https://github.com/microsoft/mcp) — 微软官方 MCP 服务器目录
- [Agent 365 Overview](https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview) — 企业级 MCP 网关
- [Dataverse MCP Server](https://www.microsoft.com/en-us/power-platform/blog/2025/07/07/dataverse-mcp/) — Dataverse MCP 集成
- [Dynamics 365 ERP MCP](https://www.microsoft.com/en-us/dynamics-365/blog/it-professional/2025/11/11/dynamics-365-erp-model-context-protocol/) — ERP MCP 服务器
- [pi-coding-agent Extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) — 扩展系统完整文档
- [iblai-openclaw-router](https://github.com/iblai/iblai-openclaw-router) — Smart Router 成本优化
- [awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills) — 5,400+ 技能合集
- [OpenClaw vs Claude Code](https://claudefa.st/blog/tools/extensions/openclaw-vs-claude-code) — 2026 比较指南
- [Microsoft Sovereign Cloud](https://blogs.microsoft.com/blog/2026/02/24/microsoft-sovereign-cloud-adds-governance-productivity-and-support-for-large-ai-models-securely-running-even-when-completely-disconnected/) — 主权云 2026 更新
- [PulseMCP Directory](https://www.pulsemcp.com/servers) — 8,600+ MCP 服务器目录
