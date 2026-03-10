import type { CognitiveBrainType, MemoryEntry, MemorySearchFilters } from '../types/index'
import type { CognitiveWorkspace } from '../workspace/index'

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface BrainIdentity {
  role: string // one-line brain role description
  instructions: string // detailed behavioral guide (static)
}

export interface ContextAssemblerConfig {
  identities: Record<CognitiveBrainType, BrainIdentity>
  skillIndex?: string // Skill index text (static, may be empty)
  timezone?: string // e.g. 'Australia/Sydney', defaults to 'UTC'
}

export interface AssembledContext {
  systemPrompt: string // complete system prompt (Block 1+2+3+4 joined)
  injectedMemoryIds: string[] // Block 4 injected memory IDs, for DMN use
}

// ─── Block 1+2: Static prefix (cache-safe) ───────────────────────────────────

/**
 * Assembles the static portion of the system prompt (Blocks 1 & 2).
 * Output MUST remain byte-identical across calls for the same config to
 * hit Anthropic's prompt cache. No dynamic content allowed here.
 */
export function assembleBlock12(brain: CognitiveBrainType, config: ContextAssemblerConfig): string {
  const identity = config.identities[brain]
  const lines: string[] = ['## Role', identity.role, '', '## Instructions', identity.instructions]
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
): Promise<{ text: string; injectedMemoryIds: string[] }> {
  let results: MemoryEntry[] = []

  if (brain === 'limbic') {
    // Limbic: semantic + episodic (thread-scoped)
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
  } else if (brain === 'cortex') {
    // Cortex: procedural + episodic (historical context)
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
  } else if (brain === 'brainstem') {
    // Brainstem: procedural (operational flows)
    results = await workspace.searchMemory({ type: 'procedural', limit: 10, excludeInvalid: true })
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
): Promise<AssembledContext> {
  const tz = config.timezone ?? 'UTC'
  const block3 = await assembleBlock3(brain, workspace, threadId, tz)
  const { text: block4Text, injectedMemoryIds } = await assembleBlock4(brain, workspace, threadId)

  const parts = [cachedBlock12, block3]
  if (block4Text) parts.push(block4Text)

  return {
    systemPrompt: parts.join('\n\n'),
    injectedMemoryIds,
  }
}
