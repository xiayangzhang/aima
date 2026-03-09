# AIMA

**Artificial Intelligence: A Minded Architecture**

An open-source framework for building autonomous cognitive agents with a neuroscience-inspired five-brain architecture, persistent memory, and built-in compliance audit trails.

## Quick Overview

| Brain | Role |
|-------|------|
| **Limbic** | Human-facing interface — routes, responds, defers |
| **Cortex** | Internal reasoning and planning engine |
| **Brainstem** | System-facing interface — tool execution |
| **Amygdala** | Pre-execution safety interrupt (synchronous) |
| **DMN** | Introspection, memory consolidation, error correction |

## Documentation

Start with [`docs/00-overview.md`](docs/00-overview.md) — internal project overview and reading guide.

| Doc | Contents |
|-----|----------|
| [00-overview.md](docs/00-overview.md) | Project overview, concepts, doc map |
| [01-agent-architecture.md](docs/01-agent-architecture.md) | Five-brain architecture, Thread/Slot model, Event Bus |
| [02-memory-architecture.md](docs/02-memory-architecture.md) | Five memory types, MemoryService API, schema |
| [03-implementation-guide.md](docs/03-implementation-guide.md) | Implementation status, adapters, ThreadRunner |
| [04-sdk-api.md](docs/04-sdk-api.md) | Public API — what AIMA adds beyond pi-agent-core |

## Status

`@aima/core` v0.1.1 — Core implementation complete (39 tests passing). Multi-turn conversation, memory read API, and identity loading in progress.

## License

TBD
