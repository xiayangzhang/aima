import { describe, expect, test } from 'bun:test'
import { parseFrontmatter } from '../../src/identity/frontmatter'

describe('parseFrontmatter', () => {
  test('standard YAML list format', () => {
    const content = `---
allowed_tools:
  - bash
  - edit
---

正文内容`
    const result = parseFrontmatter(content)
    expect(result.allowedTools).toEqual(['bash', 'edit'])
    expect(result.body).toBe('正文内容')
  })

  test('no frontmatter returns original content', () => {
    const result = parseFrontmatter('正文内容')
    expect(result.allowedTools).toEqual([])
    expect(result.body).toBe('正文内容')
  })

  test('frontmatter without allowed_tools field returns []', () => {
    const content = `---
title: Some Role
---
正文`
    const result = parseFrontmatter(content)
    expect(result.allowedTools).toEqual([])
    expect(result.body).toBe('正文')
  })

  test('body does not contain --- boundary lines', () => {
    const content = `---
allowed_tools:
  - bash
---
正文`
    expect(parseFrontmatter(content).body).not.toContain('---')
  })

  test('single tool list', () => {
    const content = '---\nallowed_tools:\n  - bash\n---\n正文'
    expect(parseFrontmatter(content).allowedTools).toEqual(['bash'])
  })

  test('empty allowed_tools inline array', () => {
    const content = '---\nallowed_tools: []\n---\n正文'
    const result = parseFrontmatter(content)
    expect(result.allowedTools).toEqual([])
  })

  test('inline array format [bash, edit]', () => {
    const content = '---\nallowed_tools: [bash, edit]\n---\nbody'
    const result = parseFrontmatter(content)
    expect(result.allowedTools).toEqual(['bash', 'edit'])
    expect(result.body).toBe('body')
  })

  test('multiline body content', () => {
    const content = '---\nallowed_tools:\n  - bash\n---\n\n# Title\n\nsome content'
    const result = parseFrontmatter(content)
    expect(result.body).toContain('# Title')
    expect(result.body).toContain('some content')
  })

  test('completely empty file', () => {
    const result = parseFrontmatter('')
    expect(result.allowedTools).toEqual([])
    expect(result.body).toBe('')
  })

  test('multiple tools in list', () => {
    const content = `---
allowed_tools:
  - bash
  - edit
  - read
  - glob
---
body text`
    const result = parseFrontmatter(content)
    expect(result.allowedTools).toEqual(['bash', 'edit', 'read', 'glob'])
  })
})
