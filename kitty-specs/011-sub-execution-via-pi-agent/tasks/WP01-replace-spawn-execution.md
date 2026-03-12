---
work_package_id: WP01
title: Replace spawnSubExecution with pi-coding-agent session
lane: "doing"
dependencies: []
subtasks:
- T001
- T002
- T003
phase: Phase 1 - Implementation
assignee: ''
agent: "claude-sonnet-4-6"
shell_pid: "47492"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-12T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated
---

# Work Package Prompt: WP01 — Replace spawnSubExecution with pi-coding-agent session

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

替换 `AIMAInstance.spawnSubExecution()` 内部实现：删除原生 `@anthropic-ai/sdk messages.create()` 路径，改用 pi-coding-agent session，使子执行 session 获得 Amygdala 工具拦截 + 完整工具访问 + EventBus 审计链。

**Success Criteria**:
- `instance.ts` 不再 import `Anthropic` from `@anthropic-ai/sdk`
- 子执行工具调用前 `amygdala.check()` 被调用（EventBus `tool.pre_use` 有事件）
- 被 Amygdala 拦截的工具触发 `tool.blocked` 事件（不实际执行）
- `result` 字段返回 pi-coding-agent session 的最后一条 assistant 文本
- `bun run typecheck` 零错误，`biome check` 通过
- 现有 388 测试全部通过（零 regression）

---

## Context

**Repository**: `/Volumes/leoyun/aima/`
**Implementation command**: `spec-kitty implement WP01`

**当前问题代码**（`src/instance.ts:329-337`）：
```typescript
const apiKey = this._config.apiKey ?? process.env.ANTHROPIC_API_KEY
const client = new Anthropic({ ...(apiKey !== undefined ? { apiKey } : {}) })
const response = await client.messages.create({
  model: resolvedModel,
  max_tokens: 8192,
  messages: [{ role: 'user', content: params.taskDescription }],
})
const textBlock = response.content.find((b) => b.type === 'text')
result = textBlock?.type === 'text' ? textBlock.text : ''
```

**问题**：无工具、无 Amygdala、无 EventBus tool 事件、无系统提示。

**目标状态**：使用 pi-coding-agent session，与主脑区 session 使用同样的工具拦截 + 事件基础设施。

**关键类型**（已验证）：

`AgentEndEvent.messages: AgentMessage[]` → `AgentMessage = Message | CustomAgentMessages[...]` → `AssistantMessage.content: (TextContent | ThinkingContent | ToolCall)[]` → `TextContent.type === 'text'`，`TextContent.text: string`

`session.messages` getter 在 `session.prompt()` 完成后返回完整对话历史。

---

## Subtask Guidance

### T001: 新增 `runSubExecutionViaPiAgent()` 方法

**文件**: `src/instance.ts`（在 `spawnSubExecution()` 之后添加新私有方法）

**新导入**（文件顶部，替换 `import Anthropic from '@anthropic-ai/sdk'`）：
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

**注意**：先读 `src/instance.ts` 确认当前 import 列表，找到 `import Anthropic from '@anthropic-ai/sdk'` 的位置，替换为上面的新 imports。

**修改 `spawnSubExecution()`**（只改 else 分支）：

将现有 else 分支：
```typescript
} else {
  const apiKey = this._config.apiKey ?? process.env.ANTHROPIC_API_KEY
  const client = new Anthropic({ ...(apiKey !== undefined ? { apiKey } : {}) })
  const response = await client.messages.create({
    model: resolvedModel,
    max_tokens: 8192,
    messages: [{ role: 'user', content: params.taskDescription }],
  })
  const textBlock = response.content.find((b) => b.type === 'text')
  result = textBlock?.type === 'text' ? textBlock.text : ''
}
```

替换为：
```typescript
} else {
  result = await this.runSubExecutionViaPiAgent(
    params.taskDescription,
    resolvedModel,
    executionSessionId,
  )
}
```

**新增方法** `runSubExecutionViaPiAgent()`（在 `spawnSubExecution()` 之后添加）：

```typescript
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

  // Wire Amygdala + EventBus — same infrastructure as main brain sessions
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

  // Extract last assistant text from completed session messages
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

**验证导入**：运行 `bun run typecheck`，确认无 TypeScript 错误。特别注意 `getModel` 第二参数的类型 cast。

---

### T002: 更新 JSDoc

**文件**: `src/instance.ts`

更新 `AIMAInstanceConfig._subQueryFn` 的 JSDoc：

```typescript
/**
 * @internal Testing escape hatch: override the sub-execution LLM query.
 * When provided, bypasses pi-coding-agent session creation entirely.
 * Use this in unit tests to avoid real API calls and session setup.
 * Signature matches SpawnExecutionSessionFn's inner logic.
 */
_subQueryFn?: (prompt: string, model: string) => Promise<string>
```

同时更新 `spawnSubExecution()` 的 JSDoc，说明现在使用 pi-coding-agent session：
```typescript
/**
 * Spawn an independent sub-execution session via pi-coding-agent.
 * Uses Amygdala tool interception and EventBus tool events.
 * Used as the SpawnExecutionSessionFn injected into createAimaMcpServer().
 */
```

---

### T003: 测试（≥4 个）

**文件**: 查找现有 `tests/unit/aima-instance.test.ts`（或 `tests/integration/`），在其中新增测试，或新建 `tests/unit/spawn-execution.test.ts`。

**Mock 策略**：
- 使用 `_subQueryFn` escape hatch（**不需要**真实 API）
- Mock workspace: `getThread`, `waitForComplete`, `createThread`
- 验证 amygdala + eventBus 行为需要通过 unit test spy

**测试场景**：

**测试 1**: `_subQueryFn` 被正确调用
```typescript
// 验证 spawnSubExecution 在有 _subQueryFn 时走 escape hatch 路径
const queryFn = mock(() => Promise.resolve('test result'))
const instance = new AIMAInstance({
  ...,
  _subQueryFn: queryFn,
})
// 通过某种方式调用 spawnSubExecution（可以用 as any 访问私有方法测试）
const result = await (instance as any).spawnSubExecution({
  taskDescription: 'do something',
})
expect(queryFn).toHaveBeenCalledWith('do something', expect.any(String))
expect(result.result).toBe('test result')
```

**测试 2**: `brain.activate` 和 `brain.complete` 事件正确 emit
```typescript
const emittedEvents: unknown[] = []
eventBus.subscribe('INFO', (e) => emittedEvents.push(e))

await (instance as any).spawnSubExecution({ taskDescription: 'task' })

expect(emittedEvents).toContainEqual(
  expect.objectContaining({ event_type: 'brain.activate', payload: { isSubExecution: true } })
)
expect(emittedEvents).toContainEqual(
  expect.objectContaining({ event_type: 'brain.complete', payload: expect.objectContaining({ isSubExecution: true }) })
)
```

**测试 3**: 返回值包含 `executionSessionId` 和 `result`
```typescript
const result = await (instance as any).spawnSubExecution({
  taskDescription: 'task',
  model: 'claude-haiku-4-5-20251001',
})
expect(result.executionSessionId).toMatch(/^[0-9a-f-]{36}$/)
expect(typeof result.result).toBe('string')
```

**测试 4**: `executionModel` 配置生效（model 参数传给 queryFn）
```typescript
const queryFn = mock(() => Promise.resolve('ok'))
const instance = new AIMAInstance({
  ...,
  executionModel: 'claude-opus-4-6',
  _subQueryFn: queryFn,
})
await (instance as any).spawnSubExecution({ taskDescription: 'task' })
expect(queryFn).toHaveBeenCalledWith('task', 'claude-opus-4-6')
```

**注意**：
- 参考 `tests/unit/aima-instance.test.ts` 中已有的 mock workspace 模式
- 这些测试都走 `_subQueryFn` 路径（不需要真实 pi-coding-agent）
- 真实 pi-coding-agent session 集成测试（需要真实 API key）可以作为 Optional 添加，参考 Feature 009 的集成测试

---

## Definition of Done

- [ ] T001: `runSubExecutionViaPiAgent()` 实现完整，`@anthropic-ai/sdk` import 已删除
- [ ] T002: JSDoc 更新完毕
- [ ] T003: ≥4 单元测试全绿
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] 现有 388 测试零 regression

---

## Risks & Notes

- **`getModel` 类型 cast**：`modelId as Parameters<typeof getModel>[1]` 是 Feature 003 确立的模式，直接复用。
- **session.messages 类型**：`AgentMessage = Message | CustomAgentMessages[...]`，使用 `'role' in msg` 类型守卫过滤自定义消息类型。
- **`@anthropic-ai/sdk` 仍在 package.json 中**：即使从 `instance.ts` 删除，`@anthropic-ai/sdk` 可能仍被其他文件使用（如 `spawnSubExecution` 旧实现的 test 文件）。删除 import 后确认 `bun run typecheck` 通过即可，不需要从 `package.json` 移除依赖。
- **`_subQueryFn` 不要改签名**：已有集成测试依赖这个 escape hatch，保持 `(prompt: string, model: string) => Promise<string>` 不变。

---

## Reviewer Guidance

**Review focus**:
1. `@anthropic-ai/sdk` 的 `Anthropic` import 是否完全删除（无残留）
2. `runSubExecutionViaPiAgent()` 中 `createAimaExtension()` 参数是否正确（brain='brainstem', threadId=executionSessionId）
3. `session.messages` 遍历是否正确处理 `AgentMessage` 联合类型（`'role' in msg` 守卫）
4. 测试是否覆盖 EventBus 事件（brain.activate + brain.complete）
5. 现有 spawn-related 集成测试是否仍通过

## Activity Log

- 2026-03-12T00:05:23Z – claude-sonnet-4-6 – shell_pid=42204 – lane=doing – Started implementation via workflow command
- 2026-03-12T00:08:09Z – claude-sonnet-4-6 – shell_pid=42204 – lane=for_review – Ready for review: replaced spawnSubExecution with pi-coding-agent session; @anthropic-ai/sdk Anthropic import removed; runSubExecutionViaPiAgent() added with Amygdala + EventBus wired; 5 unit tests green; typecheck + biome clean; 399 pass 0 fail
- 2026-03-12T00:09:53Z – claude-sonnet-4-6 – shell_pid=47492 – lane=doing – Started review via workflow command
