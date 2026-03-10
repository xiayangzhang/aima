# AIMA 实现指南

> **版本**: 1.1
> **状态**: 当前权威文档
> **关联**: `01-agent-architecture.md` 为架构概览，本文为面向开发者的实现参考

---

## 一、适配器模型

AIMA 框架层（Thread Runner / Cognitive Workspace / MemoryService / Brain Event Bus）与底层 agent runtime 无关。每个脑区的 Loop 通过适配器接口运行，适配器对上层透明。

```typescript
interface BrainAdapter {
  // 启动或续接一个脑区的 Loop，阻塞直到 Loop 完成
  run(params: BrainRunParams): Promise<BrainRunResult>
  // 向正在运行的 Loop 注入信号（如 Amygdala 中断）
  inject(signal: BrainSignal): Promise<void>
  // 中止当前 Loop（cooperative cancellation）
  abort(): void
}

interface BrainRunParams {
  brain:          BrainType       // limbic | cortex | brainstem | amygdala | dmn
  thread_id:      string          // 所属 Thread（session key = brain:thread_id）
  system_prompt:  string          // Context Assembly 组装结果（Block 1-4）
  initial_prompt?: string         // 本次激活的触发内容；不传则调用 agent.continue()
}

interface BrainRunResult {
  session_id:  string             // 本次 Loop 使用的 session ID
  output:      Record<string, unknown>
  stop_reason: 'done' | 'interrupted' | 'error'
  events:      WorkspaceEvent[]   // 本次 Loop 产生的工作空间事件（Slot 写入、Signal 写入等）
                                  // Thread Runner 在 activateBrain() 后遍历并 emit 到 workspace
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

// Brainstem 子执行 session（opt-in，仅 Brainstem 可用）
// 主 session（Haiku）自主决定是否调用：简单任务直接执行，复杂/多步任务 spawn 子 session。
// 子 session（Opus/Sonnet）完整运行 LLM 循环后，结果作为 tool_result 注入回主 session。
// 主 session 只见结构化摘要，完整推理链保留在 Event Bus（COMPLIANCE 事件携带子 session_id）。
server.tool('spawn_execution_session', '启动子执行 session（Brainstem 专用）', {
  task:      z.string(),                                  // 任务描述，子 session 的初始 prompt
  model:     z.enum(['opus', 'sonnet']).default('sonnet'),// 子 session 使用的模型
  tools:     z.array(z.string()).optional(),              // 子 session 可用工具列表（默认继承 Brainstem 工具集）
}, async ({ task, model, tools }) => {
  const childSessionId = crypto.randomUUID()
  // 将子 session ID 写入 Brainstem Slot，供崩溃恢复使用（at-most-once 语义）
  await workspace.updateBrainstemSlot(currentThreadId, { execution_session_id: childSessionId })

  const result = await runChildExecutionSession({ task, model, tools, sessionId: childSessionId })

  // 子 session 完成后清除 execution_session_id（正常路径）
  await workspace.updateBrainstemSlot(currentThreadId, { execution_session_id: null })

  // 返回结构化结果摘要，作为 tool_result 注入主 session
  return { content: [{ type: 'text', text: JSON.stringify(result.structured_output) }] }
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
  // Thread 是认知上下文的边界单元：同一 Thread 内的多次脑区激活共享同一 session（对话历史延续）；
  // 不同 Thread 之间 session 完全隔离（上下文不跨任务污染）。
  // 跨 Thread 的知识通过记忆系统（Block 4）流通，不通过 session 历史。
  // DMN Reactive / Consolidation / Amygdala 不使用 LLM session，不在此 Map 中。
  private brainSessions: Map<string, string>  // `${brain}:${thread_id}` → sessionId
  private workspace: CognitiveWorkspace

  // Thread Runner 的主循环：监听工作空间变化，激活对应脑区
  // workspace.changes() 覆盖两类写入：
  //   1. 脑区写 Slot（brain complete）→ 路由到下一个脑区
  //   2. DMN 写 pending_observations（pending 是 workspace 状态的 JSONB 字段）→ routePending()
  async run() {
    for await (const event of this.workspace.changes()) {
      if (event.type === 'slot_update') {
        await this.route(event)
      } else if (event.type === 'pending_update') {
        await this.routePending()
      }
    }
  }

  private async route(event: WorkspaceEvent) {
    const { thread_id, slot } = event

    // 示意性路由逻辑，仅覆盖核心路径。
    // 完整路由规则（Limbic EXECUTE 直接激活 Brainstem、Brainstem 完成后触发 DMN Reactive 检查、
    // 系统事件 needs_analysis → Cortex 等边界路径）见 01-agent-architecture.md 第四节激活触发条件表。
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

  // DMN 写入 pending_observations 时触发。
  // 取出所有 target_brain 对应的成熟 pending 项，创建新 Thread 并激活目标脑区。
  // "成熟"的判断由 pending 的 added_at + note 中的时间提示决定（DMN 写入时已标注预期触发时间）。
  private async routePending() {
    const pending = await this.workspace.getPendingObservations()
    for (const item of pending) {
      if (this.isMature(item)) {
        const thread = await this.workspace.createThread({ trigger: item.note, initiated_by: 'dmn' })
        await this.activateBrain(item.target_brain, thread.thread_id)
        await this.workspace.removePending(item.id)
      }
    }
  }

  private async activateBrain(brain: BrainType, thread_id: string) {
    const adapter = this.adapters.get(brain)    // pi-agent-core 或 Claude SDK adapter
    const sessionId = this.brainSessions.get(`${brain}:${thread_id}`)
    const systemPrompt = await assembleContext(brain, this.workspace, thread_id)

    const result = await adapter.run({ brain, sessionId, systemPrompt, thread_id })
    for (const event of result.events) {
      this.workspace.emit(event)
    }
  }
}
```

---

## 五、Prompt Cache 实施规则

实验验证（`scripts/test-cache.ts`）确认以下规则，实现时必须遵守：

### 已验证结论

| 场景 | 结果 |
|---|---|
| 不同 Thread 使用相同 Block 1+2 | ✅ 命中 cache（跨 Thread 共享） |
| 同 Thread 续接激活 | ✅ 命中 cache |
| Block 1+2 内容有任何改动 | ❌ cache miss，重新建 cache |
| 时间戳放在 Block 1+2 内 | ❌ 永远 miss，每次建新 cache 浪费 token |
| 时间戳放在 Block 3（不加 `cache_control`） | ✅ Block 1+2 cache 完好 |

### 强制约束

**Block 1+2 内禁止出现任何动态内容**，包括：
- 当前日期 / 时间戳
- Session 创建时间
- Skill 文件的 `last_updated` 字段
- 任何在两次调用之间可能变化的字符串

Block 1+2 在同一 AIMA 实例运行期间必须是**字节完全相同**的字符串。即使是一个空格或换行符的差异也会导致 cache miss。

**动态内容统一放 Block 3（workspace 状态）或 Block 4（记忆检索结果）**，这两个 block 不加 `cache_control`，每次调用自由变化。

### 最低 token 门槛

Anthropic prompt cache 要求 Block 1+2 **至少 2048 tokens** 才会触发。Block 1+2 过短则完全没有 cache 效果。实际的 identity + skill index 内容通常远超此门槛，但需在实现时验证。

### per-model 隔离

Cache 以模型为边界。Limbic（Sonnet）和 Cortex（Opus）的 Block 1+2 即使内容完全相同，也使用各自独立的 cache 桶，不共享。

---

## 六、适配器策略

**已决定：统一使用 `pi-coding-agent` 作为单一 adapter。**

原因：
1. `pi-coding-agent` 的内置工具（bash、文件 I/O）与外部工具走同一 `AgentTool` 路径
2. Extension API 的 `tool_call` 事件（pre-execution，可 block）让 Amygdala 覆盖所有工具
3. 无需维护两套 adapter——工具权限由 Amygdala 策略（`role.md` 中的 `permissions`）控制

**当前状态**：暂时使用 `pi-agent-core`（已实现，18/18 测试通过）。迁移到 `pi-coding-agent` 是下一个 adapter 任务。

**默认工具权限（Amygdala 内置策略）**：

```
bash          → BLOCK（默认）  可由 role.md permissions 解锁
file_write    → BLOCK（默认）  可由 role.md 限定路径解锁
file_delete   → BLOCK（默认）  可由 role.md 解锁
file_read     → BLOCK（默认）  可由 role.md 解锁
memory_search → ALLOW
workspace_read/write → ALLOW
```

**是否还需要 Claude Agent SDK 适配器？**

```
需要 Claude 以外的模型，或数据不出特定云（Azure / Bedrock）？
├── 是 → Claude Agent SDK 适配器（支持多云部署，待实现）
└── 否 → pi-coding-agent 适配器（默认，已决定）
```

---

## 七、当前阶段状态

| 组件 | 状态 |
|---|---|
| BrainAdapter 接口 | ✅ 已实现（`src/adapters/pi-agent/index.ts`） |
| pi-agent-core 适配器（PiAgentAdapter） | ✅ 已实现，18/18 测试通过 |
| Thread Runner | ✅ 已实现（`src/runner/index.ts`） |
| CognitiveWorkspace（PostgreSQL 后端） | ✅ 已实现，含 crash recovery |
| Brain Event Bus | ✅ 已实现（`src/eventbus/index.ts`） |
| MemoryService（PostgreSQL 后端） | ✅ 已实现 |
| Limbic / Cortex / Brainstem 脑区 | ✅ 已实现，E2E 通过 |
| Claude Agent SDK 适配器 | ⏳ 待实现 |
| MCP server（AIMA 工具集） | ⏳ 待实现 |
| `@aima/crew`（pi 兼容 facade） | ⏳ 待实现（见 `04-sdk-api.md`） |

实现代码位于 `aima-feature` 分支（独立 git repo，待 PR 合入）。

整体路线图与暂缓的设计决策见 [`05-status.md`](05-status.md)。
