---
work_package_id: WP02
title: AIMAInstance Sub-Execution Logic
lane: "for_review"
dependencies: ["WP01"]
subtasks:
- T005
- T006
- T007
- T008
phase: Phase 2 - Instance Layer
assignee: ''
agent: ''
shell_pid: ''
review_status: "approved"
reviewed_by: "XIAYANG ZHANG"
history:
- timestamp: '2026-03-11T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP02 – AIMAInstance Sub-Execution Logic

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

在 `AIMAInstance` 中实现子执行 session 的完整逻辑，包括独立 session 创建、executionModel 配置、EventBus 事件 emit、Amygdala 复用，并将实现注入 `createAimaMcpServer()`。

**Success Criteria**:
- `AIMAInstanceConfig` 有 `executionModel?: string`（默认 `'claude-sonnet-4-6'`）
- `spawnSubExecution()` 创建独立子执行 session（session key 不进入 ThreadRunner 命名空间）
- 子执行使用 `executionModel`（或 params.model 覆盖）
- EventBus 发出 `brain.activate` + `brain.complete` 事件，含 `isSubExecution: true`
- 子执行结束后 `executionSessionId` 是有效 UUID 格式
- 子执行不影响主 Brainstem session 历史（隔离验证）
- 新增 ≥4 测试全绿，`bun run typecheck` 零错误，`biome check` 通过

---

## Context

**Repository**: `/Volumes/leoyun/aima/`
**Implementation command**: `spec-kitty implement WP02 --base WP01`
**Depends on**: WP01 (需要 `SpawnExecutionSessionFn` 类型已定义)

**关键现有代码**（`src/instance.ts`）：

```typescript
// 构造函数中（第 85-88 行）
const amygdala = new Amygdala({}, this.workspace, this.eventBus)
const adapters = this.buildAdapters(config, amygdala)

// start() 方法（第 126-131 行）
async start(): Promise<void> {
  await this.threadRunner.start()
  // ... dmn, hippocampus
}
```

MCP server 目前在哪里创建？查看 `start()` 方法完整内容——如果 MCP server 还没有在 `start()` 中创建，需要添加。

**子执行 session 生命周期**：
```
1. 生成 UUID → executionSessionId
2. 确定 model（params.model → config.executionModel → 'claude-sonnet-4-6'）
3. 创建 adapter（若 executionModel 与 brainstem 不同，新建临时实例）
4. createAimaExtension() 创建 Extension（session key = sub-exec:{UUID}）
5. emit brain.activate（isSubExecution: true）
6. 运行 session（initialPrompt = taskDescription）
7. emit brain.complete（含 executionSessionId）
8. 返回 { executionSessionId, result }
```

**文件结构**：
```
src/
└── instance.ts    ← 唯一需要修改的文件
tests/
└── unit/
    └── aima-instance.test.ts    ← 新增/扩展测试
```

---

## Subtask Guidance

### T005: 新增 `executionModel` 配置字段

**文件**: `src/instance.ts`（`AIMAInstanceConfig` interface，第 24-51 行附近）

**添加字段**：

```typescript
export interface AIMAInstanceConfig {
  // ... existing fields ...

  /** Model to use for sub-execution sessions spawned by Brainstem.
   * Default: 'claude-sonnet-4-6'. Override with 'claude-opus-4-6' for deep reasoning.
   */
  executionModel?: string
}
```

**验证**：TypeScript 类型检查通过，无逻辑变更。

---

### T006: 实现 `spawnSubExecution()` 私有方法

**文件**: `src/instance.ts`（在 `buildAdapters` 之后新增）

**需要了解的现有 API**（实现前读源码）：

1. **`createAimaExtension()`** — 位于 `src/adapters/` 或 `src/instance.ts`。查找其签名：
   ```typescript
   // 可能的签名（需要确认）：
   createAimaExtension(adapter, amygdala, sessionKey, opts?)
   ```
   Extension 的 `run(initialPrompt)` 或类似方法用于启动 session。

2. **Adapter 构造**：复用 `this.adapters.get('brainstem')` 的 adapter 实例，或为不同 executionModel 新建临时实例。

3. **EventBus emit 格式**：参考现有 `activateBrain()` 中的 emit 调用（`src/runner/index.ts:186-193`）。

**方法实现草稿**：

```typescript
private async spawnSubExecution(params: {
  taskDescription: string
  model?: string
}): Promise<{ executionSessionId: string; result: string }> {
  const executionSessionId = crypto.randomUUID()

  // Determine model (params override → config default → global default)
  const model = params.model ?? this.config.executionModel ?? 'claude-sonnet-4-6'

  // Get brainstem adapter (or create temp adapter if model differs)
  const brainstemAdapter = this.adapters.get('brainstem')
  if (!brainstemAdapter) throw new Error('Brainstem adapter not initialized')

  // TODO: If model !== brainstem's model, create a temporary adapter instance
  // For now, use brainstem adapter (model override handled at session level if possible)
  // Check adapter API for per-session model override capability

  // Session key is outside ThreadRunner's namespace
  const sessionKey = `sub-exec:${executionSessionId}`

  this.eventBus.emit({
    event_type: 'brain.activate',
    level: 'INFO',
    brain: 'brainstem',
    thread_id: null,          // sub-execution has no Thread
    session_id: executionSessionId,
    payload: {
      brain: 'brainstem',
      sessionId: executionSessionId,
      isSubExecution: true,
    },
  })

  // Run the sub-execution session
  // TODO: Use the appropriate adapter/extension API to run with initialPrompt
  const result = await brainstemAdapter.runOnce({
    sessionKey,
    model,
    initialPrompt: params.taskDescription,
  })
  // OR: use createAimaExtension + run if runOnce doesn't exist

  this.eventBus.emit({
    event_type: 'brain.complete',
    level: 'INFO',
    brain: 'brainstem',
    thread_id: null,
    session_id: executionSessionId,
    payload: {
      brain: 'brainstem',
      sessionId: executionSessionId,
      executionSessionId,
      isSubExecution: true,
    },
  })

  return {
    executionSessionId,
    result: result.output ?? result.text ?? '',  // extract from adapter result
  }
}
```

> ⚠️ **关键决策点**：子执行需要运行一次性 session（不存入 ThreadRunner 的 `brainSessions` Map）。实现方式取决于 Adapter API：
> - 若 Adapter 有 `run({ sessionKey, initialPrompt, model })` 方法 → 直接调用，用独立 sessionKey
> - 若 Adapter 只有 `run(BrainRunParams)` → 使用不同 threadId（如 `sub-exec-{UUID}` 作为假 threadId）
> - 若需要 `pi-coding-agent` 的 Extension pattern → 使用 `createAimaExtension()` 并直接调用
>
> **实现前必读**：`src/adapters/pi-coding-agent/index.ts` 和 `src/adapters/index.ts`（BrainAdapter interface）

**子执行 adapter 选择**：
- 默认复用 `adapters.get('brainstem')` 的 adapter 实例
- 如果 `model !== brainstem 当前 model` 且 adapter 不支持 per-call model override：
  创建临时 adapter：`new PiCodingAgentAdapter({ ...shared, modelId: model, getApiKey: apiKeyFn })`
- 子执行结束后临时 adapter 被 GC，无需显式清理

**`this.config` 访问**：需要在 `AIMAInstance` 中存储 config：
```typescript
constructor(config: AIMAInstanceConfig) {
  // Add at top of constructor:
  this.config = config  // need to declare: private readonly config: AIMAInstanceConfig
  // ...
}
```

检查 `this.config` 是否已存在，否则需要新增 `private readonly config` 字段。

---

### T007: 修改 `start()` 传入 spawnExecutionSession

**文件**: `src/instance.ts`（`start()` 方法）

**找到 `createAimaMcpServer()` 的调用位置**（在 `start()` 方法中）：

> 如果 `createAimaMcpServer()` 不在 `start()` 中调用，需要查找其实际调用位置。如果根本没有调用，需要在 `start()` 中添加，并存储为实例变量（供 ThreadRunner 使用）。

**修改调用**：
```typescript
// 修改前
const mcpServer = createAimaMcpServer(this.workspace)

// 修改后
const mcpServer = createAimaMcpServer(
  this.workspace,
  { spawnExecutionSession: this.spawnSubExecution.bind(this) },
)
```

**注意**：`this.spawnSubExecution.bind(this)` 确保方法内部 `this` 正确绑定。

> ⚠️ 如果 `createAimaMcpServer` 不在现有代码中调用（即 MCP server 是由调用方独立创建的），则此步骤需要重新设计——可能 AIMAInstance 需要暴露 `spawnExecutionSession` 作为 public 方法，让调用方在创建 MCP server 时传入。查看现有代码确认集成方式。

**导入**：确认 `createAimaMcpServer` 和 `SpawnExecutionSessionFn` 已从 `'./mcp/index'` 导入。

---

### T008: 新增单元测试

**文件**: `tests/unit/aima-instance.test.ts`（新建或扩展）

**需要的测试（≥4 个）**：

**测试 1**: `executionSessionId` 是有效 UUID 格式
```typescript
// mock adapter.run() 返回结果
// 调用 spawnSubExecution({ taskDescription: 'test' })
// 验证返回的 executionSessionId 匹配 UUID regex
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
expect(result.executionSessionId).toMatch(uuidRegex)
```

**测试 2**: EventBus 收到 `brain.activate` 事件含 `isSubExecution: true`
```typescript
const events: unknown[] = []
eventBus.on('*', (event) => events.push(event))

await spawnSubExecution({ taskDescription: 'test' })

const activateEvent = events.find((e) => e.event_type === 'brain.activate')
expect(activateEvent?.payload?.isSubExecution).toBe(true)
expect(activateEvent?.brain).toBe('brainstem')
```

**测试 3**: EventBus 收到 `brain.complete` 事件含 `executionSessionId`
```typescript
const completeEvent = events.find((e) => e.event_type === 'brain.complete')
expect(completeEvent?.payload?.executionSessionId).toMatch(uuidRegex)
expect(completeEvent?.payload?.isSubExecution).toBe(true)
```

**测试 4**: model 优先级正确（params.model > executionModel > 默认）
```typescript
// 配置 executionModel: 'claude-sonnet-4-6'
// 调用时传 model: 'claude-opus-4-6'
// 验证 adapter 使用 'claude-opus-4-6'（params.model 优先）

// 配置无 executionModel
// 调用时不传 model
// 验证 adapter 使用 'claude-sonnet-4-6'（全局默认）
```

**Mock 策略**：
- Mock adapter 的 run 方法（避免真实 API 调用）
- 捕获 EventBus 事件（用 `eventBus.on`）
- Mock workspace（不需要真实数据库）

---

## Definition of Done

- [ ] T005: `AIMAInstanceConfig.executionModel?: string` 已添加，含 JSDoc
- [ ] T006: `spawnSubExecution()` 完整实现（UUID、model 选择、EventBus 事件、adapter 调用）
- [ ] T007: `start()` 中的 `createAimaMcpServer()` 调用传入 spawnSubExecution 回调
- [ ] T008: ≥4 新测试全绿，验证 UUID、EventBus 事件、model 优先级
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] 现有测试零 regression

---

## Risks & Notes

- **Adapter 的 session key 隔离**：子执行使用 `sub-exec:{UUID}` 作为 session key，不进入 `brainSessions` Map（ThreadRunner 私有）。确认 adapter 的 `run()` 调用不依赖 ThreadRunner 的 session 管理。
- **`this.config` 访问**：若 constructor 没有存储 `config`，需要新增 `private readonly config: AIMAInstanceConfig` 字段。
- **MCP server 集成点**：`createAimaMcpServer()` 可能由调用方（而非 `AIMAInstance.start()`）创建。若如此，`spawnSubExecution` 需要作为 public 方法暴露，让调用方在创建 MCP server 时注入。
- **thread_id 为 null**：子执行没有 Thread（独立 session），EventBus 事件的 `thread_id` 设为 null（确认 EventBus schema 允许 null）。

---

## Reviewer Guidance

**Review focus**:
1. `spawnSubExecution()` 的 session key 是否与 ThreadRunner 命名空间隔离
2. EventBus 事件是否含 `isSubExecution: true` 和 `executionSessionId`
3. model 优先级是否正确（params > config > default）
4. 如何确保子执行不污染主 Brainstem session 的对话历史
5. `createAimaMcpServer()` 是否正确注入了回调

## Activity Log

- 2026-03-11T13:12:21Z – unknown – lane=done – Review passed: buildBlock4Opts() correctly routes limbic/cortex to situation hint and brainstem to taskType (cortex output priority then trigger fallback). trigger() now fetches thread+slots before activation. assembleContext() opts param wired in both trigger() and route(). 7 new tests cover all brain paths and edge cases. 15 total tests pass, no regressions.
- 2026-03-11T14:07:46Z – unknown – lane=for_review – Implemented spawnSubExecution() with EventBus events, executionModel config, amygdala member, wired into claude-sdk adapter. 6 new unit tests green.
