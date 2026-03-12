# Implementation Plan: Episodic Content Quality

**Branch**: `024-episodic-content-quality` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

## Summary

Replace the `JSON.stringify(...)` call inside `buildEpisodicContent()` with a template string
that surfaces the cognitive signal — brain identity, routing decision, handoff reasoning, reply
preview — in a format that Hippocampus LLM consolidation can extract patterns from directly.

## Technical Context

**Language/Version**: TypeScript 5.x
**Primary file**: `src/dmn/reactive/index.ts` — `buildEpisodicContent()` at lines 231–245
**Test file**: `tests/unit/dmn/dmn-reactive.test.ts`
**Testing**: Bun test
**Constraints**: Signature of `buildEpisodicContent(event: BrainEvent): string` is unchanged

## Current Implementation (lines 231–245)

```typescript
private buildEpisodicContent(event: BrainEvent): string {
  const { brain, thread_id, payload } = event
  const outputSlot = payload.outputSlot as Record<string, unknown> | undefined
  const output = outputSlot?.output as Record<string, unknown> | undefined
  return JSON.stringify({
    brain,
    threadId: thread_id,
    status: outputSlot?.status,
    next: (output as Record<string, unknown> | undefined)?.next,
    hasReply: (output as Record<string, unknown> | undefined)?.reply != null,
    handoff: (output as Record<string, unknown> | undefined)?.handoff || null,
    stopReason: payload.stopReason,
    timestamp: new Date().toISOString(),
  })
}
```

## New Implementation

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

  // Derive routing decision token
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

### Example outputs

Routing case:
```
[limbic] decided: route → cortex | handoff: "User asked about invoice X. I determined this requires detailed analysis." | status: done | thread: abc123
```

Reply case:
```
[brainstem] decided: complete | reply: "Here are the steps to..." | status: done | thread: abc123
```

Error case:
```
[cortex] decided: error | stopReason: max_tokens | status: done | thread: abc123
```

Defer case:
```
[limbic] decided: defer | handoff: "Waiting for user to provide clarification." | status: done | thread: abc123
```

## Test Plan

New `describe` block in `dmn-reactive.test.ts` titled `"buildEpisodicContent format"`:

- **T001-a**: routing case — content contains `[cortex]`, `route → brainstem`, handoff excerpt
- **T001-b**: complete case (next=null) — content contains `complete`, no stopReason
- **T001-c**: reply case — content contains `reply:` with preview
- **T001-d**: error case — content contains `error`, `stopReason:`
- **T001-e**: defer case (next='self') — content contains `defer`

Strategy: call `buildEpisodicContent` via a `brain.complete` event dispatched through the mock
bus, then inspect the `writeMemory` call's `content` argument (same pattern as existing tests).

## Files Changed

| File | Change |
|------|--------|
| `src/dmn/reactive/index.ts` | Replace `JSON.stringify(...)` body with template-string builder (~15 lines) |
| `tests/unit/dmn/dmn-reactive.test.ts` | Add new `describe` block with 5 tests (~80 lines) |
