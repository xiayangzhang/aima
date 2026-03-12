# Cortex — Planner + Reasoner

> **版本**: v2.0
> **状态**: 草稿

---

## 角色定位

Cortex 是 AIMA 的纯内部推理引擎。它负责复杂任务的分解、规划、分析和判断——所有需要深度思考才能推进的事情都归 Cortex。

Cortex **永远不直接与人类或外部系统交互**。它没有 `reply` 字段，不能发消息给人类，也不能调用外部 API。Cortex 只产出认知结论——通过 `handoff` 字段传递给下一个脑区，由对方负责表达或执行。

**Cortex 是"昂贵"的**：每次激活都是一次 Opus 级 LLM 调用，用于需要深度推理的场景。简单问题直接由 Limbic 处理，常规操作由 Brainstem 直接执行——Cortex 只在真正需要规划或分析时才值得激活。

**Skill Review 是 Cortex 的职责**：评估 Skill 的质量、固化时机和更新必要性，是认知判断而非数据维护。Hippocampus 提供使用统计数据，DMN 心跳整合检测到固化模式后写 pending 给 Cortex，Cortex 做最终决策。

---

## 触发方式

以下情况激活 Cortex：

1. **Limbic 路由**：Limbic 判断输入超出自己的直接处理能力，需要深度分析或规划
2. **Brainstem 路由**：执行中遇到未知/复杂情况（如事件类型不在 `event-routing.md` 对照表中），标记 `needs_analysis` 后激活 Cortex
3. **DMN pending 路由**：DMN 心跳整合判断某个预测或 Skill Review 需要 Cortex 介入
4. **`brainstem → cortex` 失败恢复**：执行失败后，DMN 介入，由 Cortex 决策重新规划

---

## Input

Cortex 激活时，Thread Slot 的 input 区域包含：

- **任务描述**：来自 Limbic 或 Brainstem 的 `handoff` 内容，说明需要 Cortex 做什么
- **工作空间状态**（Block 3）：当前 Thread 历史 Slot 状态，包含前序脑区已完成的工作
- **推理角色与方法论**（Block 1）：来自 soul.md 和 role 文件，定义分析视角、判断标准和思维风格
- **分析 Skill**（Block 2）：适用的分析方法论 Skill，如结构化推理框架、领域知识模板
- **冷启动记忆**（Block 4，可选）：Thread Runner 预注入的相关记忆（semantic + episodic），作为推理起点

---

## Output Model

```typescript
{
  next:             'limbic' | 'brainstem' | null
  handoff:          string          // 必填。Cortex 推理的核心输出：计划、结论、执行指令
  complexity_hint?: 'simple' | 'complex'
}
```

**`handoff` 是必填字段**，不是可选备注。这是 Cortex 存在的全部意义——它的分析结论、规划结果、对下一脑区的指令，全部通过 `handoff` 传递。`handoff` 应该写得足够完整，让接收脑区无需猜测上下文。

**`complexity_hint`** 是给 Brainstem 的预判注解：Cortex 在规划阶段能看到任务的全貌，比 Brainstem 更早知道执行复杂度。Brainstem 的主 session（Haiku）优先使用此提示，决定是否 spawn 子执行 session；无提示时 Haiku 独立判断。

| `next` | 含义 |
|---|---|
| `'limbic'` | 分析结论需要对外表达，或需要向人类确认某个信息 |
| `'brainstem'` | 规划完成，有待执行的具体操作 |
| `null` | 分析完成，无需进一步行动（罕见）|

---

## LLM Session 模型

- **session key 格式**：`cortex:{thread_id}`
- **跨激活持久化**：同一 Thread 内，Cortex 的多次激活共享同一 LLM session。若 Cortex 在同一任务中被多次激活（如分析中途需要向 Limbic 确认信息后再继续），中间的推理状态得以延续
- **跨 Thread 隔离**：不同 Thread 的 Cortex session 完全独立
- **模型**：Opus（深度推理、多步规划、复杂分析——这是 Cortex 最核心的能力要求，不能用低配模型替代）

---

## 工具集

### Hippocampus 工具（推理中主动拉取）

| 工具 | 用途 |
|---|---|
| `memory_find_similar(situation)` | 推理到一半时，主动查"上次类似情况是怎么处理的"——这是 Cortex 最重要的记忆工具 |
| `memory_search(query)` | 通用检索兜底 |
| `memory_write(entry)` | 写入 `procedural` 记忆——固化本次推理中形成的新决策流程，供后续执行脑区直接使用 |

**`memory_find_similar` 的典型使用场景**：Cortex 在分析一个新任务时，先查"是否见过类似情况"——若有，直接参考历史决策路径；若没有，从头规划并将结论写入 `procedural` 记忆，降低下次处理类似任务的 Cortex 激活成本。

**`memory_write` 的使用原则**：只有在推理过程中形成了可复用的决策模式时才写入。一次性的特殊情况不值得固化——写入应有"这个流程会再次出现"的判断依据。

---

## 典型轨迹

### 轨迹一：分析结论传回用户

```
触发：Limbic handoff "用户请求分析合同付款条款的风险"
Cortex 深度分析合同条款，识别关键风险点
输出：{ next: 'limbic', handoff: '识别出三个主要风险：1. 付款周期过长（60天）；2. 违约金条款对我方不利；3. 汇率锁定条件不明确。建议告知用户并提供修改建议。' }
```

Limbic 接收后将分析结论转化为人类可读的回复。

### 轨迹二：规划完成需要执行

```
触发：Limbic handoff "用户要求整理过去三个月的采购报告并发送给财务部门"
Cortex 拆解任务：1. 从 Dataverse 拉取数据，2. 按模板整理，3. 生成 Excel，4. 发邮件给财务
输出：{
  next: 'brainstem',
  handoff: '执行步骤：\n1. 查询 Dataverse 采购记录（过去90天）\n2. 按月份分组汇总\n3. 导出为 Excel 格式\n4. 发邮件给财务部（收件人：finance@company.com），附件为生成的报告',
  complexity_hint: 'complex'
}
```

`complexity_hint: 'complex'` 提示 Brainstem 此任务涉及多步操作，建议 spawn 子执行 session。

### 轨迹三：分析中发现需要向用户确认

```
触发：Limbic handoff "用户要求处理一批供应商账单"
Cortex 分析中发现账单数量超过 20 个，金额总计超过审批阈值
输出：{ next: 'limbic', handoff: '发现账单总金额（¥320,000）超过单次批量处理授权上限（¥200,000）。需向用户确认：是否分批处理，或是否已获得更高级别授权？请 Limbic 向用户询问后重新路由给 Cortex 继续规划。' }
```

Limbic 向用户询问，用户回复后触发新的 Thread 或继续当前 Thread，Cortex 再次激活完成规划。

---

## 边界：不做什么

- **不直接输出 reply**：Cortex 没有 `reply` 字段，任何需要发给人类的内容必须通过 `next: 'limbic'` + `handoff` 传递
- **不执行操作**：调用 API、写文件、发送消息——这些是 Brainstem 的职责。Cortex 只规划，不执行
- **不处理系统事件的常规路由**：已知事件类型的处理由 Brainstem 按 `event-routing.md` 规则直接处理；Cortex 只处理 Brainstem 标记 `needs_analysis` 的未知/复杂事件
- **不维护记忆基础设施**：Hippocampus 的数据合并、过期清理、段精修是 Hippocampus Consolidation 的职责；Cortex 只通过工具读写记忆，不直接操作 Hippocampus 内部逻辑
- **不判断认知对错**：Cortex 的推理依据来自 soul.md 和 role 文件注入的价值观；AIMA 框架不内置"正确"的定义
