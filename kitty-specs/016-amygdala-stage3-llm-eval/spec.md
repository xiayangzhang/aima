# Feature Specification: Amygdala Stage 3 LLM Eval

**Feature Branch**: `016-amygdala-stage3-llm-eval`
**Created**: 2026-03-12
**Status**: Draft

## Background

Amygdala 是 AIMA 的安全门控脑区，对脑区发起的工具调用进行三阶段评估。目前 Stage 1（静态规则）已完整实现，Stage 2（隐性记忆匹配）和 Stage 3（LLM 评估）均为存根。

Stage 3 的当前存根行为：当工具风险级别为 `high` 且启用了 LLM 评估时，直接返回"需要人工审核"——没有实际的 LLM 判断。这意味着高风险工具要么被静态规则处理，要么永远触发人工审核，Amygdala 无法对新型高风险工具做出智能判断。

实现 Stage 3 后，Amygdala 能够对未被静态规则覆盖的高风险工具调用进行上下文感知的安全评估，并将评估结果写入记忆系统，为系统随时间积累工具安全知识奠定基础。

---

## User Scenarios & Testing

### User Story 1 — 高风险工具获得 LLM 安全评估 (Priority: P1)

当一个高风险工具调用通过了静态规则检查（无匹配规则），Amygdala 启用 LLM 评估时，系统应对该工具调用发起轻量 LLM 评估，根据工具名称、调用参数和风险级别做出 allow/block/escalate 决策，而不是直接返回固定的"需要人工审核"。

**Why this priority**: Stage 3 是 Amygdala 智能判断能力的核心。没有它，所有未被静态规则覆盖的高风险工具都只能触发人工审核，无法自动放行合理的高风险操作，也无法自动阻止明显危险的操作。

**Independent Test**: 给一个高风险工具调用，启用 LLM 评估，mock LLM 返回 `{decision: 'allow', reason: 'context is safe'}`，验证 `check()` 返回 `allow`。

**Acceptance Scenarios**:

1. **Given** 一个高风险工具调用，静态规则无匹配，LLM 评估已启用，**When** 调用 `check()`，**Then** 向 LLM 发起评估调用，返回 LLM 的决策结果（allow/block/escalate）。
2. **Given** LLM 返回 `allow` 决策，**When** `check()` 返回，**Then** 决策为 `allow`，不触发 block/escalate 流程。
3. **Given** LLM 返回 `block` 决策，**When** `check()` 返回，**Then** 决策为 `block`（调用方负责后续阻断处理）。
4. **Given** LLM 调用失败（网络错误、超时），**When** `check()` 处理异常，**Then** 回退到 `escalate`，不抛出未捕获异常。
5. **Given** LLM 返回无法解析的响应，**When** `check()` 处理，**Then** 回退到 `escalate`（保守策略）。

---

### User Story 2 — 评估结果写入记忆系统 (Priority: P1)

每次 LLM 评估完成后，评估结果（工具名、参数摘要、决策、原因）应写入隐性记忆（implicit memory），使系统能够积累工具安全判断的历史数据，为未来 Stage 2 的隐性记忆匹配提供数据基础。

**Why this priority**: 没有记忆写入，每次工具调用都是全新评估，无法从历史中学习。写入隐性记忆是 Stage 2 能够运作的前提条件，成本低但价值长远。

**Independent Test**: 触发一次 Stage 3 评估，验证 `writeMemory` 被调用，写入类型为 `implicit`，内容包含工具名和决策。

**Acceptance Scenarios**:

1. **Given** Stage 3 LLM 评估完成（无论 allow/block/escalate），**When** 评估结果产生，**Then** 向记忆系统写入一条 `implicit` 类型记忆，包含工具名和决策结果。
2. **Given** LLM 评估失败回退到 escalate，**When** 回退发生，**Then** 也写入 `implicit` 记忆（记录"评估失败，保守处理"），不因失败而跳过写入。
3. **Given** 写入记忆本身失败，**When** 异常发生，**Then** 不影响 `check()` 的主流程返回，记忆写入失败不阻断安全决策。

---

### Edge Cases

- `haiku_enabled = false`（默认值）→ Stage 3 不触发，行为与修改前完全一致（直接 allow）。
- 中等风险工具（`risk = 'medium'`）→ Stage 3 不触发（仅高风险工具进入 LLM 评估）。
- LLM 返回的 decision 值不在合法范围内（非 allow/block/escalate）→ 回退到 `escalate`。

---

## Requirements

### Functional Requirements

- **FR-001**: 当 `risk === 'high'` 且 `haiku_enabled === true` 时，Stage 3 必须向 LLM 发起评估调用（不再直接返回固定结果）。
- **FR-002**: LLM 调用的输入必须包含：工具名称、调用参数摘要、风险级别。
- **FR-003**: LLM 的输出格式为 `{decision: 'allow' | 'block' | 'escalate', reason: string}`；`check()` 返回该决策。
- **FR-004**: LLM 调用失败或响应无法解析时，`check()` 必须回退到 `escalate`，不抛出未捕获异常。
- **FR-005**: 每次 Stage 3 评估完成后（含失败回退），必须向记忆系统写入一条 `implicit` 类型记忆，包含工具名、决策结果和原因摘要。
- **FR-006**: 记忆写入失败不影响 `check()` 的主流程，写入错误被静默捕获（不影响决策返回）。
- **FR-007**: `haiku_enabled = false` 时，行为与修改前完全一致——Stage 3 代码路径不执行。
- **FR-008**: 全部现有测试继续通过，不引入回归。

### Key Entities

- **AmygdalaDecision**：`'allow' | 'block' | 'escalate'`，Stage 3 评估的输出决策。
- **Implicit Memory（工具评估记录）**：Stage 3 写入的隐性记忆条目，记录每次 LLM 安全评估的结果，供未来 Stage 2 学习。

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: 高风险工具调用触发 LLM 评估时，`check()` 返回值等于 LLM 响应的 decision — 可通过单元测试 mock LLM 验证。
- **SC-002**: LLM 调用失败时，`check()` 返回 `escalate`，不抛异常 — 可通过单元测试注入错误验证。
- **SC-003**: 每次 Stage 3 触发后，`writeMemory` 被调用且类型为 `implicit` — 可通过单元测试验证。
- **SC-004**: `haiku_enabled = false` 时，LLM 不被调用 — 可通过单元测试验证。
- **SC-005**: 全部现有测试继续通过，零回归。

---

## Assumptions

- LLM 评估使用项目内已有的 `callLlm` 工具函数（默认 Haiku 模型），不引入新的 LLM 客户端。
- `AmygdalaConfig` 需要新增 `llm?: LlmConfig` 字段以支持传入 LLM 配置（API key、model 等）；未配置时使用环境变量默认值。
- 写入记忆时，`implicit` 条目的 tags 包含工具名（便于 Stage 2 按 tag 检索），baseImportance 根据决策严重性设置（block/escalate 高于 allow）。
- Stage 2（隐性记忆语义检索）不在本 feature 范围内，本 feature 只负责数据写入。
- `args` 参数摘要化（JSON stringify 截断）后传给 LLM，不传完整参数防止过长 prompt。
