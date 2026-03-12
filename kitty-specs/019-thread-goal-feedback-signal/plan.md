# Implementation Plan: Thread Goal Feedback Signal
*Path: kitty-specs/019-thread-goal-feedback-signal/plan.md*

**Branch**: `019-thread-goal-feedback-signal` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/kitty-specs/019-thread-goal-feedback-signal/spec.md`

## Summary

为 `threads` 表添加可选 `goal text` 列，并通过 `CreateThreadParams.goal?` 暴露到 API 层。当 DMN Reactive 处理 `brain.complete` 事件时，若线程携带 goal，则调用 Haiku LLM 评估最终 reply 是否达成目标，以评估结果（positive/negative）代替现有启发式（`evaluateOutcome`）标记注入记忆。没有 goal 的线程行为不变。

## Technical Context

**Language/Version**: TypeScript (Bun runtime)
**Primary Dependencies**: `drizzle-orm`（现有），`../../llm`（`callLlm`/`parseLlmJson`，DMN 已有导入）
**Storage**: PostgreSQL（`threads` 表 schema 变更，生成 Drizzle migration）
**Testing**: Bun test
**Target Platform**: Linux server (AKS)
**Project Type**: Single project
**Performance Goals**: goal 评估异步 fire-and-forget，不在关键路径上；LLM 调用延迟不影响 brain.complete 事件响应
**Constraints**: goal 字段可选，不影响现有线程创建路径；LLM 失败必须静默回退；不新增 ICognitiveWorkspace 方法
**Scale/Scope**: 改动约 80 行代码（schema + types + workspace + DMN），新增约 8 个测试用例

## Constitution Check

*无 constitution 文件，跳过。*

## Project Structure

### Documentation (this feature)

```
kitty-specs/019-thread-goal-feedback-signal/
├── plan.md
├── quickstart.md
└── tasks/
    ├── WP01-thread-goal-schema.md
    └── WP02-dmn-goal-feedback.md
```

### Source Code (repository root)

```
src/
├── schema/threads.ts            # 新增 goal text 列（Drizzle schema）
├── types/index.ts               # Thread + CreateThreadParams 新增 goal 字段
├── workspace/index.ts           # createThread 写入 goal；mapThreadRow 映射 goal
└── dmn/reactive/index.ts        # feedbackMemoryUsage 升级为 goal-aware

drizzle/migrations/              # 新增 migration 文件（spec-kitty generate-migration）

tests/unit/dmn/
└── dmn-reactive.test.ts         # 新增 goal 评估测试场景
```

**Structure Decision**: Single project，改动集中在 4 个源文件 + migration + 测试更新。

## Phase 0: Research

**代码审查结论**：

### Part A — Thread.goal 字段

| 决策 | 结论 | 依据 |
|---|---|---|
| `threads` 表当前列 | `id, state, sourceChannel, initiatedBy, trigger, createdAt, updatedAt` | `src/schema/threads.ts` 直接读取确认 |
| `goal` 列是否已存在 | **不存在** | 同上 |
| `Thread` interface 当前字段 | `id, state, sourceChannel, initiatedBy, trigger, createdAt, updatedAt` | `src/types/index.ts` 第 35-43 行 |
| `CreateThreadParams` 当前字段 | `trigger?, initiatedBy, sourceChannel?` | `src/types/index.ts` 第 99-103 行 |
| `mapThreadRow` 位置 | `src/workspace/index.ts` 第 50-60 行 | 直接读取确认 |
| `createThread` 写入逻辑 | insert + return，需新增 `goal: params.goal ?? null` | `src/workspace/index.ts` 第 209-221 行 |

### Part B — DMN Goal Feedback

| 决策 | 结论 | 依据 |
|---|---|---|
| `feedbackMemoryUsage` 位置 | `src/dmn/reactive/index.ts` 第 249-255 行 | 直接读取确认 |
| 当前行为 | 调用 `evaluateOutcome(event)` → 调用 `markMemoryUsed` | 同上 |
| `evaluateOutcome` 逻辑 | error → negative；reply → positive；next=brainstem → positive；其余 → neutral | 第 257-268 行 |
| `callLlm`/`parseLlmJson` 导入 | 已从 `../../llm` 导入（`isTopicSwitch` 和 `retroactiveCorrection` 均有使用） | `src/dmn/reactive/index.ts` 第 3 行 |
| `workspace.getThread` | `ICognitiveWorkspace` 已有方法（第 153 行）——不需要新增 | `src/types/index.ts` |
| `markMemoryUsed` | `ICognitiveWorkspace` 已有方法（第 171 行）——不需要新增 | `src/types/index.ts` |
| output slot reply 来源 | `event.payload.outputSlot.output.reply`（payload 中已有数据，无需额外 DB 查询）| `feedbackMemoryUsage` + `buildEpisodicContent` 的既有模式 |
| thread_id 可用性 | `event.thread_id` 在 `brain.complete` 路径中已有（DMN `assignSegmentAndWriteEpisodic` 依赖同一字段） | `handleBrainComplete` → `feedbackMemoryUsage` 路径 |
| `thread.complete` 事件 | `ThreadRunner` 监听 `workspace.onThreadComplete`，emit `event_type: 'thread.complete'`（`src/runner/index.ts` 第 70-79 行）——但 `feedbackMemoryUsage` 挂在 `brain.complete` 上，不在 `thread.complete` 上，这是正确的设计（injectedMemoryIds 在 brain.complete 事件中） | `src/runner/index.ts` |

### 实现草稿

#### Part A — Schema（`src/schema/threads.ts`）

在 `threads` pgTable 定义中，`updatedAt` 字段后新增：
```typescript
goal: text('goal'),
```

#### Part A — Types（`src/types/index.ts`）

`Thread` interface 新增（`trigger` 字段后）：
```typescript
goal: string | null
```

`CreateThreadParams` interface 新增：
```typescript
goal?: string
```

#### Part A — Workspace（`src/workspace/index.ts`）

`mapThreadRow` 新增：
```typescript
goal: row.goal ?? null,
```

`createThread` 写入新增：
```typescript
goal: params.goal ?? null,
```

#### Part B — DMN Reactive（`src/dmn/reactive/index.ts`）

`feedbackMemoryUsage` 替换实现：

```typescript
private async feedbackMemoryUsage(event: BrainEvent): Promise<void> {
  const injectedIds = event.payload.injectedMemoryIds as string[] | undefined
  if (!injectedIds || injectedIds.length === 0) return

  const fallbackOutcome = this.evaluateOutcome(event)

  // Goal-based evaluation: attempt quality signal if thread has a goal
  if (event.thread_id) {
    try {
      const thread = await this.config.workspace.getThread(event.thread_id)
      const goal = thread?.goal

      if (goal) {
        const outputSlot = event.payload.outputSlot as Record<string, unknown> | undefined
        const output = outputSlot?.output as Record<string, unknown> | undefined
        const reply = output?.reply as string | undefined

        if (reply) {
          const prompt = `You are evaluating whether an AI response achieved a stated goal.

Goal: ${goal}

Response: ${reply}

Did the response achieve the goal? Respond with JSON: {"achieved": boolean, "reason": string}`

          const llmResponse = await callLlm(prompt, this.config.llm)
          const result = parseLlmJson<{ achieved: boolean; reason: string }>(
            llmResponse,
            { achieved: false, reason: 'evaluation failed' },
          )
          const outcome: UsageOutcome = result.achieved ? 'positive' : 'negative'
          await this.config.workspace.markMemoryUsed(injectedIds, outcome)
          return
        }
      }
    } catch {
      // Goal evaluation failed — fall through to heuristic
    }
  }

  await this.config.workspace.markMemoryUsed(injectedIds, fallbackOutcome)
}
```

**重要设计细节**：
- `evaluateOutcome(event)` 在 try 前计算（`fallbackOutcome`），确保 catch 路径总有值可用
- reply 为 null 时不调用 LLM，回退到 `fallbackOutcome`（通常为 `'neutral'`，因为没有 reply）
- try/catch 包裹 getThread + LLM 调用 + markMemoryUsed（LLM 路径），catch 时执行启发式路径的 `markMemoryUsed`
- `return` 在 LLM 路径成功执行后，确保不会重复调用 `markMemoryUsed`

## Complexity Tracking

*无 Constitution 违规，跳过。*
