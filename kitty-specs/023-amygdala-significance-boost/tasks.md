# Tasks: Feature 023 — Amygdala Significance Boost → DMN Episodic Encoding

## WP01 — Significance boost emission + DMN episodic encoding

**Lane**: planned
**Depends on**: none

| ID   | Task | Details |
|------|------|---------|
| T001 | Add `significance_boost` to `amygdala.interrupt` payload | Edit `src/amygdala/index.ts` `startListening()`: compute `significanceBoost = decision === 'block' ? 0.4 : 0.2` before the `eventBus.emit` call, then include `significance_boost: significanceBoost` in the payload object. Block = 0.4, escalate = 0.2. Allow decisions never reach this branch. |
| T002 | DMN Reactive: handle `amygdala.interrupt` events as episodic memories | Edit `src/dmn/reactive/index.ts`: (a) add routing clause in `handleEvent()` for `event_type === 'amygdala.interrupt' && level === 'ALERT'`; (b) add private `handleAmygdalaInterrupt(event)` that writes one episodic memory with `baseImportance = Math.min(1.0, 0.5 + significance_boost)` and one `significance_mark` record. No `segmentId`/`segmentSeq` — amygdala interrupts are not part of a brain execution segment. |
| T003 | Unit tests for T001 and T002 | (a) Add 2 tests to `tests/unit/amygdala.test.ts` inside the existing `Amygdala.startListening` describe: verify `significance_boost: 0.4` on block, `significance_boost: 0.2` on escalate. (b) Add a new describe block in `tests/unit/dmn/dmn-reactive.test.ts` covering: episodic write with boost, significance_mark written, default baseImportance=0.5 when boost absent, no write for non-ALERT amygdala events. |

**Done criteria**: `bun tsc --noEmit` passes, all new tests green, no regressions in existing suite.
