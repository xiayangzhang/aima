# Tasks: DMN Reactive Quality Improvements (Feature 015)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-03-12
**Depends on**: Feature 013 (Brain Output Model Migration — must be fully merged before implementing)

## Subtask Index

| ID | Description | WP | Status |
|---|---|---|---|
| T001 | `retroactiveCorrection`: 加规则预检（三条件 OR）| WP01 | planned |
| T002 | `buildEpisodicContent`: 加 `handoff` 字段 | WP01 | planned |
| T003 | 更新单元测试（DMN retroactive correction 相关） | WP01 | planned |
| T004 | 更新单元测试（episodic content handoff 相关） | WP01 | planned |

---

## Phase 1 — Implementation

### WP01 — DMN Reactive Quality

**File**: [tasks/WP01-dmn-reactive-quality.md](tasks/WP01-dmn-reactive-quality.md)
**Priority**: P1 | **Estimated prompt size**: ~280 lines
**Dependencies**: Feature 013 merged

**Goal**: 两处私有方法改动 + 测试更新，完成 P2-A 和 P2-B。

**Subtasks**:
- [ ] T001 — `retroactiveCorrection()` 规则预检
- [ ] T002 — `buildEpisodicContent()` handoff 字段
- [ ] T003 — 测试：纠错预过滤行为（V1-V4 场景）
- [ ] T004 — 测试：episodic handoff 内容（V5-V8 场景）

**Independent test**:
```bash
cd /Volumes/leoyun/aima && bun test tests/unit/dmn/
```

---

## Definition of Done

- [ ] WP01 lane = done (reviewed and approved)
- [ ] `bun test` 全量零回归
