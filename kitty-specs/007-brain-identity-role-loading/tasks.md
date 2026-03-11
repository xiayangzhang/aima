# Tasks: Brain Identity & Role Loading (Feature 007)

**Feature**: 007-brain-identity-role-loading
**Date**: 2026-03-11
**Total WPs**: 4
**Total Subtasks**: 15

---

## Dependency Chain

```
WP01 (IdentityLoader Core)
  └── WP02 (Context Assembly Injection)  [P] ← can parallel with WP03
  └── WP03 (Extension Tool Override)     [P] ← can parallel with WP02
        └── WP04 (AIMAInstance Integration)
```

WP02 和 WP03 可并行实现（操作不同文件）；WP04 依赖 WP01/02/03 全部完成。

---

## Work Packages

---

### WP01 — IdentityLoader Core Module

**Goal**: 新建 `src/identity/` 模块，实现 YAML frontmatter 解析和 identityDir 文件加载缓存。

**Priority**: High — foundation, blocks all other WPs

**Dependencies**: None

**Estimated prompt size**: ~350 lines

**Subtasks**:
- [x] T001: 新建 `src/identity/frontmatter.ts` — 正则解析 YAML frontmatter，提取 `allowed_tools` 数组
- [x] T002: 新建 `src/identity/loader.ts` — `IdentityLoader` 类，读取 soul.md / skill-index.md / {brain}.md
- [x] T003: 新建 `src/identity/index.ts` — 导出公共接口（IdentityLoader, IdentityCache, RoleEntry 类型）
- [x] T004: 单元测试 `tests/identity/frontmatter.test.ts`（≥8 cases）
- [x] T005: 单元测试 `tests/identity/loader.test.ts`（≥8 cases）

**Prompt file**: [tasks/WP01-identity-loader-core-module.md](tasks/WP01-identity-loader-core-module.md)

---

### WP02 — Context Assembly Block 1/2 Injection

**Goal**: 扩展 `ContextAssemblerConfig` 加入 `soul` 字段，更新 `assembleBlock12` 支持 soul 前置 + brain role 文件注入。

**Priority**: High

**Dependencies**: Depends on WP01

**Estimated prompt size**: ~280 lines

**Subtasks**:
- [x] T006: 修改 `src/context/index.ts` — ContextAssemblerConfig 新增 `soul?: string`；assembleBlock12 前置 soul
- [x] T007: 更新/扩展 context 测试 — soul 注入、frontmatter 剥离、无 soul 时向后兼容、skillIndex 注入

**Prompt file**: [tasks/WP02-context-assembly-injection.md](tasks/WP02-context-assembly-injection.md)

---

### WP03 — Extension Factory Tool Permission Override

**Goal**: `createAimaExtension` 新增 `allowedTools` 参数，实现每脑区 DEFAULT_BLOCKED_TOOLS 覆盖。

**Priority**: High

**Dependencies**: Depends on WP01

**Estimated prompt size**: ~260 lines

**Subtasks**:
- [x] T008: 修改 `src/adapters/pi-coding-agent/extension.ts` — 新增 `allowedTools?: string[]` 参数；Stage 1 检查引入覆盖逻辑
- [x] T009: 扩展 extension 测试 — bash 按脑区覆盖解锁/保持拦截、其他工具不受影响

**Prompt file**: [tasks/WP03-extension-tool-permission-override.md](tasks/WP03-extension-tool-permission-override.md)

---

### WP04 — AIMAInstance Integration + reloadIdentity()

**Goal**: 在 `AIMAInstance` 中集成 `IdentityLoader`，实现 lazy init、buildAssemblerConfig 注入、reloadIdentity() 方法、reloadOnRun 支持。

**Priority**: High

**Dependencies**: Depends on WP01, WP02, WP03

**Estimated prompt size**: ~420 lines

**Subtasks**:
- [x] T010: 修改 `AIMAInstanceConfig` — 新增 `identityDir?: string` 和 `reloadOnRun?: boolean`
- [x] T011: 修改 `buildAssemblerConfig()` — 注入 identityCache 的 soul/skillIndex/brain roles
- [x] T012: lazy init 逻辑 — 首次 run() 前加载；reloadOnRun: true 每次重载
- [x] T013: adapter 创建路径 — 向 createAimaExtension 传入 per-brain allowedTools
- [x] T014: 新增 `reloadIdentity(): Promise<void>` — 重载缓存；未配置时静默返回
- [x] T015: 集成测试 — 场景 A-D（identityDir 注入、工具解锁、文件缺失降级、reload 刷新）

**Prompt file**: [tasks/WP04-aimainstance-integration.md](tasks/WP04-aimainstance-integration.md)

---

## Parallelization Summary

| 阶段 | WPs | 可并行 |
|------|-----|--------|
| Phase 1 | WP01 | 单独运行 |
| Phase 2 | WP02, WP03 | ✅ 可并行 |
| Phase 3 | WP04 | 等 WP01+02+03 完成后 |

MVP 范围：WP01（最小可用基础）
完整功能：全部 4 个 WP
