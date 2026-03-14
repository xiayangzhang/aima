# src/amygdala

`Amygdala` — synchronous three-stage tool risk evaluation. Runs before every tool call and can block or escalate without involving the brain LLM.

## check(toolName, input) → { decision, reason }

Decisions: `'allow'` | `'block'` | `'escalate'`

### Stage 1 — Static Rules

Evaluated in order:
1. Custom rules from `AmygdalaConfig.riskLevels`
2. Default block list (`bash`, `edit`, `write` — configurable)
3. Default allow prefix list (`read`, `grep`, `find`, `ls` — configurable)
4. Assigns risk level: `'low'` | `'medium'` | `'high'`

Low-risk tools return `allow` immediately without further evaluation.

### Stage 2 — Implicit Memory Lookup

For medium/high-risk tools: searches memory for recent decisions tagged `['amygdala_eval', toolName]`. If a matching evaluation exists and is recent enough, reuses that decision. Avoids redundant LLM calls for known tools.

### Stage 3 — LLM Evaluation

For high-risk tools when `haiku_enabled: true` and Stage 1+2 are inconclusive: calls a Haiku LLM with the tool name, input, and risk context. Result is written back to memory for Stage 2 reuse.

## Config

```typescript
interface AmygdalaConfig {
  llm?: LlmConfig              // required for Stage 3
  riskLevels?: Record<string, 'low' | 'medium' | 'high'>
  haiku_enabled?: boolean      // enables Stage 3 LLM eval
}
```

## Integration Points

- **pi-coding-agent adapter**: hooked via `createAimaExtension()` — intercepts every tool call before execution
- **claude-sdk adapter**: hooked via `canUseTool` callback in `query()` options
- **pi-agent adapter**: checks `popSignal('amygdala_interrupt')` at activation start

The Amygdala instance is created in `AIMAInstance` and shared across all three brain adapters.

## Dependencies

- `src/workspace/` — memory read/write for Stage 2
- `src/eventbus/` — emits `tool.blocked` and `tool.escalation` events
- `src/llm/` — Stage 3 LLM call
