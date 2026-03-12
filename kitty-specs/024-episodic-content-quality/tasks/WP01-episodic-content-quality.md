---
work_package_id: "WP01"
subtasks:
  - "T001"
  - "T002"
title: "Episodic Content Quality — buildEpisodicContent upgrade + tests"
phase: "Phase 1 - Implementation + Tests"
lane: "planned"
assignee: ""
agent: ""
shell_pid: ""
review_status: ""
dependencies: []
reviewed_by: ""
history:
  - timestamp: "2026-03-13T00:00:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via spec-kitty agent workflow"
---

# Work Package Prompt: WP01 — Episodic Content Quality

## Objectives & Success Criteria

将 `src/dmn/reactive/index.ts` 中的 `buildEpisodicContent()` 从 JSON 输出升级为认知摘要字符串，
并在 `tests/unit/dmn/dmn-reactive.test.ts` 中新增断言覆盖。完成后：

- `buildEpisodicContent()` 返回可读模板字符串，不含 JSON
- 字符串包含：`[brain]`、路由决策（`route → <next>` / `complete` / `defer` / `error`）、handoff 摘录（最多 200 字符）、reply 预览（最多 100 字符）、status、thread_id
- 错误路径包含 `stopReason` 字段
- 新增 5 个单元测试，覆盖 routing / complete / reply / error / defer 五种路径
- `bun tsc --noEmit` 零编译错误
- 现有测试套件零回归

**To implement this WP**:
```bash
spec-kitty implement WP01
```

---

## Context & Constraints

- **Spec**: `kitty-specs/024-episodic-content-quality/spec.md`
- **Plan**: `kitty-specs/024-episodic-content-quality/plan.md` — 含完整实现草稿和示例输出
- **Source files**:
  - `src/dmn/reactive/index.ts` — `buildEpisodicContent()` 在第 231–245 行
- **Test files**:
  - `tests/unit/dmn/dmn-reactive.test.ts` — 在现有 describe 块后追加新 describe 块

### Call context

`buildEpisodicContent(event)` 由 `assignSegmentAndWriteEpisodic()` 在 `brain.complete` 事件处理路径中调用（第 161 行）。测试通过 `bus._dispatch` 发送 `brain.complete` 事件，然后断言 `config.workspace.writeMemory` 收到的 `content` 参数。

---

## T001 — Upgrade `buildEpisodicContent()` in `src/dmn/reactive/index.ts`

**Goal**: Replace `JSON.stringify(...)` with a cognitive-summary template string.

**Location**: `src/dmn/reactive/index.ts`, lines 231–245 (private method `buildEpisodicContent`).

**New implementation** (from `plan.md`):

```typescript
private buildEpisodicContent(event: BrainEvent): string {
  const { brain, thread_id, payload } = event
  const outputSlot = payload.outputSlot as Record<string, unknown> | undefined
  const output = outputSlot?.output as Record<string, unknown> | undefined
  const status = outputSlot?.status as string | undefined
  const next = (output?.next as string | undefined) ?? null
  const handoff = (output?.handoff as string | undefined) ?? null
  const reply = (output?.reply as string | undefined) ?? null
  const stopReason = payload.stopReason as string | undefined

  const decision =
    stopReason && stopReason !== 'end_turn'
      ? 'error'
      : next === null || next === undefined
        ? 'complete'
        : next === 'self'
          ? 'defer'
          : `route → ${next}`

  const parts: string[] = [`[${brain}] decided: ${decision}`]

  if (handoff) {
    parts.push(`handoff: "${handoff.slice(0, 200)}"`)
  }
  if (reply) {
    parts.push(`reply: "${reply.slice(0, 100)}"`)
  }
  if (decision === 'error' && stopReason) {
    parts.push(`stopReason: ${stopReason}`)
  }
  parts.push(`status: ${status ?? 'unknown'}`)
  parts.push(`thread: ${thread_id}`)

  return parts.join(' | ')
}
```

**Example outputs for reference:**

Routing case:
```
[limbic] decided: route → cortex | handoff: "User asked about invoice X." | status: done | thread: abc123
```

Complete case (no next):
```
[brainstem] decided: complete | reply: "Here are the steps to..." | status: done | thread: abc123
```

Error case:
```
[cortex] decided: error | stopReason: max_tokens | status: done | thread: abc123
```

Defer case:
```
[limbic] decided: defer | handoff: "Waiting for user clarification." | status: done | thread: abc123
```

**Verification**: `bun tsc --noEmit` must pass after this change.

---

## T002 — Add unit tests for new format in `tests/unit/dmn/dmn-reactive.test.ts`

**Goal**: Assert that `buildEpisodicContent()` produces the expected cognitive-summary string in all five cases. Add a new `describe` block after the existing `'handler error isolation'` block.

**Strategy**: Dispatch a `brain.complete` event via `bus._dispatch(...)`, await async settlement with `await new Promise((r) => setTimeout(r, 10))`, then inspect `config.workspace.writeMemory.mock.calls` for the call whose memory object has `type: 'episodic'`. Assert on the `content` field.

**Test structure**:

```typescript
describe('buildEpisodicContent format', () => {
  it('routing case: content contains [brain], route decision, handoff excerpt', async () => {
    // brain.complete with output.next='cortex' and output.handoff='User asked about invoice X.'
    // Assert content includes '[limbic]', 'route → cortex', 'handoff: "User asked'
  })

  it('complete case: next=null → content contains "complete"', async () => {
    // brain.complete with output.next=null/absent
    // Assert content includes 'complete', does NOT contain 'route'
  })

  it('reply case: content contains reply preview when reply present', async () => {
    // brain.complete with output.reply='Here are the steps...'
    // Assert content includes 'reply: "Here are the steps'
  })

  it('error case: non-end_turn stopReason → content contains "error" and stopReason', async () => {
    // brain.complete with payload.stopReason='max_tokens'
    // Assert content includes 'error', 'stopReason: max_tokens'
  })

  it('defer case: next="self" → content contains "defer"', async () => {
    // brain.complete with output.next='self'
    // Assert content includes 'defer', does NOT contain 'route'
  })
})
```

**Notes**:
- Each test uses a fresh `makeConfig()` + `new DmnReactive(config)` + `await reactive.start()`
- The `outputSlot` field must be nested inside `payload.outputSlot`, with `output` inside that
- The `writeMemory` mock may be called multiple times (episodic + significance_mark); find the episodic call by checking `type === 'episodic'` in the call args
- `brain.complete` is the `event_type`; `level` defaults to `'INFO'` in `makeEvent()`

**Verification**: `bun test tests/unit/dmn/dmn-reactive.test.ts` — all tests pass including existing ones.
