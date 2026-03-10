import { describe, expect, test } from 'bun:test'
import { assembleBlock12, assembleBlock4, assembleContext } from '../../src/context/index'
import type { ContextAssemblerConfig } from '../../src/context/index'
import type { MemoryEntry } from '../../src/types/index'

const config: ContextAssemblerConfig = {
  identities: {
    limbic: { role: 'Emotional regulator', instructions: 'Manage emotional responses.' },
    cortex: { role: 'Planner and router', instructions: 'Decide intent and route tasks.' },
    brainstem: { role: 'Executor', instructions: 'Execute tools safely.' },
  },
  skillIndex: '- skill-a\n- skill-b',
  timezone: 'UTC',
}

describe('assembleBlock12', () => {
  test('contains role, instructions, and skill index', () => {
    const result = assembleBlock12('cortex', config)
    expect(result).toContain('## Role')
    expect(result).toContain('Planner and router')
    expect(result).toContain('## Instructions')
    expect(result).toContain('Decide intent and route tasks.')
    expect(result).toContain('## Skill Index')
    expect(result).toContain('skill-a')
  })

  test('output is deterministic (same bytes each call)', () => {
    const a = assembleBlock12('limbic', config)
    const b = assembleBlock12('limbic', config)
    expect(a).toBe(b)
  })

  test('omits Skill Index section when skillIndex not provided', () => {
    const cfgNoSkill: ContextAssemblerConfig = {
      identities: config.identities,
    }
    const result = assembleBlock12('brainstem', cfgNoSkill)
    expect(result).not.toContain('## Skill Index')
  })
})

describe('assembleBlock4', () => {
  const makeMemory = (id: string, type: MemoryEntry['type'], content: string): MemoryEntry => ({
    id,
    type,
    content,
    entityId: null,
    segmentId: null,
    segmentSeq: null,
    tags: [],
    baseImportance: 0.5,
    usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
    sourceBrain: null,
    threadId: null,
    sessionId: null,
    supersedesId: null,
    tInvalid: null,
    lastAccessedAt: null,
    pinned: false,
    forgotten: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  test('brainstem retrieves procedural memories', async () => {
    const semantic = makeMemory('m1', 'semantic', 'fact')
    const procedural = makeMemory('m2', 'procedural', 'step-by-step')

    const mockWorkspace = {
      searchMemory: async (filters: { type?: string }) => {
        if (filters.type === 'procedural') return [procedural]
        return []
      },
    } as Parameters<typeof assembleBlock4>[1]

    const { text, injectedMemoryIds } = await assembleBlock4('brainstem', mockWorkspace, 'thread-1')
    expect(injectedMemoryIds).toContain('m2')
    expect(injectedMemoryIds).not.toContain('m1')
    expect(text).toContain('[procedural] step-by-step')
  })

  test('returns empty text and ids when no memories', async () => {
    const mockWorkspace = {
      searchMemory: async () => [],
    } as Parameters<typeof assembleBlock4>[1]

    const { text, injectedMemoryIds } = await assembleBlock4('cortex', mockWorkspace, 'thread-1')
    expect(text).toBe('')
    expect(injectedMemoryIds).toHaveLength(0)
  })

  test('deduplicates memories appearing in multiple queries', async () => {
    const sharedMemory = {
      id: 'shared',
      type: 'procedural' as const,
      content: 'shared content',
      entityId: null,
      segmentId: null,
      segmentSeq: null,
      tags: [],
      baseImportance: 0.5,
      usageOutcomes: { positive: 0, negative: 0, neutral: 0 },
      sourceBrain: null,
      threadId: null,
      sessionId: null,
      supersedesId: null,
      tInvalid: null,
      lastAccessedAt: null,
      pinned: false,
      forgotten: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies MemoryEntry

    const mockWorkspace = {
      searchMemory: async () => [sharedMemory],
    } as Parameters<typeof assembleBlock4>[1]

    const { injectedMemoryIds } = await assembleBlock4('cortex', mockWorkspace, 't')
    // cortex calls searchMemory twice — deduplicated result should have only 1 ID
    const uniqueIds = [...new Set(injectedMemoryIds)]
    expect(uniqueIds).toHaveLength(injectedMemoryIds.length)
  })
})

describe('assembleContext', () => {
  test('systemPrompt contains block12 and block3 content', async () => {
    const cachedBlock12 = assembleBlock12('limbic', config)
    const mockWorkspace = {
      getThread: async () => ({ id: 't1', state: 'active', sourceChannel: null, initiatedBy: 'test', trigger: null, createdAt: new Date(), updatedAt: new Date() }),
      getSlotsByThread: async () => [],
      searchMemory: async () => [],
    } as Parameters<typeof assembleContext>[1]

    const result = await assembleContext('limbic', mockWorkspace, 't1', config, cachedBlock12)
    expect(result.systemPrompt).toContain('## Role')
    expect(result.systemPrompt).toContain('## Current Context')
    expect(result.systemPrompt).toContain('thread_id: t1')
    expect(result.injectedMemoryIds).toHaveLength(0)
  })
})
