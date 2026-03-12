# Feature Specification: Sub-Execution via Pi-Agent

**Feature ID**: 011
**Status**: Specified

---

## Problem

`AIMAInstance.spawnSubExecution()` 当前使用原生 `@anthropic-ai/sdk messages.create()` 来执行子任务。这导致：

1. **Amygdala 不覆盖子执行工具调用** — 子执行 session 中调用的工具不经过任何工具策略检查
2. **子执行 session 无工具访问** — 只有纯文本 LLM 调用，无法执行 bash/文件操作/workspace MCP 工具
3. **EventBus 工具事件缺失** — 审计链不覆盖子执行期间的工具使用
4. **无 session 系统提示** — 子执行 LLM 调用没有系统提示，行为不可控

---

## Goal

将 `spawnSubExecution()` 从原生 SDK 替换为 pi-coding-agent session，获得：

- Amygdala 工具拦截（完全相同的策略）
- 完整工具访问（bash/read/edit/write + workspace MCP 工具）
- EventBus `tool.pre_use/post_use/blocked` 事件（完整审计链）
- 最小化系统提示（sub-execution identity）

---

## Scope

**仅修改 `claude-sdk` adapter 路径下的 `spawnSubExecution`**。
`pi-coding-agent` adapter 路径当前没有 `spawn_execution_session` 工具，不在本 feature 范围内。

**不改变**：
- `SpawnExecutionSessionFn` 类型（已稳定，公共 API）
- `spawn_execution_session` MCP tool 定义（只改实现层）
- 测试 escape hatch `_subQueryFn`（保留，用于单元测试）

---

## Success Criteria

- `spawnSubExecution()` 使用 pi-coding-agent session（不再 import `Anthropic` from `@anthropic-ai/sdk`）
- 子执行中的工具调用触发 `tool.pre_use`/`tool.post_use`/`tool.blocked` EventBus 事件
- Amygdala `check()` 在子执行工具调用前被调用
- `result` 返回 session 的最后一条 assistant 文本消息
- `bun run typecheck` 零错误，`biome check` 通过
- 现有 388 测试全部通过（零 regression）
