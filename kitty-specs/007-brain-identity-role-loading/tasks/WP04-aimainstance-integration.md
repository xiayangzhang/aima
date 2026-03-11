---
work_package_id: WP04
title: AIMAInstance Integration + reloadIdentity()
lane: "for_review"
dependencies: ["WP01", "WP02", "WP03"]
subtasks:
- T010
- T011
- T012
- T013
- T014
- T015
phase: Phase 3 - Integration
assignee: ''
agent: "claude-sonnet-4-6"
shell_pid: "6060"
review_status: ''
reviewed_by: ''
history:
- timestamp: '2026-03-11T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP04 – AIMAInstance Integration + reloadIdentity()

## ⚠️ IMPORTANT: Review Feedback Status

- **Has review feedback?**: Check `review_status` above. If `has_feedback`, scroll to Review Feedback section.

---

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

在 `AIMAInstance`（`src/instance.ts`）中集成 `IdentityLoader`，实现：

1. `AIMAInstanceConfig` 新增 `identityDir?: string` 和 `reloadOnRun?: boolean`
2. Lazy init：首次 `run()` 时调用 `identityLoader.load()`，缓存结果
3. `buildAssemblerConfig()` 从 identityCache 注入 soul / skillIndex / brain roles
4. 向 `createAimaExtension()` 传入对应脑区的 `allowedTools`
5. `reloadIdentity(): Promise<void>` 公开方法
6. 集成测试覆盖场景 A-D

**Success criteria**:
- `bun run typecheck` 零错误
- `biome check` 通过
- 所有现有 instance 相关测试零失败（向后兼容）
- 新增集成测试 ≥6 个，验证场景 A-D

---

## Implementation Context

### 必读文件

**在开始实现前，必须先读取以下文件**：

```
src/instance.ts                              ← 主实现文件，了解全貌
src/identity/index.ts                        ← WP01 输出（IdentityLoader 接口）
src/context/index.ts                         ← WP02 输出（ContextAssemblerConfig 含 soul）
src/adapters/pi-coding-agent/extension.ts    ← WP03 输出（createAimaExtension 含 allowedTools）
```

### 当前 buildAssemblerConfig() 行为（参考，以实际代码为准）

```typescript
// src/instance.ts ~line 248
private buildAssemblerConfig(): ContextAssemblerConfig {
  return {
    identities: {
      limbic: {
        role: this.config.identities?.limbic?.role ?? DEFAULT_LIMBIC_ROLE,
        instructions: this.config.identities?.limbic?.instructions ?? DEFAULT_LIMBIC_INSTRUCTIONS,
      },
      cortex: { ... },
      brainstem: { ... },
    },
    skillIndex: this.config.skillIndex,
    timezone: this.config.timezone,
  }
}
```

修改后，若有 identityCache，优先使用文件内容，再 fallback 到 config.identities，再 fallback 到默认值。

### 优先级规则（identity 来源）

```
soul:         identityCache.soul > ""（无 soul 时）
skillIndex:   identityCache.skillIndex > config.skillIndex > undefined
brain role:   identityCache.roles[brain].body（作为 instructions）
              identityCache 的 brain 的 frontmatter role: 字段（若有，作为 BrainIdentity.role）
              > config.identities?.[brain] > DEFAULT_*
```

注：`{brain}.md` 的 frontmatter 可能只有 `allowed_tools`，没有 `role:` 字段——这种情况下 `BrainIdentity.role` 保持现有默认值；`BrainIdentity.instructions` 替换为文件正文（body）。

### createAimaExtension 调用位置

```typescript
// src/adapters/pi-coding-agent/index.ts (PiCodingAgentAdapter) 中
const extensionFactory = createAimaExtension(
  brain,
  threadId,
  this.config.amygdala,
  this.config.eventBus,
  // 新增：allowedTools 从 AIMAInstance 传入
)
```

但 `createAimaExtension` 在 `PiCodingAgentAdapter` 内部调用，而 `identityCache` 在 `AIMAInstance` 中。

**解决方案**：
- `PiCodingAgentAdapter` 新增可选配置字段 `getAllowedTools?: (brain: CognitiveBrainType) => string[]`
- 或在 `AIMAInstance.run()` → `adapter.run()` 的 `BrainRunParams` 中传递 `allowedTools`

**推荐方案**（最小侵入）：在 `PiCodingAgentAdapterConfig` 新增：
```typescript
getAllowedTools?: (brain: CognitiveBrainType) => string[]
```
`AIMAInstance` 在创建 Adapter 时注入此回调，Adapter 在 `createAimaExtension` 调用时查询。

---

## Subtask Guidance

### T010 — 修改 `AIMAInstanceConfig`

**Purpose**: 新增 `identityDir` 和 `reloadOnRun` 配置字段。

**Steps**:

1. 读取 `src/instance.ts`，找到 `AIMAInstanceConfig` 接口定义

2. 新增字段：
   ```typescript
   interface AIMAInstanceConfig {
     // ── 新增字段 ────────────────────────────────────────
     /**
      * 可选。identityDir 绝对路径。
      * 目录下的 soul.md / skill-index.md / {brain}.md 将替换 Block 1/2 内容来源。
      * 未设置时：与现有行为完全一致。
      */
     identityDir?: string

     /**
      * 可选，默认 false。
      * true 时每次 run() 前自动调用 reloadIdentity()。
      * 会增加文件 I/O 延迟，仅用于开发/调试。
      */
     reloadOnRun?: boolean

     // ── 现有字段保持不变 ────────────────────────────────
     // ... existing fields
   }
   ```

3. 在 `AIMAInstance` 类中新增私有字段：
   ```typescript
   private identityLoader?: IdentityLoader
   private identityCache: IdentityCache | null = null
   ```

4. 在 `constructor` 中（或类体内），若 `config.identityDir` 存在，实例化 `IdentityLoader`：
   ```typescript
   if (config.identityDir) {
     this.identityLoader = new IdentityLoader(config.identityDir)
   }
   ```

**Files**: `src/instance.ts`

---

### T011 — 修改 `buildAssemblerConfig()`

**Purpose**: 将 identityCache 的内容注入到 ContextAssemblerConfig。

**Steps**:

1. 读取当前 `buildAssemblerConfig()` 实现（通常在 ~line 248）

2. 修改后逻辑：
   ```typescript
   private buildAssemblerConfig(): ContextAssemblerConfig {
     const cache = this.identityCache

     // Soul（来自 soul.md）
     const soul = cache?.soul || undefined  // 空字符串 → undefined（不注入）

     // Skill Index（cache 优先，否则 config 中的）
     const skillIndex = (cache?.skillIndex) || this.config.skillIndex

     // 构建 identities（每个脑区：cache body → instructions；cache frontmatter role 若有 → role）
     const buildIdentity = (brain: CognitiveBrainType, defaultRole: string, defaultInstructions: string): BrainIdentity => {
       const roleEntry = cache?.roles[brain]
       const configOverride = this.config.identities?.[brain]
       return {
         role: configOverride?.role ?? defaultRole,
         instructions: roleEntry?.body || configOverride?.instructions || defaultInstructions,
       }
     }

     return {
       soul,
       identities: {
         limbic: buildIdentity('limbic', DEFAULT_LIMBIC_ROLE, DEFAULT_LIMBIC_INSTRUCTIONS),
         cortex: buildIdentity('cortex', DEFAULT_CORTEX_ROLE, DEFAULT_CORTEX_INSTRUCTIONS),
         brainstem: buildIdentity('brainstem', DEFAULT_BRAINSTEM_ROLE, DEFAULT_BRAINSTEM_INSTRUCTIONS),
       },
       skillIndex: skillIndex || undefined,
       timezone: this.config.timezone,
     }
   }
   ```

**注意**：
- 函数名、调用位置、返回类型不变
- `DEFAULT_*` 常量以现有代码命名为准
- 若 `{brain}.md` 的 body 为空字符串（文件存在但内容空），fallback 到 config override 再 fallback 到默认值

**Files**: `src/instance.ts`

---

### T012 — Lazy Init + reloadOnRun 逻辑

**Purpose**: 在 `run()` 方法中加入 identity 加载逻辑。

**Steps**:

1. 读取 `AIMAInstance.run()` 方法（或相当于 `run()` 的入口方法）

2. 在 `run()` 开头（调用 `adapter.run()` 之前）注入：

   ```typescript
   async run(params: AIMARunParams): Promise<AIMARunResult> {
     // ── Identity lazy init / reload ─────────────────────
     if (this.identityLoader) {
       if (this.identityCache === null || this.config.reloadOnRun) {
         this.identityCache = await this.identityLoader.load()
       }
     }
     // ── 后续逻辑不变 ─────────────────────────────────────
     // ...
   }
   ```

**注意**：
- `this.identityCache === null` 只在首次调用时为 true（lazy init）
- `reloadOnRun: true` 时每次都重新加载（覆盖缓存）
- 加载失败（目录不存在）会抛出错误，中断 run() — 这是期望行为

**Files**: `src/instance.ts`

---

### T013 — Adapter 创建路径注入 allowedTools

**Purpose**: 向 `createAimaExtension` 传入对应脑区的 `allowedTools`。

**设计**：在 `PiCodingAgentAdapterConfig` 新增回调，由 `AIMAInstance` 提供实现。

**Steps**:

1. 读取 `src/adapters/pi-coding-agent/index.ts`（PiCodingAgentAdapter）

2. 在 `PiCodingAgentAdapterConfig` 新增（可选）：
   ```typescript
   export interface PiCodingAgentAdapterConfig {
     // ... 现有字段
     /**
      * 可选。根据脑区返回 allowedTools 列表。
      * 来自 identity role 文件的 allowed_tools frontmatter。
      */
     getAllowedTools?: (brain: CognitiveBrainType) => string[]
   }
   ```

3. 在 `PiCodingAgentAdapter` 内部创建 Extension 时使用：
   ```typescript
   const extensionFactory = createAimaExtension(
     brain,
     threadId,
     this.config.amygdala,
     this.config.eventBus,
     this.config.getAllowedTools?.(brain),  // 新增
   )
   ```

4. 在 `AIMAInstance` 创建 Adapter 时注入回调：
   ```typescript
   // AIMAInstance 中创建 adapter 的位置
   const adapter = new PiCodingAgentAdapter({
     // ... 现有配置
     getAllowedTools: (brain) => this.identityCache?.roles[brain]?.allowedTools ?? [],
   })
   ```

**注意**：
- `getAllowedTools` 是在 Adapter 创建时注入的闭包，会实时读取 `this.identityCache`（因为是闭包，总能拿到最新缓存）
- 这确保了 `reloadIdentity()` 后，新建的 session 会使用新的 allowedTools

**Files**: `src/adapters/pi-coding-agent/index.ts`（修改）、`src/instance.ts`（修改）

---

### T014 — `reloadIdentity(): Promise<void>`

**Purpose**: 公开方法，供运维人员在不重启进程的情况下刷新 identity 缓存。

**Implementation**:

```typescript
/**
 * 重新读取 identityDir 下所有文件，刷新内存缓存。
 * 下一次 run() 时使用新内容。
 *
 * 注意：已存在的 session 的 Extension 工具策略无法回溯更新；
 * 只有新建的 session（brain:thread 首次激活）才会使用新策略。
 *
 * 若未配置 identityDir，此方法静默返回（无操作）。
 */
async reloadIdentity(): Promise<void> {
  if (!this.identityLoader) return
  this.identityCache = await this.identityLoader.load()
}
```

**位置**：在 `AIMAInstance` 类的公开方法区，`run()` 之后

**Files**: `src/instance.ts`

---

### T015 — 集成测试

**Purpose**: 验证 spec 中定义的 4 个场景（A-D）。

**先定位现有测试文件**：`Glob 'tests/**/*.test.ts'`，找到 instance 相关测试，了解 mock 结构后再编写。

**场景 A — identityDir 配置后脑区获得角色身份**:

```typescript
test('场景A: identityDir 配置后 Block 1/2 包含文件内容', async () => {
  // Setup: 创建临时 identityDir
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aima-test-'))
  await fs.writeFile(path.join(tmpDir, 'soul.md'), '你是 Alex，一个尽职的财务助理')
  await fs.writeFile(path.join(tmpDir, 'limbic.md'), '# 情感理解\n负责情感感知和关系维护')

  // 创建 AIMAInstance（mock adapter，不真实调用 LLM）
  const instance = createTestInstance({ identityDir: tmpDir, ... })

  // 触发 run()（使用 mock adapter，截获 systemPrompt）
  const capturedPrompt = await runAndCaptureSystemPrompt(instance, 'limbic', ...)

  expect(capturedPrompt).toContain('你是 Alex')
  expect(capturedPrompt).toContain('负责情感感知和关系维护')

  await fs.rm(tmpDir, { recursive: true })
})
```

**场景 B — role.md 解锁 bash 工具**:

```typescript
test('场景B: brainstem.md allowed_tools: [bash] → bash 在 brainstem 放行', async () => {
  const tmpDir = await fs.mkdtemp(...)
  await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '---\nallowed_tools:\n  - bash\n---\n# 执行任务')

  // 创建 instance，mock extension，检查 allowedTools 传入
  const capturedAllowedTools: Record<string, string[]> = {}
  // 通过 mock createAimaExtension 或 getAllowedTools 回调验证

  const instance = createTestInstance({
    identityDir: tmpDir,
    // mock adapter
  })
  await instance.run({ brain: 'brainstem', threadId: 'test', ... })

  // 验证 brainstem 获得了 ['bash'] allowedTools
  expect(capturedAllowedTools['brainstem']).toContain('bash')
  // limbic 没有 allowed_tools
  expect(capturedAllowedTools['limbic'] ?? []).not.toContain('bash')

  await fs.rm(tmpDir, { recursive: true })
})
```

**场景 C — 文件缺失优雅降级**:

```typescript
test('场景C: cortex.md 缺失时 run() 不抛异常', async () => {
  const tmpDir = await fs.mkdtemp(...)
  // 不写 cortex.md

  const instance = createTestInstance({ identityDir: tmpDir, ... })

  // cortex 脑区激活不应抛出异常
  await expect(runCortex(instance)).resolves.not.toThrow()

  await fs.rm(tmpDir, { recursive: true })
})
```

**场景 D — reloadIdentity() 后新策略生效**:

```typescript
test('场景D: reloadIdentity() 后新策略在新 session 生效', async () => {
  const tmpDir = await fs.mkdtemp(...)
  // 初始：brainstem.md 无 allowed_tools
  await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '# 执行任务')

  const instance = createTestInstance({ identityDir: tmpDir, ... })
  await instance.run({ brain: 'brainstem', ... }) // 首次 run，加载缓存

  // 验证初始状态：brainstem 无 allowedTools
  expect(instance.getIdentityCache()?.roles.brainstem?.allowedTools ?? []).toEqual([])

  // 更新文件
  await fs.writeFile(path.join(tmpDir, 'brainstem.md'), '---\nallowed_tools:\n  - bash\n---\n# 执行任务')
  await instance.reloadIdentity()

  // 验证新状态
  expect(instance.getIdentityCache()?.roles.brainstem?.allowedTools).toContain('bash')

  await fs.rm(tmpDir, { recursive: true })
})
```

**注意**：
- `createTestInstance` 是辅助函数，用 mock adapter 代替真实 LLM（参考现有 tests/instance.ts 的 mock 模式）
- `getIdentityCache()` 可暴露为测试专用 getter（或直接访问 `identityCache` 如果 tests 与 src 同包）
- 若集成测试结构与以上示意不符，以现有测试文件的 mock 模式为准

**向后兼容测试**：
```typescript
test('不传 identityDir 时现有行为不变', async () => {
  // 创建不含 identityDir 的 instance，运行现有流程
  // 验证 bun test 现有 instance 测试套件全部通过
})
```

**Files**: `tests/instance.test.ts` 或现有 instance 测试文件（新增 describe block）、或新建 `tests/identity-integration.test.ts`

---

## Definition of Done

- [ ] `src/instance.ts` — `AIMAInstanceConfig` 新增 `identityDir?` / `reloadOnRun?`
- [ ] `src/instance.ts` — `IdentityLoader` 在 constructor 中实例化（若 identityDir 存在）
- [ ] `src/instance.ts` — `buildAssemblerConfig()` 注入 soul/skillIndex/brain roles
- [ ] `src/instance.ts` — lazy init：首次 run() 时 load identity
- [ ] `src/adapters/pi-coding-agent/index.ts` — `getAllowedTools` 回调传入 createAimaExtension
- [ ] `src/instance.ts` — `reloadIdentity(): Promise<void>` 公开方法
- [ ] 所有现有 instance + adapter 测试零失败（向后兼容）
- [ ] 新增集成测试 ≥6 个，覆盖场景 A-D
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过

---

## Risks

- **buildAssemblerConfig 调用时机**：若此方法在 `run()` 开始前调用（而非每次 run 时调用），需确保 lazy init 在它之前完成。建议 lazy init 放在 `run()` 的最开头。
- **getAllowedTools 回调闭包**：回调读取 `this.identityCache`，这是对象引用，`reloadIdentity()` 更新 `this.identityCache = newCache` 后，新调用会自动读取新 cache——**前提是每次都重新调用回调**（不要在 Adapter 构造时 snapshot）。
- **现有测试 mock 结构**：先读取 `tests/` 下现有 instance/adapter 测试，了解 mock 模式。若现有代码有 `_createSession` escape hatch（WP04 中），用相同方式 mock。
- **`getIdentityCache()` 暴露**：测试场景 D 需要验证缓存内容。若 `identityCache` 是 private，可在 `AIMAInstance` 上加一个测试用 getter（标注 `/** @internal */`），或通过测试文件同 package 访问。

---

## Implementation Command

```bash
spec-kitty implement WP04 --base WP03
```

## Activity Log

- 2026-03-11T11:58:09Z – claude-sonnet-4-6 – shell_pid=6060 – lane=doing – Started implementation via workflow command
- 2026-03-11T12:04:57Z – claude-sonnet-4-6 – shell_pid=6060 – lane=for_review – Ready for review: AIMAInstance integrated with IdentityLoader. identityDir/reloadOnRun config, lazy-load on receive(), reloadIdentity() method, getAllowedTools callback to PiCodingAgentAdapter, ThreadRunner.updateAssemblerConfig(). 15 integration tests (scenarios A-D + backwards compat). 329 total unit tests passing. typecheck clean, biome clean.
