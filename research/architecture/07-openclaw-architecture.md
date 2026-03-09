# OpenClaw 架构源码级深度分析报告

> 分析版本: openclaw v2026.3.3
> 分析日期: 2026-03-06
> 代码位置: `/Volumes/leoyun/agentic/ref-repos/openclaw`
> 研究目标: 为"虚拟员工"平台（Dynamic Hierarchical MoE）提取可复用的架构模式与技术洞察

---

## 目录

1. [整体架构概览](#1-整体架构概览)
2. [Subagent 机制深度分析](#2-subagent-机制深度分析)
3. [Auto-Reply Pipeline 深度分析](#3-auto-reply-pipeline-深度分析)
4. [路由引擎的扩展性分析](#4-路由引擎的扩展性分析)
5. [Session 管理的并发问题](#5-session-管理的并发问题)
6. [Plugin Registry 设计深度分析](#6-plugin-registry-设计深度分析)
7. [Compaction 策略的改进空间](#7-compaction-策略的改进空间)
8. [Claw-like 可复用设计模式](#8-claw-like-可复用设计模式)
9. [与 OpenAI Agents SDK 的对比](#9-与-openai-agents-sdk-的对比)
10. [面向虚拟员工平台的综合评估](#10-面向虚拟员工平台的综合评估)

---

## 1. 整体架构概览

### 1.1 定位与设计哲学

OpenClaw 是一个**个人 AI 助手网关**，核心理念是"在你已有的通道上回答你"。它不是一个企业级多 Agent 平台，而是面向单用户/少量用户的、本地优先（local-first）的 AI 网关。

关键设计哲学：
- **Gateway 就是产品** -- Gateway 是单一控制面（control plane），所有通道、Agent、插件都通过它运行
- **通道优先** -- 用户不需要打开新 App，消息通过 WhatsApp/Telegram/Slack 等已有通道收发
- **Plugin 架构** -- 核心保持精简，功能通过 plugin/extension 扩展
- **TypeScript 全栈** -- 便于快速迭代和社区贡献

### 1.2 高层架构图

```
                       +---------------------------------------------+
                       |              Gateway Server                  |
                       |          (server.impl.ts)                    |
                       |                                              |
                       |  +----------+  +-----------+  +-----------+  |
    Channels --------->|  | Channel  |  |  Routing   |  |  Agent   |  |
    (Telegram,         |  | Manager  |  |  Engine    |  | Runner   |  |
     WhatsApp,         |  |          |  |            |  | (Pi)     |  |
     Slack, ...)       |  +----------+  +-----------+  +-----------+  |
                       |  +----------+  +-----------+  +-----------+  |
    WebSocket -------->|  |  WS      |  |  Plugin   |  | Session  |  |
    (Control UI,       |  |  Server  |  |  Registry |  |  Store   |  |
     Mobile Apps)      |  |          |  |           |  |          |  |
                       |  +----------+  +-----------+  +-----------+  |
                       |  +----------+  +-----------+  +-----------+  |
    HTTP ------------->|  |  HTTP    |  |   Hooks   |  |  Cron    |  |
    (OpenAI compat,    |  |  Server  |  |  System   |  | Service  |  |
     webhooks)         |  |          |  |           |  |          |  |
                       |  +----------+  +-----------+  +-----------+  |
                       +---------------------------------------------+
                                          |
                                          v
                       +---------------------------------------------+
                       |           pi-mono (Runtime Engine)           |
                       |  @mariozechner/pi-agent-core  v0.55.3       |
                       |  @mariozechner/pi-ai           v0.55.3       |
                       |  @mariozechner/pi-coding-agent v0.55.3       |
                       +---------------------------------------------+
```

### 1.3 核心模块与职责

| 模块 | 路径 | 职责 |
|------|------|------|
| **Gateway Server** | `src/gateway/server.impl.ts` | 单一入口，启动所有子系统 |
| **Channel Manager** | `src/gateway/server-channels.ts` | 通道生命周期管理 |
| **Routing Engine** | `src/routing/resolve-route.ts` | 事件到 Agent 的路由决策 |
| **Agent Runner** | `src/agents/pi-embedded-runner/` | 基于 pi-mono 的 Agent 执行 |
| **Session Store** | `src/config/sessions/store.ts` | 会话持久化（JSON 文件） |
| **Plugin Registry** | `src/plugins/registry.ts` | 全局插件注册中心 |
| **Auto-Reply** | `src/auto-reply/` | 消息处理管线 |
| **Subagent System** | `src/agents/subagent-*.ts` | 子 Agent 生成与生命周期管理 |
| **Compaction** | `src/agents/compaction.ts` | 上下文窗口压缩摘要 |

### 1.4 与 pi-mono 的关系

OpenClaw 依赖 pi-mono 的三个包作为底层 AI 运行时：

- **`@mariozechner/pi-agent-core`** -- Agent 核心抽象（AgentMessage 类型、工具定义）
- **`@mariozechner/pi-ai`** -- LLM 提供商适配（OpenAI/Anthropic/Google/Bedrock 等 API 调用）
- **`@mariozechner/pi-coding-agent`** -- 代码 Agent 能力（token 估算、`generateSummary`、Extension Context）

OpenClaw 在 pi-mono 之上构建了：通道路由、会话管理、插件系统、多 Agent 协调、安全策略等。pi-mono 提供"跑 Agent"的能力，OpenClaw 提供"在哪里跑、给谁跑、怎么管"。

---

## 2. Subagent 机制深度分析

### 2.1 核心源码文件

| 文件 | 职责 | 行数(约) |
|------|------|---------|
| `src/agents/subagent-spawn.ts` | 子 Agent 的创建入口 | ~880 |
| `src/agents/subagent-registry.ts` | 子 Agent 运行记录的注册与管理 | ~1100 |
| `src/agents/subagent-registry.types.ts` | SubagentRunRecord 类型定义 | ~57 |
| `src/agents/subagent-registry-state.ts` | 内存+磁盘双态存储 | ~57 |
| `src/agents/subagent-registry-queries.ts` | 查询辅助函数（按 requester/child 查找） | ~240 |
| `src/agents/subagent-registry-completion.ts` | 完成通知与生命周期钩子 | ~97 |
| `src/agents/subagent-registry-cleanup.ts` | 清理策略（延迟/重试/放弃） | ~75 |
| `src/agents/subagent-announce.ts` | 完成消息构建与公告投递 | ~1000+ |
| `src/agents/subagent-announce-dispatch.ts` | 公告投递路径选择 | ~110 |
| `src/agents/subagent-depth.ts` | 递归深度计算 | ~177 |

### 2.2 SubagentRunRecord -- 生命周期的数据核心

每个子 Agent 运行对应一个 `SubagentRunRecord`，源自 `subagent-registry.types.ts`：

```typescript
export type SubagentRunRecord = {
  runId: string;                    // 唯一运行标识
  childSessionKey: string;          // 子 session key，格式: agent:<agentId>:subagent:<uuid>
  requesterSessionKey: string;      // 父 session key
  requesterOrigin?: DeliveryContext; // 父 Agent 的通道上下文
  requesterDisplayKey: string;       // 用于显示的 key
  task: string;                      // 任务描述
  cleanup: "delete" | "keep";       // 完成后是否删除 session
  label?: string;                   // 可选标签
  model?: string;                   // 模型覆盖
  runTimeoutSeconds?: number;       // 运行超时
  spawnMode?: "run" | "session";    // 一次性运行 vs 持久 session
  createdAt: number;                // 创建时间
  startedAt?: number;               // 开始执行时间
  endedAt?: number;                 // 结束时间
  outcome?: SubagentRunOutcome;     // 执行结果
  archiveAtMs?: number;             // 归档时间
  cleanupCompletedAt?: number;      // 清理完成时间
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  expectsCompletionMessage?: boolean;
  announceRetryCount?: number;      // announce 重试次数
  lastAnnounceRetryAt?: number;     // 最后重试时间
  endedReason?: SubagentLifecycleEndedReason;
  wakeOnDescendantSettle?: boolean; // 子孙完成后唤醒
  frozenResultText?: string | null; // 冻结的完成结果
  frozenResultCapturedAt?: number;
  fallbackFrozenResultText?: string | null;
  endedHookEmittedAt?: number;      // 生命周期钩子已触发标记
  attachmentsDir?: string;          // 附件目录
  retainAttachmentsOnKeep?: boolean;
};
```

**关键洞察**：这个数据结构记录了子 Agent 完整的生命周期元数据，设计非常详尽。`frozenResultText` + `fallbackFrozenResultText` 的双层快照机制确保了即使在 wake-on-descendant 场景中也能可靠地投递结果。

### 2.3 完整生命周期：创建 -> 执行 -> 通知 -> 清理

#### 阶段一：创建（`spawnSubagentDirect`）

入口函数在 `subagent-spawn.ts` 的 `spawnSubagentDirect()`，执行以下步骤：

1. **参数验证**：校验 agentId 格式（正则 `[a-z0-9][a-z0-9_-]{0,63}`），防止无效 ID 创建幽灵目录
2. **深度检查**：`getSubagentDepthFromSessionStore()` 计算当前递归深度，与 `maxSpawnDepth`（默认值由 `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH` 定义）比较
3. **并发限制**：`countActiveRunsForSession()` 检查活跃子 Agent 数量，与 `maxChildrenPerAgent`（默认 5）比较
4. **跨 Agent 权限**：如果 targetAgentId != requesterAgentId，检查 `subagents.allowAgents` 白名单
5. **Sandbox 安全校验**：沙箱化的 session 不能 spawn 非沙箱子 Agent
6. **生成唯一 Session Key**：格式为 `agent:<agentId>:subagent:<uuid>`
7. **Session 初始化**：通过 Gateway RPC (`sessions.patch`) 设置 spawnDepth、model、thinking level
8. **Thread 绑定**（可选）：通过 `ensureThreadBindingForSubagentSpawn()` 调用 `subagent_spawning` 钩子创建通道线程
9. **附件处理**：如果启用，将附件写入 `.openclaw/attachments/<uuid>/` 目录
10. **构建系统提示**：`buildSubagentSystemPrompt()` 注入任务描述、requester 信息、深度限制等
11. **发送任务消息**：通过 `callGateway({ method: "agent" })` 将任务发送到子 session
12. **注册运行记录**：`registerSubagentRun()` 将 record 写入内存 Map + 磁盘持久化
13. **触发 `subagent_spawned` 钩子**

核心代码片段（`subagent-spawn.ts:363`）：

```typescript
const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
```

```typescript
const childTaskMessage = [
  `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). ` +
    `Results auto-announce to your requester; do not busy-poll for status.`,
  spawnMode === "session"
    ? "[Subagent Context] This subagent session is persistent..."
    : undefined,
  `[Subagent Task]: ${task}`,
].filter((line): line is string => Boolean(line)).join("\n\n");
```

#### 阶段二：执行

子 Agent 的执行路径与普通 Agent 相同 -- 通过 `pi-embedded-runner` 执行 LLM 调用、工具调用循环。关键区别：

- **Lane 隔离**：子 Agent 使用 `AGENT_LANE_SUBAGENT`（`CommandLane.Subagent`）Lane，与主 Agent 的 Lane 分开
- **不直接投递**：`deliver: false` 意味着子 Agent 的回复不直接发送到通道
- **额外系统提示**：通过 `extraSystemPrompt` 注入 subagent 上下文

#### 阶段三：通知（Announce）

子 Agent 完成后，通过 `subagent-announce.ts` 中的 `runSubagentAnnounceFlow()` 通知父 Agent：

1. **结果捕获**：`captureSubagentCompletionReply()` 从子 Agent 的最后一条助手消息中提取结果文本
2. **冻结结果**：将结果文本存为 `frozenResultText`，确保后续重试一致
3. **投递路径选择**（`subagent-announce-dispatch.ts`）：
   - **Queue 路径**：通过 followup queue 注入到父 Agent 的消息队列
   - **Steer 路径**：如果父 Agent 正在运行，直接向其注入消息
   - **Direct 路径**：如果父 Agent 空闲，发起新的 agent run
4. **重试机制**：如果投递失败，通过 `DeferredCleanupDecision` 策略决定：
   - `defer-descendants`：如果子 Agent 还有子孙在运行，延迟等待
   - `retry`：带退避的重试投递
   - `give-up`：超过重试限制或过期限制后放弃

投递路径选择逻辑（`subagent-announce-dispatch.ts:42-100`）：

```typescript
export async function runSubagentAnnounceDispatch(params: {
  expectsCompletionMessage: boolean;
  queue: () => Promise<SubagentAnnounceQueueOutcome>;
  direct: () => Promise<SubagentAnnounceDeliveryResult>;
}): Promise<SubagentAnnounceDeliveryResult> {
  // 不期望完成消息的场景：先尝试 queue，失败后 direct
  if (!params.expectsCompletionMessage) {
    const primaryQueue = mapQueueOutcomeToDeliveryResult(await params.queue());
    if (primaryQueue.delivered) return withPhases(primaryQueue);
    return withPhases(await params.direct());
  }
  // 期望完成消息的场景：先尝试 direct，失败后 queue fallback
  const primaryDirect = await params.direct();
  if (primaryDirect.delivered) return withPhases(primaryDirect);
  return withPhases(mapQueueOutcomeToDeliveryResult(await params.queue()));
}
```

#### 阶段四：清理

清理策略由 `subagent-registry-cleanup.ts` 的 `resolveDeferredCleanupDecision()` 决定：

```typescript
export function resolveDeferredCleanupDecision(params: {
  entry: SubagentRunRecord;
  now: number;
  activeDescendantRuns: number;
  announceExpiryMs: number;
  announceCompletionHardExpiryMs: number;
  maxAnnounceRetryCount: number;
  deferDescendantDelayMs: number;
  resolveAnnounceRetryDelayMs: (retryCount: number) => number;
}): DeferredCleanupDecision
```

清理过程包括：
1. 触发 `subagent_ended` 生命周期钩子（幂等，通过 `endedHookEmittedAt` 标记）
2. 如果 `cleanup: "delete"`，删除子 session 和转录文件
3. 如果有附件目录且不保留，清除附件
4. 将 run record 标记为 `cleanupCompletedAt`

### 2.4 状态存储：内存 + 磁盘双态

`subagent-registry-state.ts` 实现了双态存储：

```typescript
export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  // 先从磁盘读取（让其他 worker 进程也能观察到活跃的 runs）
  for (const [runId, entry] of loadSubagentRegistryFromDisk().entries()) {
    merged.set(runId, entry);
  }
  // 内存数据覆盖磁盘数据
  for (const [runId, entry] of inMemoryRuns.entries()) {
    merged.set(runId, entry);
  }
  return merged;
}
```

**关键洞察**：这是一个简化版的 CQRS 模式 -- 写操作到内存+磁盘，读操作合并两者。但这仅适用于单机，不支持真正的分布式 worker。

### 2.5 离真正的"多 Agent 协作"有多远？

OpenClaw 的 subagent 机制本质上是**父子任务委派模式**，而非真正的多 Agent 协作。具体差距：

| 维度 | OpenClaw Subagent | 真正的多 Agent 协作 |
|------|-------------------|-------------------|
| **通信模式** | 单向：父 -> 子（任务），子 -> 父（结果） | 多向：Agent 之间可以互相发消息、协商 |
| **共享状态** | 无。每个 subagent 有独立的 session | 共享黑板（Blackboard）、共享工作空间 |
| **协商机制** | 无。父 Agent 决策，子 Agent 执行 | 投票、共识、拍卖等协商协议 |
| **动态编排** | 静态：spawn 时确定任务，不可中途修改 | 动态：根据执行情况调整分工 |
| **反馈回路** | 仅完成通知，无进度反馈 | 实时进度报告、请求帮助、中间结果共享 |
| **对等性** | 严格的父子层级 | 可以是对等的 peer-to-peer |
| **故障传播** | 子 Agent 失败不影响父 Agent（仅通知） | 可以触发重新编排、故障转移 |

### 2.6 Coordinator -> Worker Agent 委派模式适配评估

如果我们需要实现 Coordinator Agent -> Worker Agent 的委派模式，OpenClaw 的 subagent **可以作为基础，但需要显著改造**：

**可直接复用的部分**：
- `SubagentRunRecord` 的数据结构（需扩展字段）
- 深度限制 + 并发限制的安全机制
- Announce 投递的重试/退避策略
- 生命周期钩子体系（`subagent_spawning`、`subagent_spawned`、`subagent_ended`）

**缺失的关键能力**：

1. **双向通信通道**：当前的 announce 机制是单向的（子 -> 父），没有父 -> 子的进度查询或指令更新通道。需要引入一个消息总线或 pub/sub 机制。

2. **任务分解引擎**：当前的 `task` 只是一个自由文本字符串。我们需要结构化的任务描述（输入参数、预期输出 schema、优先级、截止时间等）。

3. **结果聚合器**：当前父 Agent 通过自然语言理解子 Agent 的结果。企业场景需要结构化的结果聚合（如审批结果 JSON、操作日志等）。

4. **Retry with Context**：当前子 Agent 失败后，清理并通知父 Agent。企业场景需要带上下文的重试（保留已完成的部分，仅重试失败的步骤）。

5. **队列优先级**：当前所有子 Agent 使用相同的 `AGENT_LANE_SUBAGENT` Lane。企业场景需要按优先级（紧急/常规/低优先级）调度。

6. **能力匹配**：`allowAgents` 白名单是静态的。需要基于技能矩阵的动态路由（如"选一个擅长采购的 Worker Agent"）。

**具体改造建议**：

```typescript
// 扩展后的 TaskSpec（替代纯文本 task 字段）
type StructuredTask = {
  id: string;
  type: "approval" | "query" | "operation" | "notification";
  description: string;
  inputSchema: JSONSchema;
  input: Record<string, unknown>;
  expectedOutputSchema: JSONSchema;
  priority: "urgent" | "normal" | "low";
  deadline?: number;  // unix timestamp
  requiredCapabilities: string[];  // 如 ["procurement", "budget-approval"]
  retryPolicy: { maxAttempts: number; backoffMs: number };
  escalationPolicy?: {
    onTimeout: "escalate" | "notify" | "cancel";
    escalateTo?: string;  // agent ID
  };
};

// 扩展后的 Worker 注册信息
type WorkerAgentProfile = {
  agentId: string;
  capabilities: string[];
  currentLoad: number;  // 当前活跃任务数
  maxConcurrency: number;
  tenantId: string;
  status: "available" | "busy" | "offline";
};
```

---

## 3. Auto-Reply Pipeline 深度分析

### 3.1 目录结构与模块组织

`src/auto-reply/` 是 OpenClaw 最复杂的模块之一，包含 100+ 个 TypeScript 文件。核心文件：

| 文件 | 职责 |
|------|------|
| `inbound-debounce.ts` | 入站消息去抖 |
| `dispatch.ts` | 消息分发入口 |
| `reply.ts` | 公共 re-export（`getReplyFromConfig` 等） |
| `reply/get-reply.ts` | 完整的回复生成流程 |
| `reply/reply-dispatcher.ts` | 回复块分发器 |
| `reply/queue.ts` + `reply/queue/` | Followup 消息队列 |
| `reply/agent-runner.ts` | Agent 执行器（调用 pi-embedded-runner） |
| `reply/block-reply-pipeline.ts` | 块式回复管线（流式输出） |
| `reply/commands*.ts` | 斜杠命令处理（/new, /model, /think 等） |
| `reply/directive-handling*.ts` | 指令解析与执行 |
| `reply/session*.ts` | Session 状态管理 |
| `command-detection.ts` | 命令检测 |
| `commands-registry.ts` | 命令注册表 |
| `group-activation.ts` | 群组激活检测 |

### 3.2 完整消息处理管线

```
1. 通道 SDK 收到原始消息
        |
        v
2. ChannelPlugin 适配器内部处理
   - 解析为 MsgContext
   - 鉴权/Pairing 检查
   - 命令检测
        |
        v
3. 入站去抖 (inbound-debounce.ts)
   - 按 session key 聚合快速连续消息
   - 可配置去抖间隔（按通道/全局）
   - 超时后 flush 到下一步
        |
        v
4. 分发入口 (dispatch.ts)
   - dispatchInboundMessage() / dispatchInboundMessageWithBufferedDispatcher()
   - 创建 ReplyDispatcher（带 typing indicator 支持）
   - 调用 dispatchReplyFromConfig()
        |
        v
5. 回复生成 (reply/get-reply.ts)
   a. 解析 agentId 和 sessionKey
   b. 合并 skill filters
   c. 解析默认 model/provider
   d. 确保 Agent workspace 存在
   e. 媒体理解（图片/文件描述生成）
   f. 链接理解（URL 内容抓取）
   g. 命令鉴权检查
   h. Session 状态初始化
   i. 指令解析（/think, /verbose, /elevated 等）
   j. 内联动作处理
   k. 沙箱媒体暂存
   l. 调用 runPreparedReply() 执行 Agent
        |
        v
6. Agent 执行 (pi-embedded-runner)
   - 加载 session 历史
   - 构建 system prompt
   - 调用 LLM
   - 执行工具调用循环
   - 流式/块式回复
        |
        v
7. 出站分发 (ReplyDispatcher)
   - 块合并（block-reply-coalescer）
   - 格式适配（Markdown -> 平台格式）
   - typing indicator 控制
   - 通过通道 SDK 投递
```

### 3.3 入站去抖的实现细节

`inbound-debounce.ts` 实现了一个通用的去抖器：

```typescript
export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  // ...
  const enqueue = async (item: T) => {
    const key = params.buildKey(item);     // 按 session key 分组
    const debounceMs = resolveDebounceMs(item);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      // 不需要去抖的消息立即 flush
      if (key && buffers.has(key)) await flushKey(key);
      await params.onFlush([item]);
      return;
    }

    // 已有 buffer 则追加，否则创建新 buffer
    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      existing.debounceMs = debounceMs;
      scheduleFlush(key, existing);
      return;
    }
    const buffer: DebounceBuffer<T> = { items: [item], timeout: null, debounceMs };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };
}
```

**去抖配置层级**：

```
params.overrideMs  >  cfg.messages.inbound.byChannel[channel]  >  cfg.messages.inbound.debounceMs  >  0
```

**对虚拟员工的适配评估**：去抖器的设计是通用的，可以直接复用。但需要注意：
- 紧急消息应该绕过去抖（`shouldDebounce` 回调可以实现）
- 需要增加按优先级的去抖策略（紧急审批 0ms，常规消息 500ms）

### 3.4 Dispatch 的分层设计

`dispatch.ts` 提供三个分发入口，层次递进：

```typescript
// 最底层：需要外部创建 dispatcher
dispatchInboundMessage(params: {
  ctx, cfg, dispatcher, replyOptions, replyResolver
})

// 中层：自动创建带 typing 的 dispatcher
dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx, cfg, dispatcherOptions, replyOptions, replyResolver
})

// 顶层：自动创建普通 dispatcher
dispatchInboundMessageWithDispatcher(params: {
  ctx, cfg, dispatcherOptions, replyOptions, replyResolver
})
```

`withReplyDispatcher` 确保 dispatcher 的资源总是被释放：

```typescript
export async function withReplyDispatcher<T>(params) {
  try {
    return await params.run();
  } finally {
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}
```

### 3.5 企业虚拟员工适配评估

#### 3.5.1 多步审批流

**需求**：消息到达 -> 查规则 -> 需要人工确认 -> 等待 -> 继续处理

**当前 Pipeline 的局限**：
- 整个 `getReplyFromConfig()` 是一个同步流程（虽然内部有 await，但逻辑是线性的）
- 没有"暂停等待外部事件"的机制
- 没有审批状态机的概念

**需要的改造**：
```
[消息到达] -> [路由到审批 Agent] -> [Agent 查询审批规则]
                                            |
                                 +----------+-----------+
                                 |                      |
                         [金额 < 阈值]          [金额 >= 阈值]
                         自动审批                 挂起等待人工
                                                     |
                                            [写入审批队列/数据库]
                                            [通知审批人]
                                            [等待回调]
                                                     |
                                            [审批人通过/拒绝]
                                            [回调触发继续处理]
                                            [通知申请人结果]
```

需要引入：
1. **有限状态机（FSM）** 框架，管理审批流的状态转换
2. **持久化的等待队列**，不依赖内存中的 Promise
3. **回调注册机制**，将审批人的响应路由回正确的流程实例

#### 3.5.2 主动推送

**需求**：不是回复消息，而是主动发起通知或操作

**当前 Pipeline 的支持度**：
- OpenClaw 有 Cron 机制（`src/cron/`），可以定时触发 Agent 执行
- 有 Heartbeat 机制（`src/auto-reply/heartbeat.ts`），可以定期向指定通道发送消息
- 但这些都是"触发 Agent 执行"而非"直接发送消息"

**需要的改造**：
1. 引入独立的**通知服务**（Notification Service），可以不经过 Agent 直接向通道推送结构化消息
2. Agent 可以通过工具调用触发通知（当前已有 `message_tool.ts`，但功能有限）
3. 支持模板化的消息格式（审批提醒、状态更新、异常报警等）

#### 3.5.3 优先级队列

**需求**：紧急审批 vs 常规任务的优先级区分

**当前的队列机制**：
- `reply/queue/` 实现了 Followup Queue，但只有 FIFO 语义
- `QueueMode` 类型存在但仅用于控制去重/丢弃策略，不是优先级
- Lane 机制（`src/process/lanes.ts`）提供了不同的执行通道（`Nested`、`Subagent`），但不是优先级队列

**需要的改造**：

```typescript
type PriorityLevel = "critical" | "urgent" | "normal" | "low" | "background";

type PrioritizedTask = {
  id: string;
  priority: PriorityLevel;
  enqueuedAt: number;
  deadline?: number;
  task: StructuredTask;
};

// 基于优先级的调度器
class PriorityTaskScheduler {
  private queues: Map<PriorityLevel, PrioritizedTask[]>;
  private workers: Map<string, WorkerAgentProfile>;

  dequeue(): PrioritizedTask | null {
    // 严格优先级：critical > urgent > normal > low > background
    // 同级内按 deadline 排序
    // 超过 deadline 的任务自动升级优先级
  }
}
```

---

## 4. 路由引擎的扩展性分析

### 4.1 resolve-route.ts 的完整实现剖析

路由引擎的核心函数 `resolveAgentRoute()` 位于 `src/routing/resolve-route.ts`（约 790 行），是整个系统最精巧的部分之一。

#### 4.1.1 路由输入与输出

```typescript
export type ResolveAgentRouteInput = {
  cfg: OpenClawConfig;
  channel: string;         // 通道标识
  accountId?: string;      // 通道账号 ID
  peer?: RoutePeer;        // 对话对象（DM/Group/Channel）
  parentPeer?: RoutePeer;  // 线程父级（用于 binding 继承）
  guildId?: string;        // Discord Guild ID
  teamId?: string;         // Slack Team ID
  memberRoleIds?: string[];// Discord 角色 IDs
};

export type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string;
  sessionKey: string;
  mainSessionKey: string;
  matchedBy: "binding.peer" | "binding.peer.parent" | "binding.guild+roles"
    | "binding.guild" | "binding.team" | "binding.account"
    | "binding.channel" | "default";
};
```

#### 4.1.2 七层分层路由与索引加速

路由匹配使用**分层优先级 + 索引加速**架构：

```typescript
const tiers: Array<{
  matchedBy: Exclude<ResolvedAgentRoute["matchedBy"], "default">;
  enabled: boolean;
  scopePeer: RoutePeer | null;
  candidates: EvaluatedBinding[];
  predicate: (candidate: EvaluatedBinding) => boolean;
}> = [
  {
    matchedBy: "binding.peer",          // 层1: 精确 peer 匹配
    enabled: Boolean(peer),
    candidates: collectPeerIndexedBindings(bindingsIndex, peer),
    predicate: (c) => c.match.peer.state === "valid",
  },
  {
    matchedBy: "binding.peer.parent",   // 层2: 父 peer 继承
    enabled: Boolean(parentPeer?.id),
    candidates: collectPeerIndexedBindings(bindingsIndex, parentPeer),
    predicate: (c) => c.match.peer.state === "valid",
  },
  {
    matchedBy: "binding.guild+roles",   // 层3: Guild + 角色组合
    enabled: Boolean(guildId && memberRoleIds.length > 0),
    candidates: guildId ? (bindingsIndex.byGuildWithRoles.get(guildId) ?? []) : [],
    predicate: (c) => hasGuildConstraint(c.match) && hasRolesConstraint(c.match),
  },
  {
    matchedBy: "binding.guild",         // 层4: Guild 级别
    enabled: Boolean(guildId),
    candidates: guildId ? (bindingsIndex.byGuild.get(guildId) ?? []) : [],
    predicate: (c) => hasGuildConstraint(c.match) && !hasRolesConstraint(c.match),
  },
  {
    matchedBy: "binding.team",          // 层5: Team 级别
    enabled: Boolean(teamId),
    candidates: teamId ? (bindingsIndex.byTeam.get(teamId) ?? []) : [],
    predicate: (c) => hasTeamConstraint(c.match),
  },
  {
    matchedBy: "binding.account",       // 层6: Account 级别
    enabled: true,
    candidates: bindingsIndex.byAccount,
    predicate: (c) => c.match.accountPattern !== "*",
  },
  {
    matchedBy: "binding.channel",       // 层7: Channel 级别（通配符）
    enabled: true,
    candidates: bindingsIndex.byChannel,
    predicate: (c) => c.match.accountPattern === "*",
  },
];

for (const tier of tiers) {
  if (!tier.enabled) continue;
  const matched = tier.candidates.find(
    (c) => tier.predicate(c) && matchesBindingScope(c.match, { ...baseScope, peer: tier.scopePeer }),
  );
  if (matched) return choose(matched.binding.agentId, tier.matchedBy);
}

return choose(resolveDefaultAgentId(input.cfg), "default");
```

**关键架构洞察**：这种"层级 tier + 预索引 candidates"的组合设计非常高效：
1. 每层只检查预筛选后的候选集（通过 `byPeer`、`byGuild` 等索引）
2. 层间严格优先级，找到就立即返回
3. 同层内按配置中的 `order` 排序（即声明顺序）

#### 4.1.3 多层缓存策略

路由引擎使用三层缓存：

**第一层：Binding 预处理缓存**
```typescript
const evaluatedBindingsCacheByCfg = new WeakMap<OpenClawConfig, EvaluatedBindingsCache>();
```
- 使用 `WeakMap<OpenClawConfig, ...>` 绑定到配置对象生命周期
- 按 `channel + accountId` 进一步索引
- `byChannelAccount` 上限 2000 条，超限清空重建

**第二层：Binding 索引缓存**
```typescript
type EvaluatedBindingsIndex = {
  byPeer: Map<string, EvaluatedBinding[]>;
  byGuildWithRoles: Map<string, EvaluatedBinding[]>;
  byGuild: Map<string, EvaluatedBinding[]>;
  byTeam: Map<string, EvaluatedBinding[]>;
  byAccount: EvaluatedBinding[];
  byChannel: EvaluatedBinding[];
};
```
为每个 `channel + accountId` 组合构建分类索引，避免对所有 binding 线性扫描。

**第三层：最终路由结果缓存**
```typescript
const resolvedRouteCacheByCfg = new WeakMap<OpenClawConfig, {
  bindingsRef: ...; agentsRef: ...; sessionRef: ...;
  byKey: Map<string, ResolvedAgentRoute>;
}>();
const MAX_RESOLVED_ROUTE_CACHE_KEYS = 4000;
```
- 缓存 key 由所有输入参数拼接而成
- 上限 4000 条，超限清空重建
- 当 `identityLinks` 存在或 debug 模式开启时禁用缓存

**缓存失效策略**：使用 `bindingsRef`、`agentsRef`、`sessionRef` 引用相等性检测配置变更。配置对象改变时所有缓存自动失效。

### 4.2 企业级路由扩展评估

#### 4.2.1 基于技能矩阵的动态路由

**当前状态**：路由完全基于静态 binding 配置，没有运行时的能力匹配。

**扩展方案**：

```typescript
// 扩展 ResolveAgentRouteInput
type EnterpriseRouteInput = ResolveAgentRouteInput & {
  requiredCapabilities?: string[];  // 如 ["procurement", "budget > 100K"]
  taskType?: string;                // 如 "approval", "query"
  tenantId?: string;
};

// 新增技能匹配层
type SkillBinding = {
  agentId: string;
  capabilities: string[];
  score: number;  // 匹配分数
};

// 在 tiers 最前面插入技能匹配层
{
  matchedBy: "skill.match",
  enabled: Boolean(input.requiredCapabilities?.length),
  candidates: resolveSkillCandidates(input.requiredCapabilities),
  predicate: (c) => c.match.skillScore > threshold,
}
```

#### 4.2.2 基于负载的路由

**当前状态**：没有负载感知。同一 binding 匹配的 Agent 总是同一个。

**扩展方案**：在同类型的多个 Worker Agent 之间选择负载最低的：

```typescript
type AgentLoadMetrics = {
  agentId: string;
  activeSessions: number;
  activeSubagents: number;
  queueDepth: number;
  avgResponseTime: number;  // 最近 N 次的平均响应时间
};

function selectLeastLoadedAgent(
  candidates: AgentLoadMetrics[],
  strategy: "round-robin" | "least-connections" | "weighted"
): string {
  // round-robin: 简单轮询
  // least-connections: 选 activeSessions 最少的
  // weighted: 综合考虑 queue depth、response time 等
}
```

#### 4.2.3 基于租户的路由隔离

**当前状态**：完全没有租户概念。所有路由在一个命名空间。

**扩展方案**：在路由输入中加入 `tenantId`，并在 session key 中加入租户前缀：

```typescript
// 扩展 session key 格式
// 当前: agent:<agentId>:<channel>:<accountId>:<peer>
// 扩展: tenant:<tenantId>:agent:<agentId>:<channel>:<accountId>:<peer>

function buildTenantIsolatedSessionKey(params: {
  tenantId: string;
  agentId: string;
  channel: string;
  accountId?: string;
  peer?: RoutePeer;
}): string {
  const base = buildAgentSessionKey(params);
  return `tenant:${params.tenantId}:${base}`;
}
```

需要确保：
1. 数据库层的行级安全（RLS）或表分区
2. 路由缓存按租户隔离
3. Agent 配置按租户独立

#### 4.2.4 基于审批层级的路由

**扩展方案**：金额阈值 -> 自动升级到高级审批 Agent

```typescript
type ApprovalRoutingRule = {
  condition: {
    field: string;        // 如 "amount"
    operator: ">" | ">=" | "<" | "<=" | "==" | "in";
    value: number | string | string[];
  };
  targetAgentId: string;  // 如 "senior-approval-agent"
  escalationNote?: string;
};

// 在路由解析后、Agent 执行前插入审批路由层
function resolveApprovalEscalation(params: {
  originalAgentId: string;
  taskMetadata: Record<string, unknown>;
  rules: ApprovalRoutingRule[];
}): string {
  for (const rule of rules) {
    if (evaluateCondition(rule.condition, params.taskMetadata)) {
      return rule.targetAgentId;
    }
  }
  return params.originalAgentId;
}
```

---

## 5. Session 管理的并发问题

### 5.1 store.ts 的实现剖析

`src/config/sessions/store.ts`（约 860 行）是会话持久化的核心。

#### 5.1.1 存储格式

会话存储为 JSON 文件，路径格式：`~/.openclaw/agents/<agentId>/sessions.json`

文件内容是一个扁平的 `Record<string, SessionEntry>`，key 是规范化的 session key（小写），value 是 `SessionEntry`。

#### 5.1.2 文件锁机制

OpenClaw 使用**应用层 + 文件系统层的双重锁**：

**应用层锁（Lock Queue）**：

```typescript
const LOCK_QUEUES = new Map<string, SessionStoreLockQueue>();

type SessionStoreLockQueue = {
  running: boolean;
  pending: SessionStoreLockTask[];
};

async function drainSessionStoreLockQueue(storePath: string): Promise<void> {
  const queue = LOCK_QUEUES.get(storePath);
  if (!queue || queue.running) return;
  queue.running = true;
  try {
    while (queue.pending.length > 0) {
      const task = queue.pending.shift();
      // 获取文件锁、执行任务、释放文件锁
      let lock = await acquireSessionWriteLock({
        sessionFile: storePath,
        timeoutMs: remainingTimeoutMs,
        staleMs: task.staleMs,
      });
      result = await task.fn();
      await lock?.release();
    }
  } finally {
    queue.running = false;
    // 如果还有待处理任务，调度下一轮
    if (queue.pending.length > 0) {
      queueMicrotask(() => void drainSessionStoreLockQueue(storePath));
    }
  }
}
```

**文件系统层锁**：通过 `acquireSessionWriteLock()` 实现，默认 10s 超时、30s 过期。

#### 5.1.3 TTL 缓存

```typescript
const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 秒
```

读取时先检查缓存：
1. 缓存是否存在？
2. 缓存是否在 TTL 内？
3. 文件 mtime 是否与缓存记录一致？
4. 文件 size 是否与缓存记录一致？

全部通过则返回缓存的 `structuredClone(store)`（深拷贝防止外部修改污染缓存）。

#### 5.1.4 原子写入

```typescript
async function writeSessionStoreAtomic(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): Promise<void> {
  await writeTextAtomic(params.storePath, params.serialized, { mode: 0o600 });
  updateSessionStoreWriteCaches({ ... });
}
```

`writeTextAtomic` 使用 temp-file + rename 模式确保原子性。但在 Windows 上 rename 不是原子的，所以有 5 次重试机制。

### 5.2 文件锁机制的局限性

1. **单机限制**：Lock Queue 是进程内的 `Map`，无法跨进程协调。`acquireSessionWriteLock` 使用文件锁，但文件锁在 NFS 等网络文件系统上不可靠。

2. **序列化瓶颈**：所有对同一 store 文件的操作都必须排队执行。高并发场景（100+ 虚拟员工同时活跃）下，这会成为严重瓶颈。

3. **全文件读写**：每次 `updateSessionStore` 都要读取整个 JSON 文件、修改、写回。文件增长后性能线性下降。

4. **无事务支持**：如果写入中途进程崩溃（在 `writeTextAtomic` 之前），可能丢失 `mutator` 的修改。

5. **缓存一致性**：45s TTL 意味着最多 45s 的读取延迟。如果有多进程写入同一文件，缓存可能不一致。

### 5.3 数据库存储改造方案

如果改为数据库存储，`SessionEntry` 结构需要以下调整：

```sql
-- 核心表
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  session_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,

  -- 通道与投递信息
  channel TEXT,
  last_channel TEXT,
  last_to TEXT,
  last_account_id TEXT,
  last_thread_id TEXT,
  delivery_context JSONB,

  -- 模型覆盖
  model_override TEXT,
  provider_override TEXT,
  thinking_level TEXT,

  -- 状态
  spawn_depth INTEGER DEFAULT 0,
  spawned_by TEXT,
  subject TEXT,
  group_id TEXT,
  group_channel TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- 索引
  UNIQUE(tenant_id, session_key)
);

CREATE INDEX idx_sessions_tenant_agent ON sessions(tenant_id, agent_id);
CREATE INDEX idx_sessions_updated ON sessions(updated_at);

-- 会话转录（替代 .jsonl 文件）
CREATE TABLE session_transcripts (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  sequence_num INTEGER NOT NULL,
  role TEXT NOT NULL,        -- user/assistant/tool
  content TEXT,
  tool_use JSONB,
  tool_result JSONB,
  metadata JSONB,
  token_estimate INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(session_id, sequence_num)
);

-- 行级安全策略
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = current_setting('app.tenant_id')::UUID);
```

**关键改动**：
1. `session_key` 从 JSON 的 key 变为数据库字段，可以加索引
2. 转录从 JSONL 文件变为数据库表，支持 range query 和 pagination
3. 通过 RLS 实现租户隔离
4. `delivery_context` 保持 JSONB 灵活性

### 5.4 跨通道会话实现

**需求**：用户在 Teams 发消息、在 Email 中收到回复。

**OpenClaw 当前的支持**：通过 `dmScope: "main"` + `identityLinks` 可以将不同通道的用户身份关联。但这只解决了"共享 session"的问题，不解决"跨通道投递"。

**完整的跨通道会话方案**：

```typescript
// 1. 身份映射层
type UserIdentityMap = {
  userId: string;  // 全局用户 ID
  identities: Array<{
    channel: string;       // "teams" | "email" | "slack" | ...
    channelUserId: string; // 通道内的用户 ID
    preferredForNotification: boolean;
  }>;
};

// 2. 投递路由层
type DeliveryPreference = {
  userId: string;
  preferences: Array<{
    messageType: "reply" | "notification" | "approval";
    preferredChannel: string;
    fallbackChannels: string[];
    schedule?: {
      workHours: { channel: "teams"; };
      offHours: { channel: "email"; };
    };
  }>;
};

// 3. 跨通道投递器
async function deliverCrossChannel(params: {
  userId: string;
  messageType: string;
  content: string;
  sessionKey: string;
}): Promise<void> {
  const identity = await resolveUserIdentity(params.userId);
  const preference = await resolveDeliveryPreference(params.userId, params.messageType);

  for (const channel of [preference.preferredChannel, ...preference.fallbackChannels]) {
    const channelId = identity.identities.find(i => i.channel === channel);
    if (!channelId) continue;

    try {
      await channelAdapters[channel].send({
        to: channelId.channelUserId,
        content: formatForChannel(channel, params.content),
      });
      // 更新 session 的 lastRoute
      await updateLastRoute({
        sessionKey: params.sessionKey,
        channel,
        to: channelId.channelUserId,
      });
      return;
    } catch {
      continue; // 尝试下一个通道
    }
  }
  throw new Error("All delivery channels failed");
}
```

---

## 6. Plugin Registry 设计深度分析

### 6.1 注册表架构

`src/plugins/registry.ts` 定义了 `PluginRegistry` -- 一个中心化的注册表，统一管理 12 种注册类型：

```typescript
export type PluginRegistry = {
  plugins: PluginRecord[];           // 插件元数据
  tools: PluginToolRegistration[];   // Agent 工具
  hooks: PluginHookRegistration[];   // 传统事件钩子
  typedHooks: TypedPluginHookRegistration[]; // 类型安全钩子
  channels: PluginChannelRegistration[];     // 通道插件
  providers: PluginProviderRegistration[];   // LLM 提供商
  gatewayHandlers: GatewayRequestHandlers;   // Gateway RPC 方法
  httpRoutes: PluginHttpRouteRegistration[];  // HTTP 路由
  cliRegistrars: PluginCliRegistration[];     // CLI 命令
  services: PluginServiceRegistration[];      // 后台服务
  commands: PluginCommandRegistration[];      // 聊天命令
  diagnostics: PluginDiagnostic[];           // 诊断信息
};
```

### 6.2 插件 API（OpenClawPluginApi）

每个插件通过 `createApi()` 获得一个独立的注册 API 对象：

```typescript
const createApi = (record, params): OpenClawPluginApi => ({
  id: record.id,
  name: record.name,
  config: params.config,
  pluginConfig: params.pluginConfig,
  runtime: registryParams.runtime,
  logger: normalizeLogger(registryParams.logger),
  registerTool: (tool, opts) => registerTool(record, tool, opts),
  registerHook: (events, handler, opts) => registerHook(record, events, handler, opts, params.config),
  registerHttpRoute: (params) => registerHttpRoute(record, params),
  registerChannel: (registration) => registerChannel(record, registration),
  registerProvider: (provider) => registerProvider(record, provider),
  registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
  registerCli: (registrar, opts) => registerCli(record, registrar, opts),
  registerService: (service) => registerService(record, service),
  registerCommand: (command) => registerCommand(record, command),
  resolvePath: (input) => resolveUserPath(input),
  on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts, params.hookPolicy),
});
```

**设计亮点**：
1. 每个 API 对象绑定到特定的 `PluginRecord`，注册操作自动关联到正确的插件
2. 所有注册操作都有重复检查和诊断信息输出
3. `hookPolicy` 机制可以控制插件是否被允许进行 prompt injection

### 6.3 插件发现与加载流程

`src/plugins/loader.ts` 的 `loadOpenClawPlugins()` 实现了完整的插件加载流程：

```
1. 配置规范化 (normalizePluginsConfig)
   - 解析 enabled/allow/entries 等配置

2. 缓存检查 (registryCache)
   - 按 workspaceDir + plugins config 组合作为 cache key

3. 插件发现 (discoverOpenClawPlugins)
   - 从 extensions/ 目录、workspaceDir、extraPaths 中发现候选插件

4. Manifest 加载 (loadPluginManifestRegistry)
   - 读取每个候选插件的 package.json 中的 openclaw manifest

5. 逐个加载
   for each candidate:
   a. 检查 enable state（allow 白名单、entries 配置、kind 特殊处理）
   b. Memory slot 互斥检查（同类 memory 插件只能加载一个）
   c. 安全检查（boundary file check，防止路径穿越）
   d. Jiti 动态加载 TypeScript/JavaScript 模块
   e. 配置验证（JSON Schema）
   f. 调用插件的 register() 函数

6. 激活 (activatePluginRegistry)
   - setActivePluginRegistry 写入全局 Symbol
   - initializeGlobalHookRunner 初始化钩子执行器
```

### 6.4 全局单例的实现

`src/plugins/runtime.ts` 使用 `Symbol.for()` 实现跨模块边界的全局单例：

```typescript
const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  key: string | null;
  version: number;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = { registry: createEmptyPluginRegistry(), key: null, version: 0 };
  }
  return globalState[REGISTRY_STATE];
})();
```

**为什么用 `Symbol.for` 而不是普通模块变量**：
- ESM 模块有独立的命名空间，动态 import 可能创建不同的模块实例
- `Symbol.for("openclaw.pluginRegistryState")` 在整个 V8 isolate 中是唯一的
- 确保通过 jiti 加载的插件也能访问到同一个 registry

### 6.5 权限隔离评估

**当前支持的权限控制**：

1. **加载级别**：`plugins.allow` 白名单控制哪些插件可以加载
2. **Hook 级别**：`hookPolicy.allowPromptInjection` 控制插件是否可以修改 prompt
3. **HTTP 路由级别**：`auth: "gateway" | "plugin"` 控制路由的认证方式
4. **Gateway 方法级别**：不允许覆盖核心 Gateway 方法

**缺失的权限控制**：

1. **工具执行权限**：没有控制哪些工具可以执行文件操作、网络请求等
2. **数据访问权限**：没有限制插件可以访问哪些 session 的数据
3. **通道访问权限**：没有限制插件可以向哪些通道发送消息
4. **资源使用限制**：没有 CPU/内存/网络的使用限制
5. **审计日志**：没有记录插件的操作行为

**与 pi-mono Extension 机制的对比**：

| 维度 | OpenClaw Plugin | pi-mono Extension |
|------|-----------------|-------------------|
| **加载方式** | jiti 动态加载 .ts/.js | 编译时注册 |
| **注册模式** | 命令式（调用 registerXxx） | 声明式（ExtensionContext） |
| **生命周期** | 仅 register，无 destroy | beforeRun / afterRun 等 |
| **隔离级别** | 共享进程空间 | 共享进程空间 |
| **类型安全** | PluginHookHandlerMap 类型化钩子 | 强类型 Extension interface |

### 6.6 对虚拟员工平台的改造建议

```typescript
// 企业级 Plugin API 扩展
type EnterprisePluginApi = OpenClawPluginApi & {
  // 权限声明
  permissions: {
    requiredCapabilities: string[];  // 如 ["file.read", "network.external"]
    requestedScopes: string[];       // 如 ["session:read", "channel:send"]
  };

  // 资源限制
  resourceLimits: {
    maxMemoryMB: number;
    maxCpuTimeMs: number;
    maxNetworkRequestsPerMinute: number;
  };

  // 审计
  audit: {
    logAction(action: string, details: Record<string, unknown>): void;
  };

  // 生命周期
  onDestroy?: () => Promise<void>;
  onTenantIsolate?: (tenantId: string) => PluginApi;  // 返回租户隔离的子 API
};
```

---

## 7. Compaction 策略的改进空间

### 7.1 compaction.ts 完整流程

`src/agents/compaction.ts`（约 465 行）实现了上下文窗口压缩摘要。

核心常量：

```typescript
export const BASE_CHUNK_RATIO = 0.4;          // 基础分块比率
export const MIN_CHUNK_RATIO = 0.15;           // 最小分块比率
export const SAFETY_MARGIN = 1.2;              // 20% 安全余量
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;  // 摘要指令开销
```

### 7.2 摘要流程图

```
1. 触发条件检查
   estimateMessagesTokens(messages) > contextTokens ?
        |
        v (yes)
2. 自适应分块比率计算
   computeAdaptiveChunkRatio(messages, contextWindow)
   - 平均消息 > 10% context -> 缩小 chunk ratio
   - 否则使用 BASE_CHUNK_RATIO (0.4)
        |
        v
3. 历史修剪 (pruneHistoryForContextShare)
   - budget = maxContextTokens * maxHistoryShare (默认 50%)
   - 循环：按 token 份额拆分 -> 丢弃最老的 chunk -> 修复孤儿 tool_result
   - 返回 {keptMessages, droppedMessages}
        |
        v
4. 分阶段摘要 (summarizeInStages)
   a. 按 token 份额拆分为 N 部分（默认 2 部分）
   b. 对每部分调用 summarizeWithFallback()
   c. 合并所有部分摘要为最终摘要
        |
        v
5. 单部分摘要 (summarizeWithFallback)
   a. 尝试完整摘要 (summarizeChunks)
   b. 失败 -> 降级：只摘要小消息，标注大消息被省略
   c. 再失败 -> 最终降级：仅输出统计信息
        |
        v
6. 分块摘要 (summarizeChunks)
   a. 安全过滤：stripToolResultDetails（移除不受信内容）
   b. 按 maxChunkTokens 拆分为多个 chunk
   c. 级联摘要：每个 chunk 的摘要作为下一个 chunk 的 previousSummary
   d. 每个 chunk 调用 pi-mono 的 generateSummary()
   e. 失败重试：retryAsync (3次, 500ms-5000ms, 20% jitter)
```

### 7.3 摘要质量控制

摘要指令（`buildCompactionSummarizationInstructions`）包含：

**标识符保留策略**（三种模式）：
- `strict`（默认）：保留所有不透明标识符（UUID、URL、文件名等）
- `custom`：使用自定义指令
- `off`：不保留标识符

**合并摘要指令**（`MERGE_SUMMARIES_INSTRUCTIONS`）：
```
Merge these partial summaries into a single cohesive summary.

MUST PRESERVE:
- Active tasks and their current status (in-progress, blocked, pending)
- Batch operation progress (e.g., '5/17 items completed')
- The last thing the user requested and what was being done about it
- Decisions made and their rationale
- TODOs, open questions, and constraints
- Any commitments or follow-ups promised

PRIORITIZE recent context over older history.
```

**安全措施**：`toolResult.details` 中的不受信内容通过 `stripToolResultDetails()` 在摘要前被移除，永远不会进入 LLM。

### 7.4 虚拟员工场景的改进需求

对于审批历史、操作记录等企业场景，当前的自由文本摘要存在以下问题：

#### 问题 1：关键决策可能在摘要中丢失

审批流中的关键信息（谁批了、什么时候批的、金额是多少）如果被模糊化或遗漏，可能导致审计问题。

#### 问题 2：结构化信息退化为自然语言

原始的操作记录是结构化的（JSON），摘要后变成自然语言描述，后续 Agent 需要重新解析，引入不确定性。

#### 问题 3：时间线信息丢失

摘要倾向于按主题聚合，而审批流需要精确的时间线。

### 7.5 改进方案：结构化摘要 + 操作日志分离

```typescript
// 方案一：结构化摘要
type StructuredSummary = {
  // 自由文本摘要（现有能力）
  textSummary: string;

  // 结构化的决策记录（新增，永不压缩）
  decisions: Array<{
    timestamp: number;
    actor: string;
    action: "approved" | "rejected" | "escalated" | "delegated";
    subject: string;
    details: Record<string, unknown>;  // 如 { amount: 150000, currency: "CNY" }
    reason?: string;
  }>;

  // 结构化的状态快照（新增，每次摘要更新）
  stateSnapshot: {
    activeTasks: Array<{
      id: string;
      type: string;
      status: "pending" | "in-progress" | "blocked" | "completed";
      assignee?: string;
      progress?: string;
    }>;
    pendingApprovals: Array<{
      id: string;
      requestedBy: string;
      amount?: number;
      deadline?: number;
    }>;
  };

  // 操作日志（新增，独立存储，不进入 LLM 上下文）
  auditLogRef: string;  // 指向外部存储的引用
};

// 方案二：Compaction 时选择性保留
function compactWithBusinessRules(params: {
  messages: AgentMessage[];
  businessRules: {
    alwaysPreserveTypes: string[];      // 如 ["approval_decision", "escalation"]
    preserveLastNOfType: Record<string, number>;  // 如 {"status_query": 3}
    compactableTypes: string[];          // 如 ["general_chat", "info_query"]
  };
}): {
  preserved: AgentMessage[];  // 永不压缩的消息
  toSummarize: AgentMessage[];  // 需要摘要的消息
} {
  // 按 business rules 分类消息
  // preserved 消息直接保留在上下文中
  // toSummarize 消息进入正常的摘要流程
}
```

### 7.6 更优的策略对比

| 策略 | 优点 | 缺点 | 适用场景 |
|------|------|------|---------|
| **自由文本摘要**（当前） | 灵活、通用 | 可能丢失关键结构化信息 | 日常对话 |
| **结构化摘要** | 关键信息不丢失 | 需要预定义结构 | 审批流、操作记录 |
| **滑动窗口** | 简单、可预测 | 丢弃旧消息，无摘要 | 实时对话 |
| **分级摘要** | 近期详细、远期概括 | 实现复杂 | 长期任务 |
| **操作日志分离** | 审计完整性 | 额外存储成本 | 合规场景 |

**建议的混合策略**：

```
[最新 N 条消息] -- 原样保留，提供即时上下文
        +
[结构化状态快照] -- 当前任务状态、待审批项等
        +
[最近决策日志] -- 最近 K 条审批/操作决策
        +
[历史概况摘要] -- 自由文本摘要，提供背景
        +
[外部审计日志引用] -- 完整操作记录的存储位置
```

---

## 8. Claw-like 可复用设计模式

### 8.1 模式一：Gateway 单一控制面模式

**问题场景**：
多通道 AI 系统需要统一管理通道连接、Agent 调度、会话路由、插件加载等，如果分散到多个服务中，协调成本高且容易不一致。

**解决方案**：
将所有控制面逻辑集中到一个 Gateway 进程中，作为唯一的入口和编排者。

**代码示例**（`src/gateway/server.impl.ts` 启动序列简化）：

```typescript
async function startGatewayServer(options: GatewayServerOptions) {
  // 1. 加载配置
  const cfg = loadConfig();

  // 2. 初始化 Secrets
  await initSecretsSnapshot(cfg);

  // 3. 构建 Plugin Registry（所有扩展点的中心）
  const registry = loadOpenClawPlugins({ config: cfg, ... });

  // 4. 启动 HTTP/WebSocket 服务器
  const server = createHttpServer(cfg, registry);

  // 5. 启动 Channel Manager（所有通道的生命周期管理者）
  const channelManager = createChannelManager(cfg, registry);
  await channelManager.startAll();

  // 6. 启动辅助服务（Cron、Health、mDNS 等）
  await startSidecarServices(cfg, registry);
}
```

**适配建议**：
- 保留 Gateway 作为控制面的设计，但将数据面（Agent 执行）分离到独立的 Worker 进程
- Gateway 负责：路由决策、会话管理、通道连接管理、配置热加载
- Worker 负责：LLM 调用、工具执行、上下文管理
- 通过消息队列（如 Redis Streams 或 NATS）连接 Gateway 和 Worker

### 8.2 模式二：组合式适配器模式（ChannelPlugin）

**问题场景**：
需要对接 20+ 种通讯通道，每种通道的能力不同（有的支持线程、有的支持语音、有的支持文件），如何设计统一接口而不强制实现所有功能？

**解决方案**：
使用**可选组合式**的适配器接口，而非继承式的基类。每个适配器是可选的，通道只实现需要的接口。

**代码示例**（`src/channels/plugins/types.plugin.ts` 简化）：

```typescript
export type ChannelPlugin<ResolvedAccount = any> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;

  // 核心适配器（必选）
  config: ChannelConfigAdapter<ResolvedAccount>;

  // 可选适配器 -- 按需实现
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;  // 启动/停止
  outbound?: ChannelOutboundAdapter;                  // 发送消息
  streaming?: ChannelStreamingAdapter;                // 流式输出
  security?: ChannelSecurityAdapter<ResolvedAccount>; // 安全
  pairing?: ChannelPairingAdapter;                    // 配对
  groups?: ChannelGroupAdapter;                       // 群组
  threading?: ChannelThreadingAdapter;                // 线程
  mentions?: ChannelMentionAdapter;                   // @提及
  agentPrompt?: ChannelAgentPromptAdapter;            // Agent 提示
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];  // Agent 工具
  status?: ChannelStatusAdapter;                      // 状态诊断
  heartbeat?: ChannelHeartbeatAdapter;                // 心跳
  actions?: ChannelMessageActionAdapter;              // 消息操作
  // ...
};
```

**关键设计决策**：
1. 使用 TypeScript 的可选属性（`?:`）而非抽象方法
2. 泛型 `<ResolvedAccount>` 让每个通道自定义账号结构
3. `capabilities: ChannelCapabilities` 声明通道支持的功能（如是否支持图片、语音、线程等），让上层代码可以条件分支

**适配建议**：
为虚拟员工平台扩展以下适配器：

```typescript
type EnterpriseChannelPlugin = ChannelPlugin & {
  // 企业级扩展
  oauth?: ChannelOAuthAdapter;          // OAuth 令牌管理
  tenantConfig?: ChannelTenantAdapter;  // 组织级别配置
  audit?: ChannelAuditAdapter;          // 操作审计日志
  directory?: ChannelDirectoryAdapter;  // 通讯录集成
  notification?: ChannelNotificationAdapter;  // 主动推送
  approval?: ChannelApprovalAdapter;    // 审批交互（按钮/表单）
};
```

### 8.3 模式三：分层路由模式

**问题场景**：
消息到达后需要路由到正确的 Agent。路由规则可能基于不同维度（用户、群组、角色、通道等），需要可预测的优先级和高性能。

**解决方案**：
定义严格的分层优先级，每层有独立的预索引。匹配从最具体的层开始，找到即停。

**代码示例**（简化自 `resolve-route.ts`）：

```typescript
// 1. 定义层级
const tiers = [
  { name: "exact-peer",   enabled: hasPeer,   candidates: indexByPeer[peer] },
  { name: "parent-peer",  enabled: hasParent,  candidates: indexByPeer[parentPeer] },
  { name: "guild+roles",  enabled: hasGuild,   candidates: indexByGuild[guildId] },
  { name: "guild",        enabled: hasGuild,   candidates: indexByGuild[guildId] },
  { name: "team",         enabled: hasTeam,    candidates: indexByTeam[teamId] },
  { name: "account",      enabled: true,       candidates: indexByAccount },
  { name: "channel",      enabled: true,       candidates: indexByChannel },
];

// 2. 分层匹配
for (const tier of tiers) {
  if (!tier.enabled) continue;
  const matched = tier.candidates.find(c => matchesScope(c, scope));
  if (matched) return buildRoute(matched);
}
return buildDefaultRoute();

// 3. 预索引加速
type BindingsIndex = {
  byPeer: Map<string, Binding[]>;       // peer kind:id -> bindings
  byGuildWithRoles: Map<string, Binding[]>;
  byGuild: Map<string, Binding[]>;
  byTeam: Map<string, Binding[]>;
  byAccount: Binding[];
  byChannel: Binding[];
};
```

**适配建议**：扩展层级以支持企业路由：

```typescript
const enterpriseTiers = [
  { name: "tenant+capability", ... },   // 租户 + 能力精确匹配
  { name: "tenant+department", ... },    // 租户 + 部门匹配
  { name: "approval-level", ... },       // 审批层级（金额 > 阈值升级）
  ...existingTiers,                       // 原有层级
  { name: "load-balanced", ... },        // 负载均衡（同类 Agent 选最闲的）
];
```

### 8.4 模式四：会话隔离粒度模式

**问题场景**：
不同用户、不同通道的对话需要隔离，但隔离粒度应该可配置（有时同一用户在不同通道应该共享对话上下文）。

**解决方案**：
通过 `dmScope` 配置控制 session key 的构建方式，实现可配置的隔离粒度。

**代码示例**（简化自 `session-key.ts`）：

```typescript
function buildAgentPeerSessionKey(params: {
  agentId: string;
  mainKey: string;
  channel: string;
  accountId?: string;
  peerKind: string;
  peerId: string | null;
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  identityLinks?: Record<string, string[]>;
}): string {
  const { agentId, channel, accountId, peerKind, peerId, dmScope } = params;

  // DM 消息的隔离粒度
  if (peerKind === "direct" || !peerId) {
    switch (dmScope) {
      case "main":
        return `agent:${agentId}:main`;
        // 所有 DM 共享一个 session -- 最宽松

      case "per-peer":
        return `agent:${agentId}:${resolveIdentity(peerId)}`;
        // 每个用户一个 session（跨通道共享）

      case "per-channel-peer":
        return `agent:${agentId}:${channel}:${peerId}`;
        // 每个通道+用户一个 session

      case "per-account-channel-peer":
        return `agent:${agentId}:${accountId}:${channel}:${peerId}`;
        // 最细粒度
    }
  }

  // 群组消息：总是 per-group
  return `agent:${agentId}:${channel}:${accountId}:${peerKind}:${peerId}`;
}
```

**适配建议**：扩展为企业隔离粒度：

```typescript
type EnterpriseDmScope =
  | "tenant-main"                       // 租户级共享
  | "tenant-per-agent"                   // 租户+Agent 隔离
  | "tenant-per-channel-peer"            // 租户+通道+用户
  | "tenant-per-workflow"                // 租户+工作流实例（审批流等）
  | "tenant-per-account-channel-peer";   // 最细粒度
```

### 8.5 模式五：能力声明模式（ChannelCapabilities）

**问题场景**：
不同的通道/Agent 有不同的能力（支持图片否？支持线程否？支持表单否？），上层代码需要根据能力动态调整行为。

**解决方案**：
通过声明式的 Capabilities 对象，将能力与实现分离。

**代码示例**：

```typescript
export type ChannelCapabilities = {
  // 消息类型能力
  supportsImages?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  supportsFiles?: boolean;
  supportsRichText?: boolean;
  supportsButtons?: boolean;
  supportsCards?: boolean;

  // 交互能力
  supportsThreading?: boolean;
  supportsMentions?: boolean;
  supportsReactions?: boolean;
  supportsEditing?: boolean;
  supportsDeleting?: boolean;

  // 输出控制
  maxMessageLength?: number;
  supportsStreaming?: boolean;
  supportsBlockReply?: boolean;

  // 安全能力
  supportsPairing?: boolean;
  supportsOAuth?: boolean;
};

// 使用示例：上层代码根据能力决定行为
function formatReplyForChannel(reply: string, capabilities: ChannelCapabilities): string {
  if (!capabilities.supportsRichText) {
    return stripMarkdown(reply);
  }
  if (capabilities.maxMessageLength && reply.length > capabilities.maxMessageLength) {
    return splitIntoChunks(reply, capabilities.maxMessageLength);
  }
  return reply;
}
```

**适配建议**：为虚拟员工扩展能力声明：

```typescript
type EnterpriseCapabilities = ChannelCapabilities & {
  supportsApprovalButtons?: boolean;  // 审批按钮（通过/拒绝）
  supportsFormInput?: boolean;         // 表单输入
  supportsCalendarPicker?: boolean;    // 日期选择
  supportsFileUpload?: boolean;        // 文件上传
  supportsLocation?: boolean;          // 位置信息
  supportsSignature?: boolean;         // 电子签名
  maxAttachmentSizeMB?: number;        // 附件大小限制
  supportsScheduledMessages?: boolean; // 定时消息
  supportsReceipt?: boolean;           // 已读回执
};
```

### 8.6 模式六：Lane 并发控制模式

**问题场景**：
多个消息可能同时到达同一个 Agent/Session，需要控制并发避免竞态条件。

**解决方案**：
通过 Lane（泳道）机制控制并发，不同类型的请求走不同的 Lane，每个 Lane 内串行执行。

**代码位置**：`src/process/lanes.ts` + `src/agents/pi-embedded-runner/lanes.ts`

```typescript
// 定义 Lane 类型
enum CommandLane {
  Nested = "nested",       // 嵌套执行（如命令处理）
  Subagent = "subagent",   // 子 Agent 执行
}

// 使用方式：在 spawn subagent 时指定 lane
await callGateway({
  method: "agent",
  params: {
    ...taskParams,
    lane: AGENT_LANE_SUBAGENT,  // 不与主 Agent 的 Lane 竞争
  },
});
```

**适配建议**：
扩展为按优先级的 Lane 池：

```typescript
enum EnterpriseLane {
  Critical = "critical",    // 紧急审批 -- 最高优先级，专用 Worker
  Normal = "normal",        // 常规任务
  Subagent = "subagent",    // 子 Agent
  Background = "background",// 后台任务（报表生成等）
  Maintenance = "maintenance", // 维护任务（session 清理等）
}

// 每个 Lane 可以配置不同的并发度
const LANE_CONCURRENCY: Record<EnterpriseLane, number> = {
  critical: 5,    // 5 个并发
  normal: 10,     // 10 个并发
  subagent: 20,   // 20 个并发
  background: 3,  // 3 个并发
  maintenance: 1, // 串行
};
```

### 8.7 模式七：退避重启模式（Channel Manager）

**问题场景**：
通道连接可能因为网络问题断开，需要自动重连，但不能无限制地快速重连。

**解决方案**：
指数退避重启，带最大重试次数和手动停止保护。

**代码位置**：`src/gateway/server-channels.ts`

```typescript
// Channel Manager 的重启策略
const RESTART_CONFIG = {
  initialDelayMs: 5_000,      // 初始等待 5 秒
  maxDelayMs: 300_000,        // 最大等待 5 分钟
  maxAttempts: 10,            // 最多重试 10 次
  backoffMultiplier: 2,       // 指数退避倍数
};

// 手动停止保护
type ChannelAccountState = {
  manuallyStopped: boolean;   // 手动停止标记，阻止自动重启
  reconnectAttempts: number;
  lastError?: string;
  status: "enabled" | "running" | "stopped" | "error";
};
```

**适配建议**：
企业场景需要更丰富的重启策略：

```typescript
type EnterpriseRestartPolicy = {
  strategy: "exponential" | "linear" | "circuit-breaker";
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;

  // 熔断器模式
  circuitBreaker?: {
    failureThreshold: number;    // 连续失败 N 次后熔断
    resetTimeoutMs: number;      // 熔断后等待时间
    halfOpenMaxAttempts: number; // 半开状态最多尝试次数
  };

  // 告警
  alertAfterAttempts: number;    // 重试 N 次后发送告警
  alertChannels: string[];       // 告警通道

  // 故障转移
  failoverAgentId?: string;      // 故障转移到备用 Agent
};
```

---

## 9. 与 OpenAI Agents SDK 的对比

### 9.1 Handoff 机制详解

OpenAI Agents SDK（`/Volumes/leoyun/agentic/ref-repos/openai-agents-python/`）的 Handoff 机制位于 `src/agents/handoffs/__init__.py`。

核心数据结构：

```python
@dataclass
class Handoff(Generic[TContext, TAgent]):
    tool_name: str              # 工具名称
    tool_description: str       # 工具描述
    input_json_schema: dict     # 输入 JSON Schema
    on_invoke_handoff: Callable  # 调用时的回调
    agent_name: str             # 目标 Agent 名称
    input_filter: HandoffInputFilter | None  # 输入过滤器
    nest_handoff_history: bool | None  # 是否嵌套历史
    is_enabled: bool | Callable  # 是否启用（可动态）
```

创建 Handoff：

```python
def handoff(
    agent: Agent[TContext],
    tool_name_override: str | None = None,
    on_handoff: OnHandoffWithInput | OnHandoffWithoutInput | None = None,
    input_type: type[THandoffInput] | None = None,
    input_filter: Callable | None = None,
    nest_handoff_history: bool | None = None,
    is_enabled: bool | Callable = True,
) -> Handoff[TContext, Agent[TContext]]:
    # handoff 始终返回 agent 参数指定的目标 Agent
    # on_handoff 仅用于副作用（如记录日志、更新状态）
    async def _invoke_handoff(ctx, input_json):
        if on_handoff:
            await on_handoff(ctx, validated_input)
        return agent  # 关键：总是返回同一个 agent
```

### 9.2 对比分析

| 维度 | OpenClaw Subagent | OpenAI Agents SDK Handoff |
|------|-------------------|--------------------------|
| **语义** | 父 Agent 委派子任务 | 当前 Agent 移交控制权给目标 Agent |
| **控制权** | 父 Agent 保持控制权，子 Agent 完成后回报 | 控制权完全转移，父 Agent 退出 |
| **并行性** | 支持多个子 Agent 并行运行（maxChildren=5） | 串行：一次只有一个 Active Agent |
| **历史处理** | 子 Agent 有独立 session，不继承父 Agent 历史 | `nest_handoff_history` 可以将父 Agent 的历史摘要传给子 Agent |
| **结果返回** | 通过 Announce 机制异步通知父 Agent | 目标 Agent 直接与用户交互，无需返回 |
| **动态路由** | `allowAgents` 白名单限制可 spawn 的目标 | `is_enabled` 可以动态控制哪些 handoff 可用 |
| **输入过滤** | 无（子 Agent 收到完整任务描述） | `input_filter` 可以过滤/修改传递给目标 Agent 的历史 |
| **类型安全** | TypeScript 类型系统 + 运行时校验 | Pydantic TypeAdapter + JSON Schema strict mode |
| **超时控制** | `runTimeoutSeconds` 可配置 | 无内建超时（由 Runner 层控制） |
| **状态追踪** | 完整的 SubagentRunRecord 生命周期 | 通过 RunItem 追踪（HandoffInputData） |

### 9.3 Handoff 的历史嵌套机制（OpenClaw 没有的）

OpenAI Agents SDK 的 `nest_handoff_history` 功能（`src/agents/handoffs/history.py`）值得特别关注：

```python
def nest_handoff_history(handoff_input_data):
    # 1. 扁平化已有的嵌套历史（如果之前已经嵌套过）
    flattened_history = _flatten_nested_history_messages(normalized_history)

    # 2. 将所有历史条目格式化为编号列表
    summary_lines = [
        f"{idx + 1}. {_format_transcript_item(item)}"
        for idx, item in enumerate(transcript)
    ]

    # 3. 包装为一个 assistant 消息
    content = "\n".join([
        "For context, here is the conversation so far:",
        "<CONVERSATION HISTORY>",
        *summary_lines,
        "</CONVERSATION HISTORY>",
    ])

    # 4. 过滤不需要的条目（function_call/reasoning 等）
    # 5. 返回精简后的 HandoffInputData
```

**OpenClaw 可以借鉴的点**：
- 在 subagent spawn 时，将父 Agent 的相关历史摘要注入到子 Agent 的系统提示中
- 使用结构化标记（如 `<CONVERSATION HISTORY>` 标签）便于后续解析和去重
- 支持在嵌套 handoff 时扁平化已有的历史摘要，避免无限嵌套

### 9.4 对我们项目的启示

对于虚拟员工的 Coordinator -> Worker 委派模式，需要结合两者的优点：

```typescript
// 混合模式设计
type DelegationMode =
  | "spawn"     // OpenClaw 风格：父 Agent 保持控制权，子 Agent 并行执行
  | "handoff"   // OpenAI 风格：控制权转移，适合"我不擅长，交给专家"
  | "consult"   // 新增：短暂咨询，子 Agent 返回结构化建议但不执行
  ;

type DelegationRequest = {
  mode: DelegationMode;
  targetAgentId: string;
  task: StructuredTask;
  historyPolicy: "none" | "summary" | "full" | "relevant-only";
  returnPolicy: "async-announce" | "sync-wait" | "fire-and-forget";
  timeout: number;
};
```

---

## 10. 面向虚拟员工平台的综合评估

### 10.1 架构借鉴清单

| 优先级 | OpenClaw 模式 | 借鉴方式 | 改造程度 |
|--------|--------------|---------|---------|
| P0 | 组合式 ChannelPlugin 接口 | 直接借鉴结构，扩展企业适配器 | 中 |
| P0 | 分层路由优先级 | 借鉴 tier 结构，增加企业维度 | 中 |
| P0 | Session Key 结构化命名 | 借鉴格式，加入 tenant 前缀 | 低 |
| P1 | Subagent 生命周期追踪 | 借鉴 RunRecord 结构，扩展状态机 | 高 |
| P1 | Compaction 分块摘要策略 | 借鉴流程，增加结构化摘要 | 中 |
| P1 | Plugin Registry 统一注册 | 借鉴注册模式，增加权限隔离 | 高 |
| P2 | Lane 并发控制 | 扩展为优先级 Lane 池 | 中 |
| P2 | Channel Manager 退避重启 | 扩展为熔断器模式 | 低 |
| P2 | Announce 投递重试策略 | 直接借鉴退避/重试/放弃策略 | 低 |

### 10.2 必须重新设计的部分

#### 10.2.1 持久化层

OpenClaw 使用 JSON 文件 + 文件锁，完全不适合企业场景。

**替换方案**：PostgreSQL + Redis
- Session Store -> PostgreSQL 表 + RLS
- Session Transcripts -> PostgreSQL + 分区表（按时间）
- 路由缓存 -> Redis
- Subagent Registry -> PostgreSQL + Redis pub/sub
- Plugin Registry -> 启动时加载到内存，配置变更通过事件总线通知

#### 10.2.2 进程模型

OpenClaw 是单 Node.js 进程，所有通道和 Agent 共享进程空间。

**替换方案**：微服务架构
- Gateway Service：路由、会话管理、通道连接
- Worker Service（多实例）：Agent 执行、LLM 调用
- Channel Service（可选，高流量通道独立部署）
- 使用 NATS/Redis Streams 进行服务间通信

#### 10.2.3 安全模型

OpenClaw 的 AllowFrom 白名单不适合企业 RBAC。

**替换方案**：
- 集成企业 IAM（Azure AD / LDAP / OIDC）
- 基于角色的权限矩阵
- 操作级审计日志
- 数据分级与访问控制

#### 10.2.4 Agent 模型

OpenClaw 的 Agent 是被动的（收到消息才运行），我们的虚拟员工需要主动+被动混合。

**替换方案**：
- 被动模式：消息驱动（保留 OpenClaw 的 auto-reply pipeline）
- 主动模式：定时任务、事件监听、条件触发
- 长驻模式：某些虚拟员工持续监控仪表盘、邮箱等
- 混合模式：平时休眠，收到消息或条件触发时激活

### 10.3 实施路线图建议

**Phase 1（基础设施，2-3 周）**：
1. 建立 PostgreSQL 数据库 schema（sessions、transcripts、agents、tenants）
2. 实现数据库版的 SessionStore（替代文件版）
3. 实现分层路由引擎（复用 OpenClaw 的 tier 结构）
4. 实现组合式 ChannelPlugin 接口（先支持 1-2 个企业通道）

**Phase 2（Agent 框架，2-3 周）**：
1. 实现 Coordinator -> Worker 的委派模式（基于 OpenClaw subagent 改造）
2. 实现结构化任务定义（StructuredTask）
3. 实现能力匹配路由
4. 实现 Compaction 的结构化摘要扩展

**Phase 3（企业特性，3-4 周）**：
1. 多租户隔离
2. RBAC 权限体系
3. 审批流状态机
4. 审计日志
5. 主动推送机制

**Phase 4（运维与扩展，2-3 周）**：
1. 微服务拆分（Gateway + Worker）
2. 优先级队列与负载均衡
3. 可观测性（OpenTelemetry）
4. 管理面板

### 10.4 关键风险提示

1. **LLM 成本控制**：多 Agent 协作会显著增加 LLM 调用次数。需要在路由层做智能分流（简单任务用小模型，复杂任务用大模型），以及在 Compaction 层控制上下文长度。

2. **延迟敏感性**：企业审批流对延迟敏感。子 Agent 的 announce 投递路径（queue -> direct -> retry）可能引入不可预测的延迟。建议为关键路径使用同步等待模式。

3. **状态一致性**：从文件存储迁移到数据库时，需要处理好分布式事务问题。特别是 "创建 session + 发送任务 + 注册 run record" 这三个操作需要原子性。

4. **Plugin 生态迁移**：OpenClaw 有 40+ 扩展插件。如果我们要复用其通道适配器，需要保持 PluginApi 的兼容性，或者提供适配层。

---

## 附录 A：核心文件索引

### A.1 Agent 系统

| 文件 | 行数(约) | 职责 |
|------|---------|------|
| `src/agents/subagent-spawn.ts` | 880 | 子 Agent 创建入口 |
| `src/agents/subagent-registry.ts` | 1100 | 子 Agent 运行记录管理 |
| `src/agents/subagent-announce.ts` | 1000+ | 完成通知构建与投递 |
| `src/agents/compaction.ts` | 465 | 上下文压缩摘要 |
| `src/agents/pi-embedded-runner/run.ts` | 大型 | Agent 执行入口 |
| `src/agents/system-prompt.ts` | - | 系统提示构建 |
| `src/agents/lanes.ts` | 5 | Lane 常量定义 |

### A.2 路由系统

| 文件 | 行数(约) | 职责 |
|------|---------|------|
| `src/routing/resolve-route.ts` | 790 | 七层分级路由 |
| `src/routing/session-key.ts` | - | Session Key 构建 |
| `src/routing/bindings.ts` | - | Binding 配置加载 |
| `src/routing/account-id.ts` | - | Account ID 规范化 |

### A.3 Auto-Reply Pipeline

| 文件 | 职责 |
|------|------|
| `src/auto-reply/inbound-debounce.ts` | 入站去抖 |
| `src/auto-reply/dispatch.ts` | 消息分发入口 |
| `src/auto-reply/reply/get-reply.ts` | 完整回复生成 |
| `src/auto-reply/reply/agent-runner.ts` | Agent 执行 |
| `src/auto-reply/reply/queue/` | Followup 队列 |

### A.4 Session 管理

| 文件 | 行数(约) | 职责 |
|------|---------|------|
| `src/config/sessions/store.ts` | 860 | Session 持久化+锁 |
| `src/config/sessions/types.ts` | - | SessionEntry 类型 |
| `src/config/sessions/store-cache.ts` | - | TTL 缓存 |
| `src/config/sessions/disk-budget.ts` | - | 磁盘空间管理 |

### A.5 Plugin 系统

| 文件 | 行数(约) | 职责 |
|------|---------|------|
| `src/plugins/registry.ts` | 606 | 注册表与 API 创建 |
| `src/plugins/runtime.ts` | 50 | 全局单例管理 |
| `src/plugins/loader.ts` | 856 | 插件发现+加载 |
| `src/plugins/discovery.ts` | - | 插件文件发现 |
| `src/plugins/hook-runner-global.ts` | - | Hook 执行器 |

---

## 附录 B：关键类型定义速查

### B.1 ChannelPlugin 接口

文件：`src/channels/plugins/types.plugin.ts`

```typescript
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter<ResolvedAccount>;
  configSchema?: ChannelConfigSchema;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  setup?: ChannelSetupAdapter;
  outbound?: ChannelOutboundAdapter;
  streaming?: ChannelStreamingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  pairing?: ChannelPairingAdapter;
  auth?: ChannelAuthAdapter;
  groups?: ChannelGroupAdapter;
  threading?: ChannelThreadingAdapter;
  mentions?: ChannelMentionAdapter;
  agentPrompt?: ChannelAgentPromptAdapter;
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  heartbeat?: ChannelHeartbeatAdapter;
  actions?: ChannelMessageActionAdapter;
  commands?: ChannelCommandAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  elevated?: ChannelElevatedAdapter;
  onboarding?: ChannelOnboardingAdapter;
};
```

### B.2 ResolveAgentRouteInput/Output

文件：`src/routing/resolve-route.ts`

```typescript
export type ResolveAgentRouteInput = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  parentPeer?: RoutePeer | null;
  guildId?: string | null;
  teamId?: string | null;
  memberRoleIds?: string[];
};

export type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string;
  sessionKey: string;
  mainSessionKey: string;
  matchedBy: "binding.peer" | "binding.peer.parent" | "binding.guild+roles"
    | "binding.guild" | "binding.team" | "binding.account"
    | "binding.channel" | "default";
};
```

### B.3 SubagentRunRecord

文件：`src/agents/subagent-registry.types.ts`

（完整定义见 2.2 节）

### B.4 SpawnSubagentParams

文件：`src/agents/subagent-spawn.ts`

```typescript
export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: "run" | "session";
  cleanup?: "delete" | "keep";
  sandbox?: "inherit" | "require";
  expectsCompletionMessage?: boolean;
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;
};
```

---

## 附录 C：术语表

| 术语 | 含义 |
|------|------|
| **Gateway** | OpenClaw 的核心长驻进程，作为所有通道和 Agent 的控制面 |
| **Channel** | 通讯通道（Telegram、WhatsApp、Slack、Teams 等） |
| **ChannelPlugin** | 通道适配器的标准接口定义 |
| **Binding** | 路由规则，将通道+账号+对话对象映射到特定 Agent |
| **Session Key** | 会话的唯一标识符，格式如 `agent:main:telegram:default:direct:12345` |
| **Subagent** | 由父 Agent 生成的子 Agent，用于并行执行子任务 |
| **Announce** | 子 Agent 完成后向父 Agent 投递结果的机制 |
| **Compaction** | 当上下文窗口超限时，将旧消息摘要压缩的机制 |
| **Lane** | 并发控制泳道，同一 Lane 内串行执行 |
| **DmScope** | DM 会话的隔离粒度配置 |
| **pi-mono** | OpenClaw 依赖的底层 AI 运行时引擎 |
| **Tier** | 路由匹配的优先级层级 |
| **PluginRegistry** | 全局的插件注册中心，管理工具、钩子、通道等 |
| **DeliveryContext** | 消息投递上下文（通道、账号、对话对象、线程 ID） |
| **FollowupQueue** | 用于延迟投递消息的队列机制 |
