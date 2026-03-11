# Tasks: Brainstem Sub-Execution Session

**Feature**: 009-brainstem-sub-execution-session
**Status**: In Progress
**Total WPs**: 3
**Total Subtasks**: 10

---

## Phase 1 — MCP Layer

### WP01: MCP Tool Real Implementation
**Priority**: P0 | **Status**: planned | **File**: [WP01-mcp-tool-real-implementation.md](tasks/WP01-mcp-tool-real-implementation.md)

将 `spawn_execution_session` MCP tool 从 stub 升级为真实实现。定义 `SpawnExecutionSessionFn` 类型，修改 `createAimaMcpServer()` 接受可选回调，handler 调用回调或返回明确错误。

**Subtasks**:
- [x] T001: 定义 `SpawnExecutionSessionFn` 类型（`src/mcp/index.ts` 顶部）
- [x] T002: 修改 `createAimaMcpServer()` 签名，新增 `opts?: { spawnExecutionSession? }` 参数
- [x] T003: 修改 handler——有回调时调用，无回调时返回明确错误（不是 stub 文本）
- [x] T004: 新增 MCP handler 单元测试（mock 回调，≥4 测试）

**Dependencies**: none
**Estimated prompt size**: ~260 lines

---

## Phase 2 — Instance Layer

### WP02: AIMAInstance Sub-Execution Logic
**Priority**: P0 | **Status**: planned | **File**: [WP02-aimainstance-sub-execution.md](tasks/WP02-aimainstance-sub-execution.md)

在 `AIMAInstance` 中实现子执行 session 的完整逻辑：独立 session、executionModel 配置、EventBus 事件、Amygdala 复用，并注入 MCP server。

**Subtasks**:
- [x] T005: `AIMAInstanceConfig` 新增 `executionModel?: string`（默认 sonnet）
- [x] T006: 新增私有方法 `spawnSubExecution()`——完整子执行 session 生命周期
- [x] T007: 修改 `start()` 方法中 `createAimaMcpServer()` 调用，传入 spawnSubExecution 回调
- [x] T008: 新增 AIMAInstance 子执行单元测试（≥4 测试）

**Dependencies**: WP01
**Estimated prompt size**: ~360 lines

---

## Phase 3 — Public API

### WP03: Public API Export + Integration Tests
**Priority**: P1 | **Status**: planned | **File**: [WP03-public-api-export.md](tasks/WP03-public-api-export.md)

更新 `src/index.ts` 导出 `SpawnExecutionSessionFn` 类型；新增端到端集成冒烟测试。

**Subtasks**:
- [x] T009: `src/index.ts` 导出 `SpawnExecutionSessionFn` 类型
- [x] T010: 集成测试——mock MCP → 回调 → 子执行链路（≥3 测试）

**Dependencies**: WP01, WP02
**Estimated prompt size**: ~180 lines
