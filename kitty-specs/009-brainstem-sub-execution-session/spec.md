# Feature Specification: Brainstem Sub-Execution Session

**Feature**: 009-brainstem-sub-execution-session
**Status**: Draft
**Created**: 2026-03-11
**Depends on**: Feature 006 (pi-coding-agent Adapter), Feature 008 (Per-Brain Model Routing)

---

## Overview

AIMA 设计中 Brainstem 有双层执行能力：主 session（协调层，快速模型）+ 子执行 session（深度推理层，强力模型）。子执行 session 独立于主 session，有完整推理链，适合复杂任务。

当前 `spawn_execution_session` MCP tool（`src/mcp/index.ts`）是 stub，只返回占位符文本。本 Feature 实现真正的子执行 session：创建独立 AgentSession，运行任务，返回 `execution_session_id` + 结果。

---

## Problem Statement

### P1：spawn_execution_session 是空壳

```typescript
// src/mcp/index.ts:176 — 当前 stub
handler: async (args) => {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        execution_session_id: null,          // 永远 null
        result: `[spawn_execution_session stub] Task: ${task_description}`,
        note: 'Full sub-session execution implemented in AIMAInstance',
      }),
    }],
  }
}
```

Brainstem 调用此 tool 时得到假结果，`execution_session_id` 始终为 null，slot 的 `executionSessionId` 字段永远无法填充。

### P2：子执行无法使用更强的模型

Brainstem 的主 session 用于协调（应用较快模型），子执行 session 应能使用更强模型（Opus）进行深度推理。当前 stub 无法实现模型差异。

---

## Functional Requirements

### FR-01：spawn_execution_session 真实实现

`createAimaMcpServer()` 接受可选的 `SpawnExecutionSessionFn` 回调，用于创建子执行 session：

```typescript
type SpawnExecutionSessionFn = (params: {
  taskDescription: string
  model?: string
}) => Promise<{
  executionSessionId: string
  result: string
}>

function createAimaMcpServer(
  workspace: CognitiveWorkspace,
  opts?: { spawnExecutionSession?: SpawnExecutionSessionFn }
)
```

若 `spawnExecutionSession` 未提供，tool 返回明确的错误信息（不再是 stub 文本）。

**验收条件**：
- `spawnExecutionSession` 提供时：tool 调用创建真实子 session，返回真实 `executionSessionId`（UUID 格式）和 result
- `spawnExecutionSession` 未提供时：返回有意义的错误消息（不是 stub）
- tool 签名不变（向后兼容 MCP client）

### FR-02：AIMAInstance 提供 spawnExecutionSession 实现

`AIMAInstance` 内部实现 `SpawnExecutionSessionFn`，并在创建 MCP server 时注入：

**子执行 session 行为**：
1. 创建独立的一次性 AgentSession（使用 `pi-coding-agent` adapter 模式，不加入 ThreadRunner sessions）
2. 使用可配置的执行模型（`executionModel`，默认 `claude-sonnet-4-6`；高级场景可用 Opus）
3. 以 `taskDescription` 作为 `initialPrompt` 运行
4. session 运行完成后，返回 `executionSessionId`（session key）和 `result`（session 输出摘要）
5. 子 session 不共享主 session 的对话历史，是完全独立的推理链

**验收条件**：
- `AIMAInstanceConfig` 新增 `executionModel?: string`（默认 `claude-sonnet-4-6`）
- 子执行 session 有唯一 ID（UUID），与主 Brainstem session 区分
- 子执行不影响主 Brainstem session 的对话历史
- 子执行 session ID 可被 Brainstem 写入 slot 的 `executionSessionId` 字段

### FR-03：子执行 session 事件可观察

子执行 session 产生的事件通过现有 EventBus 传播，标记 `brain: 'brainstem'`，包含 `executionSessionId`：

**验收条件**：
- `brain.activate` 事件在子执行开始时 emit，包含 `{ brain: 'brainstem', isSubExecution: true }`
- `brain.complete` 事件在子执行结束时 emit，包含 `executionSessionId`

### FR-04：子执行 session 的 Amygdala 策略

子执行 session 使用与主 Brainstem session 相同的 Amygdala 实例和工具策略（包含 Feature 007 的 `allowedTools` 覆盖），确保一致的安全边界。

**验收条件**：
- 子执行使用同一 `amygdala` 实例
- 若 brainstem 的 `allowedTools` 包含 `bash`，子执行 session 同样享有此权限

---

## User Scenarios & Testing

### 场景 A：Brainstem 调用 spawn_execution_session

1. Brainstem 主 session 决定当前任务需要深度推理
2. 调用 `spawn_execution_session({ task_description: "分析并重构这段代码..." })`
3. 子执行 session 使用 `executionModel` 运行，完成后返回结果
4. `execution_session_id` 写入 Brainstem slot 的 `executionSessionId` 字段

**测试验证**：mock `spawnExecutionSession` 回调，验证参数正确，返回值格式正确。

### 场景 B：子执行 session 使用更强模型

1. 配置 `executionModel: 'claude-opus-4-6'`
2. Brainstem 调用 `spawn_execution_session`
3. 子执行 session 使用 opus 模型（而非 brainstem 主 session 的 sonnet）

**测试验证**：验证 sub-session 创建时使用了 `executionModel`。

### 场景 C：未提供 spawnExecutionSession 时返回有意义错误

1. `createAimaMcpServer(workspace)` 不提供 opts（无 spawnExecutionSession）
2. Brainstem 调用 `spawn_execution_session`
3. 返回明确错误：`"spawn_execution_session: sub-execution not configured"`

### 场景 D：子执行不污染主 session 历史

1. Brainstem 主 session 有对话历史 H
2. 子执行 session 运行并完成
3. 主 session 对话历史仍为 H（未被子执行修改）

---

## Key Entities

- **SpawnExecutionSessionFn**：回调类型，AIMAInstance 提供具体实现
- **Sub-execution session**：独立的一次性 AgentSession，不加入 ThreadRunner 管理
- **executionSessionId**：子执行 session 的唯一 ID，写入 Brainstem slot

---

## Assumptions

- 子执行 session 是一次性的——Brainstem 每次调用 `spawn_execution_session` 创建一个新 session，不复用
- 子执行使用 `pi-coding-agent` adapter 模式（提供完整工具集）
- `executionModel` 默认与 brainstem model 相同（`claude-sonnet-4-6`），用户可升级到 Opus
- 子执行的 EventBus 事件不触发 ThreadRunner 的路由逻辑（不 emit `notifySlotDone`）

---

## Success Criteria

1. **stub 替换**：`spawn_execution_session` 不再返回 stub 文本，返回真实 `executionSessionId`（UUID）
2. **独立性**：子执行 session 与主 session 对话历史完全隔离
3. **可观察**：子执行产生 `brain.activate` + `brain.complete` EventBus 事件
4. **Amygdala 一致性**：子执行使用相同工具策略
5. **向后兼容**：不提供 `spawnExecutionSession` 时，MCP server 正常工作（只有该 tool 返回错误）
6. **`bun run typecheck` 零错误，`biome check` 通过**
7. **新增测试 ≥8 个**

---

## Out of Scope

- 子执行 session 的持久化（当前一次性，不持久）
- 子执行结果自动写入记忆（Brainstem 自行决定是否 writeMemory）
- 多层嵌套子执行（子执行内再 spawn 子执行）
- 子执行 session 的 abort/cancel 控制
