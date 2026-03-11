# Data Model: Brain Identity & Role Loading

**Feature**: 007-brain-identity-role-loading
**Date**: 2026-03-11

---

## 新增类型

### IdentityCache（内存缓存结构）

```typescript
// src/identity/index.ts

export interface RoleEntry {
  /** frontmatter 剥离后的 {brain}.md 正文；缺失文件时为 "" */
  body: string
  /** allowed_tools frontmatter 字段；缺失或解析失败时为 [] */
  allowedTools: string[]
}

export interface IdentityCache {
  /** soul.md 全文内容；文件缺失时为 "" */
  soul: string
  /** skill-index.md 全文内容；文件缺失时为 "" */
  skillIndex: string
  /** 已解析的脑区角色文件；只包含实际存在的脑区 */
  roles: Partial<Record<CognitiveBrainType, RoleEntry>>
}
```

### IdentityLoader

```typescript
// src/identity/loader.ts

export class IdentityLoader {
  private readonly identityDir: string
  private cache: IdentityCache | null = null

  constructor(identityDir: string) { ... }

  /**
   * 加载 identityDir 下所有文件并缓存。
   * @throws Error 若 identityDir 路径不存在（含路径 + 原因）
   */
  async load(): Promise<IdentityCache>

  /** 返回当前缓存；未调用 load() 时返回 null */
  getCache(): IdentityCache | null
}
```

---

## 扩展现有类型

### ContextAssemblerConfig（新增 soul 字段）

```typescript
// src/context/index.ts — 修改

export interface ContextAssemblerConfig {
  /**
   * 新增：Block 1 前缀内容（soul.md 全文）。
   * 非空时出现在 Block 1 所有其他内容之前。
   * 缺失/空字符串时行为与现在完全一致（向后兼容）。
   */
  soul?: string

  /** 现有：每脑区的角色 + 指令（BrainIdentity.role / .instructions）*/
  identities: Record<CognitiveBrainType, BrainIdentity>

  /** 现有：Skill Index，注入 Block 2 末尾 */
  skillIndex?: string

  /** 现有：时区信息 */
  timezone?: string
}
```

### AIMAInstanceConfig（新增 identityDir / reloadOnRun）

```typescript
// src/instance.ts — 修改

export interface AIMAInstanceConfig {
  // ── 新增字段 ──────────────────────────────────────────────────────
  /**
   * 可选。identityDir 目录绝对路径。
   * 目录结构：
   *   soul.md           → Block 1 前缀（所有脑区共享）
   *   skill-index.md    → Block 2 Skill Index（所有脑区共享）
   *   limbic.md         → Limbic 脑区 Block 2 角色（支持 allowed_tools frontmatter）
   *   cortex.md         → Cortex 脑区 Block 2 角色
   *   brainstem.md      → Brainstem 脑区 Block 2 角色
   *
   * 未设置时：行为与现有完全一致（向后兼容）
   */
  identityDir?: string

  /**
   * 可选，默认 false。
   * true 时每次 run() 前自动调用 reloadIdentity()。
   * 注意：会增加文件 I/O 延迟，仅用于开发/调试场景。
   */
  reloadOnRun?: boolean

  // ── 现有字段（不变）──────────────────────────────────────────────
  identities?: Partial<Record<CognitiveBrainType, BrainIdentity>>
  // ... 其他现有字段
}
```

---

## identityDir 文件目录结构

```
identityDir/
├── soul.md           ← 核心人格（所有脑区共享）→ Block 1 前缀
├── skill-index.md    ← 技能索引（所有脑区共享）→ Block 2 共享部分
├── limbic.md         ← Limbic 专属角色
├── cortex.md         ← Cortex 专属角色
└── brainstem.md      ← Brainstem 专属角色
```

### {brain}.md YAML Frontmatter 格式

```yaml
---
allowed_tools:
  - bash
  - edit
---

（正文：角色职责描述，作为 BrainIdentity.instructions 内容）
```

frontmatter 中可选字段：
- `allowed_tools`: 字符串数组。列表中的工具从 Extension Factory 的 DEFAULT_BLOCKED_TOOLS 中解锁。不在 DEFAULT_BLOCKED_TOOLS 中的工具名称静默忽略。
- 其他字段：当前版本忽略（为未来扩展预留）

---

## assembleBlock12 输出格式（扩展后）

```
{config.soul}
                    ← soul 非空时包含（后跟空行分隔）

## Role
{identity.role}

## Instructions
{identity.instructions}

## Skill Index
{config.skillIndex}
                    ← skillIndex 非空时包含
```

soul 为空时输出与现在完全一致（向后兼容）。

---

## createAimaExtension 签名扩展

```typescript
// src/adapters/pi-coding-agent/extension.ts — 修改

export function createAimaExtension(
  brain: CognitiveBrainType,
  threadId: string,
  amygdala: Amygdala,
  eventBus: BrainEventBus,
  allowedTools?: string[],    // 新增：来自 {brain}.md allowed_tools frontmatter
): ExtensionFactory
```

### tool_call Stage 1 逻辑修改

```typescript
// 修改前
if (DEFAULT_BLOCKED_TOOLS.has(toolName)) {
  // block
}

// 修改后
const allowedSet = new Set(allowedTools ?? [])
if (DEFAULT_BLOCKED_TOOLS.has(toolName) && !allowedSet.has(toolName)) {
  // block
}
```

其余逻辑（Stage 2/3、事件 emit）不变。
