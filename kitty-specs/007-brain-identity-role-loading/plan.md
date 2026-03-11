# Implementation Plan: Brain Identity & Role Loading

**Branch**: `007-brain-identity-role-loading` | **Date**: 2026-03-11 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/kitty-specs/007-brain-identity-role-loading/spec.md`

---

## Summary

从文件系统目录（`identityDir`）加载 soul.md / brain role 文件 / skill-index.md，替换 `assembleBlock12` 的静态字符串来源，并将 role 文件的 `allowed_tools` frontmatter 字段映射为 Extension Factory 的每脑区工具权限覆盖。

技术实现：
1. 新增 `src/identity/` 模块，`IdentityLoader` 负责文件读取、YAML frontmatter 解析、内存缓存
2. `ContextAssemblerConfig` 扩展 `soul?: string` 字段；`assembleBlock12` 在 Block 1 中前置 soul 内容
3. `createAimaExtension` 接收 `allowedTools?: string[]` 参数，从 `DEFAULT_BLOCKED_TOOLS` 中移除对应工具
4. `AIMAInstance` 在构造时调用 `IdentityLoader`，通过 `buildAssemblerConfig()` 注入 soul/skillIndex/brain bodies，通过 `allowedTools` 传入 Extension Factory
5. `AIMAInstance.reloadIdentity()` 重新加载缓存并刷新所有 live session 的 Extension 工具权限

---

## Technical Context

**Language/Version**: TypeScript（Bun runtime）
**Primary Dependencies**: 现有 AIMA 依赖；frontmatter 解析用正则（无新依赖）
**Storage**: 本地文件系统（UTF-8 文本文件）；内存缓存（`IdentityCache` 对象）
**Testing**: Bun test（`bun test`）
**Target Platform**: Node.js/Bun 兼容（`fs/promises` 文件 API）
**Project Type**: Single TypeScript library（AIMA framework）
**Performance Goals**: 文件加载 ≤100ms（10 个 <50KB 文件），不影响 `run()` 热路径
**Constraints**: 不新增外部依赖；`identityDir` 缺失时零副作用；向后兼容（不破坏现有测试）

---

## Constitution Check

**项目约束**（来自 `.kittify/memory/constitution.md` 或推断自 AIMA 规范）：

- ✅ 无新外部依赖（frontmatter 用自研正则解析）
- ✅ 向后兼容：`identityDir` 为可选字段，缺失时 `buildAssemblerConfig()` 行为完全不变
- ✅ `bun run typecheck` 零错误，`biome check` 通过
- ✅ 测试密度 ≥20 个单元测试
- ✅ 修改范围：`src/identity/`（新增）、`src/context/index.ts`（扩展）、`src/adapters/pi-coding-agent/extension.ts`（参数扩展）、`src/instance.ts`（集成）、测试文件

---

## Project Structure

### Documentation (this feature)

```
kitty-specs/007-brain-identity-role-loading/
├── plan.md              # This file
├── data-model.md        # Phase 1 output
└── tasks.md             # Phase 2 output (/spec-kitty.tasks)
```

### Source Code

```
src/
├── identity/                    ← 新增模块
│   ├── index.ts                 ← 导出 IdentityLoader, IdentityCache 类型
│   ├── loader.ts                ← IdentityLoader 核心实现
│   └── frontmatter.ts           ← YAML frontmatter 解析工具函数
├── context/
│   └── index.ts                 ← 扩展 ContextAssemblerConfig.soul, assembleBlock12 更新
├── adapters/pi-coding-agent/
│   └── extension.ts             ← createAimaExtension 新增 allowedTools 参数
└── instance.ts                  ← buildAssemblerConfig() 集成 IdentityLoader, reloadIdentity()

tests/
├── identity/
│   ├── loader.test.ts           ← IdentityLoader 单元测试（文件读取/缺失/缓存）
│   └── frontmatter.test.ts      ← YAML 解析单元测试
├── context/
│   └── context.test.ts          ← assembleBlock12 soul 注入测试（现有 + 新增）
└── adapters/pi-coding-agent/
    └── extension.test.ts        ← allowedTools 工具权限覆盖测试（现有 + 新增）
```

---

## Architecture Decisions

### AD-01：IdentityCache 数据结构

```typescript
interface RoleEntry {
  body: string              // frontmatter 剥离后的正文
  allowedTools: string[]    // 来自 allowed_tools frontmatter，缺失时 []
}

interface IdentityCache {
  soul: string                                              // soul.md 内容，缺失时 ""
  skillIndex: string                                        // skill-index.md 内容，缺失时 ""
  roles: Partial<Record<CognitiveBrainType, RoleEntry>>    // {brain}.md 解析结果
}
```

### AD-02：YAML Frontmatter 解析策略

用正则提取 `---` 块，手动解析 `allowed_tools: [bash, edit]` 格式。不引入 `gray-matter` 等外部依赖。
解析错误（格式不合法）→ 记录 console.warn，正文仍加载，`allowedTools = []`。

```typescript
// 解析目标格式（只关心 allowed_tools，其他字段忽略）
// ---
// allowed_tools:
//   - bash
//   - edit
// ---
// 正文内容
```

### AD-03：Extension Factory 工具权限覆盖方式

`createAimaExtension(brain, threadId, amygdala, eventBus, allowedTools?: string[])` 新增可选参数。

在 tool_call Stage 1（DEFAULT_BLOCKED_TOOLS 检查）时，若 `allowedTools` 包含该工具 → 跳过默认封锁，直接进入 Stage 2/3：

```typescript
if (DEFAULT_BLOCKED_TOOLS.has(toolName) && !allowedSet.has(toolName)) {
  // block
}
```

**设计原则**：覆盖发生在 Extension 层（per-session），不改 Amygdala 的静态策略（Amygdala 是框架级守卫）。

### AD-04：soul.md 与 BrainIdentity 的映射

当前 `assembleBlock12` 输出：
```
## Role
{identity.role}

## Instructions
{identity.instructions}

## Skill Index (optional)
{config.skillIndex}
```

扩展后，在 Block 1 开头前置 soul：
```
{config.soul}     ← 若非空，前置

## Role
{identity.role}

## Instructions
{identity.instructions}

## Skill Index (optional)
{config.skillIndex}
```

`{brain}.md` 映射：
- frontmatter `role:` 字段 → `BrainIdentity.role`（若无则保留现有默认 role）
- 正文（frontmatter 剥离后）→ `BrainIdentity.instructions`（替换现有 hardcoded instructions）

### AD-05：AIMAInstance 集成点

```typescript
class AIMAInstance {
  private identityLoader?: IdentityLoader  // 仅 identityDir 配置时存在

  // 构造时同步 init（实际 loadFiles 是 async，需 initialize() 方法或在 create() 工厂中 await）
  static async create(config: AIMAInstanceConfig): Promise<AIMAInstance>

  async reloadIdentity(): Promise<void>  // 重新读取文件 + 更新 live sessions 的 allowedTools
}
```

注意：`AIMAInstance` 当前通过 `new AIMAInstance(config)` 构造，若 `identityDir` 需要 async 加载，
**方案**：新增 `async initialize()` 方法，在首次 `run()` 前或显式调用时执行。或将 `identityDir` 加载推迟到第一次 `run()` 时（lazy init）。

**决策**：Lazy init（首次 `run()` 时加载），`reloadIdentity()` 显式触发重载。
这样无需改 `AIMAInstance` 构造器签名，现有实例化代码零修改。

### AD-06：reloadIdentity() 对 live sessions 的影响

`reloadIdentity()` 仅更新缓存。Live session 的 `allowedTools` 已在 `createAimaExtension()` 调用时绑定为闭包——**无法热更新已存在的 Extension**。

**实现策略**：`reloadIdentity()` 后，已有 session 的 Extension 工具策略不变；新建的 session（下一次首次激活该 brain:thread）使用新策略。文档中明确此行为，符合 FR-05 的「下一次 run() 时使用新内容」。

如果 session 已存在（非首次 run），Extension 已创建，`allowedTools` 覆盖无法回溯。这是 **已知设计限制**，在文档和测试中注明。

---

## Data Model

详见 [data-model.md](data-model.md)。

核心新增类型：

```typescript
// src/identity/index.ts

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
  constructor(identityDir: string)
  async load(): Promise<IdentityCache>   // 加载并返回缓存
  getCache(): IdentityCache | null       // 返回当前缓存（未加载时 null）
}
```

扩展现有类型：

```typescript
// src/context/index.ts — 新增 soul 字段
export interface ContextAssemblerConfig {
  soul?: string                                           // 新增：Block 1 前缀
  identities: Record<CognitiveBrainType, BrainIdentity>
  skillIndex?: string
  timezone?: string
}

// src/adapters/pi-coding-agent/extension.ts — 新增 allowedTools 参数
export function createAimaExtension(
  brain: CognitiveBrainType,
  threadId: string,
  amygdala: Amygdala,
  eventBus: BrainEventBus,
  allowedTools?: string[],   // 新增：从 DEFAULT_BLOCKED_TOOLS 中解锁的工具列表
): ExtensionFactory
```

---

## Work Package Breakdown

### WP01 — IdentityLoader 核心模块

**范围**：新建 `src/identity/` 模块，实现 frontmatter 解析和文件加载缓存。

**子任务**：
- T01: 新建 `src/identity/frontmatter.ts` — 正则解析 `---` 块，提取 `allowed_tools` 数组；返回 `{ body: string; frontmatter: Record<string, unknown> }`；解析失败时 warn + 降级
- T02: 新建 `src/identity/loader.ts` — `IdentityLoader` 类：`constructor(identityDir)` + `load(): Promise<IdentityCache>`；读取 soul.md / skill-index.md / {brain}.md；目录不存在 → 有意义错误；文件缺失 → 空字符串降级
- T03: 新建 `src/identity/index.ts` — 导出 `IdentityLoader`、`IdentityCache`、`RoleEntry` 类型
- T04: 单元测试 `tests/identity/frontmatter.test.ts`（≥8 cases）：正常解析、缺失 frontmatter、格式错误、allowed_tools 各种格式
- T05: 单元测试 `tests/identity/loader.test.ts`（≥8 cases）：完整目录、缺失各个文件、目录不存在错误、缓存行为

**产出**：`src/identity/` 模块，≥16 单元测试通过

---

### WP02 — Context Assembly Block 1/2 注入

**范围**：扩展 `ContextAssemblerConfig` 加入 `soul`，更新 `assembleBlock12` 支持 soul 前置注入。

**子任务**：
- T06: 修改 `src/context/index.ts` — `ContextAssemblerConfig` 新增 `soul?: string`；`assembleBlock12` 在 Block 1 开头前置 soul（非空时）；`identities` 中来自 `{brain}.md` 的 `role`/`instructions` 正常映射
- T07: 扩展 `tests/context/context.test.ts` — 新增测试：soul 注入到 Block 1；无 soul 时输出不变；skillIndex 注入到 Block 2；{brain}.md 正文注入到 Block 2；frontmatter 不出现在输出中

**产出**：`assembleBlock12` 支持 soul 前置，向后兼容，≥6 新测试通过

---

### WP03 — Extension Factory 工具权限覆盖

**范围**：`createAimaExtension` 新增 `allowedTools` 参数，实现每脑区 DEFAULT_BLOCKED_TOOLS 覆盖。

**子任务**：
- T08: 修改 `src/adapters/pi-coding-agent/extension.ts` — `createAimaExtension` 新增 `allowedTools?: string[]` 参数；Stage 1 检查改为 `DEFAULT_BLOCKED_TOOLS.has(toolName) && !allowedSet.has(toolName)` 才封锁
- T09: 扩展 `tests/adapters/pi-coding-agent/extension.test.ts` — 新增测试：brainstem 声明 `[bash]` → bash 放行；limbic 未声明 → bash 拦截；非 DEFAULT_BLOCKED_TOOLS 工具不受影响；空 allowedTools 等同无覆盖

**产出**：Extension 支持每脑区工具覆盖，向后兼容，≥4 新测试通过

---

### WP04 — AIMAInstance 集成 + reloadIdentity()

**范围**：在 `AIMAInstance` 中集成 `IdentityLoader`，实现 lazy init、`buildAssemblerConfig()` 注入、`reloadIdentity()` 方法、`reloadOnRun` 支持。

**子任务**：
- T10: 修改 `src/instance.ts` — `AIMAInstanceConfig` 新增 `identityDir?: string` 和 `reloadOnRun?: boolean`；新增 `private identityLoader?: IdentityLoader` 和 `private identityCache: IdentityCache | null`
- T11: 修改 `buildAssemblerConfig()` — 若有 identityCache，将 soul/skillIndex/brain roles 注入到 config（优先于现有 hardcoded 默认值 + config.identities override）
- T12: 修改 `run()` — lazy init（首次 run 前调用 `identityLoader.load()`）；`reloadOnRun: true` 时每次 run 前 reload
- T13: 修改 adapter 创建路径 — 将 `allowedTools` 从 identityCache 中提取，传入 `createAimaExtension(brain, threadId, amygdala, eventBus, cache?.roles[brain]?.allowedTools)`
- T14: 新增 `reloadIdentity(): Promise<void>` — 重新调用 `identityLoader.load()`；静默无操作（若未配置 identityDir）
- T15: 集成测试 `tests/instance.test.ts` 新增场景 — identityDir 配置后 Block 1/2 包含文件内容；reloadIdentity 后新策略生效（新 session）；无 identityDir 时现有测试不变

**产出**：`AIMAInstance` 完整集成，`reloadIdentity()` 可用，向后兼容，≥6 新集成测试通过

---

## Success Gates

| Gate | Criteria |
|------|----------|
| 类型检查 | `bun run typecheck` 零错误 |
| Lint | `biome check` 通过 |
| 单元测试 | ≥20 个新测试，全部通过 |
| 向后兼容 | 不传 `identityDir` 的所有现有测试零失败 |
| 功能验证 | 场景 A-D（spec.md）可验证通过 |
| 无新依赖 | `package.json` 不新增运行时依赖 |

---

## Complexity Tracking

无违反约束的设计决策——所有新增复杂度都来自明确的功能需求。

| 新增组件 | 原因 | 替代方案 |
|---------|------|---------|
| `src/identity/` 新模块 | 单一职责：文件加载与解析分离 | 直接写入 instance.ts（拒绝：违反 SRP，难测试）|
| Lazy init 而非 async 构造 | 保持 `new AIMAInstance(config)` 签名不变 | 工厂方法 `AIMAInstance.create()`（可行但破坏现有代码）|
| Extension 层覆盖（非 Amygdala 层）| Amygdala.check() 不接收 brain 参数 | 修改 Amygdala API（拒绝：Feature 007 范围外）|
