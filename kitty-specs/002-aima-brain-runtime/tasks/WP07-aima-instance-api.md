---
work_package_id: WP07
title: AIMAInstance + 公共 API 导出
lane: planned
dependencies: []
subtasks: [T039, T040, T041, T042, T043, T044]
history:
- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
---

# WP07 — AIMAInstance + 公共 API 导出

## 目标

实现顶层认知个体入口 `AIMAInstance`，组装 Feature 002 全部组件，并更新 `src/index.ts` 公共导出，保持 Feature 001 导出不破坏。

## 上下文

- 依赖 WP04：ThreadRunner（路由、崩溃恢复）
- 依赖 WP05：PiCodingAgentAdapter
- 依赖 WP06：ClaudeAgentSDKAdapter、McpServer
- 依赖 WP01/02/03：BrainAdapter、assembleContext、Amygdala
- 修改文件：`src/index.ts`（追加导出）
- 新建文件：`src/instance.ts`

## 实现指导

### T039 — AIMAInstanceConfig 类型

**文件**：`src/instance.ts`（新建）

```typescript
import type { BrainAdapter } from './adapters/index'
import type { ContextAssemblerConfig } from './context/index'

export type AdapterType = 'pi-agent' | 'claude-sdk'

export interface AIMAInstanceConfig {
  // LLM 接入
  apiKey?: string              // 如果未设置，从 process.env.ANTHROPIC_API_KEY 读
  adapter: AdapterType         // 选择适配器实现

  // 数据层
  databaseUrl: string          // PostgreSQL 连接字符串

  // 身份（用于 Block 1/2）
  identityDir?: string         // 包含 identity.md 等文件的目录，可选
  timezone?: string            // 默认 'UTC'

  // 脑区配置（可选，有合理默认值）
  brainModels?: {
    limbic?: string            // 默认 'claude-sonnet-4-6'
    cortex?: string            // 默认 'claude-sonnet-4-6'
    brainstem?: string         // 默认 'claude-haiku-4-5-20251001'
    amygdala?: string          // 默认 'claude-haiku-4-5-20251001'（Haiku 降级用）
    dmn?: string               // 默认 'claude-haiku-4-5-20251001'
  }

  // MCP（Claude SDK 模式下用）
  mcpServerPath?: string       // 默认 src/mcp/index.ts 绝对路径
}
```

---

### T040 — AIMAInstance 构造 — 初始化所有组件

```typescript
import { createCognitiveWorkspace, CognitiveWorkspace } from './workspace/index'
import { getEventBus, BrainEventBus } from './eventbus/index'
import { Amygdala } from './amygdala/index'
import { assembleBlock12 } from './context/index'
import { ThreadRunner } from './runner/index'
import { PiCodingAgentAdapter } from './adapters/pi-agent/index'
import { ClaudeAgentSDKAdapter } from './adapters/claude-sdk/index'

export class AIMAInstance {
  private workspace: CognitiveWorkspace
  private eventBus: BrainEventBus
  private amygdala: Amygdala
  private threadRunner: ThreadRunner
  private block12Cache: string   // Block 1/2 静态前缀，构造时生成
  private config: AIMAInstanceConfig

  constructor(config: AIMAInstanceConfig) {
    this.config = config
    
    // 进程级单例 EventBus
    this.eventBus = getEventBus()
    
    // Workspace（连接 PostgreSQL）
    this.workspace = createCognitiveWorkspace({ databaseUrl: config.databaseUrl })
    
    // Amygdala（默认规则，可通过 config 覆盖）
    this.amygdala = new Amygdala({
      eventBus: this.eventBus,
      workspace: this.workspace,
      model: config.brainModels?.amygdala ?? 'claude-haiku-4-5-20251001',
      getApiKey: () => config.apiKey ?? process.env.ANTHROPIC_API_KEY
    })
    
    // Block 1/2 静态前缀（构造时生成一次，保证 prompt cache）
    const assemblerConfig = this.buildAssemblerConfig()
    this.block12Cache = assembleBlock12(assemblerConfig)
    
    // 构建 Adapter（根据 config.adapter 选择）
    const adapters = this.buildAdapters(assemblerConfig)
    
    // ThreadRunner
    this.threadRunner = new ThreadRunner({
      workspace: this.workspace,
      eventBus: this.eventBus,
      adapters,
      assemblerConfig,
      block12: this.block12Cache
    })
  }

  private buildAssemblerConfig(): ContextAssemblerConfig {
    return {
      identityDir: this.config.identityDir,
      timezone: this.config.timezone ?? 'UTC',
      // 其他配置...
    }
  }

  private buildAdapters(assemblerConfig: ContextAssemblerConfig): Record<string, BrainAdapter> {
    const shared = {
      workspace: this.workspace,
      eventBus: this.eventBus,
      amygdala: this.amygdala,
      assemblerConfig,
      getApiKey: () => this.config.apiKey ?? process.env.ANTHROPIC_API_KEY
    }

    if (this.config.adapter === 'pi-agent') {
      const adapter = new PiCodingAgentAdapter({
        ...shared,
        model: this.config.brainModels?.limbic ?? 'claude-sonnet-4-6',
        memoryService: this.workspace.getMemoryService()
      })
      // 所有脑区共用同一个 PiAdapter 实例（它内部按 key 区分 Agent）
      return {
        limbic: adapter,
        cortex: adapter,
        brainstem: adapter,
        dmn: adapter
      }
    }

    if (this.config.adapter === 'claude-sdk') {
      const adapter = new ClaudeAgentSDKAdapter({
        ...shared,
        model: this.config.brainModels?.limbic ?? 'claude-sonnet-4-6',
        memoryService: this.workspace.getMemoryService(),
        mcpServerPath: this.config.mcpServerPath ?? new URL('./mcp/index.ts', import.meta.url).pathname,
        databaseUrl: this.config.databaseUrl
      })
      return {
        limbic: adapter,
        cortex: adapter,
        brainstem: adapter,
        dmn: adapter
      }
    }

    throw new Error(`Unknown adapter type: ${this.config.adapter}`)
  }
}
```

**注意**：当前所有脑区共用同一个 Adapter 实例（Adapter 内部按 `brain:threadId` key 区分 session）。未来可为不同脑区配置不同模型（通过 key 路由到不同 model 参数）。

---

### T041 — AIMAInstance.receive(input) — 顶层输入入口

```typescript
async receive(input: {
  content: string
  channel?: string          // 来源通道，如 'teams' / 'email' / 'webhook'
  externalId?: string       // 通道侧的消息 ID
  threadId?: string         // 如果续接已有 Thread，传入 threadId；否则创建新 Thread
}): Promise<{ threadId: string }> {
  
  // 1. 创建或续接 Thread
  let threadId = input.threadId
  if (!threadId) {
    threadId = await this.workspace.createThread({
      source_channel: input.channel,
      source_external_id: input.externalId,
      status: 'active'
    })
  }
  
  // 2. 写入 input Slot（Limbic 将读取此 Slot 作为输入）
  await this.workspace.writeSlot({
    thread_id: threadId,
    brain: 'input',      // 特殊脑区标识，表示外部输入
    status: 'done',
    output: {
      content: input.content,
      channel: input.channel,
      external_id: input.externalId
    }
  })
  
  // 3. 激活 Limbic（ThreadRunner 监听 workspace 变化，但 receive() 直接触发）
  await this.threadRunner.activateBrain('limbic', threadId)
  
  // 4. 等待 Thread 完成
  await this.workspace.waitForComplete(threadId)
  
  return { threadId }
}
```

**关于直接调用 vs 事件驱动**：`receive()` 直接调用 `activateBrain('limbic')` 而不是等待事件，因为外部输入是线程启动的触发点，不是脑区间路由的结果。ThreadRunner 的路由监听负责后续的脑区间路由。

---

### T042 — AIMAInstance.start() / stop() — ThreadRunner 生命周期

```typescript
async start(): Promise<void> {
  // ThreadRunner 订阅 workspace 变化，执行崩溃恢复
  await this.threadRunner.start()
}

async stop(): Promise<void> {
  await this.threadRunner.stop()
  await this.workspace.close()
}
```

**崩溃恢复发生在 start()** — ThreadRunner.start() 扫描 status='active' 的 Thread，找到未完成的脑区，重新激活。

---

### T043 — createAIMAInstance(config) 工厂函数

```typescript
export async function createAIMAInstance(config: AIMAInstanceConfig): Promise<AIMAInstance> {
  const instance = new AIMAInstance(config)
  await instance.start()   // 订阅 workspace 变化 + 崩溃恢复
  return instance
}
```

工厂函数：构造 + 启动一步完成，是推荐的使用方式。

---

### T044 — src/index.ts 更新 — 导出新类型和类

**文件**：`src/index.ts`（已有 Feature 001 导出，追加以下内容）

在 Feature 001 导出末尾追加（不删除任何现有导出）：

```typescript
// ============ Feature 002: AIMA Brain Runtime ============

// Core interfaces & types
export type { BrainAdapter, BrainRunParams, BrainRunResult, BrainSignal } from './adapters/index'
export type { BrainEvent, EventLevel, EventType } from './eventbus/index'
export type { AmygdalaConfig, ToolRiskLevel, AmygdalaDecision } from './amygdala/index'
export type { ContextAssemblerConfig, AssembledContext, BrainIdentity } from './context/index'
export type { ThreadRunnerConfig } from './runner/index'

// Runtime classes
export { BrainEventBus, getEventBus } from './eventbus/index'
export { Amygdala } from './amygdala/index'
export { ThreadRunner } from './runner/index'

// Adapters
export { PiCodingAgentAdapter } from './adapters/pi-agent/index'
export type { PiCodingAgentAdapterConfig } from './adapters/pi-agent/index'
export { ClaudeAgentSDKAdapter } from './adapters/claude-sdk/index'
export type { ClaudeAgentSDKAdapterConfig } from './adapters/claude-sdk/index'

// Top-level instance
export { AIMAInstance, createAIMAInstance } from './instance'
export type { AIMAInstanceConfig } from './instance'

// Context assembler functions
export { assembleContext, assembleBlock12 } from './context/index'
```

**验证原则**：运行 `bun run build` 后，Feature 001 的现有导出不能消失（用 `grep -r "from '@aima/core'"` 检查现有代码是否有破坏）。

## 验收标准

- [ ] `AIMAInstance` 构造时生成 Block 1/2 缓存，不含动态内容
- [ ] `createAIMAInstance(config)` 返回已 start() 的实例
- [ ] `receive({ content })` 创建 Thread，写 input Slot，激活 Limbic，等待完成
- [ ] `stop()` 正确关闭 ThreadRunner 和 workspace 连接
- [ ] `src/index.ts` 所有 Feature 001 导出仍然存在（`bun run build` 成功）
- [ ] TypeScript strict 模式下无类型错误（`bun run typecheck`）

## 风险

- **all brains share one adapter**：当前设计所有脑区共用一个 Adapter 实例（不同模型通过 key 路由）。如需每个脑区独立模型参数，需要重构 buildAdapters()。记录为 TODO。
- **receive() 直接调用 activateBrain()**：绕过了 ThreadRunner 的事件监听机制。需确保 activateBrain() 幂等，不与 ThreadRunner 的路由冲突。

## 实现命令

```bash
spec-kitty implement WP07 --base WP06
```

注意：WP07 同时依赖 WP04/WP05/WP06，但 spec-kitty 只支持单个 --base。实现时请先确认 WP04、WP05 的分支均已合并到 WP06 分支（或从 main 拉取）。
