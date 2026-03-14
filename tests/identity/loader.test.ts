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
    expect(cache.roles.limbic?.body).toBe('limbic role')
    expect(cache.roles.limbic?.allowedTools).toEqual(['bash'])
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

  test('missing brain files means roles is empty', async () => {
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.roles.limbic).toBeUndefined()
    expect(cache.roles.cortex).toBeUndefined()
    expect(cache.roles.brainstem).toBeUndefined()
  })

  test('brain file without frontmatter has allowedTools = []', async () => {
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '# Role\nsome instructions')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.roles.brainstem?.allowedTools).toEqual([])
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

    expect(cache.roles.limbic?.body).toBe('limbic body')
    expect(cache.roles.cortex?.body).toBe('cortex body')
    expect(cache.roles.brainstem?.allowedTools).toEqual(['bash', 'edit'])
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
