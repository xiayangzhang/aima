# Implementation Plan: Per-Brain Model Routing & Block 4 Contextual Hints

**Branch**: `008-per-brain-model-routing-and-block4-hints` | **Date**: 2026-03-11 | **Spec**: [spec.md](spec.md)

---

## Summary

修复两个已实现但从未激活的能力缺口：
1. **Per-Brain Model Routing**：在 `buildAdapters()` 中为三个认知脑区创建独立 Adapter 实例，使用各自 model ID（默认 limbic=Haiku，cortex/brainstem=Sonnet）
2. **Block 4 Contextual Hints**：在 `ThreadRunner.activateBrain()` 中从 `thread.trigger` 和先前 slot outputs 提取 `AssembleBlock4Opts`，传入 `assembleContext()`，激活脑区专属记忆检索路径

两处修改均为最小化改动，只涉及 `src/instance.ts` 和 `src/runner/index.ts`，不新增模块。

---

## Technical Context

**Language/Version**: TypeScript（Bun runtime）
**Primary Dependencies**: 现有 AIMA 依赖，无新增
**Testing**: Bun test
**Constraints**: 不破坏任何现有测试；向后兼容（不传 `brainModels` 时使用新默认值）
**Performance**: 三个独立 Adapter 实例的内存开销可忽略不计

---

## Architecture Decisions

### AD-01：三个 Adapter 实例 vs 一个共享实例

**决策**：三个独立实例，每个脑区一个。

原因：
- `PiCodingAgentAdapterConfig.modelId` 是构造时固定的，不能运行时切换
- 独立实例确保 session map（`${brain}:${threadId}`）不跨脑区混用
- 内存开销极小（3 个 Map + 配置对象，无持久连接）

### AD-02：Block 4 Hints 提取策略

**决策**：从 `thread.trigger` + cortex slot output 中提取，不要求 Limbic 输出结构化 entityId。

原因：
- `thread.trigger` 是用户原始输入，作为 situation/taskType 的最好代理
- 要求 Limbic 输出结构化 entityId 是更大的 spec 变更，推迟到 Feature 010
- 现阶段：limbic 用 situation，cortex 用 situation，brainstem 优先用 cortex 的 `task_type`

### AD-03：hints 提取函数位置

**决策**：在 `ThreadRunner` 内部新增私有方法 `buildBlock4Opts(brain, thread, slotMap)`。

不引入新文件——ThreadRunner 已经有 `route()` 等私有方法的惯例。

---

## Source Code Changes

```
src/
├── instance.ts        ← buildAdapters() 分脑区创建，brainModels 默认值更新
└── runner/index.ts    ← activateBrain() 传入 opts；新增 buildBlock4Opts() 私有方法

tests/
├── unit/aima-instance.test.ts      ← 新增 per-brain model 路由测试
└── unit/thread-runner.test.ts      ← 新增 Block 4 opts 提取测试
```

---

## Work Package Breakdown

### WP01 — Per-Brain Model Routing

**范围**：修改 `src/instance.ts` 的 `buildAdapters()`，为三个脑区创建独立 Adapter 实例。

**子任务**：
- T001: 修改 `AIMAInstanceConfig.brainModels` 注释，文档化默认值（limbic=haiku，cortex/brainstem=sonnet）
- T002: 修改 `buildAdapters()` — 为每个脑区单独读取 model ID，创建独立 Adapter 实例
  - `pi-agent` 路径：三个 `PiAgentAdapter` 实例（各自 modelId）
  - `pi-coding-agent` 路径：三个 `PiCodingAgentAdapter` 实例（各自 modelId）
  - `claude-sdk` 路径：三个 `ClaudeAgentSDKAdapter` 实例（各自 modelId）
- T003: 新增/扩展单元测试 — 验证三个脑区使用各自 modelId；不传 brainModels 时使用正确默认值

**产出**：`src/instance.ts`（修改），≥5 新测试

---

### WP02 — Block 4 Contextual Hints

**范围**：修改 `src/runner/index.ts`，在 `activateBrain()` 中传入 `opts`；新增 `buildBlock4Opts()` 私有方法。

**子任务**：
- T004: 修改 `ThreadRunner.activateBrain()` 签名，接受 `opts?: AssembleBlock4Opts` 参数（可选，默认 undefined）
- T005: 新增 `private buildBlock4Opts(brain, thread, slotMap): AssembleBlock4Opts | undefined` — 实现 hint 提取逻辑：
  ```typescript
  // limbic: situation = thread.trigger（如有）
  // cortex: situation = thread.trigger（如有）
  // brainstem: taskType = slotMap.cortex?.output?.task_type ?? thread.trigger
  // 若所有字段均为 undefined → 返回 undefined（不传 opts）
  ```
- T006: 修改 `route()` 中对 `activateBrain()` 的调用，传入从 `buildBlock4Opts()` 构建的 opts
- T007: 修改 `trigger()` 入口方法，同样传入 opts（trigger 时 thread 和 slotMap 可从 workspace 读取）
- T008: 新增/扩展单元测试 — 验证各脑区 opts 提取正确；cortex 用 situation；brainstem 用 cortex task_type；无 trigger 时不传 opts

**产出**：`src/runner/index.ts`（修改），≥6 新测试

---

## Success Gates

| Gate | Criteria |
|------|----------|
| 类型检查 | `bun run typecheck` 零错误 |
| Lint | `biome check` 通过 |
| 现有测试 | 全部通过（零 regression） |
| 新增测试 | ≥10 个，全绿 |
| 向后兼容 | 不传 brainModels 时三脑区各自使用正确默认模型 |

---

## Complexity Tracking

改动极小：2 个文件，约 50-80 行变动（主要是分支复制）。无新模块，无新依赖。
