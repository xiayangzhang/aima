# Feature 024 — Episodic Content Quality

## Status: draft

## Background

`buildEpisodicContent()` in DMN Reactive currently serializes execution state as JSON:

```json
{"brain":"limbic","threadId":"...","status":"done","next":"cortex","hasReply":false,"handoff":"...","stopReason":"end_turn","timestamp":"..."}
```

This format captures *what happened* mechanically but loses the cognitive signal. The `handoff`
field already contains the brain's reasoning summary — the motivation for routing to the next
brain — but it is stored as a raw field in a JSON blob rather than being surfaced as the primary
narrative. When Hippocampus consolidates episodic memories, it runs an LLM over the `content`
field of each memory record. A human-readable sentence with the decision and reasoning is far
more extractable than a machine-state JSON object.

## User Stories

### US-1 — Cognitive summary format

As Hippocampus consolidation,
I want each episodic memory `content` to read as a cognitive summary (who acted, what decision,
why, what happened),
so that the LLM can extract meaningful patterns without parsing JSON.

**Acceptance criteria:**
- `content` is a template-string sentence, not JSON.
- Includes: `[brain]`, routing decision (`next` value or "complete" if null, or "error" if
  `stopReason` indicates error), handoff excerpt (first 200 chars when present), reply preview
  (first 100 chars when present), status.
- For error cases: `stopReason` is included.
- Format is consistent across all brain completions so LLM can extract patterns reliably.

### US-2 — Tests assert new format

As a developer,
I want unit tests that assert the new `buildEpisodicContent()` output format,
so that regressions are caught immediately.

**Acceptance criteria:**
- Tests confirm content contains `[brain]` identifier.
- Tests confirm routing decision is included (e.g., `"route → cortex"` or `"complete"`).
- Tests confirm handoff excerpt appears when handoff is present.
- Tests confirm reply preview appears when reply is present.
- Tests confirm error path includes `stopReason`.

## Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | `buildEpisodicContent()` MUST return a template string, not `JSON.stringify(...)` |
| FR-2 | Format MUST include `[brain]` as first token |
| FR-3 | Routing decision: `"route → <next>"` when `next` is non-null and not "self"; `"defer"` when `next === "self"`; `"complete"` when `next` is null/undefined; `"error"` when `stopReason` indicates terminal error |
| FR-4 | When `handoff` is present: include `| handoff: "<first 200 chars>"` |
| FR-5 | When `reply` is present: include `| reply: "<first 100 chars>"` |
| FR-6 | Always include `| status: <status>` and `| thread: <thread_id>` |
| FR-7 | For error cases (when routing decision is "error"): include `| stopReason: <value>` |
| FR-8 | Existing callers of `buildEpisodicContent()` require no changes — signature unchanged |

## Out of Scope

- Changing how DMN Reactive decides *when* to call `buildEpisodicContent()` — frequency unchanged.
- Changing the `writeMemory()` call parameters — only the `content` string changes.
- Adding new fields to `BrainEvent` payload.
- Modifying Hippocampus consolidation logic.

## Success Criteria

- `dmn-reactive.test.ts`: new tests assert new format for routing, complete, reply, and error cases.
- `bun tsc --noEmit` passes with zero errors.
- Existing test suite has zero regressions.
- `buildEpisodicContent()` produces no JSON output.
