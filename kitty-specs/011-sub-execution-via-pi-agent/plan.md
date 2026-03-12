# Implementation Plan: Feature 011 — Sub-Execution via Pi-Agent

## Architecture Decision

**AD-01: 直接建 session，不走 PiCodingAgentAdapter**

`PiCodingAgentAdapter` 设计用于线程持久化（sessions Map + 多轮激活）。Sub-execution 是单次一次性执行，不需要 session 缓存。直接调用 `createAgentSession()` + `session.prompt()` 更简洁，逻辑更清晰。

**AD-02: 使用 executionSessionId 作为 threadId 传入 createAimaExtension**

Extension 需要 `brain` + `threadId` 来生成 EventBus 事件。Sub-execution 没有真正的 Thread（不创建 DB Thread），用 `executionSessionId`（UUID）作为虚拟 threadId 传入。EventBus 事件中 `session_id = executionSessionId`，与现有 `brain.activate/complete` 事件一致。

**AD-03: 结果提取来自 session.messages**

`session.prompt()` 返回 `void`。执行完毕后，`session.messages` 包含完整对话历史（`AgentMessage[]`）。从末尾倒序找最后一条 `role === 'assistant'` 的消息，提取 `content` 中第一个 `type === 'text'` 的 TextContent。

**AD-04: 最小化系统提示**

Sub-execution session 不使用 `assembleContext()`（开销大、需要完整 Thread 数据）。改用单行硬编码系统提示：`"You are a sub-execution agent. Complete the task provided and report your findings concisely."`

**AD-05: 保留 _subQueryFn escape hatch**

`_subQueryFn` 是单元测试专用，避免真实 API 调用。Feature 011 保留，不动。

---

## 文件变更

```
src/
└── instance.ts          ← 主修改：新增 runSubExecutionViaPiAgent()，替换 messages.create() 路径
```

只改一个文件。

---

## 导入变更

**删除**（`instance.ts`）：
```typescript
import Anthropic from '@anthropic-ai/sdk'
```

**新增**（`instance.ts`）：
```typescript
import { getModel } from '@mariozechner/pi-ai'
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from '@mariozechner/pi-coding-agent'
import { createAimaExtension } from './adapters/pi-coding-agent/extension'
import { buildMcpTools } from './adapters/pi-coding-agent/mcp-tools'
```

---

## 核心实现（instance.ts）

```typescript
private async spawnSubExecution(params: {
  taskDescription: string
  model?: string
}): Promise<{ executionSessionId: string; result: string }> {
  const executionSessionId = randomUUID()
  const resolvedModel = params.model ?? this._config.executionModel ?? 'claude-sonnet-4-6'

  this.eventBus.emit({
    event_type: 'brain.activate',
    level: 'INFO',
    brain: 'brainstem',
    session_id: executionSessionId,
    payload: { isSubExecution: true },
  })

  let result: string
  if (this._config._subQueryFn) {
    result = await this._config._subQueryFn(params.taskDescription, resolvedModel)
  } else {
    result = await this.runSubExecutionViaPiAgent(
      params.taskDescription,
      resolvedModel,
      executionSessionId,
    )
  }

  this.eventBus.emit({
    event_type: 'brain.complete',
    level: 'INFO',
    brain: 'brainstem',
    session_id: executionSessionId,
    payload: { isSubExecution: true, executionSessionId },
  })

  return { executionSessionId, result }
}

private async runSubExecutionViaPiAgent(
  taskDescription: string,
  modelId: string,
  executionSessionId: string,
): Promise<string> {
  const authStorage = AuthStorage.inMemory()
  const apiKey = this._config.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (apiKey !== undefined) {
    authStorage.setRuntimeApiKey('anthropic', apiKey)
  }

  const modelRegistry = new ModelRegistry(authStorage)
  const model = getModel('anthropic', modelId as Parameters<typeof getModel>[1])

  // Wire Amygdala + EventBus (same as main brain sessions)
  const extensionFactory = createAimaExtension(
    'brainstem',
    executionSessionId,
    this.amygdala,
    this.eventBus,
    this.identityCache?.roles['brainstem']?.allowedTools,
  )

  const loader = new DefaultResourceLoader({
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () =>
      'You are a sub-execution agent. Complete the task provided and report your findings concisely.',
    extensionFactories: [extensionFactory],
  })
  await loader.reload()

  const mcpTools = buildMcpTools(this.workspace)
  const sessionManager = SessionManager.inMemory()

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager,
    resourceLoader: loader,
    customTools: mcpTools,
  })

  await session.prompt(taskDescription)

  // Extract last assistant text from completed session
  const messages = session.messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if ('role' in msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
      const textBlock = (msg.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === 'text',
      )
      if (textBlock?.text) return textBlock.text
    }
  }
  return ''
}
```

---

## 单 WP 计划

一个 WP，三个 task：

| Task | 内容 |
|---|---|
| T001 | 替换 `spawnSubExecution` 实现：删除 `@anthropic-ai/sdk` 导入，新增 pi-coding-agent 导入，新增 `runSubExecutionViaPiAgent()` 方法 |
| T002 | 更新 `AIMAInstanceConfig` JSDoc：`_subQueryFn` 签名说明更新（pi-agent 已替换 raw SDK，但 _subQueryFn 仍保留用于测试） |
| T003 | ≥4 测试：Amygdala 被调用、EventBus tool 事件、结果提取、blocked 工具场景 |
