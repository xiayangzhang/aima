import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { IdentityLoader } from '../../src/identity/loader'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('IdentityLoader', () => {
  test('full directory: all files load correctly', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), 'soul content')
    await fs.writeFile(path.join(tmpDir, 'skill-index.md'), 'skills')
    await fs.writeFile(
      path.join(tmpDir, 'limbic.md'),
      '---\nallowed_tools:\n  - bash\n---\nlimbic role',
    )

    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()

    expect(cache.soul).toBe('soul content')
    expect(cache.skillIndex).toBe('skills')
    // 034: body = default + override appended
    expect(cache.roles.limbic?.body).toContain('limbic role')
    // 034: allowedTools = union of defaults + override
    expect(cache.roles.limbic?.allowedTools).toContain('bash')
  })

  test('missing soul.md results in soul = ""', async () => {
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.soul).toBe('')
  })

  test('missing skill-index.md results in skillIndex = ""', async () => {
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.skillIndex).toBe('')
  })

  test('missing brain files means roles fall back to defaults', async () => {
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    // 034: default identities always present even without override files
    expect(cache.roles.limbic).toBeDefined()
    expect(cache.roles.cortex).toBeDefined()
    expect(cache.roles.brainstem).toBeDefined()
  })

  test('brain file without frontmatter contributes body, allowedTools from defaults', async () => {
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '# Role\nsome instructions')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    // 034: no frontmatter → no override allowedTools; defaults still apply
    expect(cache.roles.brainstem?.allowedTools.length).toBeGreaterThan(0)
    expect(cache.roles.brainstem?.body).toContain('some instructions')
  })

  test('nonexistent directory throws error containing the path', async () => {
    const loader = new IdentityLoader('/nonexistent/path/xyz')
    await expect(loader.load()).rejects.toThrow('/nonexistent/path/xyz')
  })

  test('getCache() returns null before load()', () => {
    const loader = new IdentityLoader(tmpDir)
    expect(loader.getCache()).toBeNull()
  })

  test('getCache() returns the same cache object after load()', async () => {
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(loader.getCache()).toBe(cache)
  })

  test('multiple brain files loaded simultaneously', async () => {
    await fs.writeFile(path.join(tmpDir, 'limbic.md'), 'limbic body')
    await fs.writeFile(path.join(tmpDir, 'cortex.md'), 'cortex body')
    await fs.writeFile(
      path.join(tmpDir, 'brainstem.md'),
      '---\nallowed_tools:\n  - bash\n  - edit\n---\nbrainstem body',
    )

    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()

    // 034: body = default + override appended
    expect(cache.roles.limbic?.body).toContain('limbic body')
    expect(cache.roles.cortex?.body).toContain('cortex body')
    // 034: allowedTools = union of defaults + override
    expect(cache.roles.brainstem?.allowedTools).toContain('bash')
    expect(cache.roles.brainstem?.allowedTools).toContain('edit')
  })

  test('second load() call overwrites previous cache', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), 'version 1')
    const loader = new IdentityLoader(tmpDir)
    await loader.load()

    await fs.writeFile(path.join(tmpDir, 'soul.md'), 'version 2')
    const cache2 = await loader.load()

    expect(cache2.soul).toBe('version 2')
    expect(loader.getCache()?.soul).toBe('version 2')
  })
})

describe('IdentityLoader — extras', () => {
  test('no extra files → extras is empty object', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), 'soul')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.extras).toEqual({})
  })

  test('extra .md file loaded into extras by key (filename without .md)', async () => {
    await fs.writeFile(path.join(tmpDir, 'experience.md'), '## Experience\n3 years at SaaS')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.extras['experience']).toContain('3 years at SaaS')
  })

  test('known files (soul, skill-index, brain files) excluded from extras', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), 'soul')
    await fs.writeFile(path.join(tmpDir, 'skill-index.md'), 'skills')
    await fs.writeFile(path.join(tmpDir, 'limbic.md'), 'limbic')
    await fs.writeFile(path.join(tmpDir, 'cortex.md'), 'cortex')
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), 'brainstem')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(Object.keys(cache.extras)).toHaveLength(0)
  })

  test('multiple extra files all loaded', async () => {
    await fs.writeFile(path.join(tmpDir, 'experience.md'), 'work history')
    await fs.writeFile(path.join(tmpDir, 'jd.md'), 'job description')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.extras['experience']).toBe('work history')
    expect(cache.extras['jd']).toBe('job description')
  })

  test('empty extra file excluded from extras', async () => {
    await fs.writeFile(path.join(tmpDir, 'empty.md'), '   \n  ')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.extras['empty']).toBeUndefined()
  })

  test('non-.md files in directory ignored', async () => {
    await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'some notes')
    await fs.writeFile(path.join(tmpDir, 'config.json'), '{}')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(Object.keys(cache.extras)).toHaveLength(0)
  })

  test('without identityDir → extras is empty object', async () => {
    const loader = new IdentityLoader()
    const cache = await loader.load()
    expect(cache.extras).toEqual({})
  })
})
