# Implementation Plan: receive() Input Content Delivery

**Branch**: `029-receive-input-content-delivery` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

## Summary

Three surgical changes across three files:
1. `src/instance.ts` — store `input.content` (not `externalId`) as `thread.trigger` in `receive()`
2. `src/runner/index.ts` — pass `thread.trigger` as `initialPrompt` for new brain sessions
3. `src/context/index.ts` — add `- trigger:` line to Block 3 output

Plus unit tests covering all five scenarios.

## Technical Context

**Language/Version**: TypeScript 5.x
**Modified files**:
- `src/instance.ts` — 1-line fix in `receive()`
- `src/runner/index.ts` — add optional param to `activateBrain()`, update 3 callers
- `src/context/index.ts` — add trigger display to `assembleBlock3()`
**Test files**: `tests/unit/` — new tests or additions to existing test files
**Testing**: Bun test
**No schema changes** — `Thread.trigger` already exists

## Current State (the gap)

### `src/instance.ts` — `receive()` lines 239–243

```typescript
const thread = await this.workspace.createThread({
  initiatedBy: 'external',
  ...(input.channel !== undefined ? { sourceChannel: input.channel } : {}),
  ...(input.externalId !== undefined ? { trigger: input.externalId } : {}),  // ← BUG: externalId, not content
})
```

### `src/runner/index.ts` — `activateBrain()` lines 250–252

```typescript
const params: BrainRunParams = existingSessionId
  ? { brain, threadId, systemPrompt }
  : { brain, threadId, systemPrompt, initialPrompt: `Thread ${threadId} — activate ${brain}` }  // ← generic text
```

### `src/context/index.ts` — `assembleBlock3()` lines 84–93

```typescript
return [
  '## Current Context',
  `- local_time: ${localTime}`,
  `- timezone: ${timezone}`,
  `- thread_id: ${threadId}`,
  `- thread_state: ${thread?.state ?? 'unknown'}`,
  // ← trigger missing
  '',
  '## Workspace Slots',
  ...
]
```

## Changes

### 1. `src/instance.ts`

**`receive()`** — replace the conditional `externalId` spread with unconditional content storage:

```typescript
const thread = await this.workspace.createThread({
  initiatedBy: 'external',
  trigger: input.content,
  ...(input.channel !== undefined ? { sourceChannel: input.channel } : {}),
})
```

Total diff: **–2 lines, +1 line** (net –1).

### 2. `src/runner/index.ts`

**`activateBrain()` signature** — add `triggerContent?: string` param:

```typescript
private async activateBrain(
  brain: CognitiveBrainType,
  threadId: string,
  opts?: AssembleBlock4Opts,
  triggerContent?: string,
): Promise<void>
```

**`initialPrompt` line** — use `triggerContent` when available:

```typescript
const params: BrainRunParams = existingSessionId
  ? { brain, threadId, systemPrompt }
  : { brain, threadId, systemPrompt, initialPrompt: triggerContent ?? `Thread ${threadId} — activate ${brain}` }
```

**Update 3 callers** (all already have `thread` in scope):

```typescript
// trigger() — line ~218:
await this.activateBrain(brain, threadId, opts, thread.trigger ?? undefined)

// Route loop — line ~183:
await this.activateBrain(nextBrain, threadId, opts, thread.trigger ?? undefined)

// recoverInFlightThreads() — line ~337:
await this.activateBrain('limbic', thread.id, undefined, thread.trigger ?? undefined)
```

`routePending()` (line ~322) — leave as-is (no 4th arg); DMN-scheduled threads don't carry user-facing content as `initialPrompt`.

Total diff: **~+6 lines** (signature + usage × 3).

### 3. `src/context/index.ts`

**`assembleBlock3()`** — add `trigger` line after `thread_state`:

```typescript
return [
  '## Current Context',
  `- local_time: ${localTime}`,
  `- timezone: ${timezone}`,
  `- thread_id: ${threadId}`,
  `- thread_state: ${thread?.state ?? 'unknown'}`,
  ...(thread?.trigger ? [`- trigger: ${thread.trigger}`] : []),
  '',
  '## Workspace Slots',
  slotsText || '  (no slots yet)',
].join('\n')
```

Total diff: **+1 line** (spread conditional).

## Test Plan

### `tests/unit/instance.test.ts` (new or existing)

| Test ID | Scenario | Assert |
|---------|----------|--------|
| T029-A | `receive({ content: 'approve', externalId: 'msg-1' })` | `createThread` called with `trigger: 'approve'`, no `externalId` key |
| T029-B | `receive({ content: 'hello' })` (no externalId) | `createThread` called with `trigger: 'hello'` |

### `tests/unit/thread-runner.test.ts` (new tests)

| Test ID | Scenario | Assert |
|---------|----------|--------|
| T029-C | New session, `triggerContent = 'approve the budget'` | adapter `run()` called with `initialPrompt: 'approve the budget'` |
| T029-D | New session, `triggerContent = undefined` | adapter `run()` called with `initialPrompt: 'Thread X — activate limbic'` |
| T029-E | Existing session (re-activation) | adapter `run()` called without `initialPrompt` key |

### `tests/unit/context.test.ts` (new tests)

| Test ID | Scenario | Assert |
|---------|----------|--------|
| T029-F | `thread.trigger = 'approve the budget'` | Block 3 contains `'- trigger: approve the budget'` |
| T029-G | `thread.trigger = null` | Block 3 does NOT contain `'trigger:'` |

## Estimated Size

- `src/instance.ts`: ~3 lines changed
- `src/runner/index.ts`: ~8 lines added/changed
- `src/context/index.ts`: ~1 line added
- Tests: ~80 lines (7 tests × ~11 lines avg)
- Total: ~92 lines
