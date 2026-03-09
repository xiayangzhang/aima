# Claude Agent SDK 与 OpenClaw 生态深度研究

> 研究日期：2026-03-06
> 研究背景：为认知分区 Swarm 架构寻找可借鉴的设计模式和生态便利
> 关联报告：[07-openclaw-architecture.md](07-openclaw-architecture.md)（OpenClaw 源码分析）、[16-token-rich-autonomous-agent.md](16-token-rich-autonomous-agent.md)（认知分区 Swarm 设计）

---

## 目录

1. [研究总览与关键发现](#1-研究总览与关键发现)
2. [Claude Agent SDK 架构深度分析](#2-claude-agent-sdk-架构深度分析)
3. [Agent Teams — 多 Agent 协作机制](#3-agent-teams--多-agent-协作机制)
4. [OpenClaw 2026 生态现状](#4-openclaw-2026-生态现状)
5. [MCP 生态系统](#5-mcp-生态系统)
6. [Claude Agent SDK × Microsoft Agent Framework 集成](#6-claude-agent-sdk--microsoft-agent-framework-集成)
7. [面向认知分区 Swarm 的设计借鉴](#7-面向认知分区-swarm-的设计借鉴)
8. [生态兼容性价值评估](#8-生态兼容性价值评估)
9. [具体可复用的架构模式和代码参考](#9-具体可复用的架构模式和代码参考)
10. [结论与建议](#10-结论与建议)

---

## 1. 研究总览与关键发现

### 1.1 核心发现

**Claude Agent SDK（原 Claude Code SDK）** 已经从一个编码工具的 SDK 演变为一个通用的 Agent 构建框架。截至 2026 年 3 月：

- **Agent Loop** 是一个单线程主循环（gather context → take action → verify → repeat），不是复杂的多 Agent 系统
- **Subagent** 机制支持 spawn 独立子 Agent，有上下文隔离、工具限制、模型选择（Opus/Sonnet/Haiku）
- **Agent Teams**（实验性）支持多个 Claude 实例协作，有共享任务列表和直接通信
- **Server-side Compaction** 实现了接近无限的上下文窗口
- **Hooks** 系统提供了完整的生命周期拦截，可以实现 guardrails
- **MCP 生态** 已有 1000+ 社区 server，覆盖主要开发工具和 SaaS
- **Microsoft Agent Framework 集成** 已在 2026 年 1 月落地，Claude Agent 可以与 Azure OpenAI、GitHub Copilot 等 Agent 混合编排

**OpenClaw** 从 2025 年 11 月的周末项目成长为 60,000+ GitHub stars 的开源项目：
- "轻内核、重插件"架构，ClawHub 上有 13,700+ 社区 Skills
- WebSocket Gateway 统一控制面
- 安全问题严重 —— 12-20% 的 ClawHub Skills 被审计为恶意，有 CVE-2026-25253 RCE 漏洞

### 1.2 对我们项目的核心价值

| 维度 | Claude Agent SDK | OpenClaw |
|------|-----------------|----------|
| **直接复用价值** | 高 — SDK 可作为 Agent Loop 的底层引擎 | 低 — 架构不适合企业级多租户 |
| **设计借鉴价值** | 高 — Subagent、Hooks、Compaction、Permissions | 中 — Skill 系统、Gateway 模式 |
| **生态兼容价值** | 极高 — MCP 生态、MS Agent Framework 集成 | 低 — ClawHub 安全问题，不适合企业 |
| **认知分区适配度** | 高 — Subagent 天然对应认知分区 | 低 — 单用户设计，无法直接映射 |

---

## 2. Claude Agent SDK 架构深度分析

### 2.1 核心理念："给 Agent 一台电脑，不只是一个 Prompt"

Claude Agent SDK 不是一个 API wrapper，而是一个完整的 Agent 运行时环境，提供：
- 终端访问（Bash）
- 文件系统访问（Read/Write/Edit/Glob/Grep）
- Web 访问（WebSearch/WebFetch）
- MCP 协议扩展

**这与我们的治理型 Agent 哲学高度契合** —— 给 Agent 能力和边界，让它自主决策如何完成任务。

### 2.2 Agent Loop 设计

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Loop (单线程)                     │
│                                                          │
│   ┌───────────┐    ┌───────────┐    ┌───────────┐       │
│   │  Gather   │───>│   Take    │───>│  Verify   │──┐    │
│   │  Context  │    │  Action   │    │   Work    │  │    │
│   └───────────┘    └───────────┘    └───────────┘  │    │
│        ^                                            │    │
│        └────────────────────────────────────────────┘    │
│                                                          │
│   Hooks: PreToolUse → [执行] → PostToolUse → Stop       │
│                                                          │
│   Compaction: ~95% 容量时自动总结旧上下文                   │
│                                                          │
│   Session: 可持久化、可恢复、可 fork                        │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

关键特性：
- **单线程主循环** —— 简单但有效，30+ 小时持续运行已被观察到
- **Server-side Compaction** —— 接近 200K token 时自动总结，Subagent transcript 不受影响
- **Session 持久化** —— session_id 可保存和恢复，实现跨会话连续性

### 2.3 Subagent 机制 — 核心参考

Subagent 是 Claude Agent SDK 最值得我们借鉴的设计。三种创建方式：

#### 方式 1：编程定义（SDK 推荐）

```python
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition

async for message in query(
    prompt="Review the authentication module",
    options=ClaudeAgentOptions(
        allowed_tools=["Read", "Grep", "Glob", "Task"],  # Task = 子 Agent 调用
        agents={
            "code-reviewer": AgentDefinition(
                description="Expert code reviewer for security reviews.",
                prompt="Analyze code quality and suggest improvements.",
                tools=["Read", "Glob", "Grep"],  # 只读工具 = 安全约束
                model="sonnet",  # 可以选择不同模型
            ),
            "test-runner": AgentDefinition(
                description="Runs and analyzes test suites.",
                prompt="Run tests and provide clear analysis.",
                tools=["Bash", "Read", "Grep"],  # 可执行命令
            ),
        },
    ),
):
    if hasattr(message, "result"):
        print(message.result)
```

#### 方式 2：文件系统定义（Claude Code 原生）

```markdown
<!-- .claude/agents/code-reviewer.md -->
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
permissionMode: plan        # 只读模式
memory: user                # 跨会话记忆
maxTurns: 50
skills:
  - api-conventions
  - error-handling-patterns
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-command.sh"
---

You are a code reviewer. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

#### 方式 3：CLI 传入（临时/自动化）

```bash
claude --agents '{
  "code-reviewer": {
    "description": "Expert code reviewer.",
    "prompt": "Review code for quality and security.",
    "tools": ["Read", "Grep", "Glob"],
    "model": "sonnet"
  }
}'
```

### 2.4 AgentDefinition 配置模型

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string (必须) | 何时使用此 Agent 的自然语言描述 |
| `prompt` | string (必须) | Agent 的 system prompt |
| `tools` | string[] | 允许的工具列表，省略则继承所有 |
| `disallowedTools` | string[] | 禁止的工具列表 |
| `model` | 'sonnet'\|'opus'\|'haiku'\|'inherit' | 模型选择 |
| `permissionMode` | 枚举 | default/acceptEdits/dontAsk/bypassPermissions/plan |
| `maxTurns` | number | 最大 agentic 轮数 |
| `skills` | string[] | 启动时注入的技能 |
| `mcpServers` | object | 可用的 MCP server |
| `hooks` | object | 生命周期钩子 |
| `memory` | 'user'\|'project'\|'local' | 持久化记忆范围 |
| `background` | boolean | 是否后台运行 |
| `isolation` | 'worktree' | git worktree 隔离 |

**关键设计约束：Subagent 不能 spawn 自己的 Subagent**（单层限制）。

### 2.5 Hooks 系统 — 治理机制

Hooks 是实现"治理而非约束"的核心机制：

```python
from claude_agent_sdk import query, ClaudeAgentOptions, HookMatcher

async def audit_file_change(input_data, tool_use_id, context):
    """审计所有文件变更"""
    file_path = input_data.get("tool_input", {}).get("file_path", "unknown")
    with open("./audit.log", "a") as f:
        f.write(f"{datetime.now()}: modified {file_path}\n")
    return {}  # 空 = 允许继续

async def block_dangerous_command(input_data, tool_use_id, context):
    """阻止危险命令"""
    command = input_data.get("tool_input", {}).get("command", "")
    if "rm -rf" in command or "DROP TABLE" in command:
        return {"error": "Blocked: dangerous command"}  # 阻止执行
    return {}

async for message in query(
    prompt="Refactor the codebase",
    options=ClaudeAgentOptions(
        permission_mode="acceptEdits",
        hooks={
            "PostToolUse": [
                HookMatcher(matcher="Edit|Write", hooks=[audit_file_change])
            ],
            "PreToolUse": [
                HookMatcher(matcher="Bash", hooks=[block_dangerous_command])
            ],
        },
    ),
):
    pass
```

**可用 Hook 事件：**

| 事件 | 触发时机 | 用途 |
|------|---------|------|
| `PreToolUse` | 工具执行前 | 验证、拦截、修改输入 |
| `PostToolUse` | 工具执行后 | 审计、日志、触发后续 |
| `Stop` | Agent 停止时 | 清理、报告 |
| `SessionStart` | 会话开始 | 初始化 |
| `SessionEnd` | 会话结束 | 持久化 |
| `SubagentStart` | 子 Agent 启动 | 配置注入 |
| `SubagentStop` | 子 Agent 完成 | 结果收集 |
| `TeammateIdle` | 队友空闲 | 重新分配任务 |
| `TaskCompleted` | 任务完成 | 质量门控 |

### 2.6 上下文管理与 Compaction

**Server-Side Compaction（推荐）：**
- API 端 `context_management.edits` (beta compact-2026-01-12)
- 当对话接近 200K token 限制时自动总结旧上下文
- Subagent transcript 独立存储，不受主对话 compaction 影响
- 支持 `pause_after_compaction` 参数用于追踪 compaction 事件

**SDK-Side Compaction（备选）：**
- 可使用更便宜的模型做总结
- 更多控制权但更复杂

**对我们的价值：** 虚拟员工需要长时间运行（数小时到数天），compaction 是必需的基础设施。

### 2.7 Permission 系统

四层权限控制：

```
1. allowed_tools  — 白名单（只有这些工具可用）
2. disallowedTools — 黑名单（排除特定工具）
3. permissionMode  — 模式控制（plan=只读, dontAsk=自动拒绝, bypassPermissions=跳过所有）
4. canUseTool 回调 — 运行时动态决定（最细粒度）
```

---

## 3. Agent Teams — 多 Agent 协作机制

### 3.1 架构概览

Agent Teams 是 Claude Code 的实验性多 Agent 协作功能（2026 年 1 月发现，feature flag 控制）。

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Team                                │
│                                                                  │
│   ┌─────────────┐                                               │
│   │  Team Lead  │  ← 你与此交互                                  │
│   │  (主会话)    │                                               │
│   └──────┬──────┘                                               │
│          │                                                       │
│   ┌──────┴──────────────────────────────────┐                   │
│   │           Shared Task List               │                   │
│   │  (pending → in_progress → completed)     │                   │
│   │  (支持任务依赖)                            │                   │
│   └──────┬──────────┬──────────┬────────────┘                   │
│          │          │          │                                  │
│   ┌──────▼───┐ ┌───▼─────┐ ┌─▼────────┐                       │
│   │Teammate A│ │Teammate B│ │Teammate C│  ← 独立上下文窗口      │
│   │(Security)│ │(Perf)    │ │(Tests)   │                       │
│   └──────────┘ └─────────┘ └──────────┘                        │
│          ↕           ↕           ↕                               │
│      直接消息（Mailbox 系统）                                     │
│                                                                  │
│   存储: ~/.claude/teams/{name}/config.json                       │
│         ~/.claude/tasks/{name}/                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Agent Teams vs Subagents 对比

| 维度 | Subagents | Agent Teams |
|------|-----------|-------------|
| **上下文** | 独立窗口，结果返回调用者 | 独立窗口，完全独立 |
| **通信** | 只能向主 Agent 报告 | 队友之间直接通信 |
| **协调** | 主 Agent 管理所有工作 | 共享任务列表 + 自协调 |
| **适用场景** | 聚焦任务，只需结果 | 需要讨论和协作的复杂工作 |
| **Token 成本** | 低（结果摘要回主上下文） | 高（每个队友独立实例） |
| **嵌套** | 不可嵌套 | 不可嵌套 |

### 3.3 关键协调机制

**任务列表系统：**
- 三种状态：pending → in_progress → completed
- 支持任务依赖（有依赖的任务需等待前置完成）
- 文件锁定防止并发 claim 冲突
- Lead 可分配任务，Teammate 也可自行 claim

**通信系统（Mailbox）：**
- `message` — 一对一消息
- `broadcast` — 广播给所有队友（慎用，成本随人数线性增长）
- 自动消息送达 + 空闲通知

**质量门控（Hooks）：**
- `TeammateIdle` — 队友空闲时触发，exit code 2 可以发送反馈让队友继续工作
- `TaskCompleted` — 任务完成时触发，exit code 2 阻止标记完成并发送反馈

**Plan Approval 模式：**
- 要求队友先制定计划，Lead 审批后才能执行
- 拒绝时附带反馈，队友修改后重新提交

### 3.4 真实案例：16 Agent 并行编译器项目

Anthropic 工程博客报道了一个案例：
- 16 个 Agent 并行工作
- 用 Rust 编写 C 编译器
- 近 2,000 个 Claude Code sessions
- $20,000 API 成本
- 产出 100,000 行代码
- 可编译 Linux 6.9（x86, ARM, RISC-V）

这证明了 Agent Teams 在大规模并行任务上的可行性。

### 3.5 局限性

- **实验性** —— 默认关闭，需手动启用
- **Session 不可恢复** —— 恢复时 in-process 队友丢失
- **一个 Team/Session** —— 不能嵌套
- **Lead 固定** —— 不能转移领导权
- **权限统一** —— Spawn 时所有队友继承 Lead 权限

---

## 4. OpenClaw 2026 生态现状

### 4.1 架构演进

从 2025 年 11 月的 "Clawdbot" 到 2026 年 3 月的 OpenClaw：

```
                  OpenClaw 架构

┌─────────────────────────────────────────────┐
│              Gateway Server                  │
│          (WebSocket, port 18789)             │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Channel  │  │  Agent   │  │  Skill    │ │
│  │ Manager  │  │  Runtime │  │  Runtime  │ │
│  │          │  │          │  │ (动态注入)  │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │   WS     │  │  Plugin  │  │  Session  │ │
│  │  Control │  │  Registry│  │  Manager  │ │
│  │  Plane   │  │          │  │ (持久化)   │ │
│  └──────────┘  └──────────┘  └───────────┘ │
└─────────────────────────────────────────────┘
         ↑              ↑              ↑
    Telegram        ClawHub         Memory
    WhatsApp       (13,700+        (Local
    Slack           Skills)         SQLite)
    Discord
    iMessage
    Teams
    Signal
```

核心设计：**轻内核、重插件**
- 核心包 ~8MB（2026 重构后）
- 模型 provider 也是外部包
- Skill 运行时选择性注入（不是全部加载到 prompt）

### 4.2 ClawHub 技能生态

截至 2026 年 2 月 28 日：
- **13,729 个社区 Skills**
- 分类包括：Calendar、Email、Smart Home、Development、Finance 等
- 使用信号：stars、downloads 用于排名

**安全问题（重大）：**
- 安全审计发现 **12-20% 的 Skills 为恶意**
- **ClawHavoc 事件** —— 导致 ClawHub 强制身份验证
- **CVE-2026-25253** —— 严重 RCE 漏洞
- **135,000+ 暴露实例** 被安全研究人员发现

### 4.3 OpenClaw vs Claude Code 定位对比

| 维度 | OpenClaw | Claude Code |
|------|----------|-------------|
| **定位** | 通用生活助手 | 编码 Agent（正在泛化） |
| **运行方式** | 持续运行的 Gateway daemon | 终端 CLI / SDK 调用 |
| **记忆** | 持久化（跨会话，数周/数月） | 基于 session + CLAUDE.md |
| **Agent Loop** | 持续轮询 API（即使空闲） | 按需执行（事件驱动） |
| **安全性** | 问题严重（RCE、恶意 Skills） | 沙箱 + 细粒度权限 |
| **多 Agent** | 无原生支持 | Subagent + Agent Teams |
| **MCP** | 支持但通过 Skills 间接 | 一等公民，深度集成 |

### 4.4 对我们的结论

**OpenClaw 不适合作为企业级虚拟员工的核心框架**，但其 Skill 系统的"发现→选择性注入"模式值得借鉴。07 报告中的源码分析已覆盖可复用的设计模式。

---

## 5. MCP 生态系统

### 5.1 生态规模（2026 年 3 月）

- **1,000+ 社区 MCP Server**
- **200+ 经过验证的 Server**（Anthropic 维护的列表）
- 三种传输模式：stdio、SSE、HTTP Streamable

### 5.2 关键 MCP Server

| Server | 维护方 | 工具数量 | 用途 |
|--------|-------|---------|------|
| `@modelcontextprotocol/server-github` | Anthropic | 15 | Issues, PRs, Search（92% 采用率） |
| `@modelcontextprotocol/server-postgres` | Anthropic | - | 数据库查询 |
| `@playwright/mcp` | Microsoft | - | 浏览器自动化 |
| `server-filesystem` | 社区 | - | 文件系统操作 |
| `server-linear` | 社区 | - | 项目管理 |
| `server-figma` | 社区 | - | 设计稿读取 |
| `server-slack` | 社区 | - | Slack 消息操作 |

### 5.3 MCP 在我们架构中的价值

**Claude Code 既是 MCP Client 又是 MCP Server：**

作为 Client：消费其他 MCP Server 提供的工具
作为 Server：暴露自己的工具（Bash, Read, Write, Edit, LS, GrepTool, GlobTool, Replace）

**对虚拟员工平台的直接价值：**

1. **工具生态复用** —— 1000+ 现成 MCP Server 可直接给 Agent 使用
2. **Power Platform 集成** —— 可以开发 MCP Server 封装 Dataverse/Graph API
3. **标准化接口** —— Agent 的工具调用通过 MCP 标准化，便于扩展
4. **社区贡献** —— 客户可以为其特定系统开发 MCP Server

### 5.4 MCP Server 配置示例

```python
# 在 Claude Agent SDK 中使用 MCP Server
async for message in query(
    prompt="Check our Dataverse records",
    options=ClaudeAgentOptions(
        mcp_servers={
            # 浏览器自动化
            "playwright": {
                "command": "npx",
                "args": ["@playwright/mcp@latest"]
            },
            # 自定义 Dataverse Server
            "dataverse": {
                "command": "python",
                "args": ["-m", "dataverse_mcp_server"],
                "env": {
                    "DATAVERSE_URL": "https://org.crm.dynamics.com",
                    "DATAVERSE_AUTH": "entra_token"
                }
            }
        }
    ),
):
    pass
```

---

## 6. Claude Agent SDK × Microsoft Agent Framework 集成

### 6.1 集成概况

2026 年 1 月，Microsoft Agent Framework（AutoGen + Semantic Kernel 的合并产品）正式集成了 Claude Agent SDK。

**关键能力：**
- Claude Agent 实现 `BaseAgent` 接口 —— 与所有 MS Agent 框架 Agent 兼容
- 混合编排 —— Claude + Azure OpenAI + GitHub Copilot 在同一工作流
- 编排模式 —— Sequential、Concurrent、Handoff、Group Chat
- 双 SDK 可用 —— Python 和 .NET

### 6.2 对我们架构的影响

这个集成直接影响了我们在 `14-microsoft-agent-framework-evaluation.md` 中讨论的核心选型：

```
我们原来的选型思路：
  方案 A: 自研 Agent 编排（pi-agent-core）
  方案 D: MS Agent Framework 做编排核心

现在的新选项：
  方案 E: Claude Agent SDK 做认知核心 + MS Agent Framework 做执行集成

具体地说：
  ┌──────────────────────────────────────────────────┐
  │           Claude Agent SDK (认知层)                │
  │   - Agent Loop (推理+决策)                         │
  │   - Subagent 机制 (认知分区)                       │
  │   - Hooks (治理机制)                               │
  │   - MCP (工具扩展)                                 │
  │   - Compaction (长时运行)                          │
  └───────────────────────┬────────────────────────────┘
                          │ BaseAgent 接口
  ┌───────────────────────▼────────────────────────────┐
  │       Microsoft Agent Framework (编排+执行层)        │
  │   - 多 Agent 编排 (Sequential, Handoff, etc.)       │
  │   - Azure 基础设施集成                               │
  │   - Semantic Kernel Plugins (Dataverse, Graph)      │
  │   - 企业级遥测和合规                                  │
  └─────────────────────────────────────────────────────┘
```

这个方案的优势：
1. 利用 Claude Agent SDK 的成熟 Agent Loop 和上下文管理
2. 利用 MS Agent Framework 的企业级编排和 Azure 集成
3. MCP 生态兼容
4. 不需要从零构建 Agent Loop

---

## 7. 面向认知分区 Swarm 的设计借鉴

### 7.1 认知分区 ↔ Subagent 映射

我们的认知分区 Swarm 设计：一个虚拟员工 = 多个专职 Agent（认知区域），对外像一个人。

Claude Agent SDK 的 Subagent 机制天然可以映射到这个设计：

```
认知分区 Swarm                    Claude Agent SDK 映射
──────────────                    ──────────────────
虚拟员工 "Alice"           →      Main Agent (Coordinator)
├── 执行脑 (Action Brain)  →      Subagent: "executor" (tools: Bash, Write, Edit)
├── 分析脑 (Analysis Brain)→      Subagent: "analyzer" (tools: Read, Grep, model: opus)
├── 沟通脑 (Comm Brain)    →      Subagent: "communicator" (MCP: teams, email)
├── 记忆脑 (Memory Brain)  →      Subagent: "memory-keeper" (memory: project)
└── 审计脑 (Audit Brain)   →      Hooks: PreToolUse + PostToolUse
```

### 7.2 可直接复用的 Claude Agent SDK 模式

#### 模式 1：异构模型路由

```python
# Opus 做复杂推理/决策，Sonnet 做执行，Haiku 做快速探索
agents = {
    "strategic-planner": AgentDefinition(
        description="Complex strategic decisions and planning",
        prompt="You are a strategic planner...",
        model="opus",  # 贵但强大
        tools=["Read", "Grep", "WebSearch"],
    ),
    "executor": AgentDefinition(
        description="Execute planned tasks efficiently",
        prompt="You are a task executor...",
        model="sonnet",  # 平衡
        tools=["Bash", "Edit", "Write"],
    ),
    "scout": AgentDefinition(
        description="Quick exploration and information gathering",
        prompt="You are a fast scout...",
        model="haiku",  # 快且便宜
        tools=["Read", "Glob", "Grep"],
    ),
}
```

**价值：** 与我们的 Token-Rich Agent 理念完美契合 —— 在需要深度推理时投入更多 token/更强模型。

#### 模式 2：持久化记忆

```markdown
<!-- .claude/agents/domain-expert.md -->
---
name: domain-expert
description: Domain expert that learns from each interaction
memory: project  # 项目级持久记忆
---

You are a domain expert. As you work:
- Read your memory at startup for accumulated knowledge
- Update memory with new patterns and insights discovered
- Memory directory: .claude/agent-memory/domain-expert/
```

记忆系统的设计：
- `user` 级：跨所有项目（如个人工作习惯）
- `project` 级：项目特定知识（如代码库模式）
- `local` 级：本地不入库的知识

**价值：** 认知分区 Swarm 中每个"脑"都需要积累经验。这个记忆系统直接可用。

#### 模式 3：动态 Agent 工厂

```python
def create_cognitive_partition(
    role: str,
    expertise: str,
    security_level: str,
    customer_context: dict,
) -> AgentDefinition:
    """根据运行时条件动态创建认知分区"""

    # 根据安全级别选择模型和工具
    if security_level == "high":
        model = "opus"
        tools = ["Read", "Grep"]  # 只读
    else:
        model = "sonnet"
        tools = ["Read", "Write", "Edit", "Bash"]

    # 根据客户上下文注入特定知识
    customer_prompt = f"""
    Customer: {customer_context['name']}
    Industry: {customer_context['industry']}
    Systems: {', '.join(customer_context['systems'])}
    """

    return AgentDefinition(
        description=f"{role} specialist for {expertise}",
        prompt=f"""You are a {role} with expertise in {expertise}.

{customer_prompt}

Follow these governance policies:
- Always log decisions
- Escalate when confidence < 70%
- Never modify production data without approval""",
        tools=tools,
        model=model,
    )
```

**价值：** 每个虚拟员工的认知分区可以根据客户、行业、安全级别动态配置。

#### 模式 4：治理 Hooks 链

```python
# 三层治理：预检 → 执行 → 审计
hooks = {
    "PreToolUse": [
        # 1. 合规检查
        HookMatcher(
            matcher="Bash|Write|Edit",
            hooks=[compliance_check]  # 检查是否违反政策
        ),
        # 2. 成本控制
        HookMatcher(
            matcher=".*",
            hooks=[cost_gate]  # 检查 token/API 预算
        ),
    ],
    "PostToolUse": [
        # 3. 审计日志
        HookMatcher(
            matcher=".*",
            hooks=[audit_logger]  # 记录所有操作
        ),
    ],
    "Stop": [
        # 4. 完成报告
        HookMatcher(hooks=[generate_completion_report])
    ],
}
```

### 7.3 Agent Teams 对认知分区的启示

Agent Teams 的设计给了我们重要启示，但也有关键差异：

**可借鉴：**
- **共享任务列表 + 自协调** —— 认知分区之间可以通过类似机制协调
- **Mailbox 直接通信** —— 分区之间不一定都要经过 Coordinator
- **Plan Approval 模式** —— 重要决策需要"主意识"审批
- **TeammateIdle/TaskCompleted Hooks** —— 质量门控机制

**需要超越：**
- Agent Teams 没有"统一意识"概念 —— 我们的认知分区需要共享意识状态
- Agent Teams 是扁平结构 —— 我们需要层次化的认知分区
- Agent Teams 不支持嵌套 —— 我们的分区可能需要递归分解
- Agent Teams 每个队友是独立上下文 —— 我们需要共享上下文子集（统一意识）

---

## 8. 生态兼容性价值评估

### 8.1 兼容 Claude Agent SDK 生态的价值

| 生态能力 | 获得的便利 | 实现难度 |
|---------|----------|---------|
| **MCP 工具生态** | 1000+ 现成工具 server，无需自己封装 | 低 — 标准协议 |
| **内置工具** | Read/Write/Edit/Bash/Glob/Grep 开箱即用 | 零 — SDK 自带 |
| **Server-side Compaction** | 长时运行不需自己实现上下文管理 | 零 — API 级别 |
| **Session 管理** | 会话持久化、恢复、fork 不需自己实现 | 零 — SDK 自带 |
| **MS Agent Framework** | 与 Azure OpenAI、Copilot 等混合编排 | 中 — 需要适配 |
| **Hooks 系统** | 治理/审计机制不需从零开发 | 低 — SDK 原生 |
| **模型路由** | Opus/Sonnet/Haiku 按需选择无需自己实现 | 零 — SDK 自带 |

### 8.2 不兼容 OpenClaw 生态的理由

| 风险 | 严重程度 |
|------|---------|
| 12-20% 恶意 Skills | **严重** — 企业/政府客户不可接受 |
| CVE-2026-25253 RCE | **严重** — 已被公开利用 |
| 135K 暴露实例 | **严重** — 安全态势极差 |
| 单用户设计 | **高** — 无法适配多租户 |
| 无原生多 Agent | **高** — 缺少核心能力 |

### 8.3 建议的生态策略

```
  采用                          借鉴                         不用
  ────                          ────                         ────
  Claude Agent SDK              OpenClaw Skill 发现机制       OpenClaw 核心
  MCP 协议标准                   OpenClaw Gateway 模式         ClawHub 生态
  MS Agent Framework 集成        Agent Teams 协调机制
  Server-side Compaction
  Hooks 系统
```

---

## 9. 具体可复用的架构模式和代码参考

### 9.1 认知分区 Swarm 的 Claude Agent SDK 实现骨架

```python
"""
认知分区 Swarm — 基于 Claude Agent SDK 的参考实现骨架

一个虚拟员工 = 一个 Main Agent + 多个认知分区 Subagent
"""

import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition, HookMatcher

# 1. 定义虚拟员工的认知分区

VIRTUAL_EMPLOYEE_CONFIG = {
    # 虚拟员工基础信息
    "name": "Alice Chen",
    "role": "Government IT Project Coordinator",
    "customer": "Department of Education",

    # 认知分区定义
    "partitions": {
        "planner": AgentDefinition(
            description="Strategic planning and task decomposition. "
                       "Use for complex decisions and multi-step planning.",
            prompt="""You are Alice's planning cognition.

Your role:
- Decompose complex requests into actionable steps
- Assess risk and priority
- Decide which cognitive partitions to engage

Governance policies:
- Never commit to deadlines without checking resource availability
- Escalate decisions involving budget > $10,000
- Always consider compliance requirements for government work""",
            tools=["Read", "Grep", "WebSearch", "Task"],
            model="opus",
        ),

        "executor": AgentDefinition(
            description="Task execution in Power Platform and Dataverse. "
                       "Use for creating records, running workflows, data entry.",
            prompt="""You are Alice's execution cognition.

Your role:
- Execute planned tasks in customer systems
- Create and update Dataverse records
- Trigger Power Automate workflows
- Report execution results accurately

Safety rules:
- Never delete records, only deactivate
- Always validate data before writing
- Log every write operation""",
            tools=["Bash", "Read", "Write"],
            model="sonnet",
        ),

        "communicator": AgentDefinition(
            description="Human communication and stakeholder management. "
                       "Use for drafting emails, Teams messages, status reports.",
            prompt="""You are Alice's communication cognition.

Your role:
- Draft professional communications
- Adapt tone to audience (executive vs technical)
- Summarize technical details for non-technical stakeholders
- Handle escalations gracefully

Style:
- Professional but warm
- Concise but thorough
- Always include next steps""",
            tools=["Read", "Write"],
            model="sonnet",
        ),

        "analyst": AgentDefinition(
            description="Data analysis and insight generation. "
                       "Use for reporting, trend analysis, anomaly detection.",
            prompt="""You are Alice's analytical cognition.

Your role:
- Analyze data patterns and trends
- Generate insights from Dataverse data
- Create reports and visualizations
- Identify anomalies and risks""",
            tools=["Read", "Grep", "Glob"],
            model="sonnet",
            memory="project",
        ),

        "auditor": AgentDefinition(
            description="Compliance and quality assurance. "
                       "Use proactively after any system modification.",
            prompt="""You are Alice's audit cognition.

Your role:
- Verify all actions comply with government regulations
- Check data integrity after modifications
- Maintain audit trail
- Flag any compliance concerns immediately

Standards:
- IRAP compliance requirements
- Data sovereignty rules
- Government procurement policies""",
            tools=["Read", "Grep"],
            model="haiku",
        ),
    },
}


# 2. 治理 Hooks

async def compliance_pre_check(input_data, tool_use_id, context):
    """执行前合规检查"""
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})
    if tool_name == "Bash":
        command = tool_input.get("command", "")
        dangerous_patterns = ["rm -rf", "DROP", "DELETE FROM", "format"]
        if any(p in command for p in dangerous_patterns):
            return {"error": f"Blocked by compliance: dangerous command pattern"}
    return {}


async def audit_post_action(input_data, tool_use_id, context):
    """执行后审计记录"""
    audit_entry = {
        "timestamp": "...",
        "agent": context.get("agent_name"),
        "tool": input_data.get("tool_name"),
        "input": input_data.get("tool_input"),
        "result": "success",
    }
    # await audit_service.log(audit_entry)
    return {}


# 3. 启动虚拟员工

async def run_virtual_employee(task: str):
    """启动虚拟员工处理一个任务"""
    config = VIRTUAL_EMPLOYEE_CONFIG

    system_prompt = f"""You are {config['name']}, a {config['role']}.

You serve {config['customer']}. You have multiple cognitive partitions
(subagents) that you can delegate to:

- planner: for strategic thinking and task decomposition
- executor: for system operations and data entry
- analyst: for data analysis and reporting
- communicator: for drafting messages and reports
- auditor: for compliance verification

Your approach:
1. First, use the planner to understand and decompose the task
2. Execute using appropriate partitions
3. Always run the auditor after any system modification
4. Communicate results professionally

You think like a real employee — you have goals and policies, not scripts."""

    async for message in query(
        prompt=f"{system_prompt}\n\nTask: {task}",
        options=ClaudeAgentOptions(
            allowed_tools=["Read", "Grep", "Glob", "Task"],
            agents=config["partitions"],
            hooks={
                "PreToolUse": [
                    HookMatcher(matcher="Bash|Write|Edit", hooks=[compliance_pre_check]),
                ],
                "PostToolUse": [
                    HookMatcher(matcher=".*", hooks=[audit_post_action]),
                ],
            },
        ),
    ):
        if hasattr(message, "result"):
            return message.result


if __name__ == "__main__":
    result = asyncio.run(run_virtual_employee(
        "Generate the monthly project status report for the Digital Transformation "
        "initiative. Check Dataverse for latest milestones, analyze progress against "
        "KPIs, and draft an executive summary email to the CIO."
    ))
    print(result)
```

### 9.2 Skill 发现与注入模式（借鉴 OpenClaw）

```python
"""
借鉴 OpenClaw 的 Skill 选择性注入模式
不是把所有 Skills 塞进 prompt，而是运行时按需发现和注入
"""

class SkillRegistry:
    """类似 ClawHub 但私有化、安全的技能注册中心"""

    def __init__(self):
        self.skills = {}

    def register(self, name: str, description: str, content: str, tags: list):
        self.skills[name] = {
            "description": description,
            "content": content,
            "tags": tags,
        }

    def discover(self, task_description: str, max_skills: int = 3) -> list:
        """基于任务描述发现相关 Skills（可以用 embedding 或 LLM 做匹配）"""
        relevant = []
        for name, skill in self.skills.items():
            if any(tag in task_description.lower() for tag in skill["tags"]):
                relevant.append(skill)
        return relevant[:max_skills]

# 使用时动态注入到 Agent 的 prompt 中
registry = SkillRegistry()
registry.register(
    name="dataverse-crud",
    description="How to create, read, update Dataverse records",
    content="...(detailed instructions)...",
    tags=["dataverse", "record", "create", "update"],
)

relevant_skills = registry.discover("Create a new project record in Dataverse")
skill_context = "\n\n".join([s["content"] for s in relevant_skills])

executor = AgentDefinition(
    description="Task executor with relevant skills",
    prompt=f"You are a task executor.\n\nAvailable Skills:\n{skill_context}",
    tools=["Bash", "Read", "Write"],
)
```

---

## 10. 结论与建议

### 10.1 核心结论

1. **Claude Agent SDK 是我们认知分区 Swarm 的强候选底层引擎**
   - Subagent 机制天然映射到认知分区
   - Hooks 系统直接实现治理层
   - Server-side Compaction 解决长时运行问题
   - MCP 生态提供丰富的工具集成
   - 异构模型路由（Opus/Sonnet/Haiku）匹配 Token-Rich 策略

2. **Claude Agent SDK × MS Agent Framework 的组合值得认真评估（方案 E）**
   - Claude SDK 做认知/推理核心
   - MS Agent Framework 做编排和 Azure 生态集成
   - 两者已有官方集成（2026-01）

3. **OpenClaw 的直接复用价值低，但设计借鉴价值中等**
   - Skill 选择性注入模式值得借鉴
   - Gateway 控制面模式值得参考（07 报告已详细分析）
   - 安全问题严重，不适合企业级使用

4. **Agent Teams 提供了多 Agent 协作的参考范式**
   - 共享任务列表 + 自协调 + Mailbox 通信
   - 但缺少"统一意识"概念，需要我们自己扩展

### 10.2 建议的下一步

1. **进行 Claude Agent SDK POC** —— 用 SDK 实现一个最小的认知分区 Swarm，验证 Subagent 机制的可行性和局限性
2. **评估方案 E（Claude SDK + MS Agent Framework）** —— 与方案 A（自研）和方案 D（纯 MS）进行三方对比
3. **验证 Subagent 单层限制的影响** —— Subagent 不能嵌套，我们需要确认这是否足够支持认知分区的层次化需求
4. **设计"统一意识"机制** —— Claude Agent SDK 没有提供这个能力，需要我们自己在 Session/Memory 层实现

### 10.3 风险提示

- Claude Agent SDK 是 Anthropic 的商业产品，存在供应商锁定风险
- Agent Teams 仍是实验性功能，生产环境稳定性待验证
- Subagent 不能嵌套是硬限制，可能影响复杂认知分区的实现
- Server-side Compaction 的信息丢失问题需要评估（总结不等于完整记忆）

---

## Sources

- [Agent SDK overview - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Subagents in the SDK - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/subagents)
- [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [Orchestrate teams of Claude Code sessions - Claude Code Docs](https://code.claude.com/docs/en/agent-teams)
- [Building agents with the Claude Agent SDK | Anthropic](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Build AI Agents with Claude Agent SDK and Microsoft Agent Framework | Semantic Kernel](https://devblogs.microsoft.com/semantic-kernel/build-ai-agents-with-claude-agent-sdk-and-microsoft-agent-framework/)
- [Building a C compiler with a team of parallel Claudes | Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- [OpenClaw vs Claude Code: Complete Comparison Guide (2026)](https://claudefa.st/blog/tools/extensions/openclaw-vs-claude-code)
- [OpenClaw in 2026: Architecture, Setup, Skills Security](https://vallettasoftware.com/blog/post/openclaw-2026-guide)
- [What are OpenClaw Skills? A 2026 Developer's Guide | DigitalOcean](https://www.digitalocean.com/resources/articles/what-are-openclaw-skills)
- [ClawHub - OpenClaw](https://docs.openclaw.ai/tools/clawhub)
- [Compaction - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Configure permissions - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [Intercept and control agent behavior with hooks - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [50+ Best MCP Servers for Claude Code in 2026](https://claudefa.st/blog/tools/mcp-extensions/best-addons)
- [Claude Code's Hidden Multi-Agent System](https://paddo.dev/blog/claude-code-hidden-swarm/)
- [AddyOsmani.com - Claude Code Swarms](https://addyosmani.com/blog/claude-code-agent-teams/)
- [The Definitive Guide to the Claude Agent SDK | Medium](https://datapoetica.medium.com/the-definitive-guide-to-the-claude-agent-sdk-building-the-next-generation-of-ai-69fda0a0530f)
