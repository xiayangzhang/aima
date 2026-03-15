import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { CognitiveBrainType } from '../types/index.js'
import { DEFAULT_BRAIN_IDENTITIES } from './defaults.js'
import { parseFrontmatter } from './frontmatter.js'

export interface RoleEntry {
  body: string
  allowedTools: string[]
}

export interface IdentityCache {
  soul: string
  skillIndex: string
  roles: Partial<Record<CognitiveBrainType, RoleEntry>>
  /** Extra Markdown files from identityDir (e.g. experience.md, jd.md). Key = filename without .md. */
  extras: Record<string, string>
}

/**
 * Loads brain identity from two sources and merges them additively:
 *
 * 1. **Built-in defaults** (`defaults.ts`) — always loaded.
 *    Contains routing rules, output formats, and tool permissions that make
 *    the AIMA cognitive chain work correctly out of the box.
 *
 * 2. **identityDir** (optional) — consumer-provided Markdown files.
 *    `soul.md` sets the agent persona. `skill-index.md` lists available skills.
 *    Brain files (`limbic.md`, `cortex.md`, `brainstem.md`) are appended
 *    after base instructions and can add domain-specific guidance.
 *
 * Merge rules:
 * - Brain `body`: base + "\n\n" + override (additive)
 * - Brain `allowedTools`: union of base and override lists
 * - `soul`: override replaces base (persona is fully agent-defined)
 * - `skillIndex`: override replaces base
 */
export class IdentityLoader {
  private readonly identityDir: string | null
  private cache: IdentityCache | null = null

  constructor(identityDir?: string) {
    this.identityDir = identityDir ? path.resolve(identityDir) : null
  }

  /**
   * Load and merge identity from defaults + identityDir.
   * Safe to call multiple times; always re-reads from disk.
   */
  async load(): Promise<IdentityCache> {
    // 1. Built-in defaults (always present)
    const base = this._loadDefaults()

    // 2. identityDir (optional, additive)
    let override: IdentityCache | null = null
    if (this.identityDir) {
      try {
        await fs.access(this.identityDir)
        const stat = await fs.stat(this.identityDir)
        if (!stat.isDirectory()) throw new Error('not a directory')
      } catch (err) {
        throw new Error(
          `IdentityLoader: identityDir does not exist or is not accessible: "${this.identityDir}" — ${(err as Error).message}`,
        )
      }
      override = await this._loadDir(this.identityDir)
    }

    this.cache = this._merge(base, override)
    return this.cache
  }

  /** Current cache; returns null if load() has not been called */
  getCache(): IdentityCache | null {
    return this.cache
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private _loadDefaults(): IdentityCache {
    const brainTypes: CognitiveBrainType[] = ['limbic', 'cortex', 'brainstem']
    const roles: Partial<Record<CognitiveBrainType, RoleEntry>> = {}

    for (const brain of brainTypes) {
      const def = DEFAULT_BRAIN_IDENTITIES[brain]
      if (def) {
        roles[brain] = { body: def.body, allowedTools: [...def.allowedTools] }
      }
    }

    return { soul: '', skillIndex: '', roles, extras: {} }
  }

  private async _loadDir(dir: string): Promise<IdentityCache> {
    const KNOWN_FILES = new Set([
      'soul.md',
      'skill-index.md',
      'limbic.md',
      'cortex.md',
      'brainstem.md',
    ])

    const readOptional = async (filename: string): Promise<string> => {
      try {
        return await fs.readFile(path.join(dir, filename), 'utf-8')
      } catch {
        return ''
      }
    }

    const soul = await readOptional('soul.md')
    const skillIndex = await readOptional('skill-index.md')

    const brainTypes: CognitiveBrainType[] = ['limbic', 'cortex', 'brainstem']
    const roles: Partial<Record<CognitiveBrainType, RoleEntry>> = {}

    for (const brain of brainTypes) {
      const raw = await readOptional(`${brain}.md`)
      if (raw !== '') {
        const parsed = parseFrontmatter(raw)
        roles[brain] = { body: parsed.body, allowedTools: parsed.allowedTools }
      }
    }

    // Scan for extra .md files (not in KNOWN_FILES) — e.g. experience.md, jd.md
    const extras: Record<string, string> = {}
    const dirEntries = await fs.readdir(dir)
    for (const entry of dirEntries.sort()) {
      if (!entry.endsWith('.md')) continue
      if (KNOWN_FILES.has(entry)) continue
      const content = await fs.readFile(path.join(dir, entry), 'utf-8')
      if (content.trim() !== '') {
        extras[entry.slice(0, -3)] = content
      }
    }

    return { soul, skillIndex, roles, extras }
  }

  private _merge(base: IdentityCache, override: IdentityCache | null): IdentityCache {
    if (!override) return base

    const brainTypes: CognitiveBrainType[] = ['limbic', 'cortex', 'brainstem']
    const roles: Partial<Record<CognitiveBrainType, RoleEntry>> = {}

    for (const brain of brainTypes) {
      const b = base.roles[brain]
      const o = override.roles[brain]

      if (!b && !o) continue
      if (!b) { roles[brain] = o!; continue }
      if (!o) { roles[brain] = b; continue }

      // Both present: append override body, union allowed tools
      roles[brain] = {
        body: `${b.body}\n\n${o.body}`.trim(),
        allowedTools: [...new Set([...b.allowedTools, ...o.allowedTools])],
      }
    }

    return {
      // soul and skillIndex: override wins (fully agent-defined)
      soul: override.soul || base.soul,
      skillIndex: override.skillIndex || base.skillIndex,
      roles,
      // extras: merge by key, override wins per key
      extras: { ...base.extras, ...override.extras },
    }
  }
}
