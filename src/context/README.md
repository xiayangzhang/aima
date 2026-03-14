# src/context

Assembles the system prompt for each brain activation from four blocks. Block 1+2 are static and cached for prompt cache alignment; Block 3+4 are assembled fresh on every activation.

## Functions

- `assembleBlock12(brain, config)` → `string` — static prefix: soul + role identity + instructions + skill index
- `assembleBlock3(brain, workspace, threadId, timezone)` → `string` — dynamic workspace state snapshot
- `assembleBlock4(brain, workspace, threadId, opts)` → `{ text, injectedMemoryIds }` — brain-specific memory injection
- `assembleContext(brain, workspace, threadId, config, cachedBlock12, opts)` → `AssembledContext` — combines all blocks

## Block Contents

**Block 1+2** (static, cached):
- Soul text (shared identity/values)
- Brain role name
- Brain-specific instructions
- Skill index listing

**Block 3** (dynamic per activation):
- Current datetime in agent timezone
- Thread state and trigger text
- All slot statuses (pending / running / done / error)
- Pending signals in workspace (amygdala_interrupt, dmn_correction)

**Block 4** (brain-specific memory injection):
- Limbic: `getEntityContext(entityId)` if thread has entityId, else `findSimilarSituations(trigger)`
- Cortex: `findSimilarSituations(trigger)`
- Brainstem: `getProcedure(taskType)` — taskType from Cortex slot output or thread trigger

## Prompt Cache Alignment

Block 1+2 must be byte-identical across all activations within a session. `ThreadRunner` caches the result at construction and rebuilds only on `updateAssemblerConfig()` (triggered by identity reload). Do not inline dynamic content into Block 1+2.

## Key Types

- `ContextAssemblerConfig` — `{ soul?, identities, skillIndex?, timezone? }`
- `BrainIdentity` — `{ role: string, instructions: string }`
- `AssembleBlock4Opts` — `{ entityId?, situation?, taskType? }` — hints for memory retrieval; undefined falls back to generic search
- `AssembledContext` — `{ systemPrompt: string, injectedMemoryIds: string[] }`

## Dependencies

- `src/workspace/` — memory retrieval for Block 4
- `src/types/` — `CognitiveBrainType`
