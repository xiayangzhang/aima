import { describe, expect, test } from 'bun:test'
import { assembleBlock4, assembleBlock12, assembleContext } from '../../src/context/index'
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
    const _semantic = makeMemory('m1', 'semantic', 'fact')
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

  test('limbic + entityId → getEntityContext called (not searchMemory)', async () => {
    const entityMemory = makeMemory('e1', 'semantic', 'entity fact')
    let getEntityContextCalled = false
    let searchMemoryCalled = false

    const mockWorkspace = {
      getEntityContext: async (_id: string) => {
        getEntityContextCalled = true
        return [entityMemory]
      },
      searchMemory: async () => {
        searchMemoryCalled = true
        return []
      },
    } as Parameters<typeof assembleBlock4>[1]

    const { injectedMemoryIds } = await assembleBlock4('limbic', mockWorkspace, 'thread-1', {
      entityId: 'user:alex',
    })
    expect(getEntityContextCalled).toBe(true)
    expect(searchMemoryCalled).toBe(false)
    expect(injectedMemoryIds).toContain('e1')
  })

  test('limbic + no entityId → searchMemory called (fallback path)', async () => {
    const semanticMemory = makeMemory('s1', 'semantic', 'generic fact')
    let getEntityContextCalled = false
    let searchMemoryCalled = false

    const mockWorkspace = {
      getEntityContext: async () => {
        getEntityContextCalled = true
        return []
      },
      searchMemory: async () => {
        searchMemoryCalled = true
        return [semanticMemory]
      },
    } as Parameters<typeof assembleBlock4>[1]

    const { injectedMemoryIds } = await assembleBlock4('limbic', mockWorkspace, 'thread-1')
    expect(getEntityContextCalled).toBe(false)
    expect(searchMemoryCalled).toBe(true)
    expect(injectedMemoryIds).toContain('s1')
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

describe('assembleBlock12 with soul', () => {
  const baseConfig: ContextAssemblerConfig = {
    identities: {
      limbic: { role: 'Limbic Brain', instructions: 'Understand emotions' },
      cortex: { role: 'Cortex Brain', instructions: 'Synthesize information' },
      brainstem: { role: 'Brainstem Brain', instructions: 'Execute tasks' },
    },
  }

  test('soul non-empty appears before ## Role', () => {
    const cfg = { ...baseConfig, soul: '你是 Alex，一个尽职的财务助理' }
    const output = assembleBlock12('limbic', cfg)
    const soulIdx = output.indexOf('你是 Alex')
    const roleIdx = output.indexOf('## Role')
    expect(soulIdx).toBeGreaterThanOrEqual(0)
    expect(soulIdx).toBeLessThan(roleIdx)
  })

  test('soul absent: output starts with ## Role (backwards compatible)', () => {
    const output = assembleBlock12('limbic', baseConfig)
    expect(output.startsWith('## Role')).toBe(true)
  })

  test('soul empty string: output starts with ## Role', () => {
    const cfg = { ...baseConfig, soul: '' }
    const output = assembleBlock12('limbic', cfg)
    expect(output.startsWith('## Role')).toBe(true)
  })

  test('soul whitespace-only: output starts with ## Role', () => {
    const cfg = { ...baseConfig, soul: '   \n   ' }
    const output = assembleBlock12('limbic', cfg)
    expect(output.startsWith('## Role')).toBe(true)
  })

  test('no frontmatter markers in output when soul is plain body text', () => {
    const cfg = { ...baseConfig, soul: '你是 Alex' }
    const output = assembleBlock12('limbic', cfg)
    expect(output).not.toMatch(/^---/m)
  })

  test('soul + skillIndex: all sections present in correct order', () => {
    const cfg = { ...baseConfig, soul: 'Soul content', skillIndex: 'Skills list' }
    const output = assembleBlock12('limbic', cfg)
    const soulIdx = output.indexOf('Soul content')
    const roleIdx = output.indexOf('## Role')
    const instrIdx = output.indexOf('## Instructions')
    const skillIdx = output.indexOf('## Skill Index')
    expect(soulIdx).toBeLessThan(roleIdx)
    expect(roleIdx).toBeLessThan(instrIdx)
    expect(instrIdx).toBeLessThan(skillIdx)
    expect(output).toContain('Skills list')
  })
})

describe('assembleContext', () => {
  test('systemPrompt contains block12 and block3 content', async () => {
    const cachedBlock12 = assembleBlock12('limbic', config)
    const mockWorkspace = {
      getThread: async () => ({
        id: 't1',
        state: 'active',
        sourceChannel: null,
        initiatedBy: 'test',
        trigger: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
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
