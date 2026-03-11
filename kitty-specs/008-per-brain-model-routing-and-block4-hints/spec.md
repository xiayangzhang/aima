# Feature Specification: Per-Brain Model Routing & Block 4 Contextual Hints

**Feature**: 008-per-brain-model-routing-and-block4-hints
**Status**: Draft
**Created**: 2026-03-11
**Depends on**: Feature 002 (Brain Runtime), Feature 006 (pi-coding-agent Adapter)

---

## Overview

AIMA 当前有两个已实现但未正确激活的核心能力：

1. **Per-Brain Model Routing 缺失**：三个认知脑区理论上应使用不同 LLM 模型，但 `buildAdapters()` 对所有脑区使用同一 `limbicModel`。

2. **Block 4 Contextual Hints 未传入**：`assembleContext()` 接受 `AssembleBlock4Opts`，用于激活脑区专属记忆检索路径，但 `ThreadRunner.activateBrain()` 从未传入 `opts`，导致脑区专属路径永远不走。

---

## Problem Statement

### P1：所有脑区使用同一模型

```typescript
// src/instance.ts — 当前问题
const limbicModel = config.brainModels?.limbic ?? 'claude-sonnet-4-6'
const adapter = new PiCodingAgentAdapter({ modelId: limbicModel, ... })
adapters.set('limbic', adapter)
adapters.set('cortex', adapter)    // 同一个 adapter！
adapters.set('brainstem', adapter) // 同一个 adapter！
```

`brainModels.cortex` 和 `brainModels.brainstem` 配置字段声明了却从未使用。

### P2：Block 4 脑区专属检索永远不激活

```typescript
// src/runner/index.ts:178 — 当前问题
const { systemPrompt, injectedMemoryIds } = await assembleContext(
  brain, workspace, threadId, assemblerConfig, cachedBlock12[brain],
  // opts 未传！Block 4 永远走 generic fallback
)
```

---

## Functional Requirements

### FR-01：每脑区独立 Adapter 实例（模型路由）

`buildAdapters()` 为每个认知脑区创建独立 Adapter 实例，使用各自的 model ID：

**默认模型**：
- `limbic`: `'claude-haiku-4-5-20251001'`（快速路由 + 通信，速度优先）
- `cortex`: `'claude-sonnet-4-6'`（推理 + 规划，能力优先）
- `brainstem`: `'claude-sonnet-4-6'`（执行 + 工具调用，能力优先）

**验收条件**：
- 三个脑区使用各自配置的 model ID 创建独立 Adapter 实例
- 不指定 `brainModels` 时使用上述默认值（不再用 `limbicModel` 作为全局默认）
- `pi-agent`、`pi-coding-agent`、`claude-sdk` 三种 adapter 类型均支持
- 现有不传 `brainModels` 的代码零修改可运行

### FR-02：ThreadRunner 传入 Block 4 Contextual Hints

`activateBrain()` 根据当前脑区和已有 Slot 信息构建 `AssembleBlock4Opts` 并传入 `assembleContext()`：

**Hints 提取规则**：

| 脑区 | opts 字段 | 来源优先级 |
|------|-----------|-----------|
| limbic | `situation` | `thread.trigger`（首次激活，用 trigger 做语义 fallback 检索） |
| cortex | `situation` | `thread.trigger` |
| brainstem | `taskType` | cortex slot `output.task_type` → 降级到 `thread.trigger` |

说明：
- `thread.trigger` 是用户输入/触发内容，是最通用的 hint 来源
- Brainstem 优先使用 Cortex slot 的结构化 `task_type` 字段
- 所有 opts 字段均为可选，无合适 hint 时不传，Block 4 自然降级 fallback

**验收条件**：
- `assembleContext()` 调用时正确传入 `opts`
- cortex 激活时 `situation = thread.trigger`（非空时）
- brainstem 激活时优先用 cortex output 的 `task_type`，否则用 `thread.trigger`

### FR-03：`AIMAInstanceConfig.brainModels` 默认值文档化

```typescript
brainModels?: {
  /** Default: claude-haiku-4-5-20251001 — fast routing & communication */
  limbic?: string
  /** Default: claude-sonnet-4-6 — reasoning & planning */
  cortex?: string
  /** Default: claude-sonnet-4-6 — execution & tool use */
  brainstem?: string
}
```

---

## User Scenarios & Testing

### 场景 A：三脑区使用不同模型

1. 配置 `brainModels: { limbic: 'claude-haiku-4-5-20251001', cortex: 'claude-sonnet-4-6', brainstem: 'claude-sonnet-4-6' }`
2. AIMAInstance 启动，三个脑区各自持有独立 Adapter 实例
3. Mock 测试：验证各脑区 adapter 的 modelId 正确

### 场景 B：Block 4 情境检索激活

1. 用户发送 `"请帮我准备与张三的会议材料"`
2. Cortex 激活，`opts = { situation: "请帮我准备..." }`
3. Block 4 调用 `workspace.findSimilarSituations(...)` 而非 generic search
4. Cortex 系统提示包含相关情境记忆

### 场景 C：Brainstem 使用 Cortex task_type

1. Cortex slot output 包含 `{ task_type: 'document_preparation' }`
2. Brainstem 激活，`opts = { taskType: 'document_preparation' }`
3. Block 4 调用 `workspace.getProcedure('document_preparation')`

### 场景 D：向后兼容

1. 不传 `brainModels` → 使用默认值（haiku/sonnet/sonnet）
2. 所有现有测试零失败

---

## Key Entities

- **Per-Brain Adapter Map**：`Map<CognitiveBrainType, BrainAdapter>`，每个脑区独立 Adapter
- **AssembleBlock4Opts**：`{ situation?, taskType? }`，由 ThreadRunner 从 Thread/Slot 上下文构建
- **hint extraction logic**：ThreadRunner 内部，从 `thread.trigger` 和 prior slot outputs 提取

---

## Assumptions

- `thread.trigger` 是通用 hint 来源（用户输入的文本表示）
- Cortex slot output 的 `task_type` 字段是可选的
- 每脑区独立 Adapter 不影响现有 `${brain}:${threadId}` session key 机制

---

## Success Criteria

1. **模型路由**：三脑区各自使用配置的 model ID，mock 测试可验证
2. **Block 4 激活**：cortex 激活时 `findSimilarSituations` 被调用；brainstem 时 `getProcedure` 被调用
3. **向后兼容**：所有现有测试零失败
4. **`bun run typecheck` 零错误，`biome check` 通过**
5. **新增测试 ≥10 个**

---

## Out of Scope

- Limbic 的 entityId 自动提取（需要结构化 Limbic 输出，推迟）
- Block 4 hints 的跨 Thread 传递
- 脑区间委派时的 hint 透传
