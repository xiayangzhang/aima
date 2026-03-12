# Implementation Plan: Amygdala Significance Boost → DMN Episodic Encoding

**Branch**: `023-amygdala-significance-boost` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)

## Summary

Two source changes and one test file (split across two test files to keep amygdala and DMN
tests co-located with their existing suites):

1. `src/amygdala/index.ts` — add `significance_boost` to `amygdala.interrupt` payload.
2. `src/dmn/reactive/index.ts` — handle `amygdala.interrupt` events and write episodic memory.
3. Tests in `tests/unit/amygdala.test.ts` and `tests/unit/dmn/dmn-reactive.test.ts` (or new
   `tests/unit/dmn/dmn-reactive-amygdala-interrupt.test.ts`).

## Technical Context

**Language/Version**: TypeScript 5.x (Bun runtime)
**Primary Dependencies**: None new — uses existing `BrainEventBus`, `CognitiveWorkspace`
**Testing**: Bun test with mocked workspace and in-process event bus
**Target files**:
- `src/amygdala/index.ts` — `startListening()` at line 191
- `src/dmn/reactive/index.ts` — `handleEvent()` at line 97, new `handleAmygdalaInterrupt()`

## Implementation Notes

### T001 — Amygdala: add significance_boost to interrupt payload

In `src/amygdala/index.ts`, `startListening()` method (line 208), the existing emit is:

```typescript
this.eventBus.emit({
  event_type: 'amygdala.interrupt',
  level: 'ALERT',
  brain: 'amygdala',
  thread_id: event.thread_id,
  session_id: event.session_id,
  causation_id: event.event_id,
  payload: { tool: toolName, decision, reason },
})
```

Add a `significanceBoost` computation before the emit and include it in payload:

```typescript
const significanceBoost = decision === 'block' ? 0.4 : 0.2  // escalate = 0.2

this.eventBus.emit({
  event_type: 'amygdala.interrupt',
  level: 'ALERT',
  brain: 'amygdala',
  thread_id: event.thread_id,
  session_id: event.session_id,
  causation_id: event.event_id,
  payload: { tool: toolName, decision, reason, significance_boost: significanceBoost },
})
```

Note: `allow` decisions never reach this branch (guarded by `if (decision === 'block' || decision === 'escalate')`), so no boost is needed for allow.

### T002 — DMN Reactive: handle amygdala.interrupt events

In `src/dmn/reactive/index.ts`, `handleEvent()` (line 97), add a new routing clause after the
existing `brain.complete` block:

```typescript
// Amygdala interrupt → episodic encoding (Responsibility 8)
if (event_type === 'amygdala.interrupt' && level === 'ALERT') {
  await this.handleAmygdalaInterrupt(event)
}
```

New private method `handleAmygdalaInterrupt`:

```typescript
private async handleAmygdalaInterrupt(event: BrainEvent): Promise<void> {
  const { thread_id, payload } = event
  const workspace = this.config.workspace

  const toolName = payload.tool as string | undefined
  const decision = payload.decision as string | undefined
  const significanceBoost = (payload.significance_boost as number | undefined) ?? 0
  const baseImportance = Math.min(1.0, 0.5 + significanceBoost)

  const tags = [
    'amygdala_interrupt',
    ...(decision ? [decision] : []),
    ...(toolName ? [toolName] : []),
    ...(thread_id ? [`thread:${thread_id}`] : []),
  ]

  await workspace.writeMemory({
    type: 'episodic',
    sourceBrain: 'amygdala',
    threadId: thread_id ?? undefined,
    content: JSON.stringify({
      event_type: 'amygdala_interrupt',
      tool: toolName,
      decision,
      reason: payload.reason,
      significance_boost: significanceBoost,
      timestamp: new Date().toISOString(),
    }),
    baseImportance,
    tags,
  })

  // significance_mark: always written for interrupt events (boost > 0)
  if (significanceBoost > 0) {
    await workspace.writeMemory({
      type: 'episodic',
      sourceBrain: 'amygdala',
      threadId: thread_id ?? undefined,
      content: JSON.stringify({
        event_type: 'significance_mark',
        boost: significanceBoost,
        trigger: 'amygdala',
        tool: toolName,
        decision,
      }),
      baseImportance: Math.min(1.0, 0.7 + significanceBoost),
      tags: ['significance_mark', 'amygdala', ...(thread_id ? [`thread:${thread_id}`] : [])],
    })
  }
}
```

Note: No `segmentId`/`segmentSeq` — amygdala interrupts are cross-thread signals, not part of a
brain's execution segment. The segment tracking state (`this.threadSegments`) is not used here.

### T003 — Tests

**In `tests/unit/amygdala.test.ts`**, add two tests to the existing `Amygdala.startListening`
describe block:

```typescript
test('emits significance_boost: 0.4 in amygdala.interrupt payload on block', async () => {
  const { eventBus, amygdala } = makeSetup()
  const captured: Record<string, unknown>[] = []
  eventBus.subscribeLevel('ALERT', (e) => {
    if (e.event_type === 'amygdala.interrupt') captured.push(e.payload)
  })
  amygdala.startListening()
  eventBus.emit({
    event_type: 'tool.pre_use',
    level: 'INFO',
    brain: 'brainstem',
    thread_id: 'thread-1',
    payload: { tool: 'bash', args: {} },
  })
  await new Promise((r) => setTimeout(r, 10))
  expect(captured[0]?.significance_boost).toBe(0.4)
})

test('emits significance_boost: 0.2 in amygdala.interrupt payload on escalate', async () => {
  // Use a custom rule to force escalate
  const { eventBus, amygdala } = makeSetup({
    rules: [{ toolName: 'some_tool', decision: 'escalate', reason: 'test escalate' }],
  })
  const captured: Record<string, unknown>[] = []
  eventBus.subscribeLevel('ALERT', (e) => {
    if (e.event_type === 'amygdala.interrupt') captured.push(e.payload)
  })
  amygdala.startListening()
  eventBus.emit({
    event_type: 'tool.pre_use',
    level: 'INFO',
    brain: 'brainstem',
    thread_id: 'thread-1',
    payload: { tool: 'some_tool', args: {} },
  })
  await new Promise((r) => setTimeout(r, 10))
  expect(captured[0]?.significance_boost).toBe(0.2)
})
```

**In `tests/unit/dmn/dmn-reactive.test.ts`** (or a new sibling file), add tests for the
amygdala interrupt episodic path. Use the same `makeConfig()` helper pattern from
`tests/unit/dmn/dmn-reactive-brain-complete.test.ts`:

```typescript
describe('DmnReactive — amygdala.interrupt handler', () => {
  it('writes episodic memory with boost on amygdala.interrupt (block)', async () => { ... })
  it('writes significance_mark on amygdala.interrupt', async () => { ... })
  it('uses default baseImportance=0.5 when significance_boost absent', async () => { ... })
  it('does not write episodic for amygdala.interrupt without ALERT level', async () => { ... })
})
```

## Estimated Line Count

| File | Change type | Estimated lines |
|------|-------------|-----------------|
| `src/amygdala/index.ts` | Edit: 2 lines added | +2 |
| `src/dmn/reactive/index.ts` | Edit: routing clause + new method | +40 |
| `tests/unit/amygdala.test.ts` | Edit: 2 new tests appended | +50 |
| `tests/unit/dmn/dmn-reactive.test.ts` | Edit: new describe block | +80 |
| **Total** | | **~172 lines** |
