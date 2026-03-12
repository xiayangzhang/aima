# Tasks: Sub-Execution via Pi-Agent

**Feature**: 011-sub-execution-via-pi-agent
**Total WPs**: 1
**Total Subtasks**: 3

---

## Phase 1 — Implementation

### WP01: Replace spawnSubExecution with pi-coding-agent session
**Priority**: P0 | **Status**: planned | **File**: [WP01-replace-spawn-execution.md](tasks/WP01-replace-spawn-execution.md)

替换 `AIMAInstance.spawnSubExecution()` 的核心实现，从原生 `@anthropic-ai/sdk messages.create()` 改为 pi-coding-agent session，获得 Amygdala 覆盖 + 工具访问 + EventBus 审计链。

**Subtasks**:
- [x] T001: `runSubExecutionViaPiAgent()` — 新私有方法，pi-coding-agent session 创建、运行、结果提取
- [x] T002: 更新导入 + JSDoc（删除 `@anthropic-ai/sdk` import，新增 pi-coding-agent imports）
- [x] T003: ≥4 单元测试（Amygdala 调用、EventBus tool 事件、结果提取、blocked 工具）

**Dependencies**: none
**Estimated prompt size**: ~250 lines
