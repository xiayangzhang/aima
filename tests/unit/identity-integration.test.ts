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

  test('limbic.md without allowed_tools → empty allowedTools', async () => {
    await fs.writeFile(path.join(tmpDir, 'limbic.md'), '# Role\n情感理解')
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    expect(instance.getIdentityCache()?.roles.limbic?.allowedTools).toEqual([])
  })

  test('different brains have independent allowedTools', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'brainstem.md'),
      '---\nallowed_tools:\n  - bash\n  - edit\n---\nbody',
    )
    await fs.writeFile(path.join(tmpDir, 'cortex.md'), '# Cortex\n分析和规划')

    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    const cache = instance.getIdentityCache()
    expect(cache?.roles.brainstem?.allowedTools).toEqual(['bash', 'edit'])
    expect(cache?.roles.cortex?.allowedTools).toEqual([])
  })
})

// ─── Scenario C: missing brain file → graceful degradation ───────────────────

describe('Scenario C: missing brain files degrade gracefully', () => {
  test('empty identityDir → no error, all roles undefined in cache', async () => {
    const instance = makeInstance(tmpDir)
    await expect(instance.reloadIdentity()).resolves.toBeUndefined()
    const cache = instance.getIdentityCache()
    expect(cache?.roles.limbic).toBeUndefined()
    expect(cache?.roles.cortex).toBeUndefined()
    expect(cache?.roles.brainstem).toBeUndefined()
  })

  test('only brainstem.md present → limbic and cortex roles remain undefined', async () => {
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), 'brainstem instructions')
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    const cache = instance.getIdentityCache()
    expect(cache?.roles.limbic).toBeUndefined()
    expect(cache?.roles.brainstem?.body).toContain('brainstem instructions')
  })

  test('nonexistent identityDir throws descriptive error', async () => {
    const instance = makeInstance('/nonexistent/aima-identity-xyz')
    await expect(instance.reloadIdentity()).rejects.toThrow('/nonexistent/aima-identity-xyz')
  })
})

// ─── Scenario D: reloadIdentity() after file update → new policy ─────────────

describe('Scenario D: reloadIdentity() updates cache for new sessions', () => {
  test('initial load → no allowedTools; after update → allowedTools present', async () => {
    // Initial state: brainstem.md with no allowed_tools
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '# 执行任务')
    const instance = makeInstance(tmpDir)
    await instance.reloadIdentity()
    expect(instance.getIdentityCache()?.roles.brainstem?.allowedTools).toEqual([])

    // Update file to add allowed_tools
    await fs.writeFile(
      path.join(tmpDir, 'brainstem.md'),
      '---\nallowed_tools:\n  - bash\n---\n# 执行任务',
    )
    await instance.reloadIdentity()
    expect(instance.getIdentityCache()?.roles.brainstem?.allowedTools).toContain('bash')
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

  test('reloadIdentity() is a no-op when identityDir not configured', async () => {
    const instance = makeInstance()
    await expect(instance.reloadIdentity()).resolves.toBeUndefined()
    expect(instance.getIdentityCache()).toBeNull()
  })
})
