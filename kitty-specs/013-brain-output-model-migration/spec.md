# Feature Specification: Brain Output Model Migration

**Feature Branch**: `013-brain-output-model-migration`
**Created**: 2026-03-12
**Status**: Draft

## Background

AIMA 五脑架构中，每个脑区完成处理后需要表达两件事：**接下来把控制权交给谁**，以及**这次处理产生了什么输出**。当前实现将这两件事合并在单一枚举里表达，导致一个根本性的表达力缺陷：枚举是互斥的，而路由和输出实际上是独立维度，可以同时发生。

**当前的核心限制**：
- Limbic 无法在同一次处理中既回复用户、又触发 Brainstem 执行——`mode=EXECUTE` 意味着静默执行，`mode=RESPOND` 意味着只回复不执行
- Brainstem 完成任务后，只有在 Cortex 事先声明 `intent=both` 的情况下才能通知用户——Brainstem 自己无法决定"我做完了，现在告诉用户"
- Cortex 的 `intent=both` 触发硬编码的三步路由（Limbic→Brainstem→Limbic），是特殊逻辑而非通用机制

**迁移目标**：三个完全独立的字段，可以任意组合：
- `next`：路由指令——控制权交给哪个脑区（可为空，表示流程结束）
- `reply`：对外输出——发给人类的内容（可为空，表示本次处理不产生对外回复）
- `handoff`：脑间上下文——给下一脑区的内部备注（可为空）

---

## User Scenarios & Testing

### User Story 1 — Limbic 同时回复用户并触发执行 (Priority: P1)

用户发来"帮我发邮件给 Alice"。Limbic 判断：应该立即告知用户"好的，我来处理"，同时触发 Brainstem 执行发送操作。在当前系统中，这两件事无法同时发生——要么静默执行，要么告知后等用户再次触发。迁移后，Limbic 可以在同一次响应中同时完成这两件事。

**Why this priority**: 这是最常见的人机协作模式——告知用户正在处理、同时开始处理。当前实现强制用户经历"静默等待"或"分两步走"，体验割裂。

**Independent Test**: 构造一个 Limbic 同时设置 `reply` 和 `next=brainstem` 的输出，验证系统同时发出回复消息并激活 Brainstem，两者互不阻塞。

**Acceptance Scenarios**:

1. **Given** Limbic 输出包含 `reply`（对用户的消息）和 `next: 'brainstem'`，**When** Thread Runner 处理该输出，**Then** 用户收到回复，且 Brainstem 被激活——两者都发生，没有一个被跳过。
2. **Given** Limbic 输出只有 `reply`，无 `next`，**When** Thread Runner 处理，**Then** 用户收到回复，Thread 正常结束，不触发任何脑区。
3. **Given** Limbic 输出只有 `next: 'cortex'`，无 `reply`，**When** Thread Runner 处理，**Then** Cortex 被激活，用户不收到任何消息（静默路由）。

---

### User Story 2 — Brainstem 完成后自主决定是否通知用户 (Priority: P1)

Brainstem 执行完一个任务（如文件处理、API 调用），它自己知道是否需要告知用户结果。在当前系统中，Brainstem 无法自主路由回 Limbic——这个决定必须由更早的 Cortex 通过 `intent=both` 预先声明，Brainstem 自己没有自主权。迁移后，Brainstem 可以在输出中设置 `next: 'limbic'` 来主动触发用户通知。

**Why this priority**: 执行结果是否需要告知用户，是执行时才知道的信息（成功/失败/部分完成），不是规划时能预测的。当前让 Cortex 预先做这个决定会导致错误的通知策略。

**Independent Test**: 构造一个 Brainstem 输出 `next: 'limbic'` 和 `handoff: '任务完成，结果为 X'` 的场景，验证 Thread Runner 激活 Limbic，Limbic 收到 handoff 内容并据此组织回复。

**Acceptance Scenarios**:

1. **Given** Brainstem 输出 `next: 'limbic'` 和执行结果摘要，**When** Thread Runner 处理，**Then** Limbic 被激活，并接收到 Brainstem 的执行结果作为输入上下文。
2. **Given** Brainstem 输出 `next: null`（无需通知），**When** Thread Runner 处理，**Then** Thread 直接结束，Limbic 不被激活，用户不收到消息。
3. **Given** Brainstem 输出 `next: 'cortex'`（需要进一步分析），**When** Thread Runner 处理，**Then** Cortex 被激活继续处理。

---

### User Story 3 — 所有合法路由转换均可正常工作 (Priority: P1)

迁移后的路由语法表（track grammar）定义了所有合法的脑区间转换。系统必须支持表中所有合法转换，并拒绝非法转换，行为与 v2 文档描述一致。

**Why this priority**: 这是基础正确性保证——路由系统是整个框架的骨架，任何遗漏或错误都会导致认知链路断裂。

**Independent Test**: 对每个合法转换（limbic→cortex、limbic→brainstem、cortex→limbic、cortex→brainstem、brainstem→limbic、brainstem→cortex）分别构造测试，验证激活正确的脑区。

**Acceptance Scenarios**:

1. **Given** 任意脑区输出中 `next` 值是合法目标脑区，**When** Thread Runner 处理，**Then** 目标脑区被正确激活。
2. **Given** 脑区输出 `next: null`，**When** Thread Runner 处理，**Then** Thread 进入完成状态，不再激活任何脑区。
3. **Given** 所有现有测试用例（407项），**When** 迁移完成后运行，**Then** 全部通过，零回归。

---

### User Story 4 — Pending Observation 路由到正确的目标脑区 (Priority: P2)

DMN 写入的 pending observations 可能指向 Cortex 或 Brainstem（而不仅仅是 Limbic）。当前 `routePending` 总是创建新 Thread 再激活目标脑区，但对于 Cortex/Brainstem 发起的 pending，应该在适当的上下文中执行，而不是孤立地在新 Thread 里执行。

**Why this priority**: P2——比路由模型本身次要，但影响 DMN 预测性激活的正确性。

**Independent Test**: 构造一个 `target_brain=cortex` 的 pending observation，验证 routePending 创建新 Thread 并正确激活 Cortex（而非 Limbic）。

**Acceptance Scenarios**:

1. **Given** 一条 `target_brain: 'cortex'` 的 pending observation 到期，**When** `routePending` 运行，**Then** 创建新 Thread 并激活 Cortex，不激活 Limbic。
2. **Given** 一条 `target_brain: 'brainstem'` 的 pending observation 到期，**When** `routePending` 运行，**Then** 创建新 Thread 并激活 Brainstem。
3. **Given** 一条 DEFER 恢复的 pending（含 `threadId`），**When** `routePending` 运行，**Then** 原 Thread 被重新激活（复用 Feature 012 的修复）。

---

### Edge Cases

- Limbic 同时设置 `reply` 和 `next: 'self'`（DEFER）——应该先发送 reply，然后进入等待状态。
- `handoff` 有值但 `next` 为空——handoff 被忽略（没有接收方），不报错。
- Cortex 输出 `next: 'cortex'`（路由给自己）——属于非法转换，Thread Runner 应终止 Thread 并标记为 interrupted。
- 所有脑区输出均为空对象 `{}`——等同于 `next: null`，Thread 正常结束。
- 旧格式（含 `mode` 或 `intent` 字段）的输出——迁移完成后不再支持，应被识别为格式错误。

---

## Requirements

### Functional Requirements

- **FR-001**: 所有脑区的输出必须使用统一的三字段结构：`next`（可选，路由目标）、`reply`（可选，对外消息）、`handoff`（可选，脑间上下文）。
- **FR-002**: `next` 和 `reply` 字段必须完全独立——任意组合均合法，互不约束。
- **FR-003**: Thread Runner 必须能正确处理 `reply` 和 `next` 同时存在的输出：先处理 `reply`（发送给用户），再按 `next` 路由。
- **FR-004**: Thread Runner 必须按照合法路由转换表处理所有 `next` 值；非法转换导致 Thread 进入 `interrupted` 状态。
- **FR-005**: Brainstem 必须能在输出中设置 `next: 'limbic'`，触发 Limbic 激活组织回复；此能力不依赖 Cortex 的事先声明。
- **FR-006**: Cortex 的 `intent=both` 特殊三步路由逻辑必须被废除，由通用 `next` 字段机制替代。
- **FR-007**: `handoff` 字段的内容必须作为输入上下文传递给 `next` 指定的下一个脑区。
- **FR-008**: `routePending` 必须按 `target_brain` 激活对应脑区，支持 limbic / cortex / brainstem 三种目标。
- **FR-009**: 迁移后现有所有测试（407项）必须继续通过，不引入回归。
- **FR-010**: 旧的 `mode` / `intent` 枚举类型定义从代码库中删除。

### Key Entities

- **BrainOutput**：脑区处理结果的统一结构，三个可选字段：`next: BrainType | null`、`reply: string | undefined`、`handoff: string | undefined`。
- **Thread Runner**：读取 `BrainOutput.next` 决定路由，读取 `reply` 触发对外发送，读取 `handoff` 组装给下一脑区的输入。
- **合法路由转换表**：定义哪些 `next` 值对哪个脑区合法（基于 v2 docs/01-framework.md §Thread Runner）。

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: 迁移后，Limbic 同时设置 `reply` 和 `next` 的场景，两者均被正确处理——可通过测试 100% 验证。
- **SC-002**: Brainstem 自主路由回 Limbic 的场景正常工作——可通过端到端测试验证。
- **SC-003**: 现有 407 项测试全部通过，零回归——测试套件是定量验证基准。
- **SC-004**: `mode` 和 `intent` 枚举从代码库中完全消失——可通过 `grep` 验证零残留。
- **SC-005**: Cortex `intent=both` 的三步路由硬编码逻辑从 Thread Runner 中消失——可通过代码审查验证。

---

## Assumptions

- 迁移范围仅覆盖 AIMA 框架层（`src/`），不涉及上层应用（secondfirst/employee）的 soul.md / role 文件。
- LLM 的结构化输出工具（每个脑区的 output schema）需要同步更新，以便脑区能输出新格式——这是迁移的核心工作量之一。
- DEFER 的处理方式保持不变（`next: 'self'`），Feature 012 的 DEFER 修复继续有效。
- `reply` 字段的实际发送机制（通过哪个通道发给用户）由上层应用负责，AIMA 框架只保证 `reply` 内容被正确传递。
- 本 Feature 不修改记忆系统、Amygdala、DMN 的内部逻辑，仅修改脑区输出结构和 Thread Runner 路由逻辑。
- 前置依赖：Feature 012 已合并（已满足）。
