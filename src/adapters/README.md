# src/adapters

`BrainAdapter` interface definition and three concrete implementations. The adapter is the boundary between AIMA's routing layer and the underlying LLM execution backend.

## Interface

```typescript
interface BrainAdapter {
  run(params: BrainRunParams): Promise<BrainRunResult>
  inject(signal: BrainSignal): Promise<void>
  abort(): void
  resetSession(brain: CognitiveBrainType, threadId: string): void
  resetAllSessions(): void
}
```

## Key Types

- `BrainRunParams` — `{ brain, threadId, systemPrompt, initialPrompt? }`. `initialPrompt` present = first activation; absent = session resume.
- `BrainRunResult` — `{ sessionId, output, stopReason, injectedMemoryIds }`. `output` is always `{}` — actual slot output is written by tools during execution.
- `BrainSignal` — `{ type: 'amygdala_interrupt' | 'dmn_correction', threadId, message }`

## Session Keying

All three adapters store sessions by `${brain}:${threadId}`. This key is used by `ThreadRunner` to distinguish first activation (sends `initialPrompt`) from subsequent activations (session resume, no `initialPrompt`).

## Implementations

### pi-agent (`src/adapters/pi-agent/`)

- Uses `@mariozechner/pi-agent-core` `Agent` class
- One `Agent` instance per session key, held in `agentInstances` Map
- `inject()` calls `agent.steer()` (amygdala_interrupt) or `agent.followUp()` (dmn_correction) in real-time
- `resetSession()` deletes the Agent instance from the map

### pi-coding-agent (`src/adapters/pi-coding-agent/`)

- Uses `@mariozechner/pi-coding-agent` `AgentSession`
- Mutable `systemPromptRef` object updated before each run; `ResourceLoader` reads it live
- Amygdala + EventBus wired via `createAimaExtension()` (see `extension.ts`)
- Workspace/memory tools exposed via `buildMcpTools()` (see `mcp-tools.ts`)
- `inject()` calls `session.steer()` / `session.followUp()` if session active, else `workspace.pushSignal()`
- `resetSession()` deletes from `sessions` Map

### claude-sdk (`src/adapters/claude-sdk/`)

- Uses `@anthropic-ai/claude-agent-sdk` `query()` — one-shot, no persistent session object
- Session continuity via `session_id` returned by SDK; stored per key, passed as `resume` on next call
- `inject()` always calls `workspace.pushSignal()` — no real-time injection possible
- Amygdala via `canUseTool` hook (per-tool, synchronous)
- `resetSession()` deletes from both `sessionIds` and `abortControllers` Maps

## Known Gaps (claude-sdk)

- No `tool.pre_use` / `tool.post_use` EventBus events
- Amygdala check at `run()` start only, not per-tool (unlike pi-coding-agent which hooks each tool call)
- Signal delivery only at next activation, not real-time

## Dependencies

- `src/amygdala/` — Amygdala instance passed in config
- `src/eventbus/` — BrainEventBus for tool event emission
- `src/workspace/` — signal push/pop, MCP tools
- `src/mcp/` — MCP server (claude-sdk only)
