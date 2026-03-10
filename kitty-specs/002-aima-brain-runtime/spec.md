# Feature Specification: AIMA Brain Runtime

**Feature**: 002-aima-brain-runtime
**Status**: approved
**Mission**: software-dev
**Created**: 2026-03-10

---

## 概述

在 Feature 001 的认知工作空间数据层之上，构建完整的认知运行时层：BrainAdapter 接口（与 pi-coding-agent API 对齐）、双适配器实现（PiCodingAgentAdapter + ClaudeAgentSDKAdapter）、Brain Event Bus、Amygdala 守卫、Context Assembly、Thread Runner、顶层 AIMAInstance 入口、以及 MCP Server 工具集。

完成后，调用方通过 `await instance.receive(input)` 即可触发完整认知流水线并等待结果。

---

## 功能需求

### FR-01：BrainAdapter 接口（与 pi-coding-agent 对齐）

定义 `BrainAdapter` 接口，字段和方法命名与 pi-coding-agent 的 Agent 接口对齐，同时包含 AIMA 额外接口：

- `run(params: BrainRunParams): Promise<BrainRunResult>`
- `inject(signal: BrainSignal): Promise<void>`
- `abort(): void`

`BrainRunParams`：`brain`, `threadId`, `systemPrompt`, `initialPrompt?`
`BrainRunResult`：`sessionId`, `output`, `stopReason`, `injectedMemoryIds`

### FR-02：PiCodingAgentAdapter

实现 `BrainAdapter`，底层使用 `@mariozechner/pi-agent-core`（过渡期）：

- 每脑区独立 Agent 实例，模型选择：Limbic=Sonnet, Cortex=Opus, Brainstem=Haiku
- `transformContext` hook：每轮调用 ContextAssembler 更新 Block 3/4
- `getSteeringMessages` hook：检查工作空间 Signals（Amygdala 中断 / DMN 纠错）
- `getFollowUpMessages` hook：Loop 结束后检查后续任务
- `agent.subscribe()` 把工具事件桥接到 Brain Event Bus
- Session key：`brain:threadId`，同 Thread 内多次激活共享 session

已知限制（文档化）：getSteeringMessages 在工具调用之间触发，非执行前同步拦截。

### FR-03：ClaudeAgentSDKAdapter

实现 `BrainAdapter`，底层使用 `@anthropic-ai/claude-agent-sdk`：

- `query()` 发起激活，`options.resume: sessionId` 续接 session
- `options.appendSystemPrompt` 注入 Block 3/4
- `PreToolUse` hook：真正执行前同步 Amygdala 拦截（`permissionDecision: 'deny'`）
- `PostToolUse` hook：桥接工具执行后事件到 Brain Event Bus
- `PreCompact` hook：压缩前写入 episodic session anchor 记忆
- 工具通过 MCP server 注册（`options.mcpServers`）

### FR-04：Brain Event Bus

结构化事件总线（进程级单例）：

- `emit(params)` — 自动补全 event_id / occurred_at / schema_version
- `subscribe(handler)` — 全量订阅，返回取消订阅函数
- `subscribeLevel(minLevel, handler)` — 按级别订阅（TRACE/DEBUG/INFO/COMPLIANCE/ALERT）
- `subscribeBrain(brain, handler)` — 按脑区订阅
- 事件字段：event_id, event_type, level, occurred_at, brain, thread_id, session_id, causation_id, schema_version, payload

### FR-05：Amygdala（工具守卫）

- 订阅 Event Bus 的 tool.pre_use 事件
- 三段决策：静态规则 → implicit 记忆匹配 → Haiku 降级评估
- 风险分级：low（仅静态规则）/ medium（+记忆匹配）/ high（完整评估）
- 违规时向工作空间写入 amygdala_interrupt Signal
- 默认权限：bash/file_write/file_delete/file_read → BLOCK；memory_*/workspace_* → ALLOW
- ClaudeAgentSDKAdapter 下通过 PreToolUse hook 同步拦截；PiCodingAgentAdapter 下退化为静态配置

### FR-06：Context Assembly（Block 1-4）

- Block 1（身份）：脑区角色定义，静态，走 prompt cache 前缀
- Block 2（Skill Index）：Skill 索引，静态，走 prompt cache 前缀
- Block 3（状态）：工作空间状态 + 当前时间，动态，每轮刷新
- Block 4（记忆）：脑区专属检索，动态
  - Limbic → searchMemory(semantic/episodic by entityId)
  - Cortex → searchMemory(procedural/episodic)
  - Brainstem → searchMemory(procedural by taskType)
  - 兜底 → searchMemory({})
- Block 1/2 内禁止任何动态内容（保证 cache 命中）
- 返回：`{ systemPrompt: string, injectedMemoryIds: string[] }`

### FR-07：Thread Runner

- `start()` — 启动事件循环，执行崩溃恢复
- `stop()` — 停止事件循环
- 路由规则（监听 Slot 写入）：
  - Limbic RESPOND/NO_REPLY → Thread complete
  - Limbic ROUTE → 激活 Cortex
  - Limbic EXECUTE → 直接激活 Brainstem（跳过 Cortex）
  - Cortex intent=communicate → 激活 Limbic
  - Cortex intent=execute → 激活 Brainstem
  - Cortex intent=both → 先激活 Limbic（试探），再激活 Brainstem，Brainstem done 再激活 Limbic（确认）
- `routePending()` — 检查 pending_observations，创建 Thread + 激活目标脑区
- 崩溃恢复：加载未完成 Thread → 找最后完成的 Slot → 重新激活下一脑区
- 并发：Thread 间并行，Thread 内顺序

### FR-08：AIMAInstance

- 构造时初始化所有组件（Workspace + MemoryService + EventBus + Amygdala + 适配器 + ThreadRunner）
- `receive(input)` — 创建 Thread，激活 Limbic，等待 Thread 完成，返回 Thread
- `start()` / `stop()` — Thread Runner 生命周期
- 适配器选择：`adapter: 'pi-agent' | 'claude-sdk'`，默认 `'claude-sdk'`

### FR-09：MCP Server（AIMA 工具集）

工具列表：
- `workspace_read_slot(thread_id, brain)`
- `workspace_write_slot(thread_id, output, intent?)`
- `memory_search(query, types?)`
- `memory_entity_context(entity_id, depth?, types?, limit?)`
- `memory_similar_situations(situation, limit?)`
- `memory_procedure(task_type, limit?)`
- `spawn_execution_session(task, model?, tools?)` — Brainstem 子执行（ClaudeSDK adapter 下实现，PiAgent 下 stub）

---

## 关键实体

| 实体 | 路径 | 说明 |
|---|---|---|
| BrainAdapter | src/adapters/index.ts | 接口定义（与 pi-coding-agent 对齐） |
| PiCodingAgentAdapter | src/adapters/pi-agent/index.ts | pi-agent-core 实现 |
| ClaudeAgentSDKAdapter | src/adapters/claude-sdk/index.ts | Claude Agent SDK 实现 |
| BrainEventBus | src/eventbus/index.ts | 结构化事件总线 |
| Amygdala | src/amygdala/index.ts | 工具守卫 |
| ContextAssembler | src/context/index.ts | Block 1-4 组装器 |
| ThreadRunner | src/runner/index.ts | 框架层编排器 |
| AIMAInstance | src/instance.ts | 顶层入口 |
| McpServer | src/mcp/index.ts | AIMA 工具集 MCP server |

---

## 边界

**包含**：FR-01 ~ FR-09，单元测试（mock adapter），集成测试（真实 DB + mock LLM），E2E smoke test（可选，需 ANTHROPIC_API_KEY）

**不包含（后续 Feature）**：DMN Reactive、DMN 心跳整合、Hippocampus Consolidation、Skill 系统、@aima/crew

---

## 成功标准

1. `await instance.receive({ content: 'Hello', sourceChannel: 'test' })` 返回 `thread.state === 'complete'`，Limbic Slot 有 output
2. 复杂问题触发完整 Limbic→Cortex→Limbic 流水线，三个 Slot 均为 `done`
3. Brain Event Bus 捕获全流程 `tool.pre_use`、`brain.complete` 等事件
4. ClaudeAgentSDKAdapter 的 PreToolUse hook 能拦截 BLOCK 工具
5. `bun run typecheck` 零错误，`biome check` 零警告
6. 单元测试覆盖核心路由逻辑，集成测试覆盖 Thread 完整生命周期

---

## 依赖

- Feature 001（@aima/core workspace schema + CognitiveWorkspace DAO）✅ 已合并
- `@anthropic-ai/claude-agent-sdk` npm 包
- `@mariozechner/pi-agent-core`、`@mariozechner/pi-ai` npm 包
- PostgreSQL（集成测试用 AIMA_TEST_DATABASE_URL）
- ANTHROPIC_API_KEY（E2E 测试，选跑）
