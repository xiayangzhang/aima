# AIMA 实现指南

> **版本**: 1.0
> **状态**: 当前权威文档
> **关联**: `01-agent-architecture.md` 为架构概览，本文为面向开发者的实现参考

---

## 一、适配器模型

AIMA 框架层（Thread Runner / Cognitive Workspace / MemoryService / Brain Event Bus）与底层 agent runtime 无关。每个脑区的 Loop 通过适配器接口运行，适配器对上层透明。

```typescript
interface BrainAdapter {
  // 启动或续接一个脑区的 Loop
  run(params: BrainRunParams): AsyncIterable<BrainEvent>
  // 向正在运行的 Loop 注入新消息（如 Amygdala 中断信号）
  inject(signal: BrainSignal): Promise<void>
  // 中止当前 Loop（cooperative cancellation）
  abort(): void
}

interface BrainRunParams {
  brain:       BrainType               // limbic | cortex | brainstem | amygdala | dmn
  sessionId?:  string                  // 续接已有 session
  systemPrompt: string                 // Context Assembly 组装结果（Block 1-4）
  tools:       ToolDefinition[]        // 该脑区允许的工具
  initialPrompt?: string               // 本次激活的触发内容
}
```

---

## 二、pi-agent-core 适配器

### 适用场景

- 需要使用 Claude 以外的模型（GPT-4、Gemini、本地模型）
- 需要精细控制 agent loop 的每一步
- 构建不依赖 Anthropic 生态的部署环境

### 核心映射

pi-agent-core 的 4 个 hooks 与 AIMA 概念的对应关系：

| pi-agent-core hook | AIMA 对应 |
|---|---|
| `transformContext` | Context Assembly —— 每轮 Loop 开始前注入 Block 3/4（工作空间状态 + 记忆检索） |
| `convertToLlm` | 消息过滤 —— 把脑区特定的自定义消息类型转换为 LLM 标准格式，过滤 UI 专用消息 |
| `getSteeringMessages` | Amygdala 中断 + DMN 纠错信号 —— 工具调用间隙检查是否有中断信号 |
| `getFollowUpMessages` | DMN follow-up / 新 Thread 触发 —— 脑区完成后检查是否有后续任务 |

### 实现框架

```typescript
import { Agent, AgentTool } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'

function createBrainAgent(brain: BrainType, workspace: CognitiveWorkspace): Agent {
  const agent = new Agent({
    initialState: {
      model: selectModel(brain),    // Limbic=Sonnet, Cortex=Opus, Brainstem=Haiku
      systemPrompt: '',             // 由 transformContext 每轮填充
      tools: getToolsForBrain(brain),
    }
  })

  // Block 3/4 每轮注入：工作空间状态 + 记忆检索
  const hooks = {
    transformContext: async (messages) => {
      const block34 = await assembleContext(brain, workspace)
      // Block 1/2（identity + skill-index）已在 systemPrompt 静态设置，走 cache
      agent.setSystemPrompt(block34.systemPrompt)
      return messages
    },

    // 脑区自定义消息类型 → LLM 标准格式
    convertToLlm: (messages) => messages.flatMap(m => {
      if (m.role === 'brain_signal') return []   // 过滤内部信号消息
      return [m]
    }),

    // 工具调用间隙检查中断信号
    getSteeringMessages: async () => {
      // 1. Amygdala 信号（来自 tool.pre_use 事件）
      const amygdalaSignal = workspace.signals.pop('amygdala_interrupt')
      if (amygdalaSignal) return [toAgentMessage(amygdalaSignal)]

      // 2. DMN 纠错通知
      const dmnSignal = workspace.signals.pop('dmn_correction')
      if (dmnSignal) return [toAgentMessage(dmnSignal)]

      return []
    },

    // 脑区完成后检查后续任务
    getFollowUpMessages: async () => {
      const nextThread = workspace.getNextPendingThread(brain)
      if (nextThread) return [toAgentMessage(nextThread)]
      return []
    }
  }

  return agent
}
```

### Brain Event Bus 集成

pi-agent-core 通过事件订阅机制接入 Brain Event Bus：

```typescript
agent.subscribe((event) => {
  switch (event.type) {
    case 'tool_execution_start':
      eventBus.emit({ level: 'INFO', type: 'tool.pre_use',
        brain, tool: event.toolName, args: event.args })
      break
    case 'tool_execution_end':
      eventBus.emit({ level: 'COMPLIANCE', type: 'tool.post_use',
        brain, tool: event.toolName, result: event.result })
      break
    case 'agent_end':
      eventBus.emit({ level: 'TRACE', type: 'brain.complete', brain })
      break
  }
})
```

---

## 三、Claude Agent SDK 适配器

### 适用场景

- 快速上手，最低阻力入门路径
- Claude 生态（Anthropic / Amazon Bedrock / Google Vertex / Azure AI Foundry）
- 利用 SDK 内置能力：session 管理、native MCP、PreCompact hook

### 核心映射

| AIMA 概念 | Claude Agent SDK 实现 |
|---|---|
| 脑区 Loop | `query()` — 每次激活对应一次 query 调用 |
| Session 续接 | `options.resume: sessionId` — SDK 原生，无需自实现 |
| Limbic 持续在线 | `prompt: AsyncIterable<SDKUserMessage>` — 消息 pipe 进来，Loop 不中断 |
| Context Assembly Block 1/2 | `CLAUDE.md`（project 级）— SDK 启动时自动注入，走 cache |
| Context Assembly Block 3/4 | `options.appendSystemPrompt` 或 `systemPrompt.append` — 每次 query 动态拼接 |
| Amygdala 检测 | `PreToolUse` hook — 工具执行前同步检查 |
| Brain Event Bus | `PostToolUse` hook — 工具执行后发射事件 |
| Session 摘要锚点 | `PreCompact` hook — 压缩前存档对话，写 `episodic` session_anchor |
| 工具注册 | MCP server（stdio 或 HTTP）— `options.mcpServers` 连接 |
| 多工具权限 | `options.allowedTools` — 每个脑区声明允许的工具列表 |

### 实现框架

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'

async function runBrainLoop(params: BrainRunParams, workspace: CognitiveWorkspace) {
  const { brain, sessionId, tools } = params

  // Limbic 用 AsyncIterable，保持 Loop 持续接收消息
  const messageStream = brain === 'limbic'
    ? createMessageStream(workspace)    // AsyncIterable<SDKUserMessage>
    : params.initialPrompt              // 其他脑区用字符串触发

  for await (const message of query({
    prompt: messageStream,
    options: {
      resume: sessionId,
      allowedTools: getSDKToolsForBrain(brain),
      permissionMode: 'bypassPermissions',
      mcpServers: { aima: { command: 'node', args: [mcpServerPath] } },

      hooks: {
        // Amygdala 检测：工具执行前
        PreToolUse: [{
          hooks: [async ({ tool_name, tool_input }) => {
            const riskLevel = getToolRiskLevel(tool_name)
            if (riskLevel === 'low') return {}    // 跳过，不调用 LLM

            const amygdalaResult = await amygdala.check(tool_name, tool_input)
            if (amygdalaResult.blocked) {
              workspace.signals.push('amygdala_interrupt', amygdalaResult)
              return { permissionDecision: 'deny' }
            }
            return { permissionDecision: 'allow' }
          }]
        }],

        // Brain Event Bus：工具执行后
        PostToolUse: [{
          hooks: [async ({ tool_name, tool_input, tool_response }) => {
            eventBus.emit({ level: 'COMPLIANCE', type: 'tool.post_use',
              brain, tool: tool_name, result: tool_response })
          }]
        }],

        // Session 摘要锚点：压缩前写入 episodic 记忆
        // ⚠️ 注意：若 summarizeTranscript() 内部调用 LLM，需确保在 SDK 压缩流程
        //    触发前完成，否则可能超时或死锁。推荐使用规则型摘要（提取关键 Slot /
        //    事件标题），避免在 PreCompact hook 内嵌套 LLM 调用。
        PreCompact: [{
          hooks: [async ({ transcript }) => {
            await memoryService.write({
              type: 'episodic',
              kind: 'session_anchor',
              content: summarizeTranscript(transcript),
              brain,
            })
            return {}    // 不阻断压缩
          }]
        }]
      }
    }
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      workspace.updateSessionId(brain, message.session_id)
    }
    if (message.type === 'result') {
      threadRunner.onBrainComplete(brain, message)
    }
  }
}
```

### CLAUDE.md 分层（Context Assembly Block 1/2）

Block 1/2（identity + skill-index）通过 CLAUDE.md 文件自动注入，走 prompt cache：

```
/workspace/
├── CLAUDE.md               # 全局：AIMA 框架规则（所有脑区共享）
└── brains/
    ├── limbic/
    │   └── CLAUDE.md       # Limbic 专属：人格、沟通风格、关系上下文
    ├── cortex/
    │   └── CLAUDE.md       # Cortex 专属：推理角色、分析方法论
    └── brainstem/
        └── CLAUDE.md       # Brainstem 专属：系统权限、API 清单
```

query 时 `cwd` 指向对应脑区目录，SDK 自动加载该脑区的 CLAUDE.md 作为项目级规则。

### MCP server：自定义工具注册

所有 AIMA 特定工具通过 MCP server 暴露：

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const server = new McpServer({ name: 'aima', version: '1.0.0' })

// 工作空间读写
server.tool('workspace_read_slot', '读取认知工作空间 Slot', {
  thread_id: z.string(),
  brain: z.enum(['limbic', 'cortex', 'brainstem']),
}, async ({ thread_id, brain }) => {
  const slot = workspace.getSlot(thread_id, brain)
  return { content: [{ type: 'text', text: JSON.stringify(slot) }] }
})

server.tool('workspace_write_slot', '写入认知工作空间 Slot', {
  thread_id: z.string(),
  output: z.string(),
  intent: z.enum(['communicate', 'execute', 'both']).optional(),
}, async ({ thread_id, output, intent }) => {
  workspace.writeSlot(thread_id, currentBrain, { output, intent, status: 'done' })
  return { content: [{ type: 'text', text: 'Slot updated.' }] }
})

// 记忆读写
server.tool('memory_search', '语义检索记忆', {
  query: z.string(),
  types: z.array(z.enum(['semantic', 'procedural', 'implicit'])).optional(),
}, async ({ query, types }) => {
  const results = await memoryService.search(query, { types })
  return { content: [{ type: 'text', text: renderMemoryResults(results) }] }
})
```

---

## 四、Thread Runner

Thread Runner 是 AIMA 框架层的核心编排器，与适配器无关。

```typescript
class ThreadRunner {
  // Session key = brain + thread_id（二元组）
  // 防止同一脑区同时处理多个 Thread 时 session 历史串线
  private brainSessions: Map<string, string>  // `${brain}:${thread_id}` → sessionId
  private workspace: CognitiveWorkspace

  private sessionKey(brain: BrainType, thread_id: string): string {
    return `${brain}:${thread_id}`
  }

  // Thread Runner 的主循环：监听工作空间变化，激活对应脑区
  async run() {
    for await (const event of this.workspace.changes()) {
      await this.route(event)
    }
  }

  private async route(event: WorkspaceEvent) {
    const { thread_id, slot } = event

    // 激活条件判断（见架构文档第四节）
    if (slot.brain === 'limbic' && slot.status === 'done' && slot.needs_analysis) {
      await this.activateBrain('cortex', thread_id)
    }
    else if (slot.brain === 'cortex' && slot.status === 'done') {
      const { intent } = slot.output
      if (intent === 'communicate' || intent === 'both')
        await this.activateBrain('limbic', thread_id)
      if (intent === 'execute' || intent === 'both')
        await this.activateBrain('brainstem', thread_id)
    }
  }

  private async activateBrain(brain: BrainType, thread_id: string) {
    const adapter = this.adapters.get(brain)    // pi-agent-core 或 Claude SDK adapter
    const sessionId = this.brainSessions.get(this.sessionKey(brain, thread_id))
    const systemPrompt = await assembleContext(brain, this.workspace, thread_id)

    for await (const event of adapter.run({ brain, sessionId, systemPrompt, thread_id })) {
      this.workspace.emit(event)
    }
  }
}
```

---

## 五、选择适配器的决策树

```
需要 Claude 以外的模型？
├── 是 → pi-agent-core 适配器
└── 否
    ├── 需要精细控制 token 和每一步调用？
    │   ├── 是 → pi-agent-core 适配器
    │   └── 否 → Claude Agent SDK 适配器
    ├── 政府/企业合规要求：数据不出特定云？
    │   └── Azure AI Foundry / Amazon Bedrock → Claude Agent SDK 适配器（支持）
    └── 快速原型 / 开源贡献 / 最低阻力？
        └── Claude Agent SDK 适配器
```

---

## 六、当前阶段状态

| 组件 | 状态 |
|---|---|
| BrainAdapter 接口 | 设计完成，待实现 |
| pi-agent-core 适配器 | 待实现 |
| Claude Agent SDK 适配器 | 待实现 |
| Thread Runner | 待实现 |
| MemoryService（PostgreSQL 后端） | 待实现 |
| Brain Event Bus | 待实现 |
| MCP server（AIMA 工具集） | 待实现 |

AIMA 当前处于架构设计阶段，无生产代码。
