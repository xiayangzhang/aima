---
work_package_id: "WP01"
title: "IdentityLoader Core Module"
phase: "Phase 1 - Foundation"
lane: "doing"
dependencies: []
subtasks:
  - "T001"
  - "T002"
  - "T003"
  - "T004"
  - "T005"
assignee: ""
agent: "claude-sonnet-4-6"
shell_pid: "52517"
review_status: ""
reviewed_by: ""
history:
  - timestamp: "2026-03-11T00:00:00Z"
    lane: "planned"
    agent: "system"
    shell_pid: ""
    action: "Prompt generated via /spec-kitty.tasks"
---

# Work Package Prompt: WP01 – IdentityLoader Core Module

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, scroll to Review Feedback section.

---

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

新建 `src/identity/` 模块，实现：
1. YAML frontmatter 正则解析工具（`frontmatter.ts`）
2. `IdentityLoader` 类，从 `identityDir` 读取并缓存 soul.md / skill-index.md / {brain}.md（`loader.ts`）
3. 公共类型和导出（`index.ts`）
4. 单元测试 ≥16 个，覆盖正常路径和边界条件

**Success criteria**:
- `bun run typecheck` 零错误
- `biome check` 通过
- `bun test tests/identity/` 全绿（≥16 tests）
- `IdentityLoader` 在目录不存在时抛出含路径的有意义错误
- 文件缺失时 `soul`/`skillIndex`/`body` 降级为空字符串，`allowedTools` 降级为 `[]`

---

## Implementation Context

### 相关文件

```
src/
└── identity/              ← 全部新建
    ├── frontmatter.ts     ← T001
    ├── loader.ts          ← T002
    └── index.ts           ← T003

tests/
└── identity/              ← 全部新建
    ├── frontmatter.test.ts  ← T004
    └── loader.test.ts       ← T005
```

### 已有类型参考

```typescript
// src/types/index.ts — CognitiveBrainType
type CognitiveBrainType = 'limbic' | 'cortex' | 'brainstem'
// (check actual definition in src/types/index.ts)
```

### identityDir 预期文件结构

```
identityDir/
├── soul.md           ← 所有脑区共享，Block 1 前缀
├── skill-index.md    ← 所有脑区共享，Block 2 技能索引
├── limbic.md         ← Limbic 专属（支持 YAML frontmatter）
├── cortex.md         ← Cortex 专属
└── brainstem.md      ← Brainstem 专属
```

### YAML Frontmatter 格式

只关心 `allowed_tools` 字段：

```yaml
---
allowed_tools:
  - bash
  - edit
---

正文内容...
```

也支持单行数组格式（可选，解析尽力而为）：

```yaml
---
allowed_tools: [bash, edit]
---
```

---

## Subtask Guidance

### T001 — `src/identity/frontmatter.ts`

**Purpose**: 解析 Markdown 文件中的 YAML frontmatter，提取 `allowed_tools` 数组，返回剥离 frontmatter 后的正文。

**Implementation**:

```typescript
export interface ParsedFrontmatter {
  body: string           // frontmatter 剥离后的正文（trim 后）
  allowedTools: string[] // 解析出的工具名称列表；解析失败时 []
}

/**
 * 解析 Markdown 内容中的 YAML frontmatter。
 * - frontmatter 必须以 "---\n" 开始（第一行）
 * - 以下一个 "---\n" 或 "---"（末尾）结束
 * - 只提取 allowed_tools 字段，其他字段忽略
 * - 解析失败时记录 console.warn，返回 body=原文, allowedTools=[]
 */
export function parseFrontmatter(content: string): ParsedFrontmatter
```

**Steps**:

1. 检测 frontmatter 边界：`/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/` 匹配文件开头

2. 若无 frontmatter：直接返回 `{ body: content.trim(), allowedTools: [] }`

3. 提取 frontmatter 块内容，解析 `allowed_tools`：
   - 多行 YAML 列表格式（`- bash`）：用 `/^\s*-\s*(.+)$/gm` 匹配 `allowed_tools:` 之后的项
   - 单行数组格式（`[bash, edit]`）：用 `/\[([^\]]+)\]/` 匹配，split by `,`
   - 去掉引号、空格，过滤空字符串

4. body = frontmatter 之后的内容，`trim()`

5. try/catch 包裹整个解析过程，catch 时 `console.warn('Failed to parse frontmatter:', err)` 并返回 `{ body: content.trim(), allowedTools: [] }`

**Files**: `src/identity/frontmatter.ts`（新建，~60 行）

**Validation**:
- [ ] 标准 YAML 列表格式正确解析
- [ ] 无 frontmatter 时 body = 原内容，allowedTools = []
- [ ] frontmatter 无 allowed_tools 时返回 []
- [ ] body 不含 `---` 边界行

---

### T002 — `src/identity/loader.ts`

**Purpose**: `IdentityLoader` 类，加载 identityDir 下所有文件，返回结构化缓存。

**Interface**:

```typescript
import type { CognitiveBrainType } from '../types/index'
import { parseFrontmatter } from './frontmatter'

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

  constructor(identityDir: string)

  /**
   * 读取 identityDir 下所有文件并缓存。
   * @throws {Error} identityDir 不存在时，错误信息包含路径和原因
   */
  async load(): Promise<IdentityCache>

  /** 当前缓存；未调用 load() 时返回 null */
  getCache(): IdentityCache | null
}
```

**Implementation Steps**:

1. `constructor(identityDir: string)` — 仅存储路径，不做 I/O

2. `load()` 实现：
   ```typescript
   async load(): Promise<IdentityCache> {
     // Step 1: 验证目录存在
     try {
       await fs.access(identityDir)
       const stat = await fs.stat(identityDir)
       if (!stat.isDirectory()) throw new Error('not a directory')
     } catch (err) {
       throw new Error(
         `IdentityLoader: identityDir does not exist or is not accessible: "${identityDir}" — ${(err as Error).message}`
       )
     }

     // Step 2: 读取各文件（缺失时 = 空字符串）
     const readOptional = async (filename: string): Promise<string> => {
       try {
         return await fs.readFile(path.join(identityDir, filename), 'utf-8')
       } catch {
         return ''
       }
     }

     const soul = await readOptional('soul.md')
     const skillIndex = await readOptional('skill-index.md')

     // Step 3: 读取各脑区文件
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
   ```

3. `getCache()` — 返回 `this.cache`

**Files**: `src/identity/loader.ts`（新建，~80 行）

**Imports**: `node:fs/promises` as `fs`, `node:path` as `path`

**Validation**:
- [ ] 完整目录：soul/skillIndex/roles 全部正确填充
- [ ] 缺失文件：对应字段为 `""`（soul/skillIndex）或 role 不出现在 roles 中
- [ ] 目录不存在：抛出含路径的错误
- [ ] 连续调用 `load()` 两次：第二次 cache 被覆盖（非累积）

---

### T003 — `src/identity/index.ts`

**Purpose**: 导出模块公共接口。

```typescript
export { IdentityLoader } from './loader'
export type { IdentityCache, RoleEntry } from './loader'
export { parseFrontmatter } from './frontmatter'
export type { ParsedFrontmatter } from './frontmatter'
```

**Files**: `src/identity/index.ts`（新建，~6 行）

---

### T004 — `tests/identity/frontmatter.test.ts`

**Purpose**: 单元测试 `parseFrontmatter` 函数，≥8 test cases。

**Test cases**:

```typescript
import { describe, expect, test } from 'bun:test'
import { parseFrontmatter } from '../../src/identity/frontmatter'

describe('parseFrontmatter', () => {
  test('标准 YAML 列表格式', () => {
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

  test('无 frontmatter 时返回原内容', () => {
    const result = parseFrontmatter('正文内容')
    expect(result.allowedTools).toEqual([])
    expect(result.body).toBe('正文内容')
  })

  test('frontmatter 无 allowed_tools 字段', () => {
    const content = `---
title: Some Role
---
正文`
    const result = parseFrontmatter(content)
    expect(result.allowedTools).toEqual([])
    expect(result.body).toBe('正文')
  })

  test('body 不包含 --- 边界行', () => {
    const content = `---
allowed_tools:
  - bash
---
正文`
    expect(parseFrontmatter(content).body).not.toContain('---')
  })

  test('单工具列表', () => {
    const content = `---\nallowed_tools:\n  - bash\n---\n正文`
    expect(parseFrontmatter(content).allowedTools).toEqual(['bash'])
  })

  test('空 allowed_tools 列表', () => {
    const content = `---\nallowed_tools: []\n---\n正文`
    const result = parseFrontmatter(content)
    expect(result.allowedTools).toEqual([])
  })

  test('正文为多行内容', () => {
    const content = `---\nallowed_tools:\n  - bash\n---\n\n# Title\n\nsome content`
    const result = parseFrontmatter(content)
    expect(result.body).toContain('# Title')
    expect(result.body).toContain('some content')
  })

  test('完全空文件', () => {
    const result = parseFrontmatter('')
    expect(result.allowedTools).toEqual([])
    expect(result.body).toBe('')
  })
})
```

**Files**: `tests/identity/frontmatter.test.ts`（新建）

---

### T005 — `tests/identity/loader.test.ts`

**Purpose**: 单元测试 `IdentityLoader`，使用临时目录，≥8 test cases。

**Test setup**:

```typescript
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
```

**Test cases**:

```typescript
describe('IdentityLoader', () => {
  test('完整目录：所有文件存在时正确加载', async () => {
    await fs.writeFile(path.join(tmpDir, 'soul.md'), 'soul content')
    await fs.writeFile(path.join(tmpDir, 'skill-index.md'), 'skills')
    await fs.writeFile(path.join(tmpDir, 'limbic.md'), '---\nallowed_tools:\n  - bash\n---\nlimbic role')

    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()

    expect(cache.soul).toBe('soul content')
    expect(cache.skillIndex).toBe('skills')
    expect(cache.roles.limbic?.body).toBe('limbic role')
    expect(cache.roles.limbic?.allowedTools).toEqual(['bash'])
  })

  test('soul.md 缺失时 soul = ""', async () => {
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.soul).toBe('')
  })

  test('skill-index.md 缺失时 skillIndex = ""', async () => {
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.skillIndex).toBe('')
  })

  test('{brain}.md 缺失时该脑区不出现在 roles', async () => {
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.roles.limbic).toBeUndefined()
    expect(cache.roles.cortex).toBeUndefined()
    expect(cache.roles.brainstem).toBeUndefined()
  })

  test('{brain}.md 无 frontmatter 时 allowedTools = []', async () => {
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '# Role\nsome instructions')
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(cache.roles.brainstem?.allowedTools).toEqual([])
    expect(cache.roles.brainstem?.body).toContain('some instructions')
  })

  test('目录不存在时抛出含路径的错误', async () => {
    const loader = new IdentityLoader('/nonexistent/path/xyz')
    await expect(loader.load()).rejects.toThrow('/nonexistent/path/xyz')
  })

  test('getCache() 在 load() 前返回 null', () => {
    const loader = new IdentityLoader(tmpDir)
    expect(loader.getCache()).toBeNull()
  })

  test('load() 后 getCache() 返回同一缓存', async () => {
    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()
    expect(loader.getCache()).toBe(cache)
  })

  test('多个脑区文件同时存在', async () => {
    await fs.writeFile(path.join(tmpDir, 'limbic.md'), 'limbic body')
    await fs.writeFile(path.join(tmpDir, 'cortex.md'), 'cortex body')
    await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '---\nallowed_tools:\n  - bash\n  - edit\n---\nbrainstem body')

    const loader = new IdentityLoader(tmpDir)
    const cache = await loader.load()

    expect(cache.roles.limbic?.body).toBe('limbic body')
    expect(cache.roles.cortex?.body).toBe('cortex body')
    expect(cache.roles.brainstem?.allowedTools).toEqual(['bash', 'edit'])
  })
})
```

**Files**: `tests/identity/loader.test.ts`（新建）

---

## Definition of Done

- [ ] `src/identity/frontmatter.ts` — parseFrontmatter 函数，~60 行
- [ ] `src/identity/loader.ts` — IdentityLoader 类，~80 行
- [ ] `src/identity/index.ts` — 导出，~6 行
- [ ] `tests/identity/frontmatter.test.ts` — ≥8 tests，全绿
- [ ] `tests/identity/loader.test.ts` — ≥8 tests（含 beforeEach/afterEach 临时目录），全绿
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过

---

## Risks

- **YAML 解析歧义**：`allowed_tools: [bash, edit]`（单行）与多行格式应分别支持，用不同正则分支处理
- **CognitiveBrainType 枚举**：确认 `src/types/index.ts` 中的实际值（limbic/cortex/brainstem）再硬编码脑区列表
- **路径处理**：`identityDir` 可能是相对路径，用 `path.resolve()` 转为绝对路径确保 `access()` 正确工作

---

## Implementation Command

```bash
spec-kitty implement WP01
```

## Activity Log

- 2026-03-11T11:50:26Z – claude-sonnet-4-6 – shell_pid=95010 – lane=doing – Started implementation via workflow command
- 2026-03-11T11:52:40Z – claude-sonnet-4-6 – shell_pid=95010 – lane=for_review – Ready for review: IdentityLoader core module complete. 20 tests passing (10 frontmatter + 10 loader). typecheck clean, biome check clean.
- 2026-03-11T12:33:37Z – claude-sonnet-4-6 – shell_pid=52517 – lane=doing – Started review via workflow command
