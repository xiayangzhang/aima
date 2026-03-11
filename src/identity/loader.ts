import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { CognitiveBrainType } from '../types/index.js'
import { parseFrontmatter } from './frontmatter.js'

export interface RoleEntry {
  body: string
  allowedTools: string[]
}

export interface IdentityCache {
  soul: string
  skillIndex: string
  roles: Partial<Record<CognitiveBrainType, RoleEntry>>
}

export class IdentityLoader {
  private readonly identityDir: string
  private cache: IdentityCache | null = null

  constructor(identityDir: string) {
    this.identityDir = path.resolve(identityDir)
  }

  /**
   * Read all files in identityDir and populate the cache.
   * @throws {Error} if identityDir does not exist or is not accessible
   */
  async load(): Promise<IdentityCache> {
    // Validate directory exists
    try {
      await fs.access(this.identityDir)
      const stat = await fs.stat(this.identityDir)
      if (!stat.isDirectory()) {
        throw new Error('not a directory')
      }
    } catch (err) {
      throw new Error(
        `IdentityLoader: identityDir does not exist or is not accessible: "${this.identityDir}" — ${(err as Error).message}`,
      )
    }

    const readOptional = async (filename: string): Promise<string> => {
      try {
        return await fs.readFile(path.join(this.identityDir, filename), 'utf-8')
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

    this.cache = { soul, skillIndex, roles }
    return this.cache
  }

  /** Current cache; returns null if load() has not been called */
  getCache(): IdentityCache | null {
    return this.cache
  }
}
