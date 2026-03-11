---
work_package_id: WP01
title: MCP Tool Real Implementation
lane: "done"
dependencies: []
subtasks:
- T001
- T002
- T003
- T004
phase: Phase 1 - MCP Layer
assignee: ''
agent: "claude-sonnet-4-6"
shell_pid: "52203"
review_status: "approved"
reviewed_by: "XIAYANG ZHANG"
history:
- timestamp: '2026-03-11T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP01 – MCP Tool Real Implementation

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

将 `src/mcp/index.ts` 中 `spawn_execution_session` tool 的 stub 实现替换为真实实现。

**Success Criteria**:
- `SpawnExecutionSessionFn` 类型已定义并导出
- `createAimaMcpServer()` 接受 `opts?: { spawnExecutionSession? }` 第二参数（向后兼容）
- 提供 `spawnExecutionSession` 时：handler 调用回调，返回真实 `executionSessionId` 和 `result`
- 未提供时：返回明确错误消息 `"spawn_execution_session: sub-execution not configured"`（不是 stub 文本）
- 向后兼容：现有不传 opts 的调用正常工作（只有 `spawn_execution_session` 返回错误，其他 tool 不受影响）
- 新增 ≥4 测试全绿，`bun run typecheck` 零错误，`biome check` 通过

---

## Context

**Repository**: `/Volumes/leoyun/aima/`
**Implementation command**: `spec-kitty implement WP01` (no dependencies)

**当前 stub 实现**（`src/mcp/index.ts:175-191`）：

```typescript
handler: async (args) => {
  const { task_description } = args as { task_description: string; model?: string }
  // Stub: returns a placeholder.
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        execution_session_id: null,                                    // 永远 null
        result: `[spawn_execution_session stub] Task: ${task_description}`,
        note: 'Full sub-session execution implemented in AIMAInstance',
      }),
    }],
  }
},
```

**当前函数签名**（`src/mcp/index.ts:15`）：
```typescript
export function createAimaMcpServer(workspace: CognitiveWorkspace)
```

**文件结构**：
```
src/
└── mcp/index.ts    ← 唯一需要修改的文件
tests/
└── unit/
    └── aima-mcp.test.ts    ← 新建测试文件
```

---

## Subtask Guidance

### T001: 定义 `SpawnExecutionSessionFn` 类型

**文件**: `src/mcp/index.ts`（文件顶部，import 之后，`createAimaMcpServer` 之前）

**添加**：

```typescript
// ─── Sub-Execution Session ────────────────────────────────────────────────────

/**
 * Callback for spawning an independent sub-execution session.
 * Implemented by AIMAInstance and injected into createAimaMcpServer.
 */
export type SpawnExecutionSessionFn = (params: {
  taskDescription: string
  model?: string
}) => Promise<{
  executionSessionId: string
  result: string
}>
```

**验证**：类型可被导出和使用，`bun run typecheck` 通过。

---

### T002: 修改 `createAimaMcpServer()` 签名

**文件**: `src/mcp/index.ts`（第 15 行）

**当前**：
```typescript
export function createAimaMcpServer(workspace: CognitiveWorkspace)
```

**修改为**：
```typescript
export function createAimaMcpServer(
  workspace: CognitiveWorkspace,
  opts?: { spawnExecutionSession?: SpawnExecutionSessionFn },
)
```

> ⚠️ 注意：`opts` 是可选的，现有调用 `createAimaMcpServer(workspace)` 无需修改。

---

### T003: 修改 `spawn_execution_session` handler

**文件**: `src/mcp/index.ts`（第 175-191 行 handler 内部）

**修改为**：

```typescript
handler: async (args) => {
  const { task_description, model } = args as { task_description: string; model?: string }

  if (!opts?.spawnExecutionSession) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'spawn_execution_session: sub-execution not configured',
        }),
      }],
    }
  }

  const { executionSessionId, result } = await opts.spawnExecutionSession({
    taskDescription: task_description,
    ...(model !== undefined ? { model } : {}),
  })

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        execution_session_id: executionSessionId,
        result,
      }),
    }],
  }
},
```

**验证**：
- `opts` 未提供时：返回含 `error` 字段的 JSON
- `opts.spawnExecutionSession` 提供时：调用回调，返回 `execution_session_id`（非 null）和 `result`
- `model` 参数正确传递给回调（存在时传，不存在时不传，避免 undefined 污染）

---

### T004: 新增单元测试

**文件**: `tests/unit/aima-mcp.test.ts`（新建）

**需要的测试（≥4 个）**：

**测试 1**: 未提供 `spawnExecutionSession` 时，handler 返回明确错误消息
```typescript
import { createAimaMcpServer } from '../../src/mcp/index.ts'

// mock workspace
const mockWorkspace = createMockWorkspace()

// create server without opts
const server = createAimaMcpServer(mockWorkspace)

// find spawn_execution_session tool and call its handler
const handler = findTool(server, 'spawn_execution_session')
const result = await handler({ task_description: 'test task' })

const parsed = JSON.parse(result.content[0].text)
expect(parsed.error).toBe('spawn_execution_session: sub-execution not configured')
// Should NOT have the old stub text
expect(parsed.result).toBeUndefined()
```

**测试 2**: 提供 `spawnExecutionSession` 时，handler 调用回调并返回 executionSessionId
```typescript
const mockSpawn = mock(() => Promise.resolve({
  executionSessionId: 'abc-123-uuid',
  result: 'Task completed successfully',
}))

const server = createAimaMcpServer(mockWorkspace, { spawnExecutionSession: mockSpawn })
const handler = findTool(server, 'spawn_execution_session')
const result = await handler({ task_description: 'analyze code' })

expect(mockSpawn).toHaveBeenCalledOnce()
expect(mockSpawn).toHaveBeenCalledWith({ taskDescription: 'analyze code' })

const parsed = JSON.parse(result.content[0].text)
expect(parsed.execution_session_id).toBe('abc-123-uuid')
expect(parsed.result).toBe('Task completed successfully')
```

**测试 3**: model 参数正确传递
```typescript
const mockSpawn = mock(() => Promise.resolve({
  executionSessionId: 'uuid-456',
  result: 'done',
}))

const server = createAimaMcpServer(mockWorkspace, { spawnExecutionSession: mockSpawn })
const handler = findTool(server, 'spawn_execution_session')
await handler({ task_description: 'task', model: 'claude-opus-4-6' })

expect(mockSpawn).toHaveBeenCalledWith({
  taskDescription: 'task',
  model: 'claude-opus-4-6',
})
```

**测试 4**: 其他 tools（如 `workspace_read_slot`）不受影响
```typescript
const server = createAimaMcpServer(mockWorkspace)
const handler = findTool(server, 'workspace_read_slot')
// Should not throw, should work normally
```

**测试 helper 说明**：
- `createMockWorkspace()`：mock CognitiveWorkspace，各方法返回空结果
- `findTool(server, name)`：从 server.tools 数组中找到对应 tool 的 handler
  - 查看 `createSdkMcpServer` 返回值结构确认如何访问 tools

---

## Definition of Done

- [ ] T001: `SpawnExecutionSessionFn` 类型定义并导出
- [ ] T002: `createAimaMcpServer()` 接受 `opts?` 第二参数（向后兼容）
- [ ] T003: handler 替换 stub：有回调调用，无回调返回明确错误
- [ ] T004: ≥4 新测试全绿
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] 现有测试零 regression（其他 MCP tools 正常工作）

---

## Risks & Notes

- **`createSdkMcpServer` 返回值结构**：测试中需要访问 tool handler，先读 `@anthropic-ai/claude-agent-sdk` 的类型定义或查看现有测试了解 API。
- **错误格式**：返回 `{ error: string }` JSON 而非抛出异常，与 MCP tool 的期望格式一致（不破坏 Brainstem session）。
- **向后兼容**：修改后所有不传 opts 的调用（如 DMN、其他测试）都不应受影响。

---

## Reviewer Guidance

**Review focus**:
1. stub 文本是否已完全移除（不应再有 "[spawn_execution_session stub]"）
2. 错误消息是否明确（`"spawn_execution_session: sub-execution not configured"`）
3. `createAimaMcpServer` 签名是否向后兼容（opts 可选）
4. model 参数是否正确透传（存在时传，不存在时不传 undefined）
5. 测试是否 mock 了回调并验证了调用参数

## Activity Log

- 2026-03-11T12:33:27Z – claude-sonnet-4-6 – shell_pid=52203 – lane=doing – Started review via workflow command
- 2026-03-11T13:11:27Z – claude-sonnet-4-6 – shell_pid=52203 – lane=done – Review passed: all 3 adapter paths fixed, correct defaults (limbic=haiku, cortex/brainstem=sonnet), independent instances per brain verified. 12 tests cover modelId/model correctness and instance independence. No regressions. Code is clean and minimal.
