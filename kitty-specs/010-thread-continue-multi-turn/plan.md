# Implementation Plan: Thread Continue (Multi-Turn Dialog)

**Branch**: `010-thread-continue-multi-turn` | **Date**: 2026-03-12 | **Spec**: [spec.md](spec.md)

---

## Summary

新增 `AIMAInstance.continue(threadId, input)` 方法，三步走：

1. **Workspace 层**：新增 `reopenThread(id, trigger)` 方法——将 Thread 状态重置为 `active` + 更新 `trigger` 字段，一次原子写入
2. **AIMAInstance 层**：新增 `continue()` 公共方法，调用 `reopenThread()` 然后走与 `receive()` 完全相同的 `threadRunner.trigger('limbic')` + `waitForComplete()` 路径
3. **公共 API**：`src/index.ts` 无需改动（`AIMAInstance` 已导出，新方法自动可见）

改动范围：`src/workspace/index.ts`（+1 方法）、`src/instance.ts`（+1 方法），无新模块，无新依赖。

---

## Technical Context

**Language/Version**: TypeScript（Bun runtime）
**Primary Dependencies**: 现有 AIMA 依赖，无新增
**Testing**: Bun test（单元）；涉及 DB 的测试需要 `AIMA_TEST_DATABASE_URL`
**Constraints**: `receive()` 零 regression；`continue()` 必须复用现有 `brainSessions` Map（不能重置 session 历史）

---

## Architecture Decisions

### AD-01：`reopenThread()` vs 扩展 `updateThreadState()`

**决策**：新增独立方法 `reopenThread(id, trigger)`，不修改 `updateThreadState()`。

原因：
- `updateThreadState()` 只更新 `state` 字段，语义清晰
- `continue()` 需要同时更新 `state` + `trigger`——两个字段原子写入，合并为一次 DB 操作
- 分开会引入竞态：两次 `await` 之间 trigger 暂时为旧值

### AD-02：`continue()` 支持的 Thread 状态范围

**决策**：只接受 `complete` 和 `interrupted`，不接受 `active` 和 `waiting`。

原因：
- `active` 状态表示 ThreadRunner 正在处理，并发 `continue()` 会破坏 `processingThreads` 锁的保护
- `waiting` 状态由 DMN pending 机制管理，不通过 `continue()` 处理
- `complete` + `interrupted` 是"已静止"的状态，安全重新激活

### AD-03：`trigger` 更新策略

**决策**：`continue()` 必须更新 `thread.trigger`，不可选。

原因（效果导向）：
- Block 4 hints（Feature 008）使用 `thread.trigger` 作为 hint 来源
- 若不更新，Brainstem 的 `taskType` hint 永远基于第一条消息，记忆检索偏移越来越严重
- 对 token 无额外开销（仅一次 DB 写入）

### AD-04：并发保护

**决策**：`continue()` 依赖 ThreadRunner 已有的 `processingThreads` Set，不新增锁。

`processingThreads` 在 `route()` 开始时 `add`，结束时 `delete`。`continue()` 通过 `reopenThread()` 的状态校验（拒绝 `active` 状态）实现保护——若 Thread 正在被路由则状态为 `active`，`reopenThread()` 抛出错误，调用方自然感知冲突。

---

## Source Code Changes

```
src/
├── workspace/index.ts   ← 新增 reopenThread(id, trigger) 方法
└── instance.ts          ← 新增 continue() 公共方法

tests/
└── unit/aima-instance.test.ts    ← 新增 continue() 测试（≥6 个）
```

---

## Work Package Breakdown

### WP01 — reopenThread + AIMAInstance.continue()

**范围**：全部实现（改动极小，单 WP 足够）。

**子任务**：
- T001: `CognitiveWorkspace.reopenThread(id: string, trigger: string)` — 原子更新 `state='active'` + `trigger` + `updatedAt`；Thread 不存在时抛出；当前状态不是 `complete/interrupted` 时抛出
- T002: `AIMAInstance.continue(threadId, input)` — 调用 `reopenThread()`，走与 `receive()` 相同路径（identity lazy-init → `threadRunner.trigger('limbic')` → `waitForComplete()`）
- T003: 单元/集成测试（≥6 个）：session 保留、状态转换、错误路径、trigger 更新

**产出**：2 个文件各 +20 行，≥6 新测试

---

## Success Gates

| Gate | Criteria |
|------|----------|
| 类型检查 | `bun run typecheck` 零错误 |
| Lint | `biome check` 通过 |
| 现有测试 | 全部通过（零 regression） |
| 新增测试 | ≥6 个，全绿 |
| session 保留 | `continue()` 不重置 `brainSessions` 中的 session |
| trigger 更新 | `continue()` 后 `thread.trigger` 等于新 content |

---

## Complexity Tracking

极小改动：2 个文件，各约 20 行。单 WP 足够。


**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/kitty-specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/spec-kitty.plan` command. See `.kittify/templates/commands/plan.md` for the execution workflow.

The planner will not begin until all planning questions have been answered—capture those answers in this document before progressing to later phases.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]  
**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]  
**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]  
**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]  
**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]
**Project Type**: [single/web/mobile - determines source structure]  
**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]  
**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]  
**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

[Gates determined based on constitution file]

## Project Structure

### Documentation (this feature)

```
kitty-specs/[###-feature]/
├── plan.md              # This file (/spec-kitty.plan command output)
├── research.md          # Phase 0 output (/spec-kitty.plan command)
├── data-model.md        # Phase 1 output (/spec-kitty.plan command)
├── quickstart.md        # Phase 1 output (/spec-kitty.plan command)
├── contracts/           # Phase 1 output (/spec-kitty.plan command)
└── tasks.md             # Phase 2 output (/spec-kitty.tasks command - NOT created by /spec-kitty.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

*Fill ONLY if Constitution Check has violations that must be justified*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |