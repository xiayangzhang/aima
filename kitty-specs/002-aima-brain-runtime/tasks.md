# Tasks: AIMA Brain Runtime (Feature 002)

## 工作包总览

| WP | 标题 | 子任务 | 依赖 | 优先级 |
|---|---|---|---|---|
| WP01 | BrainAdapter 接口 + BrainEventBus | T001-T006 | — | P0 |
| WP02 | ContextAssembler（Block 1-4） | T007-T011 | WP01 | P0 |
| WP03 | Amygdala 守卫 | T012-T016 | WP01 | P0 |
| WP04 | ThreadRunner（路由 + 崩溃恢复 + pending） | T017-T024 | WP01, WP02 | P0 |
| WP05 | PiCodingAgentAdapter | T025-T030 | WP01, WP02, WP03 | P1 |
| WP06 | ClaudeAgentSDKAdapter + MCP Server | T031-T038 | WP01, WP02, WP03 | P1 |
| WP07 | AIMAInstance + 公共 API 导出 | T039-T044 | WP04, WP05, WP06 | P1 |
| WP08 | 单元测试（ThreadRunner / EventBus / ContextAssembler） | T045-T051 | WP01~WP04 | P1 |
| WP09 | 集成测试 + E2E smoke test | T052-T057 | WP07 | P2 |

---

## WP01 — BrainAdapter 接口 + BrainEventBus

**目标**：定义所有运行时组件共用的接口类型，实现进程级事件总线。

子任务：
- [x] T001: BrainAdapter 接口（run/inject/abort）+ BrainRunParams/Result/Signal 类型
- [x] T002: BrainEvent 类型 + EventLevel 枚举
- [x] T003: BrainEventBus 类（emit/subscribe/subscribeLevel/subscribeBrain）
- [x] T004: getEventBus() 进程级单例
- [x] T005: CognitiveWorkspace 扩展 — Signals 内存存储（amygdala_interrupt/dmn_correction）
- [x] T006: src/index.ts 导出新类型（不破坏 Feature 001 导出）

**Prompt**: WP01-brain-adapter-eventbus.md

---

## WP02 — ContextAssembler（Block 1-4）

**目标**：组装每次脑区激活的 system prompt，保证 Block 1/2 走 prompt cache。

子任务：
- [x] T007: ContextAssemblerConfig 类型（身份文本、Skill Index、实例时区等）
- [x] T008: assembleBlock12(brain, config) — 静态前缀，构造时生成一次
- [x] T009: assembleBlock3(brain, workspace, threadId) — 工作空间状态 + 当前时间
- [x] T010: assembleBlock4(brain, workspace) — 脑区专属记忆检索（返回 injectedMemoryIds）
- [x] T011: assembleContext(brain, workspace, threadId, config) — 合并四块，返回 { systemPrompt, injectedMemoryIds }

**Prompt**: WP02-context-assembler.md

---

## WP03 — Amygdala 守卫

**目标**：工具调用守卫，三段决策骨架，向工作空间写入中断 Signal。

子任务：
- [x] T012: ToolRiskLevel 类型 + 默认工具权限表（bash/file_* → BLOCK，memory_*/workspace_* → ALLOW）
- [x] T013: AmygdalaConfig 类型（rules, memoryService）
- [x] T014: Amygdala.check(toolName, args) — 三段决策：静态规则 → implicit 记忆 → Haiku 降级
- [x] T015: Amygdala 订阅 EventBus tool.pre_use 事件，违规时写 amygdala_interrupt Signal
- [x] T016: getAmygdalaDecision 内部函数（静态规则命中 → 立即返回，无命中 → 下一段）

**Prompt**: WP03-amygdala.md

---

## WP04 — ThreadRunner

**目标**：框架层核心编排器，监听 Slot 变化，按路由规则激活脑区，处理崩溃恢复和 pending。

子任务：
- [x] T017: ThreadRunnerConfig 类型（workspace/eventBus/memory/adapters/assemblerConfig）
- [x] T018: ThreadRunner.start() — 订阅 workspace 变化，执行崩溃恢复
- [x] T019: ThreadRunner.route(event) — 核心路由逻辑（全部 intent 分支）
- [x] T020: ThreadRunner.routePending() — pending_observations 处理
- [x] T021: ThreadRunner.activateBrain(brain, threadId) — Context Assembly + adapter.run() + events emit
- [x] T022: ThreadRunner 崩溃恢复 — 加载未完成 Thread，找最后完成 Slot，重新激活
- [x] T023: Thread 内顺序保证 — processing flag 防重入
- [x] T024: ThreadRunner.stop() + CognitiveWorkspace.waitForComplete(threadId)

**Prompt**: WP04-thread-runner.md

---

## WP05 — PiCodingAgentAdapter

**目标**：使用 @mariozechner/pi-agent-core 实现 BrainAdapter，桥接 AIMA 接口。

子任务：
- [x] T025: 安装并验证 pi-agent-core/pi-ai API（spike test）
- [x] T026: PiCodingAgentAdapter 类结构 + 构造参数（model, workspace, memory, eventBus, amygdala, getApiKey）
- [x] T027: run() — 实例化 Agent，注册 transformContext hook，调用 agent.prompt() / agent.continue()
- [x] T028: agent.subscribe() 桥接事件到 BrainEventBus（tool_execution_start → tool.pre_use，tool_execution_end → tool.post_use，agent_end → brain.complete）
- [x] T029: Amygdala 信号注入 — 订阅 workspace amygdala_interrupt Signal，调用 agent.steer(interruptMsg) + agent.abort()
- [x] T030: inject(signal) + abort() 实现

**Prompt**: WP05-pi-agent-adapter.md

---

## WP06 — ClaudeAgentSDKAdapter + MCP Server

**目标**：使用 @anthropic-ai/claude-agent-sdk 实现 BrainAdapter，实现 AIMA 工具集 MCP Server。

子任务：
- [x] T031: McpServer 实现 — workspace_read_slot, workspace_write_slot, memory_search, memory_entity_context, memory_similar_situations, memory_procedure
- [x] T032: ClaudeAgentSDKAdapter 类结构 + 构造参数（model, workspace, memory, eventBus, amygdala, mcpServerPath, getApiKey）
- [x] T033: run() — query() 调用，options.resume 续接 session，appendSystemPrompt 注入 Block 3/4
- [x] T034: PreToolUse hook — 调用 amygdala.check()，返回 { permissionDecision: 'deny' } 拦截
- [x] T035: PostToolUse hook — 桥接工具执行后事件到 BrainEventBus
- [x] T036: PreCompact hook — 写入 episodic session anchor 记忆
- [x] T037: spawn_execution_session MCP 工具（Brainstem 专用子执行 session）
- [x] T038: inject(signal) + abort() — 通过 AbortController 实现

**Prompt**: WP06-claude-sdk-adapter-mcp.md

---

## WP07 — AIMAInstance + 公共 API 导出

**目标**：顶层认知个体入口，组装所有组件，更新 src/index.ts 公共导出。

子任务：
- [x] T039: AIMAInstanceConfig 类型（apiKey, adapter, identityDir?, timezone?）
- [x] T040: AIMAInstance 构造 — 初始化 Workspace + MemoryService + EventBus + Amygdala + 适配器 + ThreadRunner
- [x] T041: AIMAInstance.receive(input) — 创建 Thread，激活 Limbic，await waitForComplete()
- [x] T042: AIMAInstance.start() / stop() — ThreadRunner 生命周期
- [x] T043: createAIMAInstance(config) 工厂函数（便捷入口）
- [x] T044: src/index.ts 更新 — 导出所有公共类型和类（不破坏 Feature 001 导出）

**Prompt**: WP07-aima-instance-api.md

---

## WP08 — 单元测试

**目标**：覆盖核心路由逻辑、EventBus 行为、ContextAssembler 输出格式，无需真实 DB 或 LLM。

子任务：
- [x] T045: BrainEventBus 单元测试（emit/subscribe/subscribeLevel/subscribeBrain/singleton）
- [x] T046: ContextAssembler 单元测试（Block 1/2 静态性、Block 3 含时间、Block 4 脑区路由）
- [x] T047: Amygdala 单元测试（BLOCK 规则命中、ALLOW 规则命中、Haiku 降级 mock）
- [x] T048: ThreadRunner 路由单元测试 — Limbic RESPOND → complete
- [x] T049: ThreadRunner 路由单元测试 — Limbic ROUTE → Cortex → Limbic
- [x] T050: ThreadRunner 路由单元测试 — Cortex intent=both → Limbic + Brainstem + Limbic
- [x] T051: ThreadRunner pending 路由单元测试（mock workspace）

**Prompt**: WP08-unit-tests.md

---

## WP09 — 集成测试 + E2E smoke test

**目标**：真实 DB 环境验证 Thread 完整生命周期；选跑 E2E（需 ANTHROPIC_API_KEY）。

子任务：
- [x] T052: 集成测试 helper — MockBrainAdapter（返回固定 Slot 结果）
- [x] T053: 集成测试 — AIMAInstance.receive() 完整 Thread 生命周期（Limbic RESPOND 路径）
- [x] T054: 集成测试 — Limbic ROUTE → Cortex → Limbic 完整路径
- [x] T055: 集成测试 — 崩溃恢复（手动把 Thread 设为 active + Limbic Slot done，重启 ThreadRunner，验证 Cortex 被激活）
- [x] T056: E2E smoke test — AIMAInstance.receive('Hello') 实际 LLM 调用（describeWithApiKey 条件跑）
- [x] T057: vitest.integration.config.ts 更新 + passWithNoTests

**Prompt**: WP09-integration-e2e-tests.md
