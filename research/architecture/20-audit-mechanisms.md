# Agent Audit 机制架构研究

> **研究日期**：2026-03-07
> **研究背景**：为认知分区 Swarm 虚拟员工平台设计政府合规级审计机制。核心候选框架：方案 A（pi-mono + 自研编排）、方案 E（Claude Agent SDK + MS Agent Framework）。设计哲学：只有 auditing 需要是代码（确定性），其他业务逻辑用 Skill（自然语言）实现。
> **关联报告**：[06-pi-mono-deep-dive.md](06-pi-mono-deep-dive.md)、[07-openclaw-architecture.md](07-openclaw-architecture.md)、[18-claude-agent-sdk-ecosystem.md](18-claude-agent-sdk-ecosystem.md)、[19-openclaw-ecosystem-deep-dive.md](19-openclaw-ecosystem-deep-dive.md)

---

## 目录

1. [Inboard vs Outboard Audit 的根本区别](#1-inboard-vs-outboard-audit-的根本区别)
2. [pi-mono 如何支持 Audit](#2-pi-mono-如何支持-audit)
3. [OpenClaw-like 架构的 Audit 支持](#3-openclaw-like-架构的-audit-支持)
4. [Claude Agent SDK 的 Audit 支持](#4-claude-agent-sdk-的-audit-支持)
5. [政府合规级 Audit 推荐架构](#5-政府合规级-audit-推荐架构)
6. [结论与技术决策建议](#6-结论与技术决策建议)

---

## 1. Inboard vs Outboard Audit 的根本区别

### 1.1 概念定义

**Inboard Audit（内嵌式审计）**

审计逻辑与 Agent 运行时在同一进程内，通过 Hook/Middleware 机制拦截 Agent 行为。

```
┌────────────────────────────────────────┐
│           Agent 进程                   │
│                                        │
│  ┌─────────────────────────────────┐   │
│  │          Agent Loop             │   │
│  │   → Tool Call → [HOOK] → Log    │   │
│  │              ↑                  │   │
│  │         Audit Logic             │   │
│  │       (同进程，同内存)           │   │
│  └─────────────────────────────────┘   │
│                                        │
│  Audit Store (可以是本地文件/内存)       │
└────────────────────────────────────────┘
```

**Outboard Audit（外置式审计）**

Agent 产生结构化事件，通过消息队列/事件总线发送给独立审计服务，审计服务异步消费和持久化。

```
┌──────────────────┐     Events      ┌──────────────────────┐
│   Agent 进程      │ ─────────────> │   Audit Service      │
│                  │    (Event Bus   │   (独立进程/服务)     │
│  Agent Loop      │     /Kafka/     │                      │
│  Tool Execution  │     Service     │   接收、验证、存储    │
│  Session State   │     Bus)        │   不可篡改日志        │
└──────────────────┘                 └──────────────────────┘
                                               │
                                     ┌─────────▼─────────┐
                                     │  Immutable Storage │
                                     │  (WORM + Ledger)  │
                                     └───────────────────┘
```

### 1.2 关键权衡对比

| 维度 | Inboard | Outboard |
|------|---------|----------|
| **延迟** | 极低（同进程，纳秒级） | 有延迟（网络/队列，毫秒级） |
| **可靠性** | Agent 崩溃则 audit 也丢 | 独立进程，Agent 崩溃不影响审计 |
| **防绕过** | 弱 — Agent 代码可以禁用 hook | 强 — Agent 无法控制外部 sink |
| **不可篡改性** | 弱 — 同进程可修改内存 | 强 — 独立服务 + WORM 存储 |
| **覆盖完整性** | 取决于 hook 覆盖面 | 所有网络流量可被 tap |
| **性能开销** | 低（无网络 I/O） | 中（序列化 + 网络 + 队列写入） |
| **扩展性** | 难（需改 Agent 代码） | 易（事件消费者可独立扩展） |
| **离线可用** | 是 | 需要网络连通性 |
| **实现复杂度** | 低 | 中（需要事件格式设计 + 消费者架构） |
| **合规强度** | 低-中 | 高（符合 SOC 2、FedRAMP 要求） |

### 1.3 政府合规的核心要求

政府级合规（FedRAMP、IRAP、GDPR、SOC 2 Type II）对 audit 有以下关键要求：

1. **不可篡改性（Tamper-Evidence）**：审计记录一旦写入不能被修改或删除
2. **防绕过（Bypass Prevention）**：被审计的 Agent 不能禁用或绕过审计
3. **完整性证明（Integrity Proof）**：可以密码学证明某条记录未被修改
4. **保留期（Retention）**：通常要求 7 年以上
5. **独立性（Independence）**：审计系统必须与被审计系统在信任边界上分离

**结论：纯 Inboard 模式无法满足政府级合规要求。**

原因：
- 内嵌在同一进程的 audit hook 可以被 Agent 代码（或注入 Agent 的恶意 prompt）绕过
- 无法保证审计数据的不可篡改性（Agent 进程可以修改内存中的 audit buffer）
- 如果 Agent 崩溃或被杀死，还未刷新到磁盘的审计记录会丢失

**最佳实践：Inboard 负责实时拦截（硬底线执行），Outboard 负责合规归档（防篡改证明）。**

---

## 2. pi-mono 如何支持 Audit

### 2.1 pi-agent-core 的 4 个 Hooks 分析

基于 `06-pi-mono-deep-dive.md` 的源码级分析，pi-agent-core 提供 4 个可扩展点：

```typescript
// pi-agent-core 的 Agent 配置接口（简化）
interface AgentConfig {
  // Hook 1: 每轮循环开始时，转换/注入上下文
  transformContext?: (context: AgentContext) => Promise<AgentContext>;

  // Hook 2: 将消息转换为 LLM 调用格式（可用于拦截/修改）
  convertToLlm?: (messages: AgentMessage[]) => Promise<LlmRequest>;

  // Hook 3: 注入"转向消息"（运行时干预）
  getSteeringMessages?: (context: AgentContext) => Promise<AgentMessage[]>;

  // Hook 4: 注入"后续消息"（异步任务/学习循环）
  getFollowUpMessages?: (result: AgentResult) => Promise<AgentMessage[]>;
}
```

**各 Hook 对 Audit 的价值和局限：**

| Hook | 类型 | Audit 用途 | 局限 |
|------|------|----------|------|
| `transformContext` | Inboard | 在每轮开始注入审计 session ID、记录上下文快照 | 无法拦截工具调用；只看到输入，不看输出 |
| `convertToLlm` | Inboard | 记录完整的 LLM 请求（token 用量、model、prompt） | 不记录工具执行结果 |
| `getSteeringMessages` | Inboard | 合规违规时注入告警/停止信号 | 是干预机制，不是审计机制 |
| `getFollowUpMessages` | Inboard | 触发异步审计任务（事后验证） | 异步，不阻塞执行路径 |

**关键缺失**：pi-agent-core 的 4 个 hooks 中**没有工具调用级别的 hook**（PreToolUse / PostToolUse）。这意味着：

- 无法逐工具记录输入/输出
- 无法在工具执行前实施硬性拦截
- 对于审计"Agent 具体做了什么"能力弱于 Claude Agent SDK

### 2.2 如何在 pi-mono 中实现 Audit

由于 pi-agent-core 缺少工具级 Hook，需要在两个层面补充：

**层面 1：工具包装（Tool Wrapping）**

```typescript
// 在工具层面包装 audit，而不是依赖 hook
function wrapToolWithAudit(tool: AgentTool, auditClient: AuditClient): AgentTool {
  return {
    ...tool,
    execute: async (input: unknown, context: AgentContext) => {
      const auditId = crypto.randomUUID();
      const startTime = Date.now();

      // Pre-execution audit（同步，可阻塞）
      await auditClient.record({
        type: 'tool_pre_execution',
        auditId,
        toolName: tool.name,
        input,
        agentId: context.agentId,
        sessionId: context.sessionId,
        tenantId: context.tenantId,
        timestamp: new Date().toISOString(),
      });

      try {
        const result = await tool.execute(input, context);

        // Post-execution audit（同步，确保记录）
        await auditClient.record({
          type: 'tool_post_execution',
          auditId,
          toolName: tool.name,
          success: true,
          outputSummary: summarize(result),
          durationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        });

        return result;
      } catch (error) {
        // 错误也必须审计
        await auditClient.record({
          type: 'tool_execution_error',
          auditId,
          toolName: tool.name,
          success: false,
          errorMessage: error.message,
          durationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        });
        throw error;
      }
    },
  };
}

// 注册时批量包装所有工具
function createAuditedToolRegistry(
  tools: AgentTool[],
  auditClient: AuditClient
): AgentTool[] {
  return tools.map(tool => wrapToolWithAudit(tool, auditClient));
}
```

**层面 2：transformContext 记录推理快照**

```typescript
const transformContext = async (context: AgentContext): Promise<AgentContext> => {
  // 每轮推理开始时记录上下文快照
  await auditClient.record({
    type: 'reasoning_turn_start',
    turnNumber: context.turnNumber,
    sessionId: context.sessionId,
    agentId: context.agentId,
    // 注意：不记录完整上下文（可能含 PII），只记录摘要/哈希
    contextHash: hashContext(context),
    messageCount: context.messages.length,
    timestamp: new Date().toISOString(),
  });

  return context; // 不修改上下文
};
```

### 2.3 pi-mono 的 Audit 性质判定

**pi-mono 的 4 个 hooks 全部是 Inboard 机制。**

理由：
- Hooks 在 pi-agent-core 的 Agent Loop 内部执行，与 Agent 同进程
- 没有内置的事件总线或外部 sink 机制
- Hook 失败不会导致 Agent 停止（除非 hook 抛出异常）

**Agent 能否绕过 pi-mono 的 Audit？**

在纯 pi-mono 方案中，有以下绕过风险：

1. **Prompt 注入绕过**：Agent 的工具调用可以在工具执行内部绕过包装层（如果工具内部有二次网络调用）
2. **Hook 代码路径绕过**：如果 hook 抛出未处理异常，Agent 可能继续执行（取决于错误处理实现）
3. **工具注册绕过**：动态加载的工具（如 MCP Server）如果不经过包装注册，则不受 audit 覆盖

**解决方案**：必须在 MCP Server 层面也实施 audit tap，不仅在工具注册层。

### 2.4 pi-mono 生态的现成 Audit 方案

OpenClaw（基于 pi-mono 构建）提供了一些参考实现，但没有企业级/政府级 audit 方案。OpenClaw 的 Hooks System（`src/hooks/`）是类似的 inboard 机制，用于 plugin 扩展，不是 audit 工具。

**结论**：pi-mono 生态中**没有现成的政府合规 audit 方案**，需要自研。

---

## 3. OpenClaw-like 架构的 Audit 支持

### 3.1 Gateway 模式：天然的 Outboard Audit 点

OpenClaw 的 Gateway 架构提供了一个在应用层实现 outboard audit 的天然位置：

```
消息输入                   Gateway Server                  Agent 运行时
   │                            │                              │
   │──── 原始消息 ──────────────>│                              │
   │                            │──── 路由决策 ───────────────>│
   │                            │                              │
   │                     [AUDIT TAP]                           │
   │                     记录所有入站消息                       │
   │                            │<─── Agent 响应 ──────────────│
   │                     [AUDIT TAP]                           │
   │                     记录所有出站响应                       │
   │<─── 响应 ───────────────────│                              │
```

Gateway 是所有流量的必经点，这使其成为 audit 的理想位置。OpenClaw 的 `server.impl.ts` 中的 `ChannelManager` 可以作为 tap 点：

```typescript
// 借鉴 OpenClaw Gateway 模式的 Audit Tap 实现
class AuditingGateway {
  private auditClient: AuditClient;
  private innerGateway: GatewayServer;

  async handleIncomingMessage(message: ChannelMessage): Promise<void> {
    // 1. 记录入站（outboard — 在 Agent 处理前）
    const auditId = crypto.randomUUID();
    await this.auditClient.emit({
      type: 'message_received',
      auditId,
      channel: message.channel,
      sessionId: message.sessionId,
      tenantId: message.tenantId,
      contentHash: sha256(message.content), // 不记录明文（PII 保护）
      timestamp: new Date().toISOString(),
    });

    // 2. 交给 Agent 处理
    const response = await this.innerGateway.process(message);

    // 3. 记录出站（outboard — Agent 处理后，发送前）
    await this.auditClient.emit({
      type: 'message_sent',
      auditId,
      channel: message.channel,
      sessionId: message.sessionId,
      tenantId: message.tenantId,
      actionsTaken: response.actions,
      toolsInvoked: response.toolsUsed,
      timestamp: new Date().toISOString(),
    });

    return response;
  }
}
```

### 3.2 Gateway Audit 的可靠性分析

**优势：**
- 所有 Agent 消息必须通过 Gateway，无法绕过
- Gateway 与 Agent 运行时是不同的代码路径（即使在同一进程）
- 可以在 Gateway 层面实现 TLS 终端，记录解密后的完整流量
- 不依赖 Agent 框架的 hook 机制，独立于 Agent 实现

**局限：**
- Gateway 与 Agent 通常在同一进程/服务（OpenClaw 中 Agent Runner 是 Gateway 的子系统）
- 如果 Gateway 进程崩溃，audit 和 Agent 一起失败
- 只能看到 Gateway 层面的消息（输入/输出），看不到 Agent 内部的推理步骤和工具调用

**关键问题**：OpenClaw 的 Gateway 是消息级别的 tap，而不是工具调用级别。这对于政府合规来说不够细粒度——我们需要记录每一次工具调用（写了什么、读了什么、调用了哪个 API），而不只是对话的入站/出站消息。

### 3.3 Gateway + Agent Hook 的双层架构

最佳实践是将 Gateway tap 和 Agent 内部 hook 结合：

```
┌─────────────────────────────────────────────────────────────┐
│                     Gateway 层（消息级审计）                  │
│   记录：对话消息、路由决策、响应内容                            │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  Agent 运行时层（工具级审计）                  │
│   记录：工具调用 I/O、推理步骤、token 用量                      │
└────────────────────────┬────────────────────────────────────┘
                         │ 异步事件流
┌────────────────────────▼────────────────────────────────────┐
│              Outboard Audit Service（合规归档）               │
│   接收：事件流 → 验证 → 签名 → 不可篡改存储                    │
└─────────────────────────────────────────────────────────────┘
```

### 3.4 现成的 OpenClaw 生态 Audit 插件

OpenClaw 社区的 ClawHub 上有一些 audit/logging 相关 Skills，但：
- 大多数是简单的文件日志（Markdown 或 JSON），不满足合规要求
- 没有针对政府合规的不可篡改存储集成
- 安全问题严重（12-20% 的 ClawHub Skills 被审计为恶意，CVE-2026-25253 RCE），**不适合企业使用**

**结论**：OpenClaw 生态中没有可直接使用的企业级/政府级 audit 方案。Gateway 模式作为设计参考有价值，但需要自行构建。

---

## 4. Claude Agent SDK 的 Audit 支持

### 4.1 Hooks 系统的 Audit 能力分析

Claude Agent SDK 的 Hooks 系统（9 种事件）比 pi-mono 的 4 个 hooks 覆盖更细粒度：

```typescript
// Claude Agent SDK Hooks — 对 Audit 有价值的 Hook 事件
const auditHooks = {
  // 工具执行前（可阻塞 + 记录）
  PreToolUse: [
    HookMatcher({
      matcher: '.*', // 覆盖所有工具
      hooks: [preToolAuditHook],
    }),
  ],

  // 工具执行后（记录结果）
  PostToolUse: [
    HookMatcher({
      matcher: '.*',
      hooks: [postToolAuditHook],
    }),
  ],

  // 会话开始（记录 session 创建）
  SessionStart: [{ hooks: [sessionStartHook] }],

  // 会话结束（记录 session 完成，触发摘要生成）
  SessionEnd: [{ hooks: [sessionEndHook] }],

  // Subagent 启动（记录认知分区激活）
  SubagentStart: [{ hooks: [subagentStartHook] }],

  // Subagent 完成（记录认知分区结果）
  SubagentStop: [{ hooks: [subagentStopHook] }],

  // Agent 停止（触发完整性验证）
  Stop: [{ hooks: [agentStopHook] }],
};
```

**完整的工具级 Audit 实现：**

```typescript
const preToolAuditHook = async (
  input: ToolHookInput,
  toolUseId: string,
  context: AgentContext
): Promise<ToolHookResult> => {
  const entry: AuditEntry = {
    type: 'pre_tool_use',
    auditId: toolUseId, // SDK 提供的唯一 ID
    sessionId: context.sessionId,
    agentId: context.agentName,
    tenantId: context.tenantId,
    toolName: input.toolName,
    toolInput: sanitizePii(input.toolInput), // PII 脱敏后记录
    inputHash: sha256(JSON.stringify(input.toolInput)), // 原始哈希
    timestamp: new Date().toISOString(),
    sequenceNumber: ++context.auditSequence, // 防止乱序
  };

  // 关键：先写 audit，再允许工具执行
  // 如果 auditClient 写入失败，可以选择阻止工具执行
  try {
    await auditClient.emit(entry);
  } catch (err) {
    // 政府合规模式：audit 失败则拒绝执行
    if (config.strictAuditMode) {
      return { error: 'Audit system unavailable — operation blocked' };
    }
    // 宽松模式：记录警告但允许继续
    console.error('Audit write failed:', err);
  }

  return {}; // 空 = 允许继续
};

const postToolAuditHook = async (
  input: ToolHookInput,
  toolUseId: string,
  context: AgentContext
): Promise<ToolHookResult> => {
  await auditClient.emit({
    type: 'post_tool_use',
    auditId: toolUseId, // 与 pre 对应，可关联
    sessionId: context.sessionId,
    agentId: context.agentName,
    tenantId: context.tenantId,
    toolName: input.toolName,
    outputSummary: summarizeOutput(input.toolOutput), // 摘要，不记录全量（可能很大）
    outputHash: sha256(JSON.stringify(input.toolOutput)),
    success: !input.error,
    errorMessage: input.error?.message,
    durationMs: input.durationMs,
    timestamp: new Date().toISOString(),
  });

  return {};
};
```

### 4.2 Hooks 的 Inboard/Outboard 性质判定

**Claude Agent SDK 的 Hooks 是 Inboard 机制。**

具体地说：
- Hooks 在 Claude Agent SDK 进程内执行（Python/TypeScript 函数）
- Hook 代码与 Agent Loop 共享同一运行时
- Hook 本身的实现决定了 audit 数据的目的地

但 Hook 内部可以调用 Outboard 的审计服务（如 Azure Service Bus、Kafka），形成混合架构：

```
Agent 进程
  │
  ├── Agent Loop（LLM 推理）
  │
  ├── PreToolUse Hook（Inboard 拦截点）
  │     └──── emit event ──────────────> Event Bus（Outboard Sink）
  │                                              │
  ├── Tool Execution                             ▼
  │                                      Audit Service（独立进程）
  ├── PostToolUse Hook（Inboard 拦截点）         │
  │     └──── emit event ──────────────>         ▼
  │                                      Immutable Storage (WORM)
  └── [继续下一轮循环]
```

这种混合架构是政府合规的最优解：
- **Inboard Hook**：实时拦截（可在 audit 失败时阻止执行）
- **Outboard Sink**：不可篡改存储（Agent 无法控制外部 sink）

### 4.3 Server-side Compaction 对 Audit 完整性的影响

**这是 Claude Agent SDK 方案的一个重要风险点。**

Server-side Compaction 的机制：
- 当对话上下文接近 200K token 时，Anthropic API 自动对旧上下文做摘要
- 摘要替换原始消息，原始推理链在上下文窗口中不再可见
- Subagent transcript 独立存储，不受主对话 compaction 影响

**对 Audit 的具体影响：**

| 场景 | 影响 |
|------|------|
| 主 Agent 上下文 compaction | 旧的推理步骤被摘要替换，推理链不完整 |
| Subagent（认知分区）上下文 | 独立存储，不受主 Agent compaction 影响 |
| 工具调用记录 | 如果在 PostToolUse hook 中已记录，则不受影响 |
| 中间推理（thinking tokens） | 可能在 compaction 中丢失 |

**缓解措施：**

```typescript
// 方案 1：在 compaction 前主动保存完整推理链
const sessionStartHook = async (context: AgentContext) => {
  // 注册 compaction 事件监听器
  context.on('pre_compaction', async (messages: AgentMessage[]) => {
    // 在 compaction 发生前，将完整推理链归档
    await auditClient.archiveReasoningChain({
      sessionId: context.sessionId,
      messages: messages,
      timestamp: new Date().toISOString(),
      compactionReason: 'context_window_limit',
    });
  });
};

// 方案 2：使用 pause_after_compaction 参数（SDK beta 功能）
// 允许在 compaction 后恢复前检查/保存状态
const options = {
  contextManagement: {
    pauseAfterCompaction: true, // 触发 compaction 后暂停
    onCompaction: async (summary: CompactionSummary) => {
      await auditClient.recordCompaction(summary);
    },
  },
};
```

**政府合规建议**：对于要求完整推理链的合规场景（如涉及重大决策的审批流程），应当：
1. 在工具级 hook 而不是上下文层面记录审计，工具级 hook 不受 compaction 影响
2. 使用 SDK-side Compaction（而不是 Server-side），获得对摘要过程的完全控制
3. 在每轮推理后立即将 thinking tokens 推送到外部存储

### 4.4 Agent Teams 的多 Agent 交互审计

Agent Teams（多个 Claude 实例协作）的审计难点：每个 Teammate 有独立上下文，跨 Teammate 的交互通过 Mailbox 系统传递。

```
Team Lead ──── 任务分配 ───> Teammate A（独立进程）
           │                      │
           │               PostToolUse Hook → Audit Sink
           │
           └── 任务分配 ───> Teammate B（独立进程）
                                  │
                            PostToolUse Hook → Audit Sink
```

**关键审计需求：跨 Agent 的因果链追踪（Causal Chain Tracing）**

```typescript
// 每个 Audit 事件必须携带父级上下文，以便重建完整的决策链
interface AuditEntry {
  // 标准字段
  auditId: string;        // 本事件唯一 ID
  sessionId: string;      // 所属会话
  tenantId: string;       // 所属租户

  // 因果链字段
  parentAuditId?: string; // 触发本事件的父事件 ID
  teamId?: string;        // Agent Team ID（如果在 Team 中）
  agentRole: string;      // 'lead' | 'teammate-A' | 'teammate-B' | subagent name

  // 事件内容
  type: AuditEventType;
  payload: unknown;
  timestamp: string;
  sequenceNumber: number; // 全局单调递增序列号（防乱序）
}
```

**Agent Teams 的审计挑战：**
- 每个 Teammate 是独立进程，hooks 分别执行
- 任务列表（共享状态）的变更也需要审计
- Mailbox 消息（Teammate 之间的直接通信）默认不经过 Gateway，需要单独 tap

---

## 5. 政府合规级 Audit 推荐架构

### 5.1 分层原则

**什么必须是 Inboard（同进程拦截）：**

| 能力 | 原因 |
|------|------|
| 硬性底线执行（PII 检测、金额上限、危险命令拦截） | 必须在工具执行前同步阻断，延迟不可接受 |
| 工具调用序列号分配 | 需要在执行前分配，保证顺序一致性 |
| 请求签名/哈希计算 | 在数据离开进程前计算，保证完整性 |
| Audit 失败时的降级决策 | 是否允许 audit 失败时继续执行（业务连续性 vs 合规强度） |

**什么适合 Outboard（独立服务归档）：**

| 能力 | 原因 |
|------|------|
| 不可篡改存储（WORM） | Agent 不能控制外部 sink |
| 完整性证明（密码学） | 独立服务的签名链，不受 Agent 影响 |
| 合规报告生成 | 计算密集，不应阻塞 Agent |
| 异常检测（Manager Dashboard） | 异步分析，不需要实时 |
| 跨 session 的行为模式分析 | 需要历史数据，只能在外部服务 |
| 长期归档（7+ 年） | 外部冷存储，与热路径分离 |

### 5.2 推荐的技术栈与架构

```
┌────────────────────────────────────────────────────────────────────┐
│                     Agent 进程（Inboard 层）                        │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  PreToolUse Hook                                           │   │
│  │    1. 计算 auditId（UUID v7，带时间戳）                      │   │
│  │    2. PII 扫描（Microsoft Presidio / regex 规则集）          │   │
│  │    3. 硬性底线检查（金额、危险命令、禁止操作）                  │   │
│  │    4. 生成请求签名（HMAC-SHA256，密钥在 Key Vault）           │   │
│  │    5. 异步 emit 事件到 Event Bus（不阻塞，但失败则拒绝执行）   │   │
│  └────────────────────────────────────────────────────────────┘   │
│                         │                                          │
│  ┌──────────────────────▼─────────────────────────────────────┐   │
│  │  Tool Execution（工具实际执行）                              │   │
│  └──────────────────────┬─────────────────────────────────────┘   │
│                         │                                          │
│  ┌──────────────────────▼─────────────────────────────────────┐   │
│  │  PostToolUse Hook                                          │   │
│  │    1. 计算输出哈希                                           │   │
│  │    2. 脱敏处理（记录摘要，不记录全量 PII）                    │   │
│  │    3. 异步 emit 结果事件到 Event Bus                        │   │
│  └────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
                         │ Azure Service Bus（持久化消息队列）
                         │ 消息保证：至少一次投递 + 去重 ID
                         ▼
┌────────────────────────────────────────────────────────────────────┐
│                  Audit Service（Outboard 层，独立部署）              │
│                                                                    │
│  1. 接收 & 验证                                                    │
│     - 验证 HMAC 签名（防伪造）                                      │
│     - 验证序列号连续性（防丢失）                                     │
│     - 验证 schema（防格式篡改）                                     │
│                                                                    │
│  2. 写入热存储（PostgreSQL with row-level locking）                 │
│     - 实时查询支持（Manager Dashboard）                             │
│     - 保留 90 天                                                   │
│                                                                    │
│  3. 写入冷存储（Azure Immutable Blob Storage — WORM）               │
│     - 保留期锁定（7 年，政府要求）                                  │
│     - 地理冗余（ZRS 或 GRS）                                       │
│                                                                    │
│  4. 写入完整性证明链（Azure Confidential Ledger）                   │
│     - 每条记录的加密哈希链                                          │
│     - 可向监管机构证明记录未被篡改                                   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────────┐
│             Manager Dashboard（异步分析层）                         │
│                                                                    │
│  - 实时 session 监控（热存储查询）                                   │
│  - 异常检测（高频工具调用、异常金额、PII 泄露模式）                   │
│  - 合规报告生成（定期批量，冷存储查询）                              │
│  - 人工审阅队列（升级事件、高风险操作）                              │
└────────────────────────────────────────────────────────────────────┘
```

### 5.3 事件格式设计（CloudEvents + 审计扩展）

采用 CloudEvents 1.0 标准作为基础格式，添加审计专用扩展字段：

```typescript
// 审计事件格式（符合 CloudEvents 1.0 + 审计扩展）
interface AuditEvent {
  // CloudEvents 标准字段
  specversion: '1.0';
  id: string;           // UUID v7（含时间戳，便于排序）
  source: string;       // 'urn:agentic:tenant:{tenantId}:agent:{agentId}'
  type: AuditEventType; // 'com.agentic.audit.tool.pre_use' 等
  time: string;         // ISO 8601
  datacontenttype: 'application/json';

  // 审计扩展字段（CloudEvents Extension）
  // 命名约定：小写字母，无连字符（CloudEvents Extension 规范）
  auditid: string;           // 本事件唯一 ID
  auditsession: string;      // 会话 ID（关联同一会话的所有事件）
  audittenant: string;       // 租户 ID
  auditseq: number;          // 全局单调递增序列号
  auditparent?: string;      // 父事件 ID（用于因果链追踪）
  auditsig: string;          // HMAC-SHA256 签名（防篡改）
  auditenv: string;          // 'production' | 'staging'

  // 事件数据（payload）
  data: {
    // 公共字段
    agentId: string;
    agentRole: string;        // 认知分区角色名
    cognitivePartition: string; // 'planner' | 'executor' | 'analyst' | ...

    // 工具调用事件特有字段（type = tool.*）
    toolName?: string;
    toolInputHash?: string;   // SHA-256，不记录明文（保护 PII）
    toolInputSanitized?: unknown; // 脱敏后的输入摘要
    toolOutputHash?: string;
    toolOutputSummary?: string;
    durationMs?: number;
    success?: boolean;
    errorCode?: string;

    // 推理事件特有字段（type = reasoning.*）
    turnNumber?: number;
    modelId?: string;
    tokenUsage?: { input: number; output: number; cacheHit?: number };
    contextHash?: string;

    // 合规字段
    complianceChecks?: ComplianceCheckResult[];
    hardLimitTriggered?: boolean;
    escalationRequired?: boolean;
  };
}

type AuditEventType =
  // 会话生命周期
  | 'com.agentic.audit.session.start'
  | 'com.agentic.audit.session.end'
  | 'com.agentic.audit.session.compaction'

  // 认知分区
  | 'com.agentic.audit.partition.start'
  | 'com.agentic.audit.partition.end'

  // 工具调用
  | 'com.agentic.audit.tool.pre_use'
  | 'com.agentic.audit.tool.post_use'
  | 'com.agentic.audit.tool.blocked'  // 被硬性底线阻断

  // 推理
  | 'com.agentic.audit.reasoning.turn_start'
  | 'com.agentic.audit.reasoning.turn_end'

  // 合规
  | 'com.agentic.audit.compliance.violation'
  | 'com.agentic.audit.compliance.escalation'
  | 'com.agentic.audit.compliance.pii_detected';
```

### 5.4 Audit Bypass Prevention（防绕过）

防止 Agent 绕过 audit 的核心机制：

**机制 1：基础设施层强制（最重要）**

```typescript
// Audit Client 设计：写入失败则阻断
class StrictAuditClient {
  async emit(event: AuditEvent): Promise<void> {
    // 1. 计算签名（Key Vault 密钥，Agent 进程无法访问）
    const signature = await this.keyVaultClient.sign(
      serialize(event),
      this.signingKeyId
    );
    event.auditsig = signature;

    // 2. 写入 Service Bus（持久化队列，不依赖 Agent 进程）
    await this.serviceBusClient.send(event);
    // 如果写入失败（网络断开、Service Bus 不可用），抛出异常
    // PreToolUse Hook 中捕获此异常，拒绝工具执行
  }
}
```

**机制 2：网络层隔离**

- Agent 进程只能通过受控的 Service Bus 连接发送 audit 事件
- Agent 进程无法直接访问 PostgreSQL、WORM 存储、Confidential Ledger（网络策略）
- Audit Service 有独立的 Managed Identity，有且仅有写入存储的权限

**机制 3：序列号连续性验证**

```typescript
// Audit Service 在接收事件时验证序列号连续性
class AuditServiceConsumer {
  private lastSequenceNumbers = new Map<string, number>(); // sessionId -> lastSeq

  async consume(event: AuditEvent): Promise<void> {
    const sessionId = event.auditsession;
    const expectedSeq = (this.lastSequenceNumbers.get(sessionId) ?? 0) + 1;

    if (event.auditseq !== expectedSeq) {
      // 序列号不连续 = 事件丢失或乱序，触发告警
      await this.alertManager.raise({
        type: 'audit_sequence_gap',
        sessionId,
        expected: expectedSeq,
        received: event.auditseq,
        severity: 'HIGH',
      });
    }

    this.lastSequenceNumbers.set(sessionId, event.auditseq);
    await this.persist(event);
  }
}
```

**机制 4：Prompt 注入防护**

即使 Agent 被 prompt 注入，也无法绕过 audit：
- Audit hook 是代码层面的拦截，不是 prompt 层面的指令
- Inboard hook 的签名密钥在 Key Vault 中，Agent 的 prompt 无法读取
- 被拦截的危险操作会记录在 `com.agentic.audit.tool.blocked` 事件中，反而提高可见性

**机制 5：双写验证（针对高风险操作）**

```typescript
// 对于高风险操作（审批、资金、PII 修改），要求 audit 在工具执行前确认写入成功
const preToolHighRiskHook = async (input, toolUseId, context) => {
  const auditWritten = await auditClient.emitAndConfirm(preEvent, {
    timeoutMs: 5000, // 5 秒超时
    confirmationMode: 'acknowledged', // 等待 Service Bus 确认收到
  });

  if (!auditWritten) {
    return { error: 'High-risk operation blocked: audit confirmation timeout' };
  }

  return {}; // audit 确认后才允许执行
};
```

### 5.5 两个方案的 Audit 实现对比

| 维度 | 方案 A（pi-mono） | 方案 E（Claude Agent SDK） |
|------|-----------------|--------------------------|
| **工具级 Hook** | 需自实现（工具包装） | 原生 PreToolUse/PostToolUse |
| **覆盖完整性** | 取决于工具注册实现 | 覆盖所有注册工具（包括 MCP） |
| **Compaction 影响** | 无（没有 compaction） | 需要处理 compaction 前归档 |
| **多 Agent 追踪** | 需自实现分布式追踪 | SubagentStart/Stop 原生支持 |
| **合规级别可达性** | 可达（但需更多自研） | 可达（原生支持更完整） |
| **实现工作量** | 高 | 中 |

---

## 6. 结论与技术决策建议

### 6.1 核心结论

1. **纯 Inboard 审计无法满足政府合规要求**。无论是 pi-mono 的 hooks 还是 Claude Agent SDK 的 hooks，都是 inboard 机制。必须通过外部 sink（Service Bus → 独立 Audit Service → WORM 存储）实现真正的不可篡改性和防绕过。

2. **最优架构是 Inboard 拦截 + Outboard 归档的双层模式**：
   - Inboard（Agent 进程内）：实时拦截、硬性底线执行、签名计算、事件 emit
   - Outboard（独立服务）：接收、验证、不可篡改存储、完整性证明

3. **Claude Agent SDK 的 Hooks 对 Audit 的支持明显优于 pi-mono**：
   - 原生 PreToolUse/PostToolUse 覆盖所有工具（包括 MCP）
   - SubagentStart/SubagentStop 支持多 Agent 因果追踪
   - pi-mono 需要通过工具包装（wrapping）来弥补这一能力缺失

4. **Server-side Compaction 是 Claude Agent SDK 方案的 audit 风险点**，但可以通过工具级记录而不是上下文级记录来缓解。

5. **OpenClaw 的 Gateway 模式作为消息级 audit 点有价值**，但细粒度不够（只记录对话消息，不记录工具调用），需要与 Agent 内部 hook 结合。

6. **防绕过的关键是基础设施层**：签名密钥在 Key Vault、事件通过 Service Bus（Agent 不能修改已发送的消息）、WORM 存储（Agent 没有删除权限）。这些机制与框架选型无关，任何方案都必须实施。

### 6.2 给两个候选方案的建议

**方案 A（pi-mono）的 Audit 实施路径：**
1. 所有工具注册时强制通过 `wrapToolWithAudit()` 包装
2. 建立工具注册白名单机制，未包装工具无法注册
3. 实现 `transformContext` hook 记录推理轮次开始
4. 在工具包装层内 emit 事件到 Azure Service Bus
5. 部署独立 Audit Service（Node.js/Python），消费 Service Bus，写入三层存储

**方案 E（Claude Agent SDK）的 Audit 实施路径：**
1. 在 SDK 初始化时注册全局 PreToolUse/PostToolUse hook（`matcher: '.*'`）
2. 在 SubagentStart/SubagentStop hook 中记录认知分区激活/停止事件
3. 在 SessionStart hook 中注册 compaction 事件监听，触发推理链归档
4. 使用 SDK-side Compaction（而不是 Server-side），保留对摘要过程的控制权
5. 部署与方案 A 相同的 Outboard Audit Service 架构

**共同的 Outboard 基础设施（无论选哪个方案）：**

| 组件 | 技术选型 | 理由 |
|------|---------|------|
| 事件格式 | CloudEvents 1.0 + 审计扩展 | 标准协议，便于未来集成 |
| 事件总线 | Azure Service Bus（Premium） | 持久化、有序、支持死信队列 |
| 热存储 | PostgreSQL（行级锁 + 插入追加，无 UPDATE） | 实时查询；写入追加保证不可修改 |
| 冷存储 | Azure Immutable Blob Storage（WORM） | 合规归档，保留锁定 7 年 |
| 完整性证明 | Azure Confidential Ledger | 密码学防篡改证明 |
| 签名密钥 | Azure Key Vault（HSM 级别） | 密钥不离开 HSM |
| PII 扫描 | Microsoft Presidio（开源） | 在记录前脱敏 |
| 异常检测 | Azure Stream Analytics（流处理） | 实时行为分析 |

### 6.3 决策树：选择 Audit 强度级别

```
是否涉及政府客户（FedRAMP/IRAP 等要求）？
  └── 是 → 必须 Strict Audit Mode：
            - Audit 写入失败 = 工具执行拒绝
            - 所有事件写入 Confidential Ledger
            - 密钥在 HSM，审计数据有签名链
  └── 否 →
      是否涉及金融/医疗敏感数据？
        └── 是 → Standard Audit Mode：
                  - Audit 写入失败 = 告警但允许继续
                  - 事件写入 WORM，不需要 Ledger
        └── 否 → Basic Audit Mode：
                  - 工具级 event，异步写入 PostgreSQL
                  - 仅热存储，90 天保留
```

---

## 参考资料

- [Intercept and control agent behavior with hooks - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [Compaction - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [pi-agent-core 源码分析 — 06-pi-mono-deep-dive.md](06-pi-mono-deep-dive.md)
- [OpenClaw Gateway 架构分析 — 07-openclaw-architecture.md](07-openclaw-architecture.md)
- [Claude Agent SDK 深度研究 — 18-claude-agent-sdk-ecosystem.md](18-claude-agent-sdk-ecosystem.md)
- [OpenClaw 生态深度研究 — 19-openclaw-ecosystem-deep-dive.md](19-openclaw-ecosystem-deep-dive.md)
- [CloudEvents 1.0 Specification](https://cloudevents.io/)
- [Azure Immutable Blob Storage — WORM](https://learn.microsoft.com/azure/storage/blobs/immutable-storage-overview)
- [Azure Confidential Ledger](https://learn.microsoft.com/azure/confidential-ledger/overview)
- [FedRAMP 审计要求 — AC-2, AU-2 through AU-16](https://www.fedramp.gov/documents-templates/)
- [Microsoft Presidio — PII Detection](https://microsoft.github.io/presidio/)
