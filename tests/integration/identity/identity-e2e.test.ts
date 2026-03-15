/**
 * Feature 007: Brain Identity & Role Loading — Real Integration Test
 *
 * Tests the full identity pipeline with real file I/O and real PostgreSQL.
 * Does NOT call the LLM — only verifies identity loading, config injection,
 * and allowedTools wiring up to the point of session creation.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assembleBlock12 } from '../../../src/context/index'
import { parseFrontmatter } from '../../../src/identity/frontmatter'
import { IdentityLoader } from '../../../src/identity/loader'
import { AIMAInstance } from '../../../src/instance'
import { describeWithDb } from '../helpers/skip'

const DB_URL = process.env.AIMA_TEST_DATABASE_URL

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aima-007-e2e-'))
}

// ─── T1: IdentityLoader with real files ──────────────────────────────────────

describe('Feature 007 — IdentityLoader (real file I/O)', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  test('loads soul.md content correctly', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), '你是 Alex，一个尽职的财务助理。')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.soul).toBe('你是 Alex，一个尽职的财务助理。')
  })

  test('loads skill-index.md content correctly', async () => {
    await fs.writeFile(path.join(tmpDir, 'skill-index.md'), '- skill-budget\n- skill-report')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.skillIndex).toContain('skill-budget')
  })

  test('parses brainstem.md frontmatter for allowed_tools', async () => {
    const content = `---
allowed_tools:
  - bash
  - edit
---
# Brainstem 执行脑
负责工具执行和任务完成。`
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), content)
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    // 034: allowedTools = union of defaults + override
    expect(cache.roles.brainstem?.allowedTools).toContain('bash')
    expect(cache.roles.brainstem?.allowedTools).toContain('edit')
    expect(cache.roles.brainstem?.body).toContain('负责工具执行和任务完成')
  })

  test('missing brain file → roles fall back to defaults (graceful degradation)', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), 'soul')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    // 034: default identities always present even without override files
    expect(cache.roles.limbic).toBeDefined()
    expect(cache.roles.cortex).toBeDefined()
    expect(cache.roles.brainstem).toBeDefined()
  })

  test('nonexistent directory throws error containing path', async () => {
    const loader = new IdentityLoader('/tmp/aima-does-not-exist-007')
    await expect(loader.load()).rejects.toThrow('/tmp/aima-does-not-exist-007')
  })

  test('parseFrontmatter: inline array format [bash, edit]', () => {
    const result = parseFrontmatter('---\nallowed_tools: [bash, edit]\n---\nbody text')
    expect(result.allowedTools).toEqual(['bash', 'edit'])
    expect(result.body).toBe('body text')
  })
})

// ─── T2: Context assembly with identity cache ─────────────────────────────────

describe('Feature 007 — Context Assembly with Identity (real files)', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  test('soul content appears before ## Role in Block 1+2', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), '你是 Alex，一个尽职的财务助理。')
    await fs.writeFile(path.join(tmpDir, 'limbic.md'), '# 情感理解\n负责情感感知和关系维护。')

    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()

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
    expect(block12).not.toMatch(/^---/m) // no frontmatter leakage
  })

  test('skill-index.md content appears in Block 2 when loaded', async () => {
    await fs.writeFile(path.join(tmpDir, 'skill-index.md'), '- budget-analysis\n- report-generation')

    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()

    const config = {
      skillIndex: cache.skillIndex || undefined,
      identities: {
        limbic: { role: 'Limbic', instructions: 'limbic instructions' },
        cortex: { role: 'Cortex', instructions: 'cortex instructions' },
        brainstem: { role: 'Brainstem', instructions: 'brainstem instructions' },
      },
    }
    const block12 = assembleBlock12('limbic', config)
    expect(block12).toContain('## Skill Index')
    expect(block12).toContain('budget-analysis')
  })
})

// ─── T3: AIMAInstance with real DB + identity ─────────────────────────────────

describeWithDb('Feature 007 — AIMAInstance + real DB identity integration', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await makeTmpDir() })
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }) })

  test('Scenario A: identityDir loads soul and brain roles into cache', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), '你是 Alex，一个尽职的财务助理。')
    await fs.writeFile(
      path.join(tmpDir, 'brainstem.md'),
      '---\nallowed_tools:\n  - bash\n---\n# 执行脑\n负责工具执行。',
    )

    const instance = new AIMAInstance({
      databaseUrl: DB_URL!,
      adapter: 'claude-sdk',
      identityDir: tmpDir,
    })

    await instance.reloadIdentity()
    const cache = instance.getIdentityCache()

    expect(cache).not.toBeNull()
    expect(cache?.soul).toBe('你是 Alex，一个尽职的财务助理。')
    expect(cache?.roles.brainstem?.allowedTools).toContain('bash')
    expect(cache?.roles.brainstem?.body).toContain('负责工具执行')
  })

  test('Scenario B: allowedTools per-brain isolation', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'brainstem.md'),
      '---\nallowed_tools:\n  - bash\n  - edit\n---\nbody',
    )
    await fs.writeFile(path.join(tmpDir, 'limbic.md'), '# Limbic\n情感理解。')

    const instance = new AIMAInstance({
      databaseUrl: DB_URL!,
      adapter: 'claude-sdk',
      identityDir: tmpDir,
    })

    await instance.reloadIdentity()
    const cache = instance.getIdentityCache()

    expect(cache?.roles.brainstem?.allowedTools).toEqual(['bash', 'edit'])
    expect(cache?.roles.limbic?.allowedTools).toEqual([])
    expect(cache?.roles.cortex).toBeUndefined()
  })

  test('Scenario C: missing brain files → no error, graceful degradation', async () => {
    // empty identityDir — no files at all
    const instance = new AIMAInstance({
      databaseUrl: DB_URL!,
      adapter: 'claude-sdk',
      identityDir: tmpDir,
    })

    await expect(instance.reloadIdentity()).resolves.not.toThrow()
    const cache = instance.getIdentityCache()
    expect(cache?.soul).toBe('')
    expect(cache?.roles.limbic).toBeUndefined()
  })

  test('Scenario D: reloadIdentity() hot-swap — new policy takes effect', async () => {
    // Initial state: no allowed_tools
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '# 执行脑\n初始指令。')

    const instance = new AIMAInstance({
      databaseUrl: DB_URL!,
      adapter: 'claude-sdk',
      identityDir: tmpDir,
    })

    await instance.reloadIdentity()
    expect(instance.getIdentityCache()?.roles.brainstem?.allowedTools).toEqual([])

    // Update file to add bash permission
    await fs.writeFile(
      path.join(tmpDir, 'brainstem.md'),
      '---\nallowed_tools:\n  - bash\n---\n# 执行脑\n更新后指令。',
    )
    await instance.reloadIdentity()

    expect(instance.getIdentityCache()?.roles.brainstem?.allowedTools).toContain('bash')
    expect(instance.getIdentityCache()?.roles.brainstem?.body).toContain('更新后指令')
  })

  test('no identityDir → getIdentityCache() stays null (backwards compatible)', async () => {
    const instance = new AIMAInstance({
      databaseUrl: DB_URL!,
      adapter: 'claude-sdk',
    })
    expect(instance.getIdentityCache()).toBeNull()
    await instance.reloadIdentity() // no-op
    expect(instance.getIdentityCache()).toBeNull()
  })
})
