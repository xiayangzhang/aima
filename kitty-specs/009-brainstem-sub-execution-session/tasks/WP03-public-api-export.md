---
work_package_id: WP03
title: Public API Export + Integration Tests
lane: "for_review"
dependencies: ["WP01", "WP02"]
subtasks:
- T009
- T010
phase: Phase 3 - Public API
assignee: ''
agent: ''
shell_pid: ''
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-11T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP03 – Public API Export + Integration Tests

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

更新 `src/index.ts` 导出 `SpawnExecutionSessionFn` 类型；新增端到端集成冒烟测试验证完整调用链路。

**Success Criteria**:
- `SpawnExecutionSessionFn` 在公共 API 中可用（外部消费者可 import）
- 集成测试覆盖：有回调 → 成功路径；无回调 → 明确错误；executionModel 覆盖
- 新增 ≥3 测试全绿，`bun run typecheck` 零错误，`biome check` 通过

---

## Context

**Repository**: `/Volumes/leoyun/aima/`
**Implementation command**: `spec-kitty implement WP03 --base WP02`
**Depends on**: WP01 (SpawnExecutionSessionFn 类型), WP02 (AIMAInstance 实现)

**文件结构**：
```
src/
└── index.ts    ← 添加导出
tests/
└── integration/
    └── spawn-execution-session.test.ts    ← 新建
```

---

## Subtask Guidance

### T009: 更新 `src/index.ts` 导出

**文件**: `src/index.ts`

**查找现有导出格式**（先读文件），然后添加：

```typescript
// 在 mcp 相关导出位置添加：
export type { SpawnExecutionSessionFn } from './mcp/index'
```

如果 `src/index.ts` 已有 `createAimaMcpServer` 的导出，在旁边添加类型导出。

**验证**：
```typescript
import type { SpawnExecutionSessionFn } from '@aima/core'
```
（或对应包名）可正常解析。

---

### T010: 集成测试

**文件**: `tests/integration/spawn-execution-session.test.ts`（新建）

**测试场景（≥3 个）**：

**场景 A**: mock 回调验证 MCP → 回调 → 返回值链路
```typescript
import { createAimaMcpServer } from '../../src/mcp/index.ts'
import type { SpawnExecutionSessionFn } from '../../src/index.ts'

const mockSpawn: SpawnExecutionSessionFn = mock(() => Promise.resolve({
  executionSessionId: '11111111-1111-4111-8111-111111111111',
  result: 'Integration test result',
}))

const server = createAimaMcpServer(mockWorkspace, { spawnExecutionSession: mockSpawn })

// simulate Brainstem calling the tool
const tool = findTool(server, 'spawn_execution_session')
const response = await tool({ task_description: 'analyze and refactor code' })

const parsed = JSON.parse(response.content[0].text)
expect(parsed.execution_session_id).toBe('11111111-1111-4111-8111-111111111111')
expect(parsed.result).toBe('Integration test result')
expect(mockSpawn).toHaveBeenCalledWith({ taskDescription: 'analyze and refactor code' })
```

**场景 B**: 未配置回调返回明确错误
```typescript
const server = createAimaMcpServer(mockWorkspace)  // no opts
const tool = findTool(server, 'spawn_execution_session')
const response = await tool({ task_description: 'task' })

const parsed = JSON.parse(response.content[0].text)
expect(parsed.error).toContain('sub-execution not configured')
// Verify old stub text is gone
expect(response.content[0].text).not.toContain('[spawn_execution_session stub]')
```

**场景 C**: `executionModel` 配置验证（通过 SpawnExecutionSessionFn type contract）
```typescript
// 验证 SpawnExecutionSessionFn 类型可正确使用
const fn: SpawnExecutionSessionFn = async ({ taskDescription, model }) => {
  // type checking: both params should be accessible
  return { executionSessionId: crypto.randomUUID(), result: 'ok' }
}
// 此测试主要验证类型兼容性，无需实际调用
expect(fn).toBeDefined()
```

---

## Definition of Done

- [ ] T009: `SpawnExecutionSessionFn` 已从 `src/index.ts` 导出
- [ ] T010: ≥3 集成测试全绿
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] 全部现有测试零 regression

---

## Risks & Notes

- 此 WP 是最轻量的，主要是收尾工作。
- 集成测试主要用 mock，不需要真实数据库或 Anthropic API key。
- `SpawnExecutionSessionFn` 是 type export（`export type`），Tree-shaking 友好。

---

## Reviewer Guidance

**Review focus**:
1. `src/index.ts` 中的导出是否使用 `export type`（非 `export`）
2. 集成测试是否真正验证了完整调用链路（不只是 unit mock）
3. 旧的 stub 文本是否已完全消失（场景 B 验证）

## Activity Log

- 2026-03-11T14:07:47Z – unknown – lane=for_review – Exported SpawnExecutionSessionFn from public API. 3 integration tests green. All 385 tests pass.
