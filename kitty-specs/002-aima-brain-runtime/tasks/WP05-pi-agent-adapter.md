---
work_package_id: WP05
title: PiCodingAgentAdapter
lane: "doing"
dependencies: []
subtasks: [T025, T026, T027, T028, T029, T030]
agent: "claude"
shell_pid: "7815"
history:
- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
---

# WP05 — PiCodingAgentAdapter

## 目标

使用 `@mariozechner/pi-agent-core@0.57.1` + `@mariozechner/pi-ai@0.57.1` 实现 BrainAdapter 接口，桥接 AIMA 的 Context Assembly、EventBus 事件和 Amygdala 信号到 pi-coding-agent 的 Agent 对象。

## 上下文

- 依赖 WP01：BrainAdapter 接口、BrainRunParams/BrainRunResult、BrainSignal、BrainEventBus、CognitiveWorkspace.pushSignal
- 依赖 WP02：assembleContext()（返回 { systemPrompt, injectedMemoryIds }）
- 依赖 WP03：Amygdala.check()
- 新建文件：`src/adapters/pi-agent/index.ts`
- 不修改任何 WP01/WP02/WP03 文件，只新建这一个文件

## pi-agent-core 实际 API（已验证）

通过读 `node_modules/@mariozechner/pi-agent-core/dist/index.d.ts` 确认的接口：

```typescript
// 构造
import { Agent } from '@mariozechner/pi-agent-core'
const agent = new Agent(options: AgentOptions)

// AgentOptions
interface AgentOptions {
  model: string           // e.g. "claude-opus-4-5-20251101"
  apiKey?: string
  transformContext?: (context: Context) => Context   // inject system prompt here
  convertToLlm?: (messages: Message[]) => LlmMessage[]  // optional message transform
  // 其他字段见 d.ts
}

// 激活（第一轮）
await agent.prompt(userMessage: string): Promise<void>

// 续接（后续轮次）
await agent.continue(message?: string): Promise<void>

// 中断（steer = 注入导向消息）
agent.steer(message: string): void

// 跟进消息（等效续接前发消息）
agent.followUp(message: string): void

// 订阅事件
agent.subscribe((event: AgentEvent) => void)

// event.type 枚举
// 'tool_execution_start' | 'tool_execution_end' | 'agent_end' | 'message' | ...

// 中止
agent.abort(): void

// session 续接（如果支持）：通过 options 或特殊参数
// 注意：pi-agent-core 的 session 管理通过 Agent 实例持续存活实现
// 同一 Thread 内保留 Agent 实例即可续接（不需要 sessionId 字符串）
```

**关键注意**：pi-agent-core 的"session"不是字符串 ID，而是 Agent 对象实例本身。ThreadRunner 的 `brainSessions` Map 存储的是 Agent 实例，而不是 sessionId 字符串（与 Claude SDK Adapter 不同）。

`BrainRunResult.sessionId` 对 PiCodingAgentAdapter 返回 `threadId:brain` 作为逻辑标识，实际续接通过保留 Agent 实例实现。

## 实现指导

### T025 — 安装并验证 pi-agent-core API（spike test）

**文件**：`src/adapters/pi-agent/spike.ts`（临时，实现后可删）

**目的**：在写正式代码前，验证 transformContext hook 是否能正确注入 system prompt，以及 subscribe() 事件格式。

```typescript
// spike.ts（可选，用于本地验证）
import { Agent } from '@mariozechner/pi-agent-core'

const agent = new Agent({
  model: 'claude-haiku-4-5-20251001',
  apiKey: process.env.ANTHROPIC_API_KEY,
  transformContext: (ctx) => {
    // 确认 ctx 结构，找到注入 system prompt 的字段
    console.log('context keys:', Object.keys(ctx))
    return ctx
  }
})

agent.subscribe((event) => {
  console.log('event:', event.type, JSON.stringify(event).slice(0, 200))
})

await agent.prompt('Hello, say just "OK"')
```

实际 Context 结构需从 d.ts 或 spike 输出确认，正式代码依赖此结论。

**验收**：能打出事件类型和 context 结构，不报类型错误。

---

### T026 — PiCodingAgentAdapter 类结构 + 构造参数

**文件**：`src/adapters/pi-agent/index.ts`（新建）

```typescript
import { Agent } from '@mariozechner/pi-agent-core'
import type { BrainAdapter, BrainRunParams, BrainRunResult, BrainSignal } from '../index'
import type { BrainEventBus } from '../../eventbus/index'
import type { CognitiveWorkspace } from '../../workspace/index'
import type { Amygdala } from '../../amygdala/index'
import type { MemoryService } from '../../types/index'
import { assembleContext } from '../../context/index'

export interface PiCodingAgentAdapterConfig {
  model: string                           // e.g. "claude-opus-4-6"
  workspace: CognitiveWorkspace
  memoryService: MemoryService
  eventBus: BrainEventBus
  amygdala: Amygdala
  getApiKey: () => string | undefined     // lazy，允许从环境变量读
  assemblerConfig: ContextAssemblerConfig // 从 WP02 import
}

export class PiCodingAgentAdapter implements BrainAdapter {
  private config: PiCodingAgentAdapterConfig
  // key = `${brain}:${threadId}`，值是存活的 Agent 实例
  private agentInstances = new Map<string, Agent>()
  private abortControllers = new Map<string, AbortController>()

  constructor(config: PiCodingAgentAdapterConfig) {
    this.config = config
  }

  async run(params: BrainRunParams): Promise<BrainRunResult> { ... }
  async inject(signal: BrainSignal): Promise<void> { ... }
  async abort(brain: string, threadId: string): Promise<void> { ... }
}
```

字段说明：
- `agentInstances`：pi-agent-core 的 session 持久化通过保存 Agent 实例实现
- `abortControllers`：用于 abort() 实现，实际会调用 agent.abort()
- 接口完整实现 BrainAdapter（run/inject/abort）

---

### T027 — run() — 构造/复用 Agent，注入 Context，启动

**run() 完整实现思路**：

```typescript
async run(params: BrainRunParams): Promise<BrainRunResult> {
  const { brain, threadId, block12 } = params
  const key = `${brain}:${threadId}`
  
  // 1. 组装 Block 3/4（动态部分）
  const { systemPrompt, injectedMemoryIds } = await assembleContext(
    brain,
    this.config.workspace,
    threadId,
    this.config.assemblerConfig,
    block12     // 传入已缓存的 block12，跳过重新生成
  )
  
  // 2. 复用或新建 Agent 实例
  let agent = this.agentInstances.get(key)
  const isFirstRun = !agent
  
  if (!agent) {
    agent = new Agent({
      model: this.config.model,
      apiKey: this.config.getApiKey(),
      transformContext: (ctx) => {
        // 将 systemPrompt 注入 context
        // 具体字段名依 spike.ts 输出确定，通常是 ctx.system 或 ctx.systemPrompt
        return { ...ctx, system: systemPrompt }
      }
    })
    
    // 注册 EventBus 桥接（只注册一次）
    this.registerEventBridge(agent, brain, threadId)
    this.agentInstances.set(key, agent)
  }
  
  // 3. 首次激活：agent.prompt()；续接：agent.continue()
  if (isFirstRun) {
    // 第一个用户消息：从 workspace 读取最新 input Slot
    const inputSlot = await this.config.workspace.getLatestSlot(threadId, 'input')
    await agent.prompt(inputSlot?.output?.content ?? '')
  } else {
    await agent.continue()
  }
  
  // 4. 等待 agent_end 事件
  const result = await this.waitForCompletion(agent, brain, threadId)
  
  return {
    brain,
    threadId,
    sessionId: key,   // pi-agent 用逻辑 key，不是真实 sessionId
    injectedMemoryIds,
    ...result
  }
}
```

**waitForCompletion()** 等待 agent_end 事件，从最终 Slot 读取结果（或读 agent 的最后输出）：

```typescript
private waitForCompletion(agent: Agent, brain: string, threadId: string): Promise<Partial<BrainRunResult>> {
  return new Promise((resolve, reject) => {
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'agent_end') {
        unsubscribe()
        resolve({ /* extract slot result from workspace */ })
      }
    })
    // abort controller cleanup
  })
}
```

**注意**：BrainRunResult 的核心字段（outputSlot 等）实际来自 ThreadRunner 读 workspace，不是 adapter 返回。adapter 只需返回 `{ brain, threadId, sessionId, injectedMemoryIds }`，ThreadRunner 负责读 Slot。

---

### T028 — agent.subscribe() 桥接事件到 BrainEventBus

在 `registerEventBridge()` 内实现（run() 首次创建 Agent 后调用）：

```typescript
private registerEventBridge(agent: Agent, brain: string, threadId: string): void {
  agent.subscribe((event) => {
    const eb = this.config.eventBus
    
    if (event.type === 'tool_execution_start') {
      // 同步发出 tool.pre_use 事件（供 Amygdala 订阅）
      eb.emit({
        type: 'tool.pre_use',
        level: 'INFO',
        brain,
        threadId,
        payload: {
          toolName: event.toolName,        // 确认实际字段名
          toolInput: event.toolInput ?? {}
        }
      })
    }
    
    if (event.type === 'tool_execution_end') {
      eb.emit({
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
    
    if (event.type === 'agent_end') {
      eb.emit({
        type: 'brain.complete',
        level: 'INFO',
        brain,
        threadId,
        payload: {}
      })
    }
  })
}
```

**注意**：`tool.pre_use` 和 `tool_execution_start` 的实际字段名需根据 spike.ts 确认。

---

### T029 — Amygdala 信号注入（steer + abort）

**时序说明**：pi-agent-core 不支持真正的"执行前拦截"。Amygdala 订阅 `tool.pre_use` 事件（由 T028 的 EventBus 桥接触发），写入 `amygdala_interrupt` Signal 到 workspace。下次 Agent 轮次开始时，T030 的 inject() 负责读取 Signal 并调用 `agent.steer()`。

**在 run() 开始时检查待处理 Signal**：

```typescript
// 在 agent.prompt() / agent.continue() 之前
const signal = await this.config.workspace.popSignal(threadId, 'amygdala_interrupt')
if (signal) {
  // 如果上一轮有中断，通知 agent（下一轮会看到这个消息）
  agent.steer(`[AMYGDALA INTERRUPT] Tool "${signal.toolName}" was blocked: ${signal.reason}`)
}
```

这样保证：工具执行 → 触发 pre_use → Amygdala 写 Signal → 下次 run() 注入 steer 消息。

---

### T030 — inject(signal) + abort() 实现

```typescript
async inject(signal: BrainSignal): Promise<void> {
  // 找到对应 Thread 的 agent
  for (const [key, agent] of this.agentInstances) {
    if (key.includes(`:${signal.threadId}`)) {
      // dmn_correction 通过 followUp 注入
      agent.followUp(`[DMN CORRECTION] ${signal.message}`)
      break
    }
  }
}

async abort(brain: string, threadId: string): Promise<void> {
  const key = `${brain}:${threadId}`
  const agent = this.agentInstances.get(key)
  if (agent) {
    agent.abort()
    this.agentInstances.delete(key)
  }
}
```

## 验收标准

- [ ] `PiCodingAgentAdapter` 实现 `BrainAdapter` 接口，TypeScript 无类型错误
- [ ] `transformContext` 成功将 systemPrompt 注入 Agent context（可通过 spike test 验证）
- [ ] 同一 Thread 的第二次 `run()` 复用同一 Agent 实例（不重新 new Agent）
- [ ] `agent_end` 事件正确触发 `brain.complete` EventBus 事件
- [ ] `tool_execution_start` 事件触发 `tool.pre_use` EventBus 事件（Amygdala 可订阅）
- [ ] `abort()` 调用 `agent.abort()` 并清理实例 Map

## 风险

- **transformContext 字段名不确定**：spike test 运行后才能确认 ctx.system 是否正确，可能需要调整
- **waitForCompletion race condition**：agent_end 可能在 subscribe 之前触发（通过同步注册规避）
- **pi-agent-core session 不支持真正 resume**：目前方案是保留 Agent 实例，进程重启后 session 丢失（可接受，crash recovery 由 ThreadRunner 处理）

## 实现命令

```bash
spec-kitty implement WP05 --base WP03
```

## Activity Log

- 2026-03-10T13:13:22Z – claude – shell_pid=52619 – lane=doing – Started implementation via workflow command
- 2026-03-10T13:16:05Z – claude – shell_pid=52619 – lane=for_review – Ready for review: PiCodingAgentAdapter implemented using actual pi-agent-core API (setSystemPrompt, setModel, steer/followUp with UserMessage, EventBus bridge). 4 unit tests passing.
- 2026-03-10T13:49:32Z – claude – shell_pid=7815 – lane=doing – Started review via workflow command
