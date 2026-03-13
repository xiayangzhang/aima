# Tasks: Episodic Cognitive Summary (030)

**Feature**: 030-episodic-cognitive-summary
**Total subtasks**: 5
**Work packages**: 1

---

## Work Package WP01 — Fix outputSlot gap + add situation field

**Priority**: High (fixes silent data corruption in all episodic records)
**Dependencies**: none
**Estimated prompt size**: ~350 lines

### Summary

修复 `brain.complete` 事件 payload 缺少 Slot 数据的根因，同时为 `buildEpisodicContent` 加入 `situation:` 字段，让 episodic 记录从执行状态升级为认知摘要。

改动仅涉及 `src/dmn/reactive/index.ts`（逻辑）和测试文件。

### Subtasks

- [ ] T001: `handleBrainComplete` — 并发获取 slot+thread，构造 enriched event，传给三个子职责
- [ ] T002: `buildEpisodicContent` — 从 enriched payload 提取 situation，插入格式字符串
- [ ] T003: 单元测试 Scenarios A/B/C（situation 字段正确性）
- [ ] T004: 单元测试 Scenarios D/E（feedbackMemoryUsage outcome / retroactiveCorrection 跳过）
- [ ] T005: 集成测试 — 更新 `tests/integration/dmn/dmn.test.ts` 的 episodic content 断言

### Implementation Notes

1. `handleBrainComplete` 负责 enrichment，子职责无需修改逻辑
2. `buildEpisodicContent` 的 situation 提取：Cortex/Brainstem 用 `slot.input.handoff`，Limbic 回退到 `thread.trigger`
3. 单元测试 mock workspace 返回带 input 字段的 Slot 和 Thread 对象
4. 集成测试只需更新断言字符串，不需要改测试逻辑

### Prompt file

`tasks/WP01-fix-outputslot-and-situation-field.md`
