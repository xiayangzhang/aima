# Implementation Plan: Brainstem Sub-Execution Session

**Branch**: `009-brainstem-sub-execution-session` | **Date**: 2026-03-11 | **Spec**: [spec.md](spec.md)

---

## Summary

实现 Brainstem 的双层执行能力：将 `spawn_execution_session` MCP tool 从 stub 升级为真实实现。

核心变更三步走：
1. **`src/mcp/index.ts`**：`createAimaMcpServer()` 接受可选 `SpawnExecutionSessionFn` 回调；tool handler 调用回调或返回明确错误
2. **`src/instance.ts`**：`AIMAInstance` 实现 `SpawnExecutionSessionFn`，新建独立子执行 session，注入 EventBus 事件，传入 `createAimaMcpServer`
3. **`src/index.ts`**：导出 `SpawnExecutionSessionFn` 类型

不新增模块文件，不新增依赖，只修改两个核心文件 + 更新 public API 导出。

---

## Technical Context

**Language/Version**: TypeScript（Bun runtime）
**Primary Dependencies**: 现有 AIMA 依赖，无新增
**Testing**: Bun test
**Constraints**: 不破坏任何现有测试；子执行 session 不进入 ThreadRunner session 管理；向后兼容（不传 spawnExecutionSession 时 MCP server 正常工作）
**Performance**: 子执行 session 是一次性的，完成即释放，无持久开销

---

## Architecture Decisions

### AD-01：回调注入 vs 直接耦合

**决策**：回调注入（`SpawnExecutionSessionFn`），而非 `createAimaMcpServer` 直接依赖 `AIMAInstance`。

原因：
- 避免循环依赖（`src/mcp` ↔ `src/instance`）
- MCP server 可独立测试（mock 回调）
- 回调未提供时，MCP server 仍可完整运行（只有该 tool 报错）

### AD-02：子 session 的 Adapter 类型

**决策**：子执行 session 使用 `pi-coding-agent` adapter 模式（即 `adapters.get('brainstem')` 的 adapter）。

原因：
- 子执行需要完整工具集（编写代码、调用工具等）
- 复用已有 adapter 实例，不新建 adapter 对象
- `executionModel` 作为覆盖 modelId 传入（adapter 本身支持按 session 使用不同 model）
  - 如果 adapter 不支持按 session override，则为子执行单独创建临时 adapter 实例

### AD-03：子 session 的 session key

**决策**：子执行 session 使用独立 UUID 作为 key，不进入 ThreadRunner 的 `${brain}:${threadId}` 命名空间。

格式：`sub-exec:${crypto.randomUUID()}`

原因：
- 与主 Brainstem session 完全隔离（不同 session key，不共享对话历史）
- ThreadRunner 不感知子 session 的存在
- UUID 是全局唯一的 `executionSessionId`，可写入 Brainstem slot

### AD-04：Amygdala 复用策略

**决策**：子执行 session 复用同一 `amygdala` 实例（AIMAInstance 已有的），通过 `createAimaExtension` 调用时传入同一 amygdala。

原因：
- 保持一致的安全边界（brainstem allowedTools 对子执行也生效）
- 不新建 amygdala 实例，避免策略不一致

### AD-05：EventBus 事件设计

**决策**：子执行 session 产生 `brain.activate` + `brain.complete` 事件，携带 `{ brain: 'brainstem', isSubExecution: true, executionSessionId }`。

不触发 ThreadRunner 的路由逻辑（`notifySlotDone` 不 emit）。

原因：
- 可观察性需求（监控子执行生命周期）
- `isSubExecution: true` 标记让外部消费者可过滤
- ThreadRunner 不应被子执行的完成事件触发

### AD-06：executionModel 覆盖机制

**决策**：若 adapter 支持 per-call model override（pi-coding-agent AdapterConfig 有 `modelId`），为子执行创建临时 adapter 实例（仅配置不同 modelId）。

原因：
- `PiCodingAgentAdapterConfig.modelId` 是构造时固定的
- 需要不同 model 就需要不同 adapter 实例
- 内存开销极小，子执行结束后 adapter 实例被 GC

---

## Source Code Changes

```
src/
├── mcp/index.ts      ← SpawnExecutionSessionFn 类型定义；createAimaMcpServer opts 参数；handler 真实实现
├── instance.ts       ← AIMAInstance 实现 SpawnExecutionSessionFn；executionModel config 字段；EventBus 事件
└── index.ts          ← 导出 SpawnExecutionSessionFn 类型

tests/
├── unit/aima-mcp.test.ts         ← spawn_execution_session handler 测试（mock 回调）
└── unit/aima-instance.test.ts    ← 子执行 session 集成测试（eventBus 事件验证）
```

---

## Work Package Breakdown

### WP01 — MCP Tool 真实实现

**范围**：修改 `src/mcp/index.ts`，实现 `SpawnExecutionSessionFn` 类型 + `createAimaMcpServer` 回调注入 + handler 真实逻辑。

**子任务**：
- T001: 定义 `SpawnExecutionSessionFn` 类型（在 `src/mcp/index.ts` 顶部）：
  ```typescript
  export type SpawnExecutionSessionFn = (params: {
    taskDescription: string
    model?: string
  }) => Promise<{
    executionSessionId: string
    result: string
  }>
  ```
- T002: 修改 `createAimaMcpServer()` 签名，新增 `opts?: { spawnExecutionSession?: SpawnExecutionSessionFn }` 第三参数（第二参数已存在，保持向后兼容）
- T003: 修改 `spawn_execution_session` handler：
  - 若 `opts?.spawnExecutionSession` 存在：调用回调，返回真实 `executionSessionId` 和 `result`
  - 若不存在：返回明确错误消息 `"spawn_execution_session: sub-execution not configured"`（不再是 stub 文本）
- T004: 新增/扩展 `src/mcp/index.ts` 的单元测试 — mock `spawnExecutionSession` 回调，验证：
  - 回调被调用时参数正确（taskDescription, model）
  - 返回值格式正确（executionSessionId UUID 格式，result string）
  - 未配置回调时返回明确错误消息
  - 现有其他 tool handlers 不受影响（向后兼容）

**产出**：`src/mcp/index.ts`（修改），≥4 新测试

---

### WP02 — AIMAInstance 子执行实现

**范围**：修改 `src/instance.ts`，实现子执行 session 的完整逻辑，并传入 MCP server。

**子任务**：
- T005: `AIMAInstanceConfig` 新增 `executionModel?: string`（默认 `'claude-sonnet-4-6'`），更新 JSDoc 注释
- T006: 新增私有方法 `private async spawnSubExecution(params: { taskDescription: string, model?: string })` — 实现子执行逻辑：
  1. 生成 `executionSessionId = crypto.randomUUID()`
  2. 确定 model：`params.model ?? this.config.executionModel ?? 'claude-sonnet-4-6'`
  3. 为子执行创建独立 adapter 实例（若 executionModel ≠ brainstem model，新建临时 PiCodingAgentAdapter）
  4. 通过 `createAimaExtension()` 创建独立 Extension（复用 amygdala，session key = `sub-exec:${executionSessionId}`）
  5. Emit `brain.activate` 事件：`{ brain: 'brainstem', sessionId: executionSessionId, isSubExecution: true }`
  6. 运行 Extension session（`initialPrompt = taskDescription`），等待完成
  7. Emit `brain.complete` 事件：`{ brain: 'brainstem', sessionId: executionSessionId, isSubExecution: true, executionSessionId }`
  8. 返回 `{ executionSessionId, result }` — result 从 session 输出提取（最后一条 assistant 消息）
- T007: 修改 `start()` 方法中 `createAimaMcpServer()` 调用，传入 `{ spawnExecutionSession: this.spawnSubExecution.bind(this) }` 作为 opts
- T008: 新增单元测试 — 验证：
  - `spawnSubExecution` 使用正确 model（优先 params.model > executionModel config > 默认值）
  - EventBus 收到 `brain.activate` + `brain.complete` 事件，含 `isSubExecution: true`
  - 子执行不影响主 Brainstem session 历史（session key 隔离验证）
  - `executionSessionId` 是有效 UUID 格式

**产出**：`src/instance.ts`（修改），≥4 新测试

---

### WP03 — Public API 导出 + 集成测试

**范围**：更新 `src/index.ts` 导出；新增端到端集成冒烟测试。

**子任务**：
- T009: `src/index.ts` 新增导出：`export type { SpawnExecutionSessionFn } from './mcp/index.ts'`
- T010: 集成测试（`tests/integration/spawn-execution-session.test.ts`）：
  - 场景 A：mock `spawnExecutionSession` 回调，验证 MCP tool → 回调 → 返回完整链路
  - 场景 B：不配置 `spawnExecutionSession`，验证 MCP tool 返回明确错误
  - 场景 C：配置 `executionModel: 'claude-opus-4-6'`，验证子执行使用该 model（通过 adapter mock 验证）

**产出**：`src/index.ts`（修改），≥3 集成测试

---

## Success Gates

| Gate | Criteria |
|------|----------|
| 类型检查 | `bun run typecheck` 零错误 |
| Lint | `biome check` 通过 |
| 现有测试 | 全部通过（零 regression） |
| 新增测试 | ≥11 个，全绿 |
| stub 替换 | `spawn_execution_session` 不再返回 stub 文本 |
| 独立性 | 子执行 session key 与主 session 不同，对话历史隔离 |
| 向后兼容 | 不配置 `spawnExecutionSession` 时，MCP server 正常工作 |

---

## Complexity Tracking

改动适中：2 个核心文件（mcp/index.ts, instance.ts）+ 1 个导出文件，约 80-120 行变动。
无新模块，无新依赖。主要复杂度在子执行 session 的生命周期管理和 EventBus 事件设计。
