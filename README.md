# AIMA

**Artificial Intelligence: A Minded Architecture**

A TypeScript framework for building autonomous cognitive agents. AIMA replaces the single-agent loop with five specialized brain regions that operate as a peer network, giving agents persistent memory, observable reasoning, and a built-in audit trail.

## Philosophy

Agents should be governed, not orchestrated. Give them goals and policies — not a playbook. Behavior and awareness are separated: acting happens in Brainstem, routing in Limbic, reflection in DMN. Every decision is observable and auditable by design, not as an afterthought.

## What is AIMA

Most agent frameworks model cognition as a single loop: receive input → call LLM → execute tools → repeat. AIMA separates concerns the way a mind does:

- **Limbic** handles all communication — routing inbound messages, producing outbound replies, and deciding when to defer to another brain region.
- **Cortex** reasons and plans. It has no direct access to tools; it produces structured intent that Brainstem executes.
- **Brainstem** owns tool execution. It spawns isolated execution sessions for complex sub-tasks and writes results back to the shared workspace.
- **Amygdala** is a synchronous safety gate. It evaluates risk before any tool call and can veto execution without involving the LLM.
- **DMN** (Default Mode Network) runs in the background — consolidating memory, correcting errors, and noticing cross-thread patterns the active brains cannot see.

The coordination primitive is a **Thread + Slot model**: every inbound event opens a Thread; each brain writes its output to a typed Slot. The Slots form a coherent, inspectable record of what each brain contributed. All state is persisted to PostgreSQL so sessions survive crashes.

## Architecture Overview

```
Inbound event (Teams / email / webhook / scheduler)
        │
        ▼
    [Limbic]  ←── Communication layer
        │            routes, responds, or defers
        │
   ┌────┴────┐
   │         │
[Cortex]  [Brainstem]  ←── Cognitive workers
 reason     execute
 & plan     & tool-use
   │         │
   └────┬────┘
        │ writes to Slots
        ▼
  CognitiveWorkspace (PostgreSQL)
        │
        ▼
    [Amygdala]  ←── Pre-execution veto (synchronous)
    [DMN]       ←── Background consolidation (async)
```

**Memory types:** semantic / episodic / procedural / working / implicit — all stored in PostgreSQL, searchable via pgvector (with ILIKE fallback).

**Adapters:** AIMA runs on top of any of three LLM execution backends — `pi-agent`, `pi-coding-agent`, or `claude-sdk`. Swap adapters without changing application code.

**Identity:** Agent personality and skills are defined as Markdown files (`soul.md`, `{brain}.md`) in an identity directory. No code changes required to change who the agent is.

**Event Bus:** Every brain activation, tool call, and thread state change emits a typed event. Subscribe for real-time observability or route events to an audit store.

## Installation

```bash
npm install @aima/core
```

Requires:
- Bun (runtime)
- PostgreSQL with the `pgvector` extension (optional, for semantic memory search)

### Database setup

```bash
# Run migrations
bun run db:migrate
```

Set `DATABASE_URL` in your environment, or pass `databaseUrl` directly to `createAIMASession`.

## Quick Start

```typescript
import { createAIMASession } from '@aima/core'

const session = await createAIMASession({
  databaseUrl: process.env.DATABASE_URL!,
  adapter: 'pi-coding-agent',
  identityDir: './identity',  // contains soul.md, limbic.md, cortex.md, brainstem.md
})

const result = await session.promptAndWait('Summarize the Q3 report and flag any risks.')
console.log(result.reply)

await session.dispose()
```

### Streaming events

```typescript
const unsubscribe = session.subscribe((event) => {
  if (event.type === 'brain_start') console.log(`[${event.brain}] activating`)
  if (event.type === 'reply')       console.log('reply:', event.content)
  if (event.type === 'thread_end')  console.log('done:', event.state)
})

await session.prompt('Draft a response to the customer complaint.')
// unsubscribe() when done
```

### Multi-turn conversation

```typescript
await session.promptAndWait('What is our refund policy?')
await session.continueAndWait('Now draft a response for a customer who missed the deadline.')
```

### Interrupting a running thread

```typescript
session.prompt('Run the full analysis pipeline.')
session.steer('Focus only on the finance data — skip marketing.')
```

## Configuration

`createAIMASession` accepts a `CreateAIMASessionOptions` object:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `databaseUrl` | `string` | — | PostgreSQL connection string (required) |
| `adapter` | `'pi-agent' \| 'pi-coding-agent' \| 'claude-sdk'` | `'pi-coding-agent'` | LLM execution backend |
| `identityDir` | `string` | — | Path to directory containing identity Markdown files |
| `apiKey` | `string` | `ANTHROPIC_API_KEY` env | Anthropic API key |
| `brainModels` | `{ limbic?, cortex?, brainstem? }` | See below | Per-brain model overrides |
| `executionModel` | `string` | `claude-sonnet-4-6` | Model for sub-execution sessions |
| `enableDmn` | `boolean` | `false` | Enable background DMN consolidation |
| `enableHippocampus` | `boolean` | `false` | Enable episodic memory consolidation |
| `amygdala` | `AmygdalaConfig` | — | Risk evaluation rules |
| `embedding` | `EmbeddingConfig` | — | pgvector embedding config for semantic search |
| `timezone` | `string` | `'UTC'` | Agent timezone |

**Default models:**
- Limbic: `claude-haiku-4-5-20251001` (fast routing)
- Cortex: `claude-sonnet-4-6` (reasoning)
- Brainstem: `claude-sonnet-4-6` (execution)

## Identity Files

Place Markdown files in your `identityDir`:

```
identity/
├── soul.md          # Core identity, values, behavioral constraints
├── skill-index.md   # Index of available skills
├── limbic.md        # Limbic-specific instructions
├── cortex.md        # Cortex-specific instructions
└── brainstem.md     # Brainstem-specific instructions
```

AIMA injects these files into the system prompt context blocks at session start. Call `session.reloadIdentity()` to hot-reload without restarting.

## Key Concepts

The source is organized by concern. Each module has its own README:

| Module | Path | Responsibility |
|--------|------|----------------|
| Session API | `src/session/` | `createAIMASession`, `AIMASession` — high-level entry point |
| Instance | `src/instance.ts` | `createAIMAInstance` — lower-level, direct brain control |
| CognitiveWorkspace | `src/workspace/` | Thread + Slot CRUD, memory read/write, PostgreSQL via Drizzle |
| ThreadRunner | `src/runner/` | Orchestrates brain activation sequence for a Thread |
| Adapters | `src/adapters/` | `pi-agent`, `pi-coding-agent`, `claude-sdk` implementations |
| Context Assembler | `src/context/` | Builds system prompt blocks from identity + workspace state |
| Amygdala | `src/amygdala/` | Synchronous risk evaluation, rule-based tool veto |
| DMN | `src/dmn/` | Background consolidation worker, cross-thread pattern recognition |
| Hippocampus | `src/hippocampus/` | Episodic memory importance scoring and compaction |
| Event Bus | `src/eventbus/` | In-process typed event bus for observability and audit |
| Identity Loader | `src/identity/` | Parses and caches Markdown identity files |
| MCP Server | `src/mcp/` | Exposes AIMA workspace as an MCP tool server |
| Schema | `src/schema/` | Drizzle ORM table definitions |
| Types | `src/types/` | Shared TypeScript types across all modules |

## Lower-Level API

For direct control over brain execution:

```typescript
import { createAIMAInstance } from '@aima/core'

const instance = await createAIMAInstance({
  databaseUrl: process.env.DATABASE_URL!,
  adapter: 'pi-agent',
  identityDir: './identity',
})

// Open a thread manually
const threadId = await instance.receiveAsync({ content: 'hello', channel: 'api' })

// Inject a signal mid-execution
await instance.injectToThread(threadId, 'amygdala_interrupt', 'abort current task')

// Inspect workspace directly
const slots = await instance.workspace.getSlotsByThread(threadId)

await instance.stop()
```

## Scripts

```bash
bun run build          # Build to dist/
bun run typecheck      # Type-check without emitting
bun run lint           # Biome lint
bun run test           # Unit tests
bun run test:integration  # Integration tests (requires DATABASE_URL)
bun run db:generate    # Generate Drizzle migration files
bun run db:migrate     # Apply migrations
bun run db:studio      # Open Drizzle Studio
```

## Contributing

1. Fork the repo and create a feature branch.
2. Run `bun run typecheck && bun run lint && bun run test` before pushing.
3. Open a pull request with a clear description of the change and why.

Bug reports and design feedback are welcome as GitHub issues.

## License

MIT
