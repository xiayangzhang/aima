# Feature Specification: receive() Input Content Delivery

**Feature**: 029-receive-input-content-delivery
**Status**: draft
**Created**: 2026-03-13
**Depends on**: Feature 001 (Thread schema — `trigger` field already exists)

---

## Overview

`AIMAInstance.receive()` accepts `input.content` (the actual user message) but stores `input.externalId` as `thread.trigger`. As a result:

1. Limbic's Block 4 memory retrieval uses `externalId` (or nothing) as the situation query — semantic search is useless
2. Limbic's first LLM call receives `"Thread X — activate limbic"` as `initialPrompt` — the actual message is invisible to the brain
3. Block 3 (`assembleBlock3`) omits `thread.trigger` entirely — even if `trigger` were correct, brains can't see it in context

This feature fixes all three gaps with surgical changes to three files.

---

## Actors

- **`AIMAInstance.receive()`**: entry point for external input; creates a Thread with wrong `trigger`
- **`ThreadRunner.activateBrain()`**: sends `initialPrompt` to the LLM adapter; always uses generic text
- **`assembleBlock3()`**: builds Block 3 workspace state; omits `trigger`
- **`Thread.trigger`**: already exists in schema; `continue()` already stores `input.content` here — `receive()` should do the same

---

## Problem Statement

### P1: `receive()` stores `externalId`, not `content`, as `thread.trigger`

```typescript
// instance.ts line 242 (current — WRONG):
...(input.externalId !== undefined ? { trigger: input.externalId } : {}),
```

When `externalId` is absent (common case), `trigger` is `null`. When present, it's an opaque ID string, not meaningful text. All downstream consumers of `thread.trigger` — Block 4 retrieval and `initialPrompt` — receive garbage or nothing.

**Contrast with `continue()`** (correct):
```typescript
// instance.ts line 281 (correct):
await this.workspace.reopenThread(threadId, input.content)
```
`continue()` already stores `input.content` as `trigger`. `receive()` must do the same.

### P2: `activateBrain()` ignores `thread.trigger` for new sessions

```typescript
// runner/index.ts line 252 (current — WRONG):
: { brain, threadId, systemPrompt, initialPrompt: `Thread ${threadId} — activate ${brain}` }
```

For a new brain session, the LLM adapter uses `initialPrompt` as the first human turn. Currently this is always the generic placeholder. The brain must instead receive the actual content that triggered the thread.

### P3: Block 3 omits `thread.trigger` — content invisible in context

`assembleBlock3()` shows `thread_id` and `thread_state` but not `trigger`. Even after fixing P1+P2, a brain re-activated mid-thread (e.g. Limbic re-reading context) cannot see the original trigger in its system prompt.

---

## Functional Requirements

### FR-01: `receive()` stores `input.content` as `thread.trigger`

```typescript
// After fix:
const thread = await this.workspace.createThread({
  initiatedBy: 'external',
  trigger: input.content,
  ...(input.channel !== undefined ? { sourceChannel: input.channel } : {}),
})
```

`input.externalId` remains in the interface for API compatibility but is no longer stored in Thread (no schema change needed). It may be stored as a separate Thread field in a future feature if deduplication is required.

**Acceptance criteria**:
- `createThread` called with `trigger: input.content`
- `externalId` no longer passed to `createThread`
- Existing `continue()` behaviour unchanged

### FR-02: `activateBrain()` uses `thread.trigger` as `initialPrompt` for new sessions

Add optional `triggerContent?: string` parameter to `activateBrain()`. When present, use it as `initialPrompt` for new sessions:

```typescript
private async activateBrain(
  brain: CognitiveBrainType,
  threadId: string,
  opts?: AssembleBlock4Opts,
  triggerContent?: string,      // NEW
): Promise<void> {
  // ...
  const params: BrainRunParams = existingSessionId
    ? { brain, threadId, systemPrompt }
    : { brain, threadId, systemPrompt, initialPrompt: triggerContent ?? `Thread ${threadId} — activate ${brain}` }
```

Update callers to pass `thread.trigger ?? undefined`:
- `trigger()` (line 218): `await this.activateBrain(brain, threadId, opts, thread.trigger ?? undefined)`
- Route loop (line 183): `await this.activateBrain(nextBrain, threadId, opts, thread.trigger ?? undefined)`
- `recoverInFlightThreads()` (line 337): `await this.activateBrain('limbic', thread.id, undefined, thread.trigger ?? undefined)` (`thread` is available in the loop)
- `routePending()` (line 322): leave as `undefined` — scheduled/DMN threads don't carry user-facing message content

**Acceptance criteria**:
- New session `initialPrompt` = `thread.trigger` when trigger is non-null/non-empty
- Falls back to generic placeholder when `triggerContent` is `undefined`
- Existing session (re-activation) behaviour unchanged — no `initialPrompt` passed

### FR-03: Block 3 displays `thread.trigger`

```typescript
// context/index.ts assembleBlock3() — add after thread_state line:
...(thread?.trigger ? [`- trigger: ${thread.trigger}`] : []),
```

`trigger` is shown only when non-null/non-empty to avoid noise for DMN/scheduled threads.

**Acceptance criteria**:
- Block 3 output includes `- trigger: <content>` when `thread.trigger` is set
- Absent when `thread.trigger` is null/empty
- No other Block 3 changes

---

## User Scenarios & Testing

### Scenario A: External message through `receive()`

1. Caller: `instance.receive({ content: 'approve the budget', channel: 'teams' })`
2. Thread created with `trigger: 'approve the budget'`
3. Limbic activated — `initialPrompt = 'approve the budget'`
4. Limbic's first LLM call sees the actual request

**Test** (`tests/unit/thread-runner.test.ts`): spy on `createThread`, assert `trigger` = `content`. Spy on adapter `run`, assert `initialPrompt` = `'approve the budget'` for new session.

### Scenario B: Multi-turn via `continue()` — no regression

1. Thread complete after `receive()` call
2. Caller: `instance.continue(threadId, { content: 'please proceed' })`
3. `reopenThread(threadId, 'please proceed')` called — stores `trigger`
4. Limbic re-activated with existing session — no `initialPrompt` passed

**Test**: verify existing `continue()` tests still pass. No `initialPrompt` for re-activation.

### Scenario C: Block 3 shows trigger

1. Thread has `trigger = 'approve the budget'`
2. `assembleBlock3()` called
3. Output contains `- trigger: approve the budget`

**Test** (`tests/unit/context.test.ts`): mock `getThread` returning `trigger: 'approve the budget'`, assert output contains `- trigger: approve the budget`.

### Scenario D: Block 3 silent when trigger absent

1. Thread has `trigger = null`
2. `assembleBlock3()` output does NOT contain `trigger:` line

**Test**: mock `getThread` returning `trigger: null`, assert `trigger` line absent.

### Scenario E: `externalId` still accepted in interface, not stored

1. `receive({ content: 'hello', externalId: 'msg-123' })`
2. Thread `trigger` = `'hello'` (not `'msg-123'`)

**Test**: assert `createThread` called with `trigger: 'hello'`, no `externalId` key.

---

## Key Entities

- **`src/instance.ts`**: one-line fix in `receive()` — `trigger: input.content` replaces `trigger: input.externalId`
- **`src/runner/index.ts`**: add `triggerContent?` param to `activateBrain()`; update 3 callers (`trigger()`, route loop, `recoverInFlightThreads()`)
- **`src/context/index.ts`**: add `trigger` line to `assembleBlock3()` output
- **`tests/unit/`**: new unit tests for all scenarios above

---

## Assumptions

- `thread.trigger` is already `string | null` in schema — no migration needed
- `input.externalId` stays in the `receive()` interface (backwards-compatible) but is a no-op for now
- Only new sessions receive `initialPrompt`; existing sessions (re-activation) are unaffected
- `routePending()` DMN-scheduled threads pass `undefined` for `triggerContent` — acceptable since these are internally-generated activations, not user-facing messages
- Block 3 `trigger:` display is a plain string; no truncation needed for now (content is typically short)

---

## Success Criteria

1. `receive({ content: 'msg' })` → `thread.trigger = 'msg'`
2. Limbic's first LLM call receives `initialPrompt = 'msg'` (not generic placeholder)
3. Block 3 shows `- trigger: msg`
4. `continue()` behaviour unchanged (still stores content as trigger via `reopenThread`)
5. Downstream brains activated from route loop pass `thread.trigger` as their `initialPrompt` candidate
6. Block 3 shows no `trigger:` line when trigger is null
7. All existing tests pass (zero regression)
8. `bun run typecheck` passes, `biome check` passes

---

## Out of Scope

- Storing `externalId` as a separate Thread schema field (future deduplication feature)
- Truncating long `trigger` in Block 3
- Passing `input.content` as `entityId` hint (covered by Feature 026 if Thread.entityId is added)
- Changing how Cortex or Brainstem receive their `initialPrompt` (they read handoff from Block 3 slots)
