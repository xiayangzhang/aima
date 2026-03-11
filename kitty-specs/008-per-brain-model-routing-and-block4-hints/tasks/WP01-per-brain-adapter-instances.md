---
work_package_id: WP01
title: Per-Brain Adapter Instances
lane: "done"
dependencies: []
subtasks:
- T001
- T002
- T003
phase: Phase 1 - Core Fixes
assignee: ''
agent: "claude-sonnet-4-6"
shell_pid: "22634"
review_status: "approved"
reviewed_by: "XIAYANG ZHANG"
history:
- timestamp: '2026-03-11T00:00:00Z'
  lane: planned
  agent: system
  shell_pid: ''
  action: Prompt generated via /spec-kitty.tasks
---

# Work Package Prompt: WP01 – Per-Brain Adapter Instances

## Review Feedback

*[Empty initially — populated by reviewers if work is returned.]*

---

## Objectives & Success Criteria

修改 `src/instance.ts` 的 `buildAdapters()` 方法，为三个认知脑区（limbic/cortex/brainstem）创建**独立**的 Adapter 实例，各自使用配置的 model ID。

**Success Criteria**:
- `buildAdapters()` 为每个脑区创建独立 Adapter 实例（不再共享同一个）
- 默认 model 正确：limbic=`claude-haiku-4-5-20251001`，cortex=`claude-sonnet-4-6`，brainstem=`claude-sonnet-4-6`
- `brainModels` 配置字段（cortex/brainstem）被实际读取使用
- 三条 adapter 路径（pi-agent/pi-coding-agent/claude-sdk）均修改
- 现有测试零 regression；新增 ≥5 测试全绿
- `bun run typecheck` 零错误，`biome check` 通过

---

## Context

**Repository**: `/Volumes/leoyun/aima/`
**Implementation command**: `spec-kitty implement WP01` (no dependencies)

**当前问题**（`src/instance.ts:191-200`）：

```typescript
// pi-agent 路径（其他路径相同）
const limbicModel = config.brainModels?.limbic ?? 'claude-sonnet-4-6'
const adapter = new PiAgentAdapter({
  ...shared,
  modelId: limbicModel,
  getApiKey: apiKeyFn,
})
adapters.set('limbic', adapter)
adapters.set('cortex', adapter)    // 同一个 adapter！cortex 配置未使用
adapters.set('brainstem', adapter) // 同一个 adapter！brainstem 配置未使用
```

`config.brainModels?.cortex` 和 `config.brainModels?.brainstem` 字段有声明，但永远不被读取。

**文件结构**：
```
src/
└── instance.ts    ← 唯一需要修改的文件
tests/
└── unit/
    └── aima-instance.test.ts    ← 新增/扩展测试
```

---

## Subtask Guidance

### T001: 更新 `brainModels` JSDoc 注释

**文件**: `src/instance.ts`（第 38-42 行附近）

**目标**：文档化 `brainModels` 各字段的默认值，使 API 消费者清楚知道不传时用什么模型。

**修改**：
```typescript
/** Per-brain model overrides.
 * - limbic: defaults to 'claude-haiku-4-5-20251001' (fast routing & communication)
 * - cortex: defaults to 'claude-sonnet-4-6' (reasoning & planning)
 * - brainstem: defaults to 'claude-sonnet-4-6' (execution & tool use)
 */
brainModels?: {
  limbic?: string
  cortex?: string
  brainstem?: string
}
```

**验证**：注释更新，无逻辑变更。

---

### T002: 修改 `buildAdapters()` 三条路径

**文件**: `src/instance.ts`（第 174-231 行）

**目标**：每个脑区读取自己的 modelId，创建独立 Adapter 实例。

**Default models（hardcoded fallback）**：
```typescript
const BRAIN_MODEL_DEFAULTS = {
  limbic: 'claude-haiku-4-5-20251001',
  cortex: 'claude-sonnet-4-6',
  brainstem: 'claude-sonnet-4-6',
} as const
```

> ⚠️ 注意：可以在 `buildAdapters` 内部定义 defaults，也可以作为模块级常量，两者均可。保持代码简洁优先。

**pi-agent 路径修改**（其他路径类似）：

```typescript
if (config.adapter === 'pi-agent') {
  const limbicModel = config.brainModels?.limbic ?? 'claude-haiku-4-5-20251001'
  const cortexModel = config.brainModels?.cortex ?? 'claude-sonnet-4-6'
  const brainstemModel = config.brainModels?.brainstem ?? 'claude-sonnet-4-6'

  adapters.set('limbic', new PiAgentAdapter({
    ...shared,
    modelId: limbicModel,
    getApiKey: apiKeyFn,
  }))
  adapters.set('cortex', new PiAgentAdapter({
    ...shared,
    modelId: cortexModel,
    getApiKey: apiKeyFn,
  }))
  adapters.set('brainstem', new PiAgentAdapter({
    ...shared,
    modelId: brainstemModel,
    getApiKey: apiKeyFn,
  }))
  return adapters
}
```

**pi-coding-agent 路径**：结构相同，替换 `PiAgentAdapter` → `PiCodingAgentAdapter`，注意 `PiCodingAgentAdapter` 构造参数是否与 `PiAgentAdapter` 相同（检查 `src/adapters/pi-coding-agent/index.ts` 确认参数名）。

**claude-sdk 路径**：结构相同，替换 `PiAgentAdapter` → `ClaudeAgentSDKAdapter`，注意 `ClaudeAgentSDKAdapter` 用 `model` 而非 `modelId`（检查 `src/adapters/claude-sdk/index.ts`）。

**检查 Adapter 构造函数**（实现前先读源码）：
- `src/adapters/pi-agent/index.ts` — 确认 `{ modelId, getApiKey, workspace, eventBus, amygdala }` 参数
- `src/adapters/pi-coding-agent/index.ts` — 确认参数（可能有 `getAllowedTools` 等额外字段）
- `src/adapters/claude-sdk/index.ts` — 确认参数（可能用 `model` 不是 `modelId`）

**验证**：三条路径均修改完毕，`adapters.get('cortex')` 和 `adapters.get('limbic')` 返回不同实例（`!==`）。

---

### T003: 新增单元测试

**文件**: `tests/unit/aima-instance.test.ts`（新建或扩展）

**测试目标**：验证 `buildAdapters()` 的行为。由于 `buildAdapters` 是私有方法，通过检查 `threadRunner` 的 adapters 或 mock constructor 来验证。

**推荐策略**：Mock Adapter 构造函数，验证每个脑区调用时传入的 modelId 是否正确。

**需要的测试（≥5 个）**：

**测试 1**: 不传 `brainModels` — limbic 使用 haiku 默认值
```typescript
// mock PiAgentAdapter constructor 记录调用参数
// createAIMAInstance({ adapter: 'pi-agent', databaseUrl: mockDb })
// 验证 limbic 对应的 adapter 构造时 modelId === 'claude-haiku-4-5-20251001'
```

**测试 2**: 不传 `brainModels` — cortex 使用 sonnet 默认值
```typescript
// 同上，验证 cortex adapter 的 modelId === 'claude-sonnet-4-6'
```

**测试 3**: 不传 `brainModels` — brainstem 使用 sonnet 默认值
```typescript
// 同上，验证 brainstem adapter 的 modelId === 'claude-sonnet-4-6'
```

**测试 4**: 传入 `brainModels: { limbic: 'claude-opus-4-6' }` — limbic 使用覆盖值
```typescript
// 验证 limbic adapter 的 modelId === 'claude-opus-4-6'
// 验证 cortex/brainstem 仍使用默认值
```

**测试 5**: 三脑区使用不同 model 时，每个脑区是独立 Adapter 实例
```typescript
// 验证 adapters.get('limbic') !== adapters.get('cortex')
// 验证 adapters.get('cortex') !== adapters.get('brainstem')
```

**Mock 策略**：参考现有 `tests/unit/` 中的 mock 方式（读 WP03/WP04 测试文件了解已有 helper）。可以 spy 构造函数或使用 Bun mock。数据库可以 mock（不需要真实连接）。

---

## Definition of Done

- [ ] T001: `brainModels` JSDoc 更新，含三个默认值说明
- [ ] T002: 三条 adapter 路径（pi-agent/pi-coding-agent/claude-sdk）各自读取 per-brain modelId，创建独立实例
- [ ] T003: ≥5 新测试全绿
- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] 现有测试零 regression（`bun test` 全绿）
- [ ] 不传 `brainModels` 时：limbic=haiku，cortex=brainstem=sonnet

---

## Risks & Notes

- **Adapter 参数差异**：三种 adapter 的构造参数可能不完全一致（`modelId` vs `model`，有无 `getAllowedTools`）。实现前先读各 adapter 的源码。
- **Session isolation 不变**：三个独立 adapter 实例不影响现有 `${brain}:${threadId}` session key 机制——session 管理在 ThreadRunner，不在 adapter 本身。
- **内存开销**：三个 adapter 实例的内存开销可忽略（各含一个 Map + 配置对象，无持久连接）。

---

## Reviewer Guidance

**Review focus**:
1. 三条路径（pi-agent/pi-coding-agent/claude-sdk）是否全部修改
2. 默认 model 是否正确（limbic=haiku，cortex=brainstem=sonnet）
3. 旧代码中 `cortex/brainstem` 配置未使用的 bug 是否已修复
4. 测试是否真正验证了各脑区使用了各自 modelId（不是只验证 adapter 类型）
5. 不传 brainModels 时行为是否向后兼容

## Activity Log

- 2026-03-11T13:00:12Z – claude-sonnet-4-6 – shell_pid=2212 – lane=doing – Started implementation via workflow command
- 2026-03-11T13:04:31Z – claude-sonnet-4-6 – shell_pid=2212 – lane=for_review – Ready for review: per-brain adapter instances implemented. limbic=haiku, cortex=brainstem=sonnet defaults. All 3 adapter paths fixed (pi-agent/pi-coding-agent/claude-sdk). 12 new tests covering defaults, overrides and instance independence. 319 unit tests pass, typecheck clean.
- 2026-03-11T13:10:55Z – claude-sonnet-4-6 – shell_pid=22634 – lane=doing – Started review via workflow command
- 2026-03-11T13:13:34Z – claude-sonnet-4-6 – shell_pid=22634 – lane=done – Review passed: all 3 adapter paths fixed, correct defaults (limbic=haiku, cortex/brainstem=sonnet), independent instances per brain. 12 tests pass.
