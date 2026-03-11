---
work_package_id: WP02
title: Context Assembly Block 1/2 Injection
lane: "done"
dependencies: ["WP01"]
subtasks:
- T006
- T007
phase: Phase 2 - Core Features
assignee: ''
agent: "claude-sonnet-4-6"
shell_pid: "53111"
review_status: "approved"
reviewed_by: "XIAYANG ZHANG"
history:
- timestamp: '2026-03-11T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP02 – Context Assembly Block 1/2 Injection

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, scroll to Review Feedback section.

---

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

扩展 `ContextAssemblerConfig` 接口，新增 `soul?: string` 字段，修改 `assembleBlock12` 函数，在 Block 1 开头前置 soul 内容。确保：

1. Block 1 输出格式：`{soul}\n\n## Role\n...`（soul 非空时）
2. frontmatter 不出现在 Context Assembly 输出中（已在 WP01 的 parseFrontmatter 处理，此处使用 `body` 字段）
3. 不传 `soul` 时，输出与现在完全一致（向后兼容）

**Success criteria**:
- `bun run typecheck` 零错误
- `biome check` 通过
- 现有 context 相关测试零失败
- 新增测试：soul 注入、向后兼容、frontmatter 剥离验证

---

## Implementation Context

### 当前 assembleBlock12 行为

读取 `src/context/index.ts`，确认现有实现。预期结构如下（实际以代码为准）：

```typescript
export function assembleBlock12(
  brain: CognitiveBrainType,
  config: ContextAssemblerConfig
): string {
  const identity = config.identities[brain]
  const parts: string[] = []

  // Block 1: Role
  parts.push(`## Role\n${identity.role}`)

  // Block 2: Instructions
  parts.push(`## Instructions\n${identity.instructions}`)

  // Skill Index (optional)
  if (config.skillIndex) {
    parts.push(`## Skill Index\n${config.skillIndex}`)
  }

  return parts.join('\n\n')
}
```

**修改后预期输出**（soul 非空）：
```
你是 Alex，一个尽职的财务助理

## Role
Limbic Brain — Emotional Intelligence

## Instructions
...

## Skill Index
...
```

**修改后预期输出**（soul 为空/未设置，向后兼容）：
```
## Role
Limbic Brain — Emotional Intelligence

## Instructions
...
```

### ContextAssemblerConfig 当前定义

```typescript
// 在修改前，先 Read src/context/index.ts 确认实际字段
interface ContextAssemblerConfig {
  identities: Record<CognitiveBrainType, BrainIdentity>
  skillIndex?: string
  timezone?: string
}
```

---

## Subtask Guidance

### T006 — 修改 `src/context/index.ts`

**Purpose**: 为 `ContextAssemblerConfig` 新增 `soul?: string`，并更新 `assembleBlock12` 前置 soul。

**Steps**:

1. **读取 `src/context/index.ts`** — 确认现有接口定义和函数实现

2. **扩展 `ContextAssemblerConfig`**：
   ```typescript
   export interface ContextAssemblerConfig {
     /**
      * Block 1 前缀（来自 soul.md 全文）。
      * 非空时出现在 ## Role 之前，与其余内容以空行分隔。
      * 缺失/空字符串时行为与修改前完全一致（向后兼容）。
      */
     soul?: string
     identities: Record<CognitiveBrainType, BrainIdentity>
     skillIndex?: string
     timezone?: string  // 若已存在
   }
   ```

3. **修改 `assembleBlock12`**（在 `## Role` 之前插入 soul）：
   ```typescript
   export function assembleBlock12(
     brain: CognitiveBrainType,
     config: ContextAssemblerConfig
   ): string {
     const identity = config.identities[brain]
     const parts: string[] = []

     // Block 1 前缀：soul（可选）
     if (config.soul && config.soul.trim() !== '') {
       parts.push(config.soul.trim())
     }

     // Block 1: Role
     parts.push(`## Role\n${identity.role}`)

     // Block 2: Instructions
     parts.push(`## Instructions\n${identity.instructions}`)

     // Skill Index（可选）
     if (config.skillIndex && config.skillIndex.trim() !== '') {
       parts.push(`## Skill Index\n${config.skillIndex}`)
     }

     return parts.join('\n\n')
   }
   ```

**注意**：
- `soul.trim()` 确保不引入多余空白
- `parts.join('\n\n')` 确保各块之间有双换行分隔
- 若现有代码结构与预期不同，以实际代码为准进行最小化修改

**Files**: `src/context/index.ts`（修改）

**Validation**:
- [ ] `ContextAssemblerConfig` 有 `soul?: string` 字段（可选）
- [ ] soul 非空时，出现在 `## Role` 之前
- [ ] soul 空字符串时，输出不含空行头部
- [ ] soul 缺失时，输出与修改前完全一致

---

### T007 — 更新/扩展 Context 测试

**Purpose**: 新增测试覆盖 soul 注入场景，同时确认现有测试仍通过。

**先读取现有测试文件**：定位 context 相关测试（可能在 `tests/context/` 或 `tests/`），了解现有测试结构再添加。

**新增 test cases**：

```typescript
describe('assembleBlock12 with soul', () => {
  const baseConfig: ContextAssemblerConfig = {
    identities: {
      limbic: { role: 'Limbic Brain', instructions: 'Understand emotions' },
      cortex: { role: 'Cortex Brain', instructions: 'Synthesize information' },
      brainstem: { role: 'Brainstem Brain', instructions: 'Execute tasks' },
    },
  }

  test('soul 非空时出现在 ## Role 之前', () => {
    const config = { ...baseConfig, soul: '你是 Alex，一个尽职的财务助理' }
    const output = assembleBlock12('limbic', config)
    const soulIdx = output.indexOf('你是 Alex')
    const roleIdx = output.indexOf('## Role')
    expect(soulIdx).toBeGreaterThanOrEqual(0)
    expect(soulIdx).toBeLessThan(roleIdx)
  })

  test('soul 缺失时输出不变（向后兼容）', () => {
    const withoutSoul = assembleBlock12('limbic', baseConfig)
    expect(withoutSoul.startsWith('## Role')).toBe(true)
  })

  test('soul 空字符串时等同缺失', () => {
    const config = { ...baseConfig, soul: '' }
    const output = assembleBlock12('limbic', config)
    expect(output.startsWith('## Role')).toBe(true)
  })

  test('soul 内容 trim 后不为空才输出', () => {
    const config = { ...baseConfig, soul: '   \n   ' }
    const output = assembleBlock12('limbic', config)
    expect(output.startsWith('## Role')).toBe(true)
  })

  test('frontmatter 标记（---）不出现在输出中（soul 传入时已是剥离后的 body）', () => {
    // soul.md 的内容经过 IdentityLoader 处理，这里只测 soul 本身不含 ---
    const config = { ...baseConfig, soul: '你是 Alex' }
    const output = assembleBlock12('limbic', config)
    expect(output).not.toMatch(/^---/m)
  })

  test('soul + skillIndex 都存在时输出结构正确', () => {
    const config = { ...baseConfig, soul: 'Soul content', skillIndex: 'Skills list' }
    const output = assembleBlock12('limbic', config)
    expect(output).toContain('Soul content')
    expect(output).toContain('## Role')
    expect(output).toContain('## Instructions')
    expect(output).toContain('## Skill Index')
    expect(output).toContain('Skills list')
  })
})
```

**Files**: `tests/context/context.test.ts` 或现有 context 测试文件（新增 describe block）

**注意**：若测试文件路径不同，先 `Glob 'tests/**/*.test.ts'` 确认位置。

---

## Definition of Done

- [ ] `src/context/index.ts` — `ContextAssemblerConfig` 新增 `soul?: string`
- [ ] `src/context/index.ts` — `assembleBlock12` 在 soul 非空时前置
- [ ] 所有现有 context 测试仍通过（零 regression）
- [ ] ≥5 个新测试通过（soul 注入、向后兼容 2 种、frontmatter 不出现、soul+skillIndex 组合）
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过

---

## Risks

- **现有测试结构**：先读取现有测试文件，不要假设路径——用 Glob 确认
- **parts.join 分隔符**：确保 soul 与 `## Role` 之间有 `\n\n` 而非 `\n`（单换行）；以 `parts.join('\n\n')` 统一处理
- **identity 字段确认**：`BrainIdentity` 是否有 `role`/`instructions` 字段，以代码实际定义为准

---

## Implementation Command

```bash
spec-kitty implement WP02 --base WP01
```

## Activity Log

- 2026-03-11T11:55:06Z – claude-sonnet-4-6 – shell_pid=940 – lane=doing – Started implementation via workflow command
- 2026-03-11T11:56:46Z – claude-sonnet-4-6 – shell_pid=940 – lane=for_review – Ready for review: soul field added to ContextAssemblerConfig, assembleBlock12 prepends soul before ## Role when non-empty. 13 tests passing (7 existing + 6 new). typecheck clean, biome clean.
- 2026-03-11T12:33:56Z – claude-sonnet-4-6 – shell_pid=53111 – lane=doing – Started review via workflow command
- 2026-03-11T12:34:03Z – claude-sonnet-4-6 – shell_pid=53111 – lane=done – Review passed: soul field added to ContextAssemblerConfig, assembleBlock12 prepends soul before ## Role. 13 tests (7 existing + 6 new). Backwards compatible. typecheck clean, biome clean.
