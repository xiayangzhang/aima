# Feature Specification: Amygdala Stage 2 Implicit Memory

**Feature Branch**: `018-amygdala-stage2-implicit-memory`
**Created**: 2026-03-13
**Status**: Draft

## Background

Amygdala 是 AIMA 的安全门控脑区，对脑区发起的工具调用进行三阶段评估：

- **Stage 1**（静态规则）：已实现。匹配自定义规则 + 默认 BLOCK/ALLOW 表，命中即返回。
- **Stage 2**（隐性记忆匹配）：**存根**。当前代码为 `const memoryResult = null`，永远穿透到 Stage 3。
- **Stage 3**（LLM 评估）：已在 Feature 016 实现。`haiku_enabled=true` 且 `risk=high` 时调用 Haiku LLM 做决策，并将结果写入 `implicit` 记忆。

Stage 2 的设计意图是：**利用 Stage 3 写入的历史评估记录**，对已知工具做出快速决策，跳过高延迟的 LLM 调用。Feature 016 已建立了完整的数据写入链路，每次 Stage 3 评估后都会写入一条 `implicit` 记忆，tags 格式为 `['amygdala_eval', toolName, decision]`。

Feature 018 的目标是替换 Stage 2 存根：调用 `workspace.getByTags(['amygdala_eval', toolName], undefined, 5)` 拉取该工具最近 5 条评估历史，取最新一条作为决策返回，从而为高频重复工具调用提供**无 LLM 快速路径**。

Stage 2 只是 Stage 3 的快捷方式，不替代 Stage 3 的判断能力：
- 对于没有历史记录的新工具，Stage 2 自然穿透到 Stage 3。
- 对于 `haiku_enabled=false` 的部署，Stage 3 不触发，Stage 2 也不应产生阻断效果（直接穿透到默认 allow）。
- `getByTags` 任何异常都必须静默处理，绝不能让 Stage 2 错误阻断整个 gate 决策。

---

## User Scenarios & Testing

### User Story 1 — 有 block 历史的工具直接被拦截（无 LLM 调用）(Priority: P1)

当 Amygdala 对一个 `medium` 或 `high` 风险工具进行检查，且该工具在 `implicit` 记忆中存在 Stage 3 的评估历史（例如最近一次决策为 `block`），Stage 2 应直接返回 `block`，不发起 LLM 调用，reason 前缀为 `[memory]`。

**Why this priority**: 这是 Stage 2 存在的核心价值——避免对已有历史的工具反复调用 LLM，降低延迟和成本。

**Independent Test**: Mock `workspace.getByTags` 返回一条 `{ decision: 'block', reason: 'dangerous' }` 的历史记录，验证 `check()` 返回 `block`，且未调用 LLM。

**Acceptance Scenarios**:

1. **Given** 工具有历史记录，最新记录决策为 `block`，**When** 调用 `check()`，**Then** 返回 `{ decision: 'block', reason: '[memory] ...' }`，不调用 LLM。
2. **Given** 工具有历史记录，最新记录决策为 `allow`，**When** 调用 `check()`，**Then** 返回 `{ decision: 'allow', reason: '[memory] ...' }`，不调用 LLM。
3. **Given** 工具有多条历史记录，**When** 调用 `check()`，**Then** 使用 `createdAt` 最新的那条记录（不是第一条）。
4. **Given** Stage 2 匹配命中，**When** 返回决策，**Then** reason 字段以 `[memory]` 前缀开头，区别于 Stage 3 的 LLM reason。

---

### User Story 2 — 没有历史的新工具穿透到 Stage 3 (Priority: P1)

当一个工具在 `implicit` 记忆中没有评估历史（`getByTags` 返回空数组），Stage 2 不应产生任何决策，流程自然穿透到 Stage 3。

**Why this priority**: Stage 2 是加速路径，不是替代路径。新工具首次出现时必须经过 Stage 3 的完整评估，才能建立历史记录。

**Independent Test**: Mock `getByTags` 返回空数组，验证流程继续执行（到 Stage 3 或默认 allow），而非返回错误决策。

**Acceptance Scenarios**:

1. **Given** `getByTags` 返回空数组，`haiku_enabled=true`，**When** 调用 `check()`，**Then** 穿透到 Stage 3（LLM 被调用）。
2. **Given** `getByTags` 返回空数组，`haiku_enabled=false`，**When** 调用 `check()`，**Then** 穿透到默认 allow（LLM 不被调用）。

---

### User Story 3 — getByTags 失败不影响 gate 决策 (Priority: P1)

当 `getByTags` 因任何原因抛出异常（数据库连接失败、超时等），Stage 2 必须静默处理错误并穿透到 Stage 3，绝不能因 Stage 2 的查询失败而阻断工具执行。

**Why this priority**: 安全门控的可靠性比速度优化更重要。Stage 2 是可选快捷路径，其失败不应影响核心决策流程。

**Independent Test**: Mock `getByTags` 抛出 `new Error('db connection failed')`，验证 `check()` 不抛异常，且流程穿透到 Stage 3。

**Acceptance Scenarios**:

1. **Given** `getByTags` 抛出异常，**When** 调用 `check()`，**Then** 异常被静默捕获，流程继续执行，不抛出未捕获异常。
2. **Given** `getByTags` 抛出异常，`haiku_enabled=true`，**When** 流程继续，**Then** Stage 3 正常触发（LLM 被调用）。

---

### Edge Cases

- `haiku_enabled=false`（默认）→ Stage 2 可以命中记忆并返回，但若无记忆则穿透到默认 allow（Stage 3 不触发）。
- `risk=low` 工具 → 在 `check()` 的上下文中，Stage 2 代码块已在 `risk` 计算之后。`low` 工具不会到达 Stage 2（Feature 018 不改变此行为，仅替换存根内容）。
- 历史记录中 `content` 字段 JSON 解析失败 → 该条记录视为无效，跳过，继续检查下一条；若全部无效则穿透到 Stage 3。
- 历史记录中 `decision` 字段值不在 `['allow', 'block', 'escalate']` → 同上，跳过。

---

## Requirements

### Functional Requirements

- **FR-001**: Stage 2 实现必须调用 `workspace.getByTags(['amygdala_eval', toolName], undefined, 5)` 拉取最近评估历史。
- **FR-002**: 若 `getByTags` 返回非空结果，必须按 `createdAt` 降序排序，取最新一条记录作为决策来源。
- **FR-003**: 从最新记录的 `content` 字段（JSON 格式）中解析 `decision` 和 `reason`；解析后的 `decision` 必须通过合法值校验（`['allow', 'block', 'escalate']`）。
- **FR-004**: Stage 2 命中时，返回的 `reason` 必须以 `[memory] ` 为前缀，附加原始 `reason`。
- **FR-005**: `getByTags` 返回空数组，或所有记录均无法解析为合法决策时，Stage 2 穿透（不返回，继续执行后续逻辑）。
- **FR-006**: `getByTags` 抛出任何异常时，异常必须被 catch 块静默捕获，流程穿透到 Stage 3，不抛出未捕获异常。
- **FR-007**: `getByTags` 方法必须添加到 `ICognitiveWorkspace` interface（`src/types/index.ts`）和 `CognitiveWorkspace` 实现（`src/workspace/index.ts`）中，签名为 `getByTags(tags: string[], timeRange?: { after?: Date; before?: Date }, limit?: number): Promise<MemoryEntry[]>`。
- **FR-008**: 全部现有测试继续通过，不引入回归。

### Key Entities

- **Stage 2 隐性记忆记录**：Feature 016 写入的 `implicit` 类型记忆，`tags` 含 `['amygdala_eval', toolName, decision]`，`content` 为 `JSON.stringify({ tool, decision, reason })`。
- **getByTags**：`ICognitiveWorkspace` 的新方法，按 tags AND 匹配查询记忆，支持时间范围过滤和数量限制。

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: `getByTags` 返回有效历史记录时，`check()` 返回该记录的 decision，reason 以 `[memory] ` 开头 — 可通过单元测试 mock `getByTags` 验证。
- **SC-002**: `getByTags` 返回空数组时，流程穿透（Stage 3 或默认 allow 正常执行）— 可通过单元测试验证。
- **SC-003**: `getByTags` 抛出异常时，`check()` 不抛异常，流程正常继续 — 可通过单元测试注入错误验证。
- **SC-004**: Stage 2 命中时，LLM 不被调用（无需走 Stage 3）— 可通过单元测试验证 mock 调用次数为 0。
- **SC-005**: `ICognitiveWorkspace` interface 和 `CognitiveWorkspace` 实现均含 `getByTags` 方法 — 可通过 TypeScript 编译验证。
- **SC-006**: 全部现有测试继续通过，零回归 — `bun test` 全量通过。

---

## Assumptions

- `getByTags` 的底层实现复用现有 `searchMemory` 的 `arrayContains(memories.tags, tags)` 查询模式（Drizzle ORM，已有先例）。
- Stage 2 仅使用最新一条记录（最简策略）。未来可升级为多数投票或置信度加权，但不在本 feature 范围内。
- `getByTags` 的 `timeRange` 参数在 Stage 2 调用时传 `undefined`（不限时间），以获取全部历史记录。
- Stage 2 不写入任何新的记忆条目（写入仍由 Stage 3 的 `writeEvalMemory` 负责）。
