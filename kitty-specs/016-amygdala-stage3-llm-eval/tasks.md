# Tasks: Amygdala Stage 3 LLM Eval (Feature 016)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-03-12

## Subtask Index

| ID | Description | WP | Status |
|---|---|---|---|
| T001 | `AmygdalaConfig` 新增 `llm?: LlmConfig`；`_args` → `args` | WP01 | planned |
| T002 | 实现 `evaluateWithLlm()` 私有方法（LLM call + 失败回退） | WP01 | planned |
| T003 | 实现 `writeEvalMemory()` 私有方法（implicit 记忆写入） | WP01 | planned |
| T004 | 替换 Stage 3 存根，调用 `evaluateWithLlm` | WP01 | planned |
| T005 | 单元测试：V1-V7 场景 | WP01 | planned |

---

## Phase 1 — Implementation

### WP01 — Amygdala Stage 3

**File**: [tasks/WP01-amygdala-stage3.md](tasks/WP01-amygdala-stage3.md)
**Priority**: P1 | **Estimated prompt size**: ~320 lines
**Dependencies**: 无

**Goal**: 替换 Stage 3 存根，实现 LLM 评估 + 记忆写入。

**Subtasks**:
- [x] T001 — Config + args 参数更新
- [ ] T002 — `evaluateWithLlm()` 实现
- [ ] T003 — `writeEvalMemory()` 实现
- [ ] T004 — Stage 3 存根替换
- [ ] T005 — 单元测试 V1-V7

**Independent test**:
```bash
cd /Volumes/leoyun/aima && bun test tests/unit/amygdala/
```

---

## Definition of Done

- [ ] WP01 lane = done
- [ ] `bun test` 全量零回归
