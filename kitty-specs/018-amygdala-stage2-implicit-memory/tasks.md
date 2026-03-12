# Tasks: Amygdala Stage 2 Implicit Memory (Feature 018)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-03-13

## Subtask Index

| ID | Description | WP | Status |
|---|---|---|---|
| T001 | 实现 Stage 2 `getByTags` 检索逻辑（替换 `check()` 中的存根） | WP01 | planned |
| T002 | `ICognitiveWorkspace` 新增 `getByTags` 方法签名；`CognitiveWorkspace` 新增实现 | WP01 | planned |
| T003 | 单元测试：V1-V6 场景 | WP01 | planned |

---

## Phase 1 — Implementation

### WP01 — Amygdala Stage 2 Implicit Memory

**File**: [tasks/WP01-amygdala-stage2-implicit-memory.md](tasks/WP01-amygdala-stage2-implicit-memory.md)
**Priority**: P1 | **Estimated prompt size**: ~280 lines
**Dependencies**: 无（Feature 016 已合并到 main，`writeEvalMemory` 写入链路已就绪）

**Goal**: 替换 Stage 2 存根，实现隐性记忆快速路径；新增 `getByTags` workspace 方法。

**Subtasks**:
- [ ] T001 — Stage 2 `getByTags` 检索实现
- [ ] T002 — `getByTags` interface + 实现
- [ ] T003 — 单元测试 V1-V6

**Independent test**:
```bash
cd /Volumes/leoyun/aima && bun test tests/unit/amygdala/
```

---

## Definition of Done

- [ ] WP01 lane = done
- [ ] `bun test` 全量零回归
