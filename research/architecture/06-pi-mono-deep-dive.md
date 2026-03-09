# pi-mono 源码级深度分析报告

> 研究目标: 评估 pi-mono 作为"虚拟员工"平台（Dynamic Hierarchical MoE）基础组件的可行性
> 代码版本: 基于 2026-03-06 main 分支
> 仓库地址: https://github.com/badlogic/pi-mono
> 分析方法: 源码级逐文件阅读，围绕项目需求进行定向评估

---

## 目录

1. [仓库结构总览](#1-仓库结构总览)
2. [Agent Loop 的可扩展性深度评估](#2-agent-loop-的可扩展性深度评估)
3. [pi-ai 的政府云适配能力](#3-pi-ai-的政府云适配能力)
4. [Extension 机制的企业化改造可行性](#4-extension-机制的企业化改造可行性)
5. [事件系统的审计适配](#5-事件系统的审计适配)
6. [Proxy 架构的多租户潜力](#6-proxy-架构的多租户潜力)
7. [与我们项目架构的具体对接方案](#7-与我们项目架构的具体对接方案)

---

## 1. 仓库结构总览

### 1.1 Packages 列表及职责

| Package | NPM 名称 | 核心源文件 | 职责 |
|---------|----------|-----------|------|
| `ai` | `@mariozechner/pi-ai` | 40+ 源文件 | 统一 LLM API 抽象层，支持 10 个 API 协议（Anthropic/OpenAI/Bedrock/Google/Mistral/Azure 等），流式输出、token 计算、模型注册、OAuth |
| `agent` | `@mariozechner/pi-agent-core` | 5 个源文件 | 通用 Agent 运行时：agent-loop、Agent 类、proxy 流、类型定义 |
| `coding-agent` | `@mariozechner/pi-coding-agent` | 90+ 源文件 | 编码 Agent 上层应用：Extension 系统、Session 管理、Tool 实现、Compaction、System Prompt |
| `tui` | `@mariozechner/pi-tui` | — | Terminal UI 库，差分渲染引擎 |
| `web-ui` | `@mariozechner/pi-web-ui` | — | Web UI 组件（Lit Web Components） |
| `mom` | `@mariozechner/pi-mom` | — | Slack Bot，委托 coding-agent 执行 |
| `pods` | `@mariozechner/pi` | — | GPU Pod 上的 vLLM 部署管理 CLI |

### 1.2 依赖关系图

```
pi-tui (独立)
  |
pi-ai (独立，依赖各家 LLM SDK)
  |
pi-agent-core (依赖 pi-ai)
  |
pi-coding-agent (依赖 pi-agent-core + pi-ai + pi-tui)
  |
pi-mom / web-ui (应用层)
```

### 1.3 对我们项目的意义

我们需要关注的层次：

- **直接使用层**: `pi-ai`（LLM 抽象）、`pi-agent-core`（Agent Loop）
- **借鉴设计层**: `pi-coding-agent` 的 Extension 机制、Session 管理
- **不需要的层**: `pi-tui`、`web-ui`（我们有自己的 UI）、`pi-mom`（Slack 集成）

---

## 2. Agent Loop 的可扩展性深度评估

### 2.1 核心架构分析

Agent Loop 的核心代码仅有两个文件：

- `packages/agent/src/agent-loop.ts`（417 行）—— 纯函数式循环逻辑
- `packages/agent/src/agent.ts`（559 行）—— 有状态的 Agent 类封装

#### 2.1.1 `agentLoop` 函数签名

```typescript
// agent-loop.ts:28-35
export function agentLoop(
    prompts: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
    signal?: AbortSignal,
    streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]>
```

这是一个精心设计的函数式 API。注意以下关键点：

1. **返回 `EventStream`** 而非 Promise —— 支持流式消费
2. **`AgentLoopConfig` 中的 4 个 hook** 是扩展点
3. **`streamFn` 可替换** —— 允许 proxy、mock 等场景
4. **`signal` 支持中断** —— 通过 AbortController

#### 2.1.2 四个核心 Hook

```typescript
// types.ts:22-98
export interface AgentLoopConfig extends SimpleStreamOptions {
    model: Model<any>;
    convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
    getSteeringMessages?: () => Promise<AgentMessage[]>;
    getFollowUpMessages?: () => Promise<AgentMessage[]>;
}
```

| Hook | 调用时机 | 用途 | 我们的场景 |
|------|---------|------|-----------|
| `convertToLlm` | 每次 LLM 调用前 | AgentMessage[] -> Message[] 转换 | 可注入自定义消息类型（审批状态、组织上下文） |
| `transformContext` | 每次 LLM 调用前（在 convertToLlm 之前） | 上下文裁剪、注入 | 实现 RAG 注入、长期记忆注入 |
| `getSteeringMessages` | 每个 tool 执行后 | 用户中断 / 高优先级消息注入 | Coordinator Agent 向 Sub-Agent 发送指令 |
| `getFollowUpMessages` | Agent 准备停止时 | 追加后续消息 | 工作流编排：一个步骤完成后注入下一步指令 |

#### 2.1.3 `runLoop` 的双层循环结构

```typescript
// agent-loop.ts:104-198 (简化)
async function runLoop(...) {
    // 外层循环：处理 followUp 消息
    while (true) {
        // 内层循环：处理 tool 调用 + steering 消息
        while (hasMoreToolCalls || pendingMessages.length > 0) {
            // 1. 注入 pending 消息
            // 2. 流式获取 LLM 响应
            // 3. 执行 tool 调用（串行）
            // 4. 检查 steering 消息
        }
        // 检查 followUp 消息
        const followUpMessages = await config.getFollowUpMessages?.();
        if (followUpMessages.length > 0) {
            pendingMessages = followUpMessages;
            continue;
        }
        break;
    }
}
```

**关键发现**：这是一个无限循环，只在没有更多 tool 调用且没有 followUp 消息时才退出。这意味着通过 `getFollowUpMessages`，我们可以让 Agent 无限运行。

### 2.2 多 Agent 协作能力评估

**需求**：一个 Coordinator Agent 的 tool 调用中启动另一个 Agent 实例

**可行性：完全可行，无需 fork**

具体方案：

```typescript
// 方案：在 Coordinator 的 tool 中创建子 Agent
const subAgentTool: AgentTool = {
    name: "delegate_to_specialist",
    label: "委派给专家",
    description: "将子任务委派给专业的虚拟员工处理",
    parameters: Type.Object({
        specialist: Type.String(),
        task: Type.String(),
    }),
    execute: async (toolCallId, params, signal) => {
        // 创建一个新的 Agent 实例
        const subAgent = new Agent({
            streamFn: streamSimple, // 或 streamProxy
            convertToLlm: defaultConvertToLlm,
        });

        // 配置子 Agent 的角色
        subAgent.setSystemPrompt(getSpecialistPrompt(params.specialist));
        subAgent.setModel(getModelForSpecialist(params.specialist));
        subAgent.setTools(getToolsForSpecialist(params.specialist));

        // 运行子 Agent
        await subAgent.prompt(params.task);
        await subAgent.waitForIdle();

        // 提取结果
        const result = extractResult(subAgent.state.messages);
        return { content: [{ type: "text", text: result }], details: {} };
    },
};
```

**代码级证据**：

1. `Agent` 类是独立的，不依赖全局状态（`agent.ts:96`）
2. `Agent.prompt()` 返回 Promise，可以在 tool 执行中 await（`agent.ts:336`）
3. `Agent.waitForIdle()` 提供了等待完成的机制（`agent.ts:319`）
4. `streamFn` 可以自定义，子 Agent 可以用不同的 LLM provider（`agent.ts:132`）

**限制点**：

- **嵌套调用不共享上下文**：子 Agent 独立维护自己的消息历史，Coordinator 只看到最终的 tool result。这实际上是好的设计——它符合 MoE 的封装原则。
- **没有内置的 Agent 间通信协议**：如果需要子 Agent 向 Coordinator 报告中间状态（如审批进度），需要在 tool 层面自行实现 callback。
- **并发子 Agent**：`Agent.prompt()` 会检查 `isStreaming` 并拒绝并发调用（`agent.ts:337-339`），但可以创建多个 Agent 实例并行运行。

### 2.3 长期任务与断点续传

**需求**：一个审批工作流可能持续数天，如何在 agent loop 之上实现断点续传？

**核心代码限制分析**：

1. **Agent 状态是内存态**（`agent.ts:97-107`）：

```typescript
private _state: AgentState = {
    systemPrompt: "",
    model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
    thinkingLevel: "off",
    tools: [],
    messages: [],        // 全部在内存中
    isStreaming: false,
    streamMessage: null,
    pendingToolCalls: new Set<string>(),
    error: undefined,
};
```

2. **`AgentMessage` 类型是可序列化的**（`types.ts:129`）：

```typescript
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

`Message` 包含 `UserMessage | AssistantMessage | ToolResultMessage`，这些都是纯 JSON 结构（含 timestamp）。

3. **`agentLoopContinue` 支持从断点恢复**（`agent-loop.ts:65-92`）：

```typescript
export function agentLoopContinue(
    context: AgentContext,
    config: AgentLoopConfig,
    signal?: AbortSignal,
    streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]>
```

4. **`Agent.replaceMessages()` 可以恢复消息历史**（`agent.ts:240-242`）：

```typescript
replaceMessages(ms: AgentMessage[]) {
    this._state.messages = ms.slice();
}
```

**断点续传方案（无需 fork）**：

```typescript
// 保存断点
function checkpoint(agent: Agent): SerializedCheckpoint {
    return {
        messages: agent.state.messages,
        systemPrompt: agent.state.systemPrompt,
        modelId: agent.state.model.id,
        modelProvider: agent.state.model.provider,
        // tools 需要单独处理（函数不可序列化）
    };
}

// 恢复断点
function restore(checkpoint: SerializedCheckpoint): Agent {
    const agent = new Agent();
    agent.setSystemPrompt(checkpoint.systemPrompt);
    agent.setModel(getModel(checkpoint.modelProvider, checkpoint.modelId));
    agent.replaceMessages(checkpoint.messages);
    agent.setTools(resolveTools(checkpoint)); // 根据角色重新加载 tools
    return agent;
}

// 续传执行
async function resume(agent: Agent, newInput: string) {
    agent.followUp({
        role: "user",
        content: [{ type: "text", text: newInput }],
        timestamp: Date.now(),
    });
    await agent.continue();
}
```

**pi-coding-agent 的 Session Manager 提供了参考**（`session-manager.ts`）：

- 使用 JSONL 格式追加写入（append-only log）
- 支持分支（branching）和压缩（compaction）
- 每条 entry 都有 `id`、`parentId`、`timestamp`

但 Session Manager 和 coding-agent 耦合太深（依赖 filesystem、cwd 等），不适合直接用于虚拟员工场景。**建议自行实现基于数据库的持久化层**，但借鉴其 append-only + branching 的设计模式。

**关键风险**：

- `tools` 数组中的 `execute` 函数不可序列化。恢复时必须通过角色配置重新构建 tools。
- 长时间暂停后，LLM 的上下文可能已超过 token 限制。需要配合 `transformContext` 实现上下文压缩。
- `abortController` 不可序列化，恢复时需创建新的。

### 2.4 主动触发机制

**需求**：虚拟员工需要主动发起工作（定时任务、事件驱动），而非被动等待消息

**当前设计是"消息驱动"的**：

```typescript
// agent.ts:336-367
async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
    if (this._state.isStreaming) {
        throw new Error("Agent is already processing a prompt...");
    }
    // ...
    await this._runLoop(msgs);
}
```

**主动触发方案（无需 fork）**：

Agent 本身就是一个状态机，它不关心谁调用了 `prompt()`。定时任务或事件驱动只是调用 `agent.prompt()` 的不同入口：

```typescript
// 方案 1：定时任务
import cron from 'node-cron';

const reportAgent = new Agent(/* config */);
cron.schedule('0 9 * * 1', async () => {
    // 每周一 9:00 自动生成周报
    await reportAgent.prompt("请根据上周的审批记录生成周报");
    const result = extractResult(reportAgent.state.messages);
    await sendReport(result);
    reportAgent.clearMessages(); // 清理上下文
});

// 方案 2：事件驱动（如收到新的审批请求）
eventBus.on('new_approval_request', async (request) => {
    const approvalAgent = createApprovalAgent(request.department);
    await approvalAgent.prompt(
        `收到新的审批请求：${JSON.stringify(request)}，请按照流程处理。`
    );
});
```

**关键限制**：

- `Agent` 不支持并发 `prompt()`（一个 Agent 实例同时只能处理一个请求）
- 解决方案：为每个并发任务创建独立的 Agent 实例，或使用 Agent Pool

### 2.5 并行 Tool 调用

**需求**：当前 tool 是串行执行的，能否改为并行？

**当前实现：严格串行**（`agent-loop.ts:294-378`）：

```typescript
async function executeToolCalls(
    tools: AgentTool<any>[] | undefined,
    assistantMessage: AssistantMessage,
    signal: AbortSignal | undefined,
    stream: EventStream<AgentEvent, AgentMessage[]>,
    getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
    const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
    const results: ToolResultMessage[] = [];

    for (let index = 0; index < toolCalls.length; index++) {  // <-- 串行 for 循环
        const toolCall = toolCalls[index];
        // ... 执行单个 tool ...

        // 关键：每个 tool 执行后检查 steering messages
        if (getSteeringMessages) {
            const steering = await getSteeringMessages();
            if (steering.length > 0) {
                steeringMessages = steering;
                // 跳过剩余 tool calls
                const remainingCalls = toolCalls.slice(index + 1);
                for (const skipped of remainingCalls) {
                    results.push(skipToolCall(skipped, stream));
                }
                break;
            }
        }
    }
    return { toolResults: results, steeringMessages };
}
```

**串行的原因**：

1. **Steering 机制依赖顺序执行**：每个 tool 执行后检查是否有用户中断，如果有则跳过后续 tools。如果并行执行，就无法在中间中断。
2. **事件顺序保证**：`tool_execution_start` -> `tool_execution_end` 事件是有序的，UI 依赖这个顺序。
3. **实际场景考虑**：编码场景中 tool 调用之间常有依赖关系（如先读文件再编辑）。

**改为并行的方案**：

方案 A：Fork `agent-loop.ts`，修改 `executeToolCalls`：

```typescript
// 并行执行版本（约 40 行修改）
async function executeToolCallsParallel(
    tools: AgentTool<any>[] | undefined,
    assistantMessage: AssistantMessage,
    signal: AbortSignal | undefined,
    stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<{ toolResults: ToolResultMessage[] }> {
    const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");

    const promises = toolCalls.map(async (toolCall) => {
        stream.push({ type: "tool_execution_start", ... });
        const result = await tool.execute(toolCall.id, validatedArgs, signal, ...);
        stream.push({ type: "tool_execution_end", ... });
        return createToolResultMessage(toolCall, result);
    });

    const results = await Promise.all(promises);
    return { toolResults: results };
}
```

方案 B：不 fork，在 tool 层面实现并行（推荐）：

```typescript
// 创建一个 "batch_execute" tool，内部并行执行多个子操作
const batchTool: AgentTool = {
    name: "batch_execute",
    execute: async (toolCallId, params, signal) => {
        const results = await Promise.all(
            params.operations.map(op => executeOperation(op, signal))
        );
        return { content: [{ type: "text", text: JSON.stringify(results) }], details: {} };
    },
};
```

**影响分析**：

| 方面 | 串行 | 并行 |
|------|------|------|
| Steering 中断 | 支持（每个 tool 后检查） | 不支持或需要 AbortController |
| 事件顺序 | 确定性 | 不确定（race condition） |
| 资源竞争 | 无 | 可能有（如同时写同一文件） |
| 执行速度 | 慢 | 快 |
| 政府场景适用性 | 好（可审计、可中断） | 差（审计困难） |

**结论**：对政府审批场景，**串行执行实际上更合适**。每个审批步骤需要可追溯，中间可中断。如果需要并行，建议在 tool 层面而非 loop 层面实现。

### 2.6 `CustomAgentMessages` 的声明合并机制

这是一个值得关注的设计模式（`types.ts:107-130`）：

```typescript
export interface CustomAgentMessages {
    // Empty by default - apps extend via declaration merging
}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

这允许我们通过 TypeScript 声明合并添加自定义消息类型：

```typescript
// 在我们的代码中
declare module "@mariozechner/pi-agent-core" {
    interface CustomAgentMessages {
        approval_status: {
            role: "approval_status";
            requestId: string;
            status: "pending" | "approved" | "rejected";
            approver: string;
            timestamp: number;
        };
        organization_context: {
            role: "organization_context";
            department: string;
            policies: string[];
            timestamp: number;
        };
    }
}
```

这些自定义消息会被 `convertToLlm` 过滤或转换，不会直接发送给 LLM。这是一个非常优雅的设计，允许在 agent 层携带业务语义信息。

### 2.7 Agent Loop 可扩展性总结

| 能力需求 | 是否可无 fork 实现 | 方案 | 代码限制点 |
|---------|-------------------|------|-----------|
| 多 Agent 协作 | 是 | 在 tool 中创建子 Agent | 无 |
| 断点续传 | 是 | replaceMessages + continue | tools 不可序列化 |
| 主动触发 | 是 | 外部调用 prompt() | isStreaming 互斥锁 |
| 并行 tool | 部分 | tool 层并行（推荐）或 fork | executeToolCalls 串行循环 |
| 自定义消息类型 | 是 | 声明合并 | 无 |
| 上下文管理 | 是 | transformContext hook | 无 |

---

## 3. pi-ai 的政府云适配能力

### 3.1 Provider 架构概览

`packages/ai/src/providers/` 目录下有 10 个 provider 实现：

```
anthropic.ts                 -> anthropic-messages API
amazon-bedrock.ts            -> bedrock-converse-stream API
azure-openai-responses.ts    -> azure-openai-responses API
openai-responses.ts          -> openai-responses API
openai-completions.ts        -> openai-completions API
openai-codex-responses.ts    -> openai-codex-responses API
google.ts                    -> google-generative-ai API
google-vertex.ts             -> google-vertex API
google-gemini-cli.ts         -> google-gemini-cli API
mistral.ts                   -> mistral-conversations API
```

所有 provider 通过 `register-builtins.ts` 中的 `registerApiProvider()` 注册到全局 registry。

### 3.2 Amazon Bedrock Provider 深度分析

文件：`packages/ai/src/providers/amazon-bedrock.ts`（749 行）

#### 3.2.1 端点配置

```typescript
// amazon-bedrock.ts:90-143
const config: BedrockRuntimeClientConfig = {
    profile: options.profile,
};

// Region 解析优先级：
// 1. options.region（显式传入）
// 2. AWS_REGION 环境变量
// 3. AWS_DEFAULT_REGION 环境变量
// 4. 如果设置了 AWS_PROFILE，留空让 SDK 从 profile 解析
// 5. 默认 us-east-1
const explicitRegion = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
```

**AWS GovCloud 支持分析**：

Bedrock provider 使用 AWS SDK v3（`@aws-sdk/client-bedrock-runtime`），SDK 原生支持 GovCloud：

- GovCloud region：`us-gov-west-1`、`us-gov-east-1`
- 设置 `AWS_REGION=us-gov-west-1` 即可
- SDK 自动将 endpoint 解析为 `bedrock-runtime.us-gov-west-1.amazonaws.com`

**关键发现 - Skip Auth 模式**：

```typescript
// amazon-bedrock.ts:107-111
// Support proxies that don't need authentication
if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") {
    config.credentials = {
        accessKeyId: "dummy-access-key",
        secretAccessKey: "dummy-secret-key",
    };
}
```

这个"skip auth"模式是为了支持自定义代理（如 LiteLLM proxy），它表明 Bedrock provider 已经考虑了企业部署场景。

**HTTP 代理支持**：

```typescript
// amazon-bedrock.ts:114-138
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || ...) {
    const proxyAgent = await import("proxy-agent");
    const agent = new proxyAgent.ProxyAgent();
    config.requestHandler = new nodeHttpHandler.NodeHttpHandler({
        httpAgent: agent,
        httpsAgent: agent,
    });
} else if (process.env.AWS_BEDROCK_FORCE_HTTP1 === "1") {
    config.requestHandler = new nodeHttpHandler.NodeHttpHandler();
}
```

这对政府网络环境非常重要——支持通过 HTTP 代理访问 Bedrock。

**不足之处**：

1. **不支持自定义 endpoint URL**：Bedrock provider 没有类似 `baseUrl` 的配置。虽然 AWS SDK 可以通过 `endpoint` 参数指定自定义端点，但 pi-ai 没有暴露这个配置。
2. **不支持 FIPS 端点**：GovCloud 通常要求使用 FIPS 端点（如 `bedrock-runtime-fips.us-gov-west-1.amazonaws.com`）。当前代码没有 FIPS 支持。

**解决方案**：可以通过 AWS SDK 的 `AWS_USE_FIPS_ENDPOINT=true` 环境变量让 SDK 自动选择 FIPS 端点，无需修改代码。如果需要完全自定义 endpoint，需要 fork 并在 `BedrockRuntimeClientConfig` 中添加 `endpoint` 字段。

#### 3.2.2 凭证管理

```typescript
// env-api-keys.ts:88-106
if (provider === "amazon-bedrock") {
    if (
        process.env.AWS_PROFILE ||
        (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
        process.env.AWS_BEARER_TOKEN_BEDROCK ||
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
        process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
        process.env.AWS_WEB_IDENTITY_TOKEN_FILE
    ) {
        return "<authenticated>";
    }
}
```

支持 6 种认证方式：
1. AWS Profile
2. IAM Access Key + Secret
3. Bedrock Bearer Token
4. ECS Container Credentials
5. ECS Container Credentials (Full URI)
6. IRSA（IAM Roles for Service Accounts）

**BYOK 支持**：通过环境变量传入凭证即可实现客户自带 Key。AgentLoopConfig 的 `getApiKey` hook 也支持动态解析：

```typescript
// types.ts:71-75
getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
```

### 3.3 Azure OpenAI Responses Provider 深度分析

文件：`packages/ai/src/providers/azure-openai-responses.ts`（257 行）

#### 3.3.1 端点配置

```typescript
// azure-openai-responses.ts:43-50
export interface AzureOpenAIResponsesOptions extends StreamOptions {
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    reasoningSummary?: "auto" | "detailed" | "concise" | null;
    azureApiVersion?: string;
    azureResourceName?: string;
    azureBaseUrl?: string;          // <-- 支持自定义 baseUrl
    azureDeploymentName?: string;   // <-- 支持自定义 deployment
}
```

**Azure Government Cloud 支持分析**：

```typescript
// azure-openai-responses.ts:147-176
function resolveAzureConfig(
    model: Model<"azure-openai-responses">,
    options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
    const apiVersion = options?.azureApiVersion
        || process.env.AZURE_OPENAI_API_VERSION
        || DEFAULT_AZURE_API_VERSION;

    const baseUrl = options?.azureBaseUrl?.trim()
        || process.env.AZURE_OPENAI_BASE_URL?.trim()
        || undefined;
    const resourceName = options?.azureResourceName
        || process.env.AZURE_OPENAI_RESOURCE_NAME;

    let resolvedBaseUrl = baseUrl;
    if (!resolvedBaseUrl && resourceName) {
        resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
        // -> https://${resourceName}.openai.azure.com/openai/v1
    }
    if (!resolvedBaseUrl && model.baseUrl) {
        resolvedBaseUrl = model.baseUrl;
    }
    // ...
}
```

**结论：完全支持 Azure Government Cloud**

Azure Government Cloud 只是域名不同：
- 商业云：`https://{resource}.openai.azure.com`
- 政府云：`https://{resource}.openai.azure.us`

配置方式：
```bash
# 方式 1：环境变量
AZURE_OPENAI_BASE_URL=https://my-resource.openai.azure.us/openai/v1

# 方式 2：代码配置
options.azureBaseUrl = "https://my-resource.openai.azure.us/openai/v1"
```

**Deployment Name Map 功能**：

```typescript
// azure-openai-responses.ts:21-31
function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
    // AZURE_OPENAI_DEPLOYMENT_NAME_MAP="gpt-4=my-gpt4-deployment,gpt-4o=my-gpt4o"
    // ...
}
```

这允许在同一个 Azure 资源中映射不同的 deployment name，对多租户场景很有用。

#### 3.3.2 自定义 baseUrl 能力汇总

| Provider | 自定义 baseUrl | 配置方式 |
|----------|--------------|---------|
| Anthropic | 支持 | `model.baseUrl` 字段 |
| Azure OpenAI | 支持 | `azureBaseUrl` 选项 / `AZURE_OPENAI_BASE_URL` 环境变量 |
| AWS Bedrock | 部分支持 | `region` 配置 + SDK 自动解析端点，不支持完全自定义 URL |
| OpenAI | 支持 | `model.baseUrl` 字段（用于 OpenAI 兼容端点如 Ollama） |
| Google | 支持 | Vertex AI 通过 `GOOGLE_CLOUD_LOCATION` 配置 |

### 3.4 Model 注册与自定义模型

`Model<TApi>` 接口支持完全自定义（`types.ts:297-320`）：

```typescript
export interface Model<TApi extends Api> {
    id: string;
    name: string;
    api: TApi;
    provider: Provider;
    baseUrl: string;        // 自定义端点
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input; output; cacheRead; cacheWrite; };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;   // 自定义请求头
    compat?: ...;           // 兼容性覆盖
}
```

通过 `registerApiProvider()` 可以注册完全自定义的 provider：

```typescript
// api-registry.ts:66-78
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
    provider: ApiProvider<TApi, TOptions>,
    sourceId?: string,
): void {
    apiProviderRegistry.set(provider.api, {
        provider: { api: provider.api, stream: ..., streamSimple: ... },
        sourceId,
    });
}
```

这意味着我们可以注册自己的 "gov-bedrock" 或 "gov-azure" API 类型。

### 3.5 BYOK（自带 API Key）支持

三个层级的 API Key 解析：

1. **环境变量层**（`env-api-keys.ts`）：读取 `ANTHROPIC_API_KEY`、`AZURE_OPENAI_API_KEY` 等
2. **StreamOptions 层**（`types.ts:63`）：`options.apiKey` 参数
3. **动态解析层**（`types.ts:71-75`）：`getApiKey` 回调

对于多租户 BYOK 场景，推荐使用 `getApiKey` hook：

```typescript
const agent = new Agent({
    getApiKey: async (provider: string) => {
        // 从租户配置中读取 API Key
        return await tenantConfigService.getApiKey(tenantId, provider);
    },
});
```

### 3.6 政府云适配能力总结

| 需求 | 支持程度 | 说明 |
|------|---------|------|
| Azure Government Cloud | 完全支持 | 通过 baseUrl 配置 |
| AWS GovCloud | 基本支持 | 通过 region 配置，FIPS 需环境变量 |
| 自定义端点 | 完全支持（Azure/Anthropic/OpenAI）/ 部分支持（Bedrock） | Bedrock 不暴露 endpoint 配置 |
| BYOK | 完全支持 | getApiKey hook + 环境变量 |
| 网络代理 | 完全支持（Bedrock）/ 需验证（其他） | Bedrock 有显式代理支持 |
| 自定义 Headers | 完全支持 | Model.headers + StreamOptions.headers |
| 自定义 Provider | 完全支持 | registerApiProvider() |

---

## 4. Extension 机制的企业化改造可行性

### 4.1 Extension 系统架构

Extension 系统位于 `packages/coding-agent/src/core/extensions/`，由 4 个核心文件组成：

- `types.ts`（~500 行）—— 类型定义
- `loader.ts`（~545 行）—— 加载器
- `runner.ts`（~848 行）—— 运行器
- `wrapper.ts`（~119 行）—— Tool 包装器

#### 4.1.1 Extension 生命周期

```
1. 发现（discoverAndLoadExtensions）
   |-- 扫描 .pi/extensions/ 目录
   |-- 扫描全局 agentDir/extensions/ 目录
   |-- 加载显式配置的路径

2. 加载（loadExtension）
   |-- 使用 jiti 加载 TypeScript 模块
   |-- 创建 Extension 对象
   |-- 创建 ExtensionAPI
   |-- 调用 factory 函数

3. 绑定（bindCore）
   |-- 替换 runtime 的 notInitialized 存根为真实实现
   |-- 刷新 pending provider 注册

4. 运行（emit 各类事件）
   |-- 生命周期事件
   |-- tool_call / tool_result 拦截
   |-- context 转换
```

#### 4.1.2 Extension Factory 模式

```typescript
// 一个 Extension 是一个导出 factory 函数的模块
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
```

ExtensionAPI 提供的能力：

```typescript
interface ExtensionAPI {
    // 注册类方法（在加载时调用）
    on(event: string, handler: HandlerFn): void;
    registerTool(tool: ToolDefinition): void;
    registerCommand(name: string, options: ...): void;
    registerShortcut(shortcut: KeyId, options: ...): void;
    registerFlag(name: string, options: ...): void;
    registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void;
    registerProvider(name: string, config: ProviderConfig): void;

    // 动作类方法（在运行时调用）
    sendMessage(message, options): void;
    sendUserMessage(content, options): void;
    appendEntry(customType: string, data?: unknown): void;
    exec(command: string, args: string[], options?: ExecOptions): ...;
    getActiveTools(): string[];
    setActiveTools(toolNames: string[]): void;
    setModel(model): Promise<void>;

    // 事件总线
    events: EventBus;
}
```

### 4.2 虚拟员工角色作为 Extension 的可行性

**需求**：每个虚拟员工角色作为一个 Extension（注册角色特有的 tools 和 skills）

**可行性分析**：

Extension 系统设计得很适合这个用途。一个"审批专员"角色的 Extension 可能是：

```typescript
// approval-officer.ts
import { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default async function(api: ExtensionAPI) {
    // 注册审批专用 tools
    api.registerTool({
        name: "check_approval_rules",
        label: "检查审批规则",
        description: "根据组织规则检查审批请求是否符合要求",
        parameters: Type.Object({
            requestId: Type.String(),
            department: Type.String(),
        }),
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
            const rules = await fetchApprovalRules(params.department);
            const request = await fetchRequest(params.requestId);
            const result = evaluateRules(rules, request);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                details: { rules, result },
            };
        },
    });

    api.registerTool({
        name: "submit_approval_decision",
        label: "提交审批决定",
        description: "提交审批决定（通过/驳回）",
        parameters: Type.Object({
            requestId: Type.String(),
            decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
            reason: Type.String(),
        }),
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
            // ...
        },
    });

    // 注册事件处理器
    api.on("before_agent_start", async (event, ctx) => {
        // 在每次对话开始时注入组织上下文
        return {
            systemPrompt: event.systemPrompt + "\n\n" + getOrganizationContext(),
        };
    });

    // 拦截 tool 调用进行权限检查
    api.on("tool_call", async (event, ctx) => {
        if (event.toolName === "submit_approval_decision") {
            const hasPermission = await checkPermission(ctx, event.input);
            if (!hasPermission) {
                return { block: true, reason: "权限不足：当前角色无法审批此类请求" };
            }
        }
    });
}
```

**限制点**：

1. **Extension 与 coding-agent 耦合**：`ExtensionAPI` 的类型定义、`ExtensionContext`、`ExtensionRunner` 都在 `coding-agent` 包中。它们引用了大量 coding-agent 特有的概念（SessionManager、BashOperations 等）。

2. **Extension 加载依赖文件系统**：loader 使用 `jiti` 从文件路径加载 TypeScript 模块，不支持从数据库或 API 加载。

3. **Extension 没有命名空间/隔离**：多个 Extension 的 tool 名称可能冲突（first-win 策略），`runner.ts:311-320`：

```typescript
getAllRegisteredTools(): RegisteredTool[] {
    const toolsByName = new Map<string, RegisteredTool>();
    for (const ext of this.extensions) {
        for (const tool of ext.tools.values()) {
            if (!toolsByName.has(tool.definition.name)) {
                toolsByName.set(tool.definition.name, tool);
            }
        }
    }
    return Array.from(toolsByName.values());
}
```

### 4.3 多租户环境下 Extension 的隔离加载

**当前状态**：Extension 系统没有多租户概念。所有 Extension 共享同一个 `ExtensionRuntime`（`loader.ts:119-153`）：

```typescript
export function createExtensionRuntime(): ExtensionRuntime {
    const runtime: ExtensionRuntime = {
        sendMessage: notInitialized,
        // ... 所有方法都是共享的
        flagValues: new Map(),
        pendingProviderRegistrations: [],
    };
    return runtime;
}
```

**隔离方案**：

```
方案 A：进程级隔离（推荐用于政府场景）
- 每个租户运行独立的 Node.js 进程
- 每个进程加载该租户的 Extension
- 通过 IPC / HTTP 与 Coordinator 通信
- 优点：完全隔离，安全性最高
- 缺点：资源开销大

方案 B：实例级隔离
- 每个租户创建独立的 Agent + ExtensionRunner 实例
- 使用不同的 tools 集合
- 共享同一进程但数据隔离
- 优点：资源开销小
- 缺点：内存泄漏风险，JavaScript 无法真正隔离

方案 C：自行实现 Extension 注册表
- 不使用 pi-mono 的 Extension 系统
- 借鉴其 ToolDefinition 接口和 wrapper 模式
- 自行实现基于租户的 tool 注册和隔离
```

**推荐**：对政府场景，采用方案 A + C 混合。使用 pi-mono 的 `AgentTool` 接口定义 tools，但用自己的注册表管理，不依赖文件系统的 Extension 发现机制。

### 4.4 热插拔能力

**当前状态**：Extension 系统**不支持运行时热插拔**。

加载是一次性的（`loader.ts:361-385`）：

```typescript
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
    const extensions: Extension[] = [];
    // ...
    for (const extPath of paths) {
        const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);
        // ...
    }
    return { extensions, errors, runtime };
}
```

`ExtensionRunner` 在构造后不再接受新的 Extension：

```typescript
// runner.ts:221-234
constructor(
    extensions: Extension[],
    runtime: ExtensionRuntime,
    cwd: string,
    sessionManager: SessionManager,
    modelRegistry: ModelRegistry,
) {
    this.extensions = extensions;  // 固定的数组
    // ...
}
```

**热插拔方案**：

如果需要运行时添加/移除 tools（如：某个虚拟员工被授予新权限），可以：

1. **使用 `Agent.setTools()`**（`agent.ts:236-238`）：直接替换 tools 集合，无需重启
2. **利用 `tool_call` 拦截**：在 Extension 的 `tool_call` handler 中动态检查权限，而非静态注册
3. **Provider 注册/注销**：`registerProvider` / `unregisterProvider` 在 bindCore 后是立即生效的（`runner.ts:270-272`）

### 4.5 权限控制能力

**当前状态**：Extension 系统通过 `tool_call` 事件提供了基本的拦截能力。

```typescript
// wrapper.ts:48-67
if (runner.hasHandlers("tool_call")) {
    const callResult = await runner.emitToolCall({
        type: "tool_call",
        toolName: tool.name,
        toolCallId,
        input: params,
    });
    if (callResult?.block) {
        const reason = callResult.reason || "Tool execution was blocked by an extension";
        throw new Error(reason);
    }
}
```

这个拦截机制可以实现基于角色的权限控制：

```typescript
api.on("tool_call", async (event, ctx) => {
    const currentRole = getCurrentRole(ctx);
    const toolPermissions = getToolPermissions(event.toolName);

    if (!toolPermissions.allowedRoles.includes(currentRole)) {
        return {
            block: true,
            reason: `角色 "${currentRole}" 没有权限使用工具 "${event.toolName}"`,
        };
    }

    // 记录审计日志
    await auditLog.record({
        action: "tool_call",
        tool: event.toolName,
        role: currentRole,
        input: event.input,
        timestamp: new Date(),
    });
});
```

**不足**：

1. 权限检查在 tool 执行前，但 LLM 已经生成了 tool call 参数。如果 tool 被 block，LLM 会看到错误消息并可能重试。更好的方案是在注册 tool 时就根据角色过滤可用 tools。
2. 没有细粒度的参数级权限（如：允许审批 10 万以下的请求，但不允许超过 10 万的）。

### 4.6 Extension 机制总结

| 需求 | 可行性 | 实现难度 | 是否需要 fork |
|------|--------|---------|-------------|
| 角色作为 Extension | 部分可行 | 中 | 不需要，但需要解耦 coding-agent 依赖 |
| 多租户隔离 | 需自行实现 | 高 | 不使用 Extension 系统，借鉴接口设计 |
| 热插拔 | 通过 setTools() | 低 | 不需要 |
| 权限控制 | 通过 tool_call 事件 | 中 | 不需要 |

---

## 5. 事件系统的审计适配

### 5.1 事件类型分析

pi-mono 有两层事件系统：

#### 5.1.1 Agent 层事件（`packages/agent/src/types.ts:179-194`）

```typescript
export type AgentEvent =
    | { type: "agent_start" }
    | { type: "agent_end"; messages: AgentMessage[] }
    | { type: "turn_start" }
    | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
    | { type: "message_start"; message: AgentMessage }
    | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
    | { type: "message_end"; message: AgentMessage }
    | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
    | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
    | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

#### 5.1.2 Extension 层事件（`packages/coding-agent/src/core/extensions/types.ts`）

更丰富，增加了：
- `session_start` / `session_switch` / `session_fork` / `session_shutdown`
- `before_agent_start`
- `context`（上下文修改事件）
- `input`（用户输入事件）
- `tool_call` / `tool_result`（可拦截和修改）
- `resources_discover`
- `model_select`

#### 5.1.3 EventBus（`packages/coding-agent/src/core/event-bus.ts`）

```typescript
export interface EventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}
```

简单的 pub/sub，基于 Node.js `EventEmitter`。

### 5.2 审计日志需求分析

政府合规审计通常要求记录：

| 审计维度 | AgentEvent 是否包含 | 缺失信息 |
|---------|-------------------|---------|
| 操作时间 | 部分（message 有 timestamp） | agent_start/turn_start 没有 timestamp |
| 操作者身份 | **缺失** | 无 userId/tenantId/sessionId |
| 操作类型 | 有（event type） | — |
| 操作内容 | 有（args/result） | — |
| 操作结果 | 有（isError） | 无结构化的成功/失败原因 |
| 操作原因 | **缺失** | 无操作发起的原因/上下文 |
| 关联关系 | 部分（toolCallId） | 无 requestId/traceId |
| 数据变更 | **缺失** | 无 before/after 对比 |
| 审批链路 | **缺失** | 无审批人、审批层级 |

### 5.3 构建审计层的方案

**方案：在 Agent.subscribe() 之上构建审计适配器**

```typescript
function createAuditSubscriber(config: AuditConfig) {
    return (event: AgentEvent) => {
        const auditEntry: AuditEntry = {
            // 基础信息
            id: generateId(),
            timestamp: Date.now(),
            eventType: event.type,

            // 补充的上下文（config 中提供）
            userId: config.userId,
            tenantId: config.tenantId,
            sessionId: config.sessionId,
            agentRole: config.agentRole,
            requestId: config.requestId,
            traceId: config.traceId,

            // 事件数据
            data: sanitizeForAudit(event),
        };

        // 写入审计日志
        auditLogger.write(auditEntry);
    };
}

// 使用
const agent = new Agent();
const unsub = agent.subscribe(createAuditSubscriber({
    userId: currentUser.id,
    tenantId: tenant.id,
    sessionId: session.id,
    agentRole: "approval_officer",
    requestId: approvalRequest.id,
}));
```

**关键增强点**：

1. **所有事件类型都需要 timestamp**：当前 `agent_start`、`turn_start` 等事件没有时间戳。可以在审计适配器中统一添加 `Date.now()`。

2. **tool_call 需要记录完整参数**：当前 `tool_execution_start` 的 `args` 是 `any` 类型，足够灵活。

3. **tool_result 需要记录完整结果**：`tool_execution_end` 的 `result` 也是 `any`。但注意某些结果可能很大（如文件内容），审计时需要截断或存储摘要。

4. **LLM 调用需要记录 token 使用量**：`message_end` 事件中的 `AssistantMessage` 包含 `usage` 字段（input/output/cache/cost），可以直接用于成本审计。

5. **Extension 的 `tool_call` 拦截可以记录权限决策**：

```typescript
api.on("tool_call", async (event, ctx) => {
    const decision = evaluatePermission(event);
    auditLogger.write({
        type: "permission_check",
        tool: event.toolName,
        input: event.input,
        decision: decision.allowed ? "allow" : "deny",
        reason: decision.reason,
    });
    if (!decision.allowed) {
        return { block: true, reason: decision.reason };
    }
});
```

### 5.4 不可变审计日志

pi-coding-agent 的 SessionManager 使用 JSONL append-only 日志（`session-manager.ts`）：

```typescript
// session-manager.ts:27
export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
    type: "session";
    version?: number;
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string;
}
```

每条 entry 都有 `id`、`parentId`、`timestamp`，形成了一个不可变的有向无环图（DAG）。这个设计非常适合审计日志——每条记录不可修改，只能追加，天然支持溯源。

**但**：SessionManager 基于文件系统（JSONL 文件），政府场景需要改为数据库存储。建议借鉴其 DAG 结构设计，用数据库表实现。

### 5.5 审计适配总结

| 审计需求 | 当前支持 | 需要补充 | 实现方式 |
|---------|---------|---------|---------|
| 操作记录 | AgentEvent 覆盖完整生命周期 | 部分事件缺 timestamp | 审计适配器补充 |
| 身份追踪 | 不支持 | userId/tenantId/role | 注入到审计上下文 |
| 成本追踪 | usage 字段完整 | — | 直接使用 |
| 权限审计 | tool_call 拦截 | — | Extension hook |
| 日志存储 | JSONL 文件 | 数据库存储 | 自行实现 |
| 链路追踪 | toolCallId | requestId/traceId | 注入到审计上下文 |
| 不可篡改 | append-only JSONL | 数字签名/区块链 | 自行实现 |

---

## 6. Proxy 架构的多租户潜力

### 6.1 Proxy 流函数分析

文件：`packages/agent/src/proxy.ts`（341 行）

`streamProxy` 是一个替代 `streamSimple` 的流函数，将 LLM 请求转发到代理服务器：

```typescript
// proxy.ts:59-64
export interface ProxyStreamOptions extends SimpleStreamOptions {
    authToken: string;      // 代理服务器的认证 token
    proxyUrl: string;       // 代理服务器 URL
}

// proxy.ts:85-206
export function streamProxy(
    model: Model<any>,
    context: Context,
    options: ProxyStreamOptions
): ProxyMessageEventStream {
    // ...
    const response = await fetch(`${options.proxyUrl}/api/stream`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${options.authToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            context,
            options: {
                temperature: options.temperature,
                maxTokens: options.maxTokens,
                reasoning: options.reasoning,
            },
        }),
        signal: options.signal,
    });
    // 处理 SSE 流响应 ...
}
```

### 6.2 多租户代理架构

Proxy 层天然适合实现多租户 LLM 请求隔离。当前的 proxy 架构已经有：

1. **认证（authToken）**：可以用来标识租户
2. **请求转发**：所有 LLM 调用通过统一入口
3. **SSE 流式响应**：支持长连接流式输出

**基于 proxy 的多租户方案**：

```
Client (Agent)                    Proxy Server                    LLM Provider
     |                                |                                |
     |-- POST /api/stream ----------->|                                |
     |   Authorization: Bearer <T>    |                                |
     |   Body: { model, context }     |                                |
     |                                |-- 验证 authToken              |
     |                                |-- 从 token 解析 tenantId       |
     |                                |-- 检查配额                     |
     |                                |-- 选择对应的 API Key           |
     |                                |-- 转发请求 ------------------>|
     |                                |                                |
     |                                |<-- 流式响应 ------------------|
     |<-- SSE events ----------------|                                |
     |                                |-- 记录 token 使用量           |
     |                                |-- 更新配额                    |
```

**Proxy Server 需要实现的功能**：

```typescript
// proxy-server.ts (需要自行实现)
app.post("/api/stream", async (req, res) => {
    // 1. 租户认证
    const tenant = await authenticateTenant(req.headers.authorization);

    // 2. 配额检查
    const quota = await getQuota(tenant.id);
    if (quota.remaining <= 0) {
        return res.status(429).json({ error: "配额已用完" });
    }

    // 3. API Key 路由 —— 不同租户用不同的 API Key
    const apiKey = await getTenantApiKey(tenant.id, req.body.model.provider);

    // 4. 转发请求到 LLM provider
    const llmResponse = await streamSimple(req.body.model, req.body.context, {
        ...req.body.options,
        apiKey,
    });

    // 5. 流式转发响应 + 记录使用量
    res.setHeader("Content-Type", "text/event-stream");
    for await (const event of llmResponse) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);

        if (event.type === "done" || event.type === "error") {
            // 记录 token 使用量
            await recordUsage(tenant.id, event.usage);
            await updateQuota(tenant.id, event.usage);
        }
    }
    res.end();
});
```

### 6.3 Token 配额管理

`AssistantMessage` 的 `usage` 字段提供了完整的 token 使用数据（`types.ts:159-172`）：

```typescript
export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;   // 美元
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}
```

**cost 计算是自动的**（`models.ts:39-46`）：

```typescript
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
    usage.cost.input = (model.cost.input / 1000000) * usage.input;
    usage.cost.output = (model.cost.output / 1000000) * usage.output;
    usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
    usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
    return usage.cost;
}
```

每个 Model 定义中都包含了价格信息（`models.generated.ts` 中的 `cost` 字段），所以 proxy 层可以精确计算每次请求的成本。

**配额管理数据模型**：

```typescript
interface TenantQuota {
    tenantId: string;
    period: "daily" | "monthly";
    tokenLimit: number;          // token 限额
    costLimit: number;           // 成本限额（美元）
    tokensUsed: number;
    costUsed: number;
    resetAt: Date;
}
```

### 6.4 Proxy 事件的带宽优化

当前 proxy 实现有一个巧妙的带宽优化：服务端发送的 `ProxyAssistantMessageEvent` 不包含 `partial` 字段，客户端从 delta 事件中重建完整的 partial message。

```typescript
// proxy.ts:36-57
export type ProxyAssistantMessageEvent =
    | { type: "start" }
    | { type: "text_delta"; contentIndex: number; delta: string }
    // ... 没有 partial 字段，节省带宽
    | { type: "done"; reason: ...; usage: ... }
```

这对多租户场景很有价值——减少了网络带宽消耗。

### 6.5 Proxy 架构总结

| 能力 | 当前 proxy 支持 | 需要补充 | 复杂度 |
|------|---------------|---------|-------|
| 请求转发 | 完全支持 | — | — |
| 租户认证 | authToken 机制 | 租户 token 管理系统 | 中 |
| API Key 路由 | 不支持 | proxy server 端实现 | 低 |
| Token 配额 | usage 数据完整 | 配额管理逻辑 | 中 |
| 成本分摊 | cost 自动计算 | 按租户聚合 | 低 |
| 流量限制 | 不支持 | proxy server 端实现 | 低 |
| 审计日志 | 不支持 | proxy server 端实现 | 低 |

---

## 7. 与我们项目架构的具体对接方案

### 7.1 总体对接策略

基于以上深度分析，我将 pi-mono 的各组件分为三类：

#### 7.1.1 直接 npm install 使用

| 包 | 使用方式 | 理由 |
|----|---------|------|
| `@mariozechner/pi-ai` | 直接安装 | LLM 抽象层设计优秀，支持 10 个 API 协议，provider 注册机制灵活，baseUrl 可自定义，完全满足政府云需求 |
| `@mariozechner/pi-agent-core` | 直接安装 | Agent Loop 的 4 个 hook 足以满足我们的扩展需求，CustomAgentMessages 声明合并优雅，proxy 支持现成可用 |

**具体用法**：

```typescript
import { Agent, AgentTool, AgentMessage } from "@mariozechner/pi-agent-core";
import { streamSimple, getModel, registerApiProvider } from "@mariozechner/pi-ai";

// 创建 Coordinator Agent
const coordinator = new Agent({
    convertToLlm: customConvertToLlm,
    transformContext: injectOrganizationContext,
    getApiKey: async (provider) => tenantConfig.getApiKey(provider),
});

coordinator.setSystemPrompt(COORDINATOR_PROMPT);
coordinator.setModel(getModel("anthropic", "claude-opus-4-6-20250630"));
coordinator.setTools([
    delegateToSpecialistTool,
    checkApprovalStatusTool,
    queryPolicyDatabaseTool,
]);
```

#### 7.1.2 需要 Fork 并修改

| 组件 | Fork 原因 | 修改范围 |
|------|----------|---------|
| `amazon-bedrock.ts` provider | 需要支持自定义 endpoint URL 和 FIPS 端点 | 约 10 行：在 `BedrockRuntimeClientConfig` 中添加 `endpoint` 字段 |

这是唯一需要 fork 的部分，而且修改很小。也可以通过 `registerApiProvider()` 注册一个自定义的 "gov-bedrock" provider 来规避 fork：

```typescript
// 替代 fork 的方案：注册自定义 provider
registerApiProvider({
    api: "gov-bedrock" as Api,
    stream: (model, context, options) => {
        // 复制 streamBedrock 的逻辑，但添加 endpoint 配置
        const config: BedrockRuntimeClientConfig = {
            endpoint: process.env.GOV_BEDROCK_ENDPOINT,
            region: process.env.AWS_REGION,
            // ...
        };
        // ...
    },
    streamSimple: (model, context, options) => { /* ... */ },
});
```

这样就完全不需要 fork 了。

#### 7.1.3 借鉴设计模式但完全重写

| pi-mono 组件 | 借鉴的设计模式 | 我们的实现 |
|-------------|-------------|----------|
| Extension 系统 | `ToolDefinition` 接口、`tool_call` 拦截模式、`registerProvider` | 自行实现基于数据库的角色/工具注册表，支持多租户隔离 |
| Session Manager | Append-only JSONL + DAG 结构、Compaction 机制 | 自行实现基于数据库的会话持久化，支持长期任务断点续传 |
| EventBus | 简单的 pub/sub 模式 | 自行实现基于消息队列的事件总线，支持审计日志、跨进程通信 |
| Proxy Server | SSE 流式转发、ProxyAssistantMessageEvent 带宽优化 | 自行实现多租户 Proxy Server，添加配额管理和审计 |

### 7.2 Dynamic Hierarchical MoE 的具体对接架构

```
                          ┌─────────────────────┐
                          │   API Gateway        │
                          │   (认证/限流/审计)     │
                          └─────────┬───────────┘
                                    │
                          ┌─────────┴───────────┐
                          │   Proxy Server       │  <-- 借鉴 proxy.ts 的 SSE 流式协议
                          │   (配额/路由/BYOK)    │  <-- 新增：多租户 API Key 管理
                          └─────────┬───────────┘
                                    │
                     ┌──────────────┼──────────────┐
                     │              │              │
              ┌──────┴──────┐ ┌────┴────┐  ┌──────┴──────┐
              │ Coordinator │ │ Coord 2 │  │ Coord N    │  <-- 每个租户独立的 Coordinator
              │   Agent     │ │  Agent  │  │  Agent     │
              │ (pi-agent)  │ │         │  │            │
              └──────┬──────┘ └─────────┘  └────────────┘
                     │
         ┌───────────┼───────────┐
         │           │           │
    ┌────┴─────┐ ┌───┴────┐ ┌───┴──────┐
    │ 审批专员  │ │数据录入 │ │ 报告生成  │   <-- Sub-Agents (也是 pi-agent)
    │ Agent    │ │ Agent  │ │ Agent    │
    │ + Tools  │ │+ Tools │ │ + Tools  │   <-- 每个角色有专属 tools
    └──────────┘ └────────┘ └──────────┘
```

**Coordinator Agent 的两阶段路由实现**：

```typescript
const coordinatorTools: AgentTool[] = [
    {
        name: "route_task",
        label: "路由任务",
        description: "将任务路由到合适的虚拟员工处理",
        parameters: Type.Object({
            task_description: Type.String(),
            urgency: Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]),
        }),
        execute: async (toolCallId, params, signal) => {
            // 阶段 1：规则路由
            const ruleResult = ruleRouter.match(params.task_description);
            if (ruleResult.matched) {
                return await delegateToSubAgent(ruleResult.agentType, params, signal);
            }

            // 阶段 2：LLM 兜底路由
            const routingAgent = new Agent();
            routingAgent.setSystemPrompt(ROUTING_PROMPT);
            routingAgent.setModel(getModel("anthropic", "claude-haiku-4-20250801"));
            await routingAgent.prompt(
                `请分析以下任务应该分配给哪个专员处理：${params.task_description}`
            );
            const agentType = parseRoutingResult(routingAgent.state.messages);
            return await delegateToSubAgent(agentType, params, signal);
        },
    },
];
```

### 7.3 断点续传的数据库方案

借鉴 SessionManager 的设计，但用数据库实现：

```sql
-- 工作流表
CREATE TABLE workflows (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    agent_role VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,  -- pending/running/paused/completed/failed
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    parent_workflow_id UUID,      -- 支持工作流嵌套
    checkpoint JSONB              -- Agent 状态快照
);

-- 消息历史表（append-only）
CREATE TABLE workflow_messages (
    id UUID PRIMARY KEY,
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    parent_id UUID,               -- DAG 结构
    message JSONB NOT NULL,       -- AgentMessage 序列化
    created_at TIMESTAMP NOT NULL
);

-- 审计日志表
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY,
    workflow_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    user_id UUID,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL
);
```

### 7.4 我们需要新写的核心组件

| 组件 | 功能 | 依赖 |
|------|------|------|
| **TenantManager** | 租户管理、配额管理、API Key 管理 | 数据库 |
| **WorkflowEngine** | 工作流编排、断点续传、超时管理 | pi-agent-core + 数据库 |
| **RoleRegistry** | 角色定义、Tool 注册表、权限矩阵 | 数据库 |
| **AuditService** | 审计日志采集、存储、查询 | pi-agent-core 事件 + 数据库 |
| **ProxyServer** | 多租户 LLM 代理、配额限制 | pi-ai + pi-agent-core proxy |
| **TriggerEngine** | 定时任务、事件驱动触发 | pi-agent-core + 消息队列 |
| **ContextManager** | 长期记忆、组织知识库注入 | pi-agent-core transformContext |

### 7.5 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| pi-mono 是个人项目，可能停止维护 | 中 | 高 | 核心包（pi-ai、pi-agent-core）代码量小（<2000 行），可 fork 自维护 |
| API 不兼容升级 | 中 | 中 | 锁定版本，按需跟进 |
| 性能瓶颈（Agent Loop 串行） | 低 | 中 | 可在 tool 层并行，或创建多 Agent 实例 |
| LLM Provider API 变更 | 中 | 低 | pi-ai 持续跟进主流 provider |
| TypeScript 声明合并在某些构建工具中有问题 | 低 | 低 | 可改用 wrapper 模式 |

### 7.6 实施路径建议

**第一阶段（2-3 周）：核心 Agent 层验证**

1. `npm install @mariozechner/pi-ai @mariozechner/pi-agent-core`
2. 实现一个最小化的 Coordinator + Sub-Agent 原型
3. 验证 Azure Government Cloud / AWS GovCloud 连通性
4. 验证 tool 嵌套调用（Coordinator 中启动 Sub-Agent）

**第二阶段（3-4 周）：多租户 + 持久化**

1. 实现 ProxyServer 和 TenantManager
2. 实现基于数据库的 WorkflowEngine（借鉴 SessionManager）
3. 实现 AuditService
4. 实现 RoleRegistry

**第三阶段（2-3 周）：企业特性**

1. 实现 TriggerEngine（定时任务 + 事件驱动）
2. 实现 ContextManager（长期记忆 + RAG）
3. 压力测试和性能优化
4. 安全审计

---

## 附录 A：关键代码路径索引

| 功能 | 文件路径 | 行号 |
|------|---------|------|
| Agent Loop 主循环 | `packages/agent/src/agent-loop.ts` | 104-198 |
| Tool 串行执行 | `packages/agent/src/agent-loop.ts` | 294-378 |
| Agent 类 | `packages/agent/src/agent.ts` | 96-559 |
| AgentLoopConfig hooks | `packages/agent/src/types.ts` | 22-98 |
| AgentEvent 类型定义 | `packages/agent/src/types.ts` | 179-194 |
| CustomAgentMessages 声明合并 | `packages/agent/src/types.ts` | 107-130 |
| Proxy 流函数 | `packages/agent/src/proxy.ts` | 85-206 |
| Bedrock Provider | `packages/ai/src/providers/amazon-bedrock.ts` | 62-214 |
| Azure OpenAI Provider | `packages/ai/src/providers/azure-openai-responses.ts` | 55-257 |
| Anthropic Provider | `packages/ai/src/providers/anthropic.ts` | 193-421 |
| API 注册表 | `packages/ai/src/api-registry.ts` | 40-98 |
| Model 类型定义 | `packages/ai/src/types.ts` | 297-320 |
| 环境变量 API Key | `packages/ai/src/env-api-keys.ts` | 63-129 |
| streamSimple 入口 | `packages/ai/src/stream.ts` | 43-50 |
| Extension 类型定义 | `packages/coding-agent/src/core/extensions/types.ts` | 全文 |
| Extension 加载器 | `packages/coding-agent/src/core/extensions/loader.ts` | 361-385 |
| Extension 运行器 | `packages/coding-agent/src/core/extensions/runner.ts` | 196-848 |
| Tool 拦截包装器 | `packages/coding-agent/src/core/extensions/wrapper.ts` | 38-111 |
| EventBus | `packages/coding-agent/src/core/event-bus.ts` | 1-33 |
| Session Manager | `packages/coding-agent/src/core/session-manager.ts` | 全文 |
| Model Registry | `packages/coding-agent/src/core/model-registry.ts` | 全文 |
| EventStream 基础类 | `packages/ai/src/utils/event-stream.ts` | 4-87 |

## 附录 B：pi-mono 包的 npm 安装命令

```bash
# 核心依赖（直接使用）
npm install @mariozechner/pi-ai @mariozechner/pi-agent-core

# 如果需要 Extension 系统的类型定义（仅开发时参考）
npm install --save-dev @mariozechner/pi-coding-agent
```

## 附录 C：环境变量速查

### AWS Bedrock / GovCloud

```bash
# 认证
AWS_PROFILE=gov-profile
# 或
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx

# 区域
AWS_REGION=us-gov-west-1

# FIPS
AWS_USE_FIPS_ENDPOINT=true

# 代理
HTTPS_PROXY=http://proxy.gov.example.com:8080

# 跳过认证（用于 LiteLLM 等代理）
AWS_BEDROCK_SKIP_AUTH=1
AWS_BEDROCK_FORCE_HTTP1=1
```

### Azure OpenAI / Government Cloud

```bash
# 认证
AZURE_OPENAI_API_KEY=xxx

# 端点（政府云）
AZURE_OPENAI_BASE_URL=https://my-resource.openai.azure.us/openai/v1
# 或
AZURE_OPENAI_RESOURCE_NAME=my-resource  # 仅商业云

# API 版本
AZURE_OPENAI_API_VERSION=v1

# Deployment 映射
AZURE_OPENAI_DEPLOYMENT_NAME_MAP="gpt-4=my-gpt4,gpt-4o=my-gpt4o"
```

### Anthropic

```bash
# API Key
ANTHROPIC_API_KEY=sk-ant-xxx
# 或 OAuth Token
ANTHROPIC_OAUTH_TOKEN=sk-ant-oat-xxx
```

### 通用

```bash
# 缓存策略
PI_CACHE_RETENTION=long  # none | short | long
```

## 附录 D：与竞品对比

| 特性 | pi-mono | LangChain | AutoGen | 我们的需求 |
|------|---------|-----------|---------|-----------|
| Agent Loop 可扩展性 | 4 个 hook，简洁 | Chain 模式，复杂 | 对话模式 | hook 模式更适合 |
| LLM Provider 统一 | 10 个 API 协议 | 更多但质量参差 | 依赖 OpenAI | pi-ai 质量高 |
| 多 Agent 协作 | 通过 tool 嵌套 | Agent Executor | 原生支持 | 均可满足 |
| 持久化 | JSONL + DAG | Memory 抽象 | 无 | 需自行实现 |
| Extension 系统 | TypeScript 模块 | Python 插件 | 无 | pi-mono 更规范 |
| 代码量 | agent 核心 <1000 行 | 数万行 | 数千行 | 小巧可控 |
| 维护者 | 个人项目 | LangChain Inc | Microsoft | 个人项目有风险 |

**结论**：pi-mono 的 `pi-ai` 和 `pi-agent-core` 是我们所评估的方案中最适合的基础组件。代码量小、设计精良、hook 机制灵活、支持政府云。主要风险在于个人项目的持续维护，但核心代码足够简洁，fork 维护的成本可控。
