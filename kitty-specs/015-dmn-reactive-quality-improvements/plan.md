# Implementation Plan: DMN Reactive Quality Improvements
*Path: kitty-specs/015-dmn-reactive-quality-improvements/plan.md*

**Branch**: `015-dmn-reactive-quality-improvements` | **Date**: 2026-03-12 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/kitty-specs/015-dmn-reactive-quality-improvements/spec.md`

## Summary

在 `src/dmn/reactive/index.ts` 中实现两处质量改进：
1. **P2-A 纠错预过滤**：`retroactiveCorrection()` 加入规则预检，正常输出直接跳过 LLM 调用
2. **P2-B Episodic 内容重构**：`buildEpisodicContent()` 写入 `output.handoff` 认知摘要，让 episodic 记录承载脑区决策内容

改动集中在 `src/dmn/reactive/index.ts` 的两个私有方法，加上相应的单元测试更新。

## Technical Context

**Language/Version**: TypeScript (Bun runtime，与项目一致)
**Primary Dependencies**: 无新增依赖
**Storage**: N/A（不涉及 DB schema 变更）
**Testing**: Bun test
**Target Platform**: Linux server (AKS)
**Project Type**: Single project
**Performance Goals**: P2-A 改动后，正常 brain.complete 路径的 LLM call 数从 1 降到 0
**Constraints**: 不改接口签名；不改并行结构；本 feature 基于 Feature 013 完全合并后的代码（BrainOutput `{next, reply, handoff}` 已就位）
**Scale/Scope**: 改动 ~30 行代码，更新 ~3 个测试文件

## Spec Correction Notes

无 spec 偏差。代码审查确认：

- `retroactiveCorrection` 当前确实无条件调用 LLM（仅有 `recentEvents.length < 2` 的早期返回）
- `buildEpisodicContent` 当前不包含 `handoff` 字段
- **依赖说明**：本 feature 基于 Feature 013 完全合并后的代码（`buildEpisodicContent` 已改为 `next`/`hasReply`，`evaluateOutcome` 已改为 `reply != null`/`next === 'brainstem'`）

## Constitution Check

*无 constitution 文件，跳过。*

## Project Structure

### Documentation (this feature)

```
kitty-specs/015-dmn-reactive-quality-improvements/
├── plan.md              # This file
├── quickstart.md        # Phase 1 output
└── tasks/               # Phase 2 output (/spec-kitty.tasks)
```

### Source Code (repository root)

```
src/
└── dmn/reactive/index.ts        # 主改动文件（两个私有方法）

tests/unit/dmn/
├── dmn-reactive.test.ts
├── dmn-reactive-brain-complete.test.ts
└── dmn-comprehensive.test.ts
```

**Structure Decision**: Single project，改动集中在 1 个源文件 + 测试更新，无新目录。

## Phase 0: Research

**代码审查结论**（无需外部研究）：

| 决策 | 结论 | 依据 |
|---|---|---|
| 规则预检位置 | `retroactiveCorrection()` 方法最开头，早期返回 | 最小改动；不影响方法签名 |
| 规则触发条件 | `status==='error'` \| `stopReason==='error'` \| `output==null` | 与设计回顾 P2-A 一致 |
| handoff 字段位置 | `buildEpisodicContent()` 中，与 `next`/`hasReply` 同级 | Feature 013 BrainOutput model |
| handoff 空值处理 | `handoff: output?.handoff \|\| null` | 空字符串也变 null，不记录无意义内容 |
| 并行结构变化 | 无：三个 Promise.all 项保持不变 | retroactiveCorrection 的早期返回是内部实现 |

### 当前 retroactiveCorrection 的缺口

```typescript
// 当前：只有一个保护
if (recentEvents.length < 2) return

// 目标：在 recentEvents 查询之前加规则预检
const outputSlot = payload.outputSlot as Record<string, unknown> | undefined
const output = outputSlot?.output as Record<string, unknown> | undefined

const hasError = outputSlot?.status === 'error'
const hasErrorStop = payload.stopReason === 'error'
const hasNoOutput = output == null

if (!hasError && !hasErrorStop && !hasNoOutput) return  // 正常情况跳过，不发 DB 查询
// 后续：recentEvents 查询 + LLM call（只有触发条件满足才走到这里）
```

**性能改进**：规则预检放在 `recentEvents` DB 查询**之前**，正常路径连 DB 都不查，零开销。

### 当前 buildEpisodicContent 的缺口

```typescript
// 当前（after Feature 013 WP03）：
return JSON.stringify({
  brain, threadId: thread_id,
  status: outputSlot?.status,
  next: (output as Record<string, unknown> | undefined)?.next,
  hasReply: (output as Record<string, unknown> | undefined)?.reply != null,
  stopReason: payload.stopReason,
  timestamp: new Date().toISOString(),
})

// 目标：加入 handoff
return JSON.stringify({
  brain, threadId: thread_id,
  status: outputSlot?.status,
  next: (output as Record<string, unknown> | undefined)?.next,
  hasReply: (output as Record<string, unknown> | undefined)?.reply != null,
  handoff: (output as Record<string, unknown> | undefined)?.handoff || null,  // ← 新增
  stopReason: payload.stopReason,
  timestamp: new Date().toISOString(),
})
```

## Phase 1: Design & Contracts

### Data Model

无 schema 变更。`handoff` 内容存入 `memories.content`（TEXT 列，已有），无需新列。

### Implementation Contracts

#### retroactiveCorrection — 规则预检

```
触发纠错 LLM 的条件（OR，满足任一即进入 LLM）：
  A: outputSlot?.status === 'error'
  B: payload.stopReason === 'error'
  C: output == null (null 或 undefined)

非触发（direct return，跳过 DB 查询 + LLM）：
  A、B、C 均不满足（正常完成）
```

已有的 `recentEvents.length < 2` 保护保留，在规则预检之后（进入 LLM 路径后才检查历史长度）。

#### buildEpisodicContent — 字段扩展

新增字段：`handoff: output?.handoff || null`（空字符串视同 null）

### Quickstart Validation

**V1 — 正常输出跳过 LLM**
```typescript
// Mock callLlm，发 brain.complete 事件 status=done，有 reply 输出
// 断言：callLlm mock 未被调用（用于纠错的那次；isTopicSwitch 的 LLM 调用不受影响）
```

**V2 — 错误 status 触发 LLM**
```typescript
// 发 brain.complete 事件 status=error
// 断言：callLlm mock 被调用（纠错路径触发）
```

**V3 — Episodic 包含 handoff**
```typescript
// 发 brain.complete，output = { next: 'brainstem', handoff: 'routing to execution layer' }
// 查询写入的 episodic，parse content JSON
// 断言：content.handoff === 'routing to execution layer'
```

**V4 — handoff 为 null 时不影响写入**
```typescript
// 发 brain.complete，output = { next: 'brainstem' }（无 handoff）
// 查询写入的 episodic
// 断言：content.handoff === null，记录正常写入
```

**V5 — 零回归**
```bash
cd /Volumes/leoyun/aima && bun test
```

## Complexity Tracking

*无 Constitution 违规，跳过。*


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