---
work_package_id: "WP06"
title: "ClaudeAgentSDKAdapter + MCP Server"
lane: "planned"
dependencies: ["WP01", "WP02", "WP03"]
subtasks: ["T031", "T032", "T033", "T034", "T035", "T036", "T037", "T038"]
history:
  - 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
---

# WP06 — ClaudeAgentSDKAdapter + MCP Server

## 目标

实现两个组件：
1. **McpServer**：AIMA 工具集（workspace/memory 访问），供 ClaudeAgentSDK 挂载
2. **ClaudeAgentSDKAdapter**：用 `@anthropic-ai/claude-agent-sdk@0.2.72` 实现 BrainAdapter，使用 PreToolUse hook 同步拦截工具调用（真正的 Amygdala 执行前守卫）

## 上下文

- 依赖 WP01：BrainAdapter、BrainEventBus、BrainSignal、CognitiveWorkspace.pushSignal
- 依赖 WP02：assembleContext()
- 依赖 WP03：Amygdala.check()
- 新建文件：`src/mcp/index.ts`、`src/adapters/claude-sdk/index.ts`
- 这是主路径 Adapter（ClaudeAgentSDK 支持真正的同步 PreToolUse 拦截）

## Claude Agent SDK 实际 API（@anthropic-ai/claude-agent-sdk@0.2.72）

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'

// 核心调用
const result = await query({
  prompt: string,             // 用户消息或续接消息
  options: {
    model?: string,
    apiKey?: string,
    resume?: string,          // 前一次的 sessionId，用于续接
    appendSystemPrompt?: string,  // 追加到 system prompt（Block 3/4 走这里）
    mcpServers?: McpServerConfig[],
    hooks?: {
      PreToolUse?: (event: PreToolUseEvent) => PreToolUseResult | Promise<PreToolUseResult>
      PostToolUse?: (event: PostToolUseEvent) => void | Promise<void>
      PreCompact?: (event: PreCompactEvent) => void | Promise<void>
    }
  }
})
// result.sessionId: string  — 下次 resume 用
// result.result: string     — LLM 最终文字输出

// PreToolUseResult
type PreToolUseResult = 
  | { permissionDecision: 'allow' }
  | { permissionDecision: 'deny'; denyMessage?: string }
  | void  // 等同 allow

// McpServerConfig（stdio 模式）
interface McpServerConfig {
  type: 'stdio'
  command: string       // "bun"
  args: string[]        // ["run", "src/mcp/index.ts"]
  env?: Record<string, string>
}
```

**关键点**：
- `appendSystemPrompt` 追加到已有 system prompt 末尾，Block 1/2 在 API 配置层固定，Block 3/4 每次通过此参数注入
- `resume` 字段传上次的 `result.sessionId` 实现 session 续接
- `PreToolUse` 是同步拦截（执行前），返回 deny 则工具不执行
- MCP Server 以 stdio 子进程方式启动

## 实现指导

### T031 — McpServer 实现

**文件**：`src/mcp/index.ts`（新建）

使用 `@modelcontextprotocol/sdk` 实现 stdio MCP server，注册以下工具：

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// 工具列表
const TOOLS = [
  'workspace_read_slot',
  'workspace_write_slot',
  'memory_search',
  'memory_entity_context',
  'memory_similar_situations',
  'memory_procedure',
  'spawn_execution_session',  // Brainstem 专用，见 T037
]
```

**各工具签名**：

```typescript
// workspace_read_slot
// 读取指定 Thread 的 Slot
// input: { threadId: string, brain: string }
// output: Slot JSON

// workspace_write_slot  
// 写入 Slot（供脑区更新自己的 output）
// input: { threadId: string, brain: string, status: string, output: object }
// output: { ok: true }

// memory_search
// 通用语义检索
// input: { query: string, types?: string[], limit?: number }
// output: MemoryEntry[]

// memory_entity_context
// 实体中心检索（Limbic 专用）
// input: { entityId: string, depth?: number, types?: string[], limit?: number }
// output: MemoryEntry[]

// memory_similar_situations
// 情境匹配（Cortex 专用）
// input: { situation: string, limit?: number }
// output: { episodes: MemoryEntry[], procedures: MemoryEntry[] }

// memory_procedure
// 任务过程检索（Brainstem 专用）
// input: { taskType: string, limit?: number }
// output: MemoryEntry[]
```

**MCP Server 启动入口**（stdio 模式，被子进程 spawn）：

```typescript
// src/mcp/index.ts 末尾
if (process.argv[1]?.endsWith('mcp/index.ts')) {
  // 当作为子进程运行时启动 server
  const server = createMcpServer(getSharedDependencies())
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
```

**注意**：MCP server 运行在子进程，需要通过环境变量或 stdio 协议与主进程共享 DB 连接信息（连接字符串通过 env 传入）。每个 adapter 实例启动一个 MCP server 子进程。

---

### T032 — ClaudeAgentSDKAdapter 类结构 + 构造参数

**文件**：`src/adapters/claude-sdk/index.ts`（新建）

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { BrainAdapter, BrainRunParams, BrainRunResult, BrainSignal } from '../index'
import type { BrainEventBus } from '../../eventbus/index'
import type { CognitiveWorkspace } from '../../workspace/index'
import type { Amygdala } from '../../amygdala/index'
import type { MemoryService } from '../../types/index'

export interface ClaudeAgentSDKAdapterConfig {
  model: string                        // e.g. "claude-sonnet-4-6"
  workspace: CognitiveWorkspace
  memoryService: MemoryService
  eventBus: BrainEventBus
  amygdala: Amygdala
  getApiKey: () => string | undefined
  assemblerConfig: ContextAssemblerConfig
  mcpServerPath: string                // 绝对路径到 src/mcp/index.ts
  databaseUrl: string                  // 传给 MCP server 子进程
}

export class ClaudeAgentSDKAdapter implements BrainAdapter {
  private config: ClaudeAgentSDKAdapterConfig
  // key = `${brain}:${threadId}`，值是 Claude SDK 返回的 sessionId 字符串
  private sessionIds = new Map<string, string>()
  // key = `${brain}:${threadId}`，用于 abort()
  private abortControllers = new Map<string, AbortController>()

  constructor(config: ClaudeAgentSDKAdapterConfig) {
    this.config = config
  }

  async run(params: BrainRunParams): Promise<BrainRunResult> { ... }
  async inject(signal: BrainSignal): Promise<void> { ... }
  async abort(brain: string, threadId: string): Promise<void> { ... }
}
```

---

### T033 — run() — query() 调用，session 续接，Block 3/4 注入

```typescript
async run(params: BrainRunParams): Promise<BrainRunResult> {
  const { brain, threadId, block12 } = params
  const key = `${brain}:${threadId}`
  
  // 1. 组装 Block 3/4
  const { systemPrompt: block34, injectedMemoryIds } = await assembleContext(
    brain,
    this.config.workspace,
    threadId,
    this.config.assemblerConfig,
    block12
  )
  
  // 2. 读取 prompt（当前输入 Slot）
  const inputSlot = await this.config.workspace.getLatestInputSlot(threadId)
  const prompt = inputSlot?.output?.content ?? '[no input]'
  
  // 3. 创建 AbortController
  const ac = new AbortController()
  this.abortControllers.set(key, ac)
  
  // 4. 调用 query()
  let result
  try {
    result = await query({
      prompt,
      options: {
        model: this.config.model,
        apiKey: this.config.getApiKey(),
        resume: this.sessionIds.get(key),       // undefined = 新 session
        appendSystemPrompt: block34,             // Block 3/4 每次动态注入
        mcpServers: [{
          type: 'stdio',
          command: 'bun',
          args: ['run', this.config.mcpServerPath],
          env: {
            DATABASE_URL: this.config.databaseUrl,
            AIMA_THREAD_ID: threadId,
            AIMA_BRAIN: brain,
          }
        }],
        hooks: {
          PreToolUse: this.buildPreToolUseHook(brain, threadId),
          PostToolUse: this.buildPostToolUseHook(brain, threadId),
          PreCompact: this.buildPreCompactHook(brain, threadId),
        },
        // 如果 SDK 支持 AbortSignal，传入
        // signal: ac.signal
      }
    })
  } finally {
    this.abortControllers.delete(key)
  }
  
  // 5. 保存 sessionId 供下次续接
  this.sessionIds.set(key, result.sessionId)
  
  // 6. Emit brain.complete
  this.config.eventBus.emit({
    type: 'brain.complete',
    level: 'INFO',
    brain,
    threadId,
    payload: {}
  })
  
  return {
    brain,
    threadId,
    sessionId: result.sessionId,
    injectedMemoryIds
  }
}
```

---

### T034 — PreToolUse hook — Amygdala 同步拦截

```typescript
private buildPreToolUseHook(brain: string, threadId: string) {
  return async (event: PreToolUseEvent) => {
    const { toolName, toolInput } = event
    
    // 发出 tool.pre_use 事件（用于审计）
    this.config.eventBus.emit({
      type: 'tool.pre_use',
      level: 'INFO',
      brain,
      threadId,
      payload: { toolName, toolInput }
    })
    
    // Amygdala 三段决策
    const decision = await this.config.amygdala.check(toolName, toolInput)
    
    if (decision.block) {
      // 写 Signal（审计用，ThreadRunner 可感知）
      await this.config.workspace.pushSignal(threadId, {
        type: 'amygdala_interrupt',
        toolName,
        reason: decision.reason,
        timestamp: new Date().toISOString()
      })
      
      // 发出 COMPLIANCE 级别事件
      this.config.eventBus.emit({
        type: 'tool.blocked',
        level: 'COMPLIANCE',
        brain,
        threadId,
        payload: { toolName, reason: decision.reason }
      })
      
      return {
        permissionDecision: 'deny' as const,
        denyMessage: `[AMYGDALA] Tool "${toolName}" blocked: ${decision.reason}`
      }
    }
    
    return { permissionDecision: 'allow' as const }
  }
}
```

---

### T035 — PostToolUse hook — 桥接工具执行后事件

```typescript
private buildPostToolUseHook(brain: string, threadId: string) {
  return async (event: PostToolUseEvent) => {
    this.config.eventBus.emit({
      type: 'tool.post_use',
      level: 'INFO',
      brain,
      threadId,
      payload: {
        toolName: event.toolName,
        toolOutput: event.toolOutput
      }
    })
  }
}
```

---

### T036 — PreCompact hook — 写入 episodic session anchor 记忆

当 Claude SDK 触发 context compaction（conversation 过长时），写入 episodic 记忆保存当前 session 锚点，便于后续 Hippocampus 回放：

```typescript
private buildPreCompactHook(brain: string, threadId: string) {
  return async (event: PreCompactEvent) => {
    // 写入 episodic anchor（记录 session 被压缩的时间点）
    await this.config.memoryService.write({
      id: crypto.randomUUID(),
      type: 'episodic',
      brain,
      threadId,
      content: `Session compacted. Brain: ${brain}, Thread: ${threadId}. Summary: ${event.summary ?? 'N/A'}`,
      base_importance: 0.3,
      created_at: new Date().toISOString(),
      tags: ['session_anchor', 'compaction'],
    })
    
    this.config.eventBus.emit({
      type: 'session.compacted',
      level: 'DEBUG',
      brain,
      threadId,
      payload: { summary: event.summary }
    })
  }
}
```

---

### T037 — spawn_execution_session MCP 工具（Brainstem 专用）

这个 MCP 工具供 Brainstem 调用，用于在子 session 中执行高强度推理任务（Brainstem 双层执行模型）。

**工具定义**（在 T031 的 McpServer 中注册）：

```typescript
// spawn_execution_session
// input: { task_description: string, model?: string }
// output: { execution_session_id: string, result: string }

// 实现：
async function spawnExecutionSession({ task_description, model = 'claude-sonnet-4-6' }) {
  // 在独立的 query() 调用中执行任务
  const result = await query({
    prompt: task_description,
    options: {
      model,
      apiKey: process.env.ANTHROPIC_API_KEY,
      // 不 resume，总是新 session（子执行 session 不续接）
    }
  })
  
  // 将 execution_session_id 存到 Brainstem Slot 的扩展字段
  // （实际通过 workspace_write_slot 工具存储）
  return {
    execution_session_id: result.sessionId,
    result: result.result
  }
}
```

**架构说明**：这对应文档中的"Brainstem 双层执行"——主 session（Brainstem 本身，Haiku 协调）发现需要深度推理时，通过此工具 spawn 一个独立的子执行 session（Sonnet/Opus），子 session 完成后结果写回主 session。

---

### T038 — inject(signal) + abort() — AbortController 实现

```typescript
async inject(signal: BrainSignal): Promise<void> {
  // DMN correction：当前 Claude SDK 不支持 inject 到运行中的 session
  // 记录 Signal 到 workspace，下次 run() 时通过 appendSystemPrompt 携带
  await this.config.workspace.pushSignal(signal.threadId, {
    type: 'dmn_correction',
    message: signal.message,
    timestamp: new Date().toISOString()
  })
}

async abort(brain: string, threadId: string): Promise<void> {
  const key = `${brain}:${threadId}`
  const ac = this.abortControllers.get(key)
  if (ac) {
    ac.abort()
    this.abortControllers.delete(key)
  }
  this.sessionIds.delete(key)
}
```

**注意**：Claude Agent SDK 可能不支持 AbortSignal（需确认版本 API）。如果不支持，abort() 只能清理内部状态，无法真正中断正在运行的 query() 调用。记录为已知限制。

## 验收标准

- [ ] `ClaudeAgentSDKAdapter` 实现 `BrainAdapter` 接口，TypeScript 无类型错误
- [ ] `resume` 正确传递：同一 Thread 第二次 `run()` 使用前次 `result.sessionId`
- [ ] `appendSystemPrompt` 每次 `run()` 都注入 Block 3/4（Block 1/2 不重复）
- [ ] `PreToolUse` hook 调用 `amygdala.check()`，BLOCK 时返回 `permissionDecision: 'deny'`
- [ ] MCP Server 工具 `workspace_read_slot` / `memory_search` 可被 Claude Agent 调用
- [ ] `spawn_execution_session` 返回 `{ execution_session_id, result }`
- [ ] `PreCompact` hook 写入 episodic 记忆（类型检查通过）

## 实现命令

```bash
spec-kitty implement WP06 --base WP03
```
