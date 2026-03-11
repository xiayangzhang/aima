# Feature Specification: pi-coding-agent Adapter Migration

**Feature**: 006-pi-coding-agent-adapter-migration
**Status**: Draft
**Created**: 2026-03-11
**Depends on**: Feature 001 (Workspace), Feature 002 (Brain Runtime), Feature 003 (DMN), Feature 005 (Brain Retrieval)

---

## Overview

AIMA 当前使用 `pi-agent-core` 作为唯一 brain adapter，但它存在三个结构性缺口：

1. **Amygdala 覆盖不完整**：pi-agent-core 无法在每个工具调用前同步拦截并阻断，Amygdala 只能在 run() 开始时读取信号，无法保护单次工具执行
2. **EventBus tool 事件缺失**：工具执行的 pre/post 事件没有发射到 EventBus，DMN 和审计系统看不到工具执行链
3. **inject() 实时性不足**：向正在运行的 Agent 注入信号（Amygdala interrupt、DMN correction）无法在本轮立即生效，只能等到下次 run()

`pi-coding-agent` 通过其 Extension API 解决了上述全部问题。本 Feature 实现从 pi-agent-core 到 pi-coding-agent 的完整迁移，同时保留 pi-agent-core 作为可选的 fallback adapter 直到完全验证。

---

## Actors

- **AIMA 框架**（系统）：通过 `BrainAdapter` 接口使用 adapter，无需感知底层实现
- **Amygdala**：注册 Extension 处理器，在每个工具调用前同步决策（allow / block / escalate）
- **EventBus**：接收 adapter 发射的工具事件（tool.pre_use / tool.post_use），供 DMN 和审计消费
- **ThreadRunner**：调用 `adapter.inject()` 向运行中的 session 注入实时信号
- **上层应用**：通过 `AIMAInstance` 配置选择 adapter 类型，无需关心 Extension 注册细节

---

## Problem Statement

### P1：Amygdala 无法阻断单个工具调用

pi-agent-core 的 Agent 执行工具时不提供拦截点。Amygdala 的检查只在 `run()` 开始时通过 `workspace.popSignal()` 触发，这意味着：
- 工具调用在 LLM 决定使用之后、执行之前没有阻断机会
- bash、file_write 等高风险内置工具无法被策略控制
- 只能事后审查，无法事前防护

### P2：审计和 DMN 对工具执行盲目

pi-agent-core adapter 不发射 `tool.pre_use` / `tool.post_use` 事件，导致：
- EventBus 中工具执行链缺失，审计不完整
- DMN Reactive 无法对工具执行结果做实时响应
- Amygdala 无法基于工具历史积累风险判断

### P3：inject() 无法实时生效

当 Amygdala 在工具执行过程中检测到风险，调用 `inject(amygdala_interrupt)` 时：
- pi-agent-core 将信号写入 workspace，等待下次 run()
- 危险操作可能在信号被处理前已经完成
- DMN correction 同样延迟一轮才能注入推理上下文

---

## Functional Requirements

### FR-01：PiCodingAgentAdapter 实现

新建 `src/adapters/pi-coding-agent/index.ts`，实现 `BrainAdapter` 接口：

```typescript
class PiCodingAgentAdapter implements BrainAdapter {
  run(params: BrainRunParams): Promise<BrainRunResult>
  inject(signal: BrainSignal): Promise<void>
  abort(): void
  abortSession(brain: CognitiveBrainType, threadId: string): void
}
```

- 每个 `brain:threadId` 组合维护一个 `AgentSession`（via `SessionManager.inMemory()`）
- 首次 run() 调用 `createAgentSession()` 并注册 Extension；后续 run() resume 同一 session
- `systemPrompt` 在每次 run() 前刷新（Block 3/4 每次都变化）
- `initialPrompt` 在首次 run() 时作为用户消息发送；后续 run() 调用 `session.prompt()` 或 `session.followUp()`

**验收条件**：
- 同一 `brain:threadId` 多次 run() 共享会话历史
- 系统提示词在每次激活时更新（不依赖 session 内的历史 system prompt）
- adapter 实现 `BrainAdapter` 接口的全部三个方法

### FR-02：Amygdala Extension 集成（实时 per-tool 拦截）

在 `createAgentSession()` 时注册 Extension，实现 `tool_call` 事件处理器：

- 每个工具调用前，同步调用 `amygdala.check(toolName, args)`
- `decision = 'allow'` → 返回 `undefined`（允许执行）
- `decision = 'block'` → 返回 `{ block: true, message: reason }` — 工具不执行，LLM 收到拒绝消息
- `decision = 'escalate'` → 同 block，并额外向 EventBus 发射 `ALERT` 级别事件

**默认工具权限策略**（Amygdala 内置，`role.md` 可解锁）：

| 工具 | 默认 | 说明 |
|------|------|------|
| `bash` | BLOCK | 任意命令执行，需显式解锁 |
| `edit` / `write` | BLOCK | 文件写入，需显式解锁 |
| `read` | ALLOW | 只读，默认允许 |
| `grep` / `find` / `ls` | ALLOW | 查询类，默认允许 |
| 自定义 MCP 工具 | 通过 Amygdala 策略决定 | 无默认 |

**验收条件**：
- block 决策阻止工具执行，LLM 收到包含 reason 的拒绝结果
- allow 决策不干预工具执行
- escalate 同 block + 发射 `amygdala.escalation` ALERT 事件
- Amygdala check 的延迟不超过工具执行本身（check 是同步路径的一部分）

### FR-03：EventBus Tool 事件完整覆盖

通过 Extension `tool_execution_start` / `tool_execution_end` 事件（以及 `tool_call` 事件），向 EventBus 发射完整工具执行链：

| EventBus 事件 | 触发时机 | Level |
|---------------|---------|-------|
| `tool.pre_use` | `tool_call` 处理器（Amygdala check 前或后） | INFO |
| `tool.post_use` | `tool_execution_end` | INFO |
| `tool.blocked` | Amygdala block 决策后 | COMPLIANCE |
| `amygdala.escalation` | Amygdala escalate 决策后 | ALERT |
| `brain.loop_end` | `agent_end` 事件 | INFO |

**验收条件**：
- 每次工具调用产生一对 `tool.pre_use` + `tool.post_use` 事件（未被 block）
- 被 block 的工具调用产生 `tool.pre_use` + `tool.blocked` 事件（无 `tool.post_use`）
- EventBus 事件包含 `brain`、`thread_id`、`payload.tool`、`payload.toolCallId`

### FR-04：inject() 实时注入

- `inject({ type: 'amygdala_interrupt', message })` → 调用 `session.steer(...)` 向正在运行的 session 立即注入中断消息，本轮生效
- `inject({ type: 'dmn_correction', message })` → 调用 `session.followUp(...)` 队列化跟进消息，当前轮次完成后注入
- 若该 `brain:threadId` 尚无活跃 session，降级写入 workspace（与 pi-agent-core 一致）

**验收条件**：
- `amygdala_interrupt` 通过 `steer()` 实时注入（不等待下次 run()）
- `dmn_correction` 通过 `followUp()` 队列化注入
- inject 对非活跃 session 无副作用

### FR-05：MCP 工具注册

通过 Extension 的 `registeredTools` 字段将 AIMA MCP server 工具注册到 pi-coding-agent 的工具系统：

- `createAimaMcpServer(workspace)` 的工具列表转换为 `AgentTool[]`
- 注册到 Extension 的 `registeredTools`，使 LLM 可以调用这些工具
- MCP 工具同样走 `tool_call` Extension 事件，受 Amygdala 管辖

**验收条件**：
- LLM 可以调用 `memory_search`、`workspace_read` 等 AIMA MCP 工具
- MCP 工具的调用也会被 Amygdala check（不绕过）
- MCP 工具执行产生对应 EventBus 事件

### FR-06：AIMAInstance 集成与 adapter 配置

更新 `src/instance.ts` 支持 `adapter: 'pi-coding-agent'` 选项：

```typescript
interface AIMAInstanceConfig {
  adapter: 'pi-coding-agent' | 'pi-agent' | 'claude-sdk'  // 新增 'pi-coding-agent'
  // ...
}
```

- `'pi-coding-agent'` 创建 `PiCodingAgentAdapter`
- `'pi-agent'` 保留现有 `PiCodingAgentAdapter`（pi-agent-core，不删除，作为 fallback）
- 默认 adapter 从 `'pi-agent'` 改为 `'pi-coding-agent'`

**验收条件**：
- `adapter: 'pi-coding-agent'` 正常创建并运行
- `adapter: 'pi-agent'` 继续工作（不破坏现有功能）
- `src/index.ts` 导出 `PiCodingAgentAdapter` 和对应 config 类型

### FR-07：全量测试覆盖

实现以下测试，覆盖宪法要求的边界条件：

**单元测试**：
- `PiCodingAgentAdapter.run()` 首次 / 续接两种路径
- Extension 注册与 `tool_call` 事件处理（mock session）
- Amygdala allow / block / escalate 三种决策的不同行为
- EventBus 事件发射（类型、payload、level）
- `inject()` 三种场景（amygdala_interrupt / dmn_correction / 无活跃 session）
- 默认工具权限策略（bash BLOCK / read ALLOW）
- `abort()` / `abortSession()` 清理逻辑

**集成测试**（真实 pi-coding-agent，不连接 LLM）：
- `SessionManager.inMemory()` 会话创建与复用
- Extension 注册后 `tool_call` 事件触发（用 mock tool）
- `steer()` / `followUp()` 在会话中的实际行为
- `amygdala.check()` block 决策阻止工具执行的端到端验证

**E2E 冒烟测试**（需要真实 API key，CI skip）：
- `AIMAInstance` 用 `pi-coding-agent` adapter 完整跑一轮 thread，验证 EventBus 事件顺序正确

---

## User Scenarios & Testing

### 场景 A：bash 命令被 Amygdala 默认阻断

1. LLM 决定调用 bash 工具执行 `ls -la`
2. Extension `tool_call` 处理器触发，调用 `amygdala.check('bash', { command: 'ls -la' })`
3. Amygdala 默认策略返回 `decision: 'block'`
4. Extension 返回 `{ block: true, message: 'bash tool blocked by default policy' }`
5. LLM 收到拒绝结果，EventBus 发射 `tool.pre_use` + `tool.blocked` 事件

**测试验证**：mock Amygdala 返回 block，验证工具不执行、EventBus 有 `tool.blocked` 事件。

### 场景 B：Amygdala 中途注入中断

1. LLM 正在执行一个多步工具链
2. DMN 检测到风险，调用 `adapter.inject({ type: 'amygdala_interrupt', message: '...' })`
3. `session.steer()` 立即注入到当前运行的 session 消息队列
4. LLM 在当前轮次内收到中断，改变执行路径

**测试验证**：验证 `steer()` 被调用，消息内容包含 `[AMYGDALA INTERRUPT]`。

### 场景 C：MCP 工具正常调用

1. LLM 调用 `memory_search` MCP 工具
2. Extension `tool_call` 处理器触发，Amygdala check 返回 allow
3. 工具执行，返回结果给 LLM
4. EventBus 发射 `tool.pre_use` + `tool.post_use`

**测试验证**：端到端验证 MCP 工具执行流程，EventBus 事件配对正确。

### 场景 D：Session 跨 run() 保持历史

1. 首次 run() 发送 "你好"，LLM 回复 "你好，我是 Alex"
2. 第二次 run() 发送 "你刚才说了什么"
3. LLM 能基于会话历史正确回答

**测试验证**：两次 run() 共享同一 AgentSession，第二次 prompt 使用 resume 模式。

---

## Key Entities

- **PiCodingAgentAdapter**：新增，实现 `BrainAdapter`，持有 `AgentSession` Map
- **PiCodingAgentAdapterConfig**：新增，配置接口（model, apiKey, workspace, eventBus, amygdala）
- **Extension Factory**：内部逻辑，注册 `tool_call` / `tool_execution_start` / `tool_execution_end` / `agent_end` 处理器
- **AgentSession**（pi-coding-agent）：per `brain:threadId` 的会话对象，持有完整对话历史
- **PiAgentAdapter**（保留）：原 pi-agent-core adapter，改名为 `PiAgentAdapter`，adapter 类型值 `'pi-agent'`

---

## Assumptions

- `@mariozechner/pi-coding-agent` v0.57.1 的 Extension API 与上述研究结果一致
- `SessionManager.inMemory()` 创建的 session 可以在不写文件的情况下维持会话历史
- pi-coding-agent 的 `tool_call` Extension 事件在工具执行前同步触发（blocking），handler 的返回值决定是否执行
- MCP server 工具可以通过 Extension `registeredTools` 注册为 `AgentTool[]`
- pi-agent-core adapter 保留（不删除），仅在 adapter 配置中降为非默认选项

---

## Success Criteria

1. **Amygdala 全覆盖**：所有工具调用（内置 + MCP）在执行前经过 Amygdala check；block 决策 100% 阻止执行
2. **EventBus 完整性**：每次工具调用产生正确配对的 pre/post 事件；block 产生 pre + blocked 事件
3. **inject() 实时性**：`amygdala_interrupt` 通过 `steer()` 注入，DMN 可验证消息在当前轮次出现
4. **会话连续性**：同一 `brain:threadId` 的多次 run() 共享完整对话历史
5. **向后兼容**：`adapter: 'pi-agent'` 的现有功能全部通过，测试数量不减少
6. **测试密度**：单元测试 ≥ 30 个，集成测试 ≥ 10 个，覆盖所有 FR 的核心路径和边界条件
7. **`bun run typecheck` 零错误，`biome check` 通过**

---

## Out of Scope

- 删除 pi-agent-core adapter（保留为 `'pi-agent'` 选项）
- claude-sdk adapter 的 EventBus bridge 补齐（独立 feature）
- pi-coding-agent 的 `ThinkingLevel` / `ThinkingBudgets` 配置（后续 feature）
- 会话持久化到文件系统（当前用 inMemory，进程重启丢失 session，由 ThreadRunner crash recovery 处理）
- pi-coding-agent CLI 工具的任何 UI 功能（仅使用其 SDK API）
