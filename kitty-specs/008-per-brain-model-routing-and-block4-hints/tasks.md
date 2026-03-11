# Tasks: Per-Brain Model Routing & Block 4 Contextual Hints

**Feature**: 008-per-brain-model-routing-and-block4-hints
**Status**: In Progress
**Total WPs**: 2
**Total Subtasks**: 8

---

## Phase 1 — Core Fixes

### WP01: Per-Brain Adapter Instances
**Priority**: P0 | **Status**: planned | **File**: [WP01-per-brain-adapter-instances.md](tasks/WP01-per-brain-adapter-instances.md)

修改 `src/instance.ts` 的 `buildAdapters()`，为三个认知脑区创建独立 Adapter 实例，使用各自 model ID。

**Subtasks**:
- [x] T001: 更新 `AIMAInstanceConfig.brainModels` 注释（文档化 limbic=haiku, cortex/brainstem=sonnet 默认值）
- [x] T002: 修改 `buildAdapters()`——pi-agent/pi-coding-agent/claude-sdk 三条路径各自读取 per-brain modelId，创建三个独立 Adapter 实例
- [x] T003: 新增单元测试——验证三脑区使用各自 modelId；不传 brainModels 时使用正确默认值（≥5 测试）

**Dependencies**: none
**Estimated prompt size**: ~280 lines

---

### WP02: Block 4 Contextual Hints
**Priority**: P0 | **Status**: planned | **File**: [WP02-block4-contextual-hints.md](tasks/WP02-block4-contextual-hints.md)

修改 `src/runner/index.ts`，在 `activateBrain()` 中传入 `AssembleBlock4Opts`；新增 `buildBlock4Opts()` 私有方法提取 hint 来源。

**Subtasks**:
- [x] T004: 修改 `activateBrain()` 签名，接受可选 `opts?: AssembleBlock4Opts` 参数
- [x] T005: 新增 `private buildBlock4Opts(brain, thread, slotMap)` 方法——limbic/cortex 用 `thread.trigger`，brainstem 优先用 cortex slot 的 `task_type`
- [x] T006: 修改 `route()` 中对 `activateBrain()` 的调用，传入 opts
- [x] T007: 修改 `trigger()` 入口方法，同样传入 opts
- [x] T008: 新增单元测试——验证各脑区 opts 提取正确；brainstem 优先 cortex task_type；无 trigger 时不传 opts（≥6 测试）

**Dependencies**: none (WP01 和 WP02 可并行)
**Estimated prompt size**: ~380 lines
