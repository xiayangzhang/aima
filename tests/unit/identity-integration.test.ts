/**
 * WP04 Integration tests: AIMAInstance + IdentityLoader
 *
 * Tests run without a real database (construction is lazy) and without real LLM calls.
 * They verify the identity loading, caching, and config injection behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assembleBlock12 } from '../../src/context/index'
import { IdentityLoader } from '../../src/identity/index'
import { AIMAInstance } from '../../src/instance'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aima-identity-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// Helper: create an AIMAInstance with a fake databaseUrl (no actual connection made at construction)
function makeInstance(identityDir?: string, reloadOnRun?: boolean): AIMAInstance {
  return new AIMAInstance({
    databaseUrl: 'postgresql://localhost/test',
    adapter: 'claude-sdk',
    apiKey: 'sk-test-unit',
    ...(identityDir !== undefined ? { identityDir } : {}),
    ...(reloadOnRun !== undefined ? { reloadOnRun } : {}),
  })
}

// ─── Scenario A: identityDir configured → Block 1/2 includes file content ────

describe('Scenario A: identityDir → Block 1/2 content from files', () => {
  test('getIdentityCache() is null before reloadIdentity()', () => {
    const instance = makeInstance(tmpDir)
    expect(instance.getIdentityCache()).toBeNull()
  })

  test('reloadIdentity() loads soul.md into cache', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), '你是 Alex，一个尽职的财务助理')
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    expect(instance.getIdentityCache()?.soul).toBe('你是 Alex，一个尽职的财务助理')
  })

  test('soul from cache appears before ## Role in assembleBlock12', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), '你是 Alex，财务助理')
    await fs.writeFile(path.join(tmpDir, 'limbic.md'), '# 情感理解\n负责情感感知和关系维护')

    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()

    // Verify: soul is before ## Role when assembling Block 1/2
    const config = {
      soul: cache.soul || undefined,
      identities: {
        limbic: { role: 'Limbic', instructions: cache.roles.limbic?.body ?? 'default' },
        cortex: { role: 'Cortex', instructions: 'default cortex' },
        brainstem: { role: 'Brainstem', instructions: 'default brainstem' },
      },
    }
    const block12 = assembleBlock12('limbic', config)
    const soulIdx = block12.indexOf('你是 Alex')
    const roleIdx = block12.indexOf('## Role')
    expect(soulIdx).toBeGreaterThanOrEqual(0)
    expect(soulIdx).toBeLessThan(roleIdx)
    expect(block12).toContain('负责情感感知和关系维护')
  })

  test('skill-index.md content appears in cache skillIndex', async () => {
    await fs.writeFile(path.join(tmpDir, 'skill-index.md'), '- skill-a\n- skill-b')
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    expect(instance.getIdentityCache()?.skillIndex).toContain('skill-a')
  })
})

// ─── Scenario B: brain.md allowed_tools → allowedTools in cache ──────────────

describe('Scenario B: brain role file sets allowedTools', () => {
  test('brainstem.md with allowed_tools: [bash] → allowedTools in cache', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'brainstem.md'),
      '---\nallowed_tools:\n  - bash\n---\n# 执行任务',
    )
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    const cache = instance.getIdentityCache()
    expect(cache?.roles.brainstem?.allowedTools).toContain('bash')
  })

  test('limbic.md without allowed_tools → merged with base default tools', async () => {
    await fs.writeFile(path.join(tmpDir, 'limbic.md'), '# Role\n情感理解')
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    // identityDir limbic.md has no tools, so result = base default tools only
    const tools = instance.getIdentityCache()?.roles.limbic?.allowedTools ?? []
    expect(tools).toContain('workspace_read_slot')
    expect(tools).toContain('workspace_write_slot')
    expect(tools).toContain('memory_search')
  })

  test('different brains have independent allowedTools — override unions with base', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'brainstem.md'),
      '---\nallowed_tools:\n  - bash\n  - edit\n---\nbody',
    )
    await fs.writeFile(path.join(tmpDir, 'cortex.md'), '# Cortex\n分析和规划')

    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    const cache = instance.getIdentityCache()
    // brainstem: base tools ∪ {bash, edit}
    expect(cache?.roles.brainstem?.allowedTools).toContain('bash')
    expect(cache?.roles.brainstem?.allowedTools).toContain('edit')
    expect(cache?.roles.brainstem?.allowedTools).toContain('workspace_read_slot')
    // cortex: base tools only (cortex.md has no tool list)
    expect(cache?.roles.cortex?.allowedTools).toContain('workspace_read_slot')
    expect(cache?.roles.cortex?.allowedTools).toContain('memory_search')
    expect(cache?.roles.cortex?.allowedTools).not.toContain('bash')
  })
})

// ─── Scenario C: missing brain file → graceful degradation ───────────────────

describe('Scenario C: missing brain files degrade gracefully', () => {
  test('empty identityDir → no error, all roles populated from base defaults', async () => {
    const instance = makeInstance(tmpDir)
    await expect(instance.reloadIdentity()).resolves.toBeUndefined()
    const cache = instance.getIdentityCache()
    // Base defaults always populate all three brain roles
    expect(cache?.roles.limbic).toBeDefined()
    expect(cache?.roles.cortex).toBeDefined()
    expect(cache?.roles.brainstem).toBeDefined()
  })

  test('only brainstem.md present → limbic/cortex use base defaults, brainstem appended', async () => {
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), 'brainstem instructions')
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    const cache = instance.getIdentityCache()
    // limbic and cortex still have base defaults
    expect(cache?.roles.limbic).toBeDefined()
    expect(cache?.roles.cortex).toBeDefined()
    // brainstem: base + override appended
    expect(cache?.roles.brainstem?.body).toContain('brainstem instructions')
    expect(cache?.roles.brainstem?.body).toContain('Brainstem — Execution')
  })

  test('nonexistent identityDir throws descriptive error', async () => {
    const instance = makeInstance('/nonexistent/aima-identity-xyz')
    await expect(instance.reloadIdentity()).rejects.toThrow('/nonexistent/aima-identity-xyz')
  })
})

// ─── Scenario D: reloadIdentity() after file update → new policy ─────────────

describe('Scenario D: reloadIdentity() updates cache for new sessions', () => {
  test('initial load → base tools only; after update → override tools added to union', async () => {
    // Initial state: brainstem.md with no allowed_tools (base defaults apply)
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '# 执行任务')
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    const toolsBefore = instance.getIdentityCache()?.roles.brainstem?.allowedTools ?? []
    expect(toolsBefore).toContain('workspace_read_slot')
    expect(toolsBefore).not.toContain('bash')

    // Update file to add allowed_tools — should union with base
    await fs.writeFile(
      path.join(tmpDir, 'brainstem.md'),
      '---\nallowed_tools:\n  - bash\n---\n# 执行任务',
    )
    await instance.reloadIdentity()
    const toolsAfter = instance.getIdentityCache()?.roles.brainstem?.allowedTools ?? []
    expect(toolsAfter).toContain('bash')
    expect(toolsAfter).toContain('workspace_read_slot')
  })

  test('second reloadIdentity() replaces previous cache entirely', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), 'version 1')
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    expect(instance.getIdentityCache()?.soul).toBe('version 1')

    await fs.writeFile(path.join(tmpDir, 'soul.md'), 'version 2')
    await instance.reloadIdentity()
    expect(instance.getIdentityCache()?.soul).toBe('version 2')
  })
})

// ─── Backwards compatibility: no identityDir ─────────────────────────────────

describe('backwards compatibility: no identityDir', () => {
  test('AIMAInstance without identityDir constructs without error', () => {
    const instance = makeInstance()
    expect(instance).toBeDefined()
  })

  test('getIdentityCache() returns null when no identityDir configured', () => {
    const instance = makeInstance()
    expect(instance.getIdentityCache()).toBeNull()
  })

  test('reloadIdentity() without identityDir loads base defaults', async () => {
    const instance = makeInstance()
    await expect(instance.reloadIdentity()).resolves.toBeUndefined()
    // Cache is now populated with base defaults (not null)
    const cache = instance.getIdentityCache()
    expect(cache).not.toBeNull()
    expect(cache?.roles.limbic).toBeDefined()
    expect(cache?.roles.cortex).toBeDefined()
    expect(cache?.roles.brainstem).toBeDefined()
  })
})
