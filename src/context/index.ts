import type { CognitiveBrainType, MemoryEntry, MemorySearchFilters } from '../types/index'
import type { CognitiveWorkspace } from '../workspace/index'

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface BrainIdentity {
  role: string // one-line brain role description
  instructions: string // detailed behavioral guide (static)
}

export interface ContextAssemblerConfig {
  /**
   * Block 1 prefix (full content of soul.md).
   * When non-empty, prepended before ## Role with a blank line separator.
   * Omitting or passing an empty string preserves the original output (backwards compatible).
   */
  soul?: string
  identities: Record<CognitiveBrainType, BrainIdentity>
  skillIndex?: string // Skill index text (static, may be empty)
  timezone?: string // e.g. 'Australia/Sydney', defaults to 'UTC'
}

export interface AssembledContext {
  systemPrompt: string // complete system prompt (Block 1+2+3+4 joined)
  injectedMemoryIds: string[] // Block 4 injected memory IDs, for DMN use
}

/**
 * Brain-specific context for Block 4 memory retrieval.
 * Each field is used by the corresponding brain type; unused fields are ignored.
 */
export interface AssembleBlock4Opts {
  /** limbic: entity to retrieve context for */
  entityId?: string
  /** brainstem: task type to look up procedures for */
  taskType?: string
  /** cortex: situation description for similarity matching */
  situation?: string
}

// ─── Block 1+2: Static prefix (cache-safe) ───────────────────────────────────

/**
 * Assembles the static portion of the system prompt (Blocks 1 & 2).
 * Output MUST remain byte-identical across calls for the same config to
 * hit Anthropic's prompt cache. No dynamic content allowed here.
 */
export function assembleBlock12(brain: CognitiveBrainType, config: ContextAssemblerConfig): string {
  const identity = config.identities[brain]
  const lines: string[] = []

  if (config.soul && config.soul.trim() !== '') {
    lines.push(config.soul.trim(), '')
  }

  lines.push('## Role', identity.role, '', '## Instructions', identity.instructions)

  if (config.skillIndex) {
    lines.push('', '## Skill Index', config.skillIndex)
  }
  return lines.join('\n')
}

// ─── Block 3: Workspace state + current time (dynamic) ───────────────────────

export async function assembleBlock3(
  _brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  threadId: string,
  timezone: string,
): Promise<string> {
  const thread = await workspace.getThread(threadId)
  const slots = await workspace.getSlotsByThread(threadId)
  const now = new Date()
  const localTime = now.toLocaleString('en-AU', { timeZone: timezone, hour12: false })

  const slotsText = slots
    .map(
      (s) =>
        `  ${s.brain}: ${s.status}${s.output ? ` (output: ${JSON.stringify(s.output).slice(0, 100)})` : ''}`,
    )
    .join('\n')

  return [
    '## Current Context',
    `- local_time: ${localTime}`,
    `- timezone: ${timezone}`,
    `- thread_id: ${threadId}`,
    `- thread_state: ${thread?.state ?? 'unknown'}`,
    ...(thread?.trigger ? [`- trigger: ${thread.trigger}`] : []),
    '',
    '## Workspace Slots',
    slotsText || '  (no slots yet)',
  ].join('\n')
}

// ─── Block 4: Brain-specific memory retrieval (dynamic) ──────────────────────

export async function assembleBlock4(
  brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  _threadId: string,
  opts?: AssembleBlock4Opts,
): Promise<{ text: string; injectedMemoryIds: string[] }> {
  let results: MemoryEntry[] = []

  if (brain === 'limbic') {
    if (opts?.entityId) {
      // Brain-specific path: entity-centric retrieval
      results = await workspace.getEntityContext(opts.entityId, { limit: 10 })
    } else {
      // Fallback: original behavior preserved
      const semantic = await workspace.searchMemory({
        type: 'semantic',
        limit: 10,
        excludeInvalid: true,
      })
      const episodic = await workspace.searchMemory({
        type: 'episodic',
        limit: 5,
        excludeInvalid: true,
      } satisfies MemorySearchFilters)
      results = [...semantic, ...episodic]
    }
  } else if (brain === 'cortex') {
    if (opts?.situation) {
      // Brain-specific path: situation similarity matching
      const { episodes, procedures, facts } = await workspace.findSimilarSituations(
        opts.situation,
        { limit: 5 },
      )
      results = [...episodes, ...procedures, ...facts]
    } else {
      // Fallback: original behavior preserved
      const procedural = await workspace.searchMemory({
        type: 'procedural',
        limit: 10,
        excludeInvalid: true,
      })
      const episodic = await workspace.searchMemory({
        type: 'episodic',
        limit: 5,
        excludeInvalid: true,
      })
      results = [...procedural, ...episodic]
    }
  } else if (brain === 'brainstem') {
    if (opts?.taskType) {
      // Brain-specific path: procedure lookup
      results = await workspace.getProcedure(opts.taskType, { limit: 10 })
    } else {
      // Fallback: original behavior preserved
      results = await workspace.searchMemory({
        type: 'procedural',
        limit: 10,
        excludeInvalid: true,
      })
    }
  }

  // Deduplicate by ID
  const seen = new Set<string>()
  const unique = results.filter((r) => {
    if (seen.has(r.id)) return false
    seen.add(r.id)
    return true
  })

  if (unique.length === 0) return { text: '', injectedMemoryIds: [] }

  const text = ['## Relevant Memory', ...unique.map((m) => `[${m.type}] ${m.content}`)].join('\n')

  return { text, injectedMemoryIds: unique.map((m) => m.id) }
}

// ─── assembleContext: Join all four blocks ────────────────────────────────────

export async function assembleContext(
  brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  threadId: string,
  config: ContextAssemblerConfig,
  cachedBlock12: string, // pre-computed at construction time by caller
  opts?: AssembleBlock4Opts,
): Promise<AssembledContext> {
  const tz = config.timezone ?? 'UTC'
  const block3 = await assembleBlock3(brain, workspace, threadId, tz)
  const { text: block4Text, injectedMemoryIds } = await assembleBlock4(
    brain,
    workspace,
    threadId,
    opts,
  )

  const parts = [cachedBlock12, block3]
  if (block4Text) parts.push(block4Text)

  return {
    systemPrompt: parts.join('\n\n'),
    injectedMemoryIds,
  }
}
