# src/mcp

`createAimaMcpServer()` — in-process MCP server that exposes AIMA workspace and memory tools to LLM sessions running via the claude-sdk adapter.

## createAimaMcpServer(workspace, opts?)

Returns an MCP server instance. Mounted as `'aima-workspace'` in `ClaudeAgentSDKAdapter`.

Optional `opts.spawnExecutionSession` — if provided, exposes the `spawn_execution_session` tool.

## Exposed Tools

| Tool | Description |
|------|-------------|
| `workspace_read_slot` | Read a brain's slot output for the current thread |
| `workspace_write_slot` | Write output and/or status to a brain's slot |
| `memory_search` | Search memories by type, tags, query text |
| `memory_entity_context` | Retrieve memories for an entity (depth 1–2) |
| `memory_similar_situations` | Find episodic + procedural + semantic memories matching a situation |
| `memory_procedure` | Retrieve procedural memories for a task type |
| `spawn_execution_session` | (Optional) Spawn a sub-execution session for complex tasks |

## Relationship to pi-coding-agent MCP Tools

`src/adapters/pi-coding-agent/mcp-tools.ts` provides the same workspace tools as `ToolDefinition[]` for the pi-coding-agent adapter. Both expose the same logical operations — different wire format for each adapter.

## spawn_execution_session

When `opts.spawnExecutionSession` is provided (injected by `AIMAInstance`), Brainstem can call this tool to offload complex tasks to an independent sub-execution session. The sub-session runs with its own LLM context and reports results back. The session ID is stored in the Brainstem slot's `executionSessionId` field.

## Dependencies

- `src/workspace/` — all tool implementations delegate to workspace methods
- `@modelcontextprotocol/sdk` — MCP server protocol
