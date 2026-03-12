# Amygdala — GuardRail

> **版本**: v2.0
> **状态**: 草稿

---

## 一、角色定位

Amygdala 是 AIMA 的**工具调用守卫**，唯一职责是在工具执行前做同步拦截判断。

**边界清晰**：

| 属于 Amygdala | 不属于 Amygdala |
|---|---|
| 工具调用层面的风险 | 决策/推理层面的错误 |
| 执行前（pre-execution）拦截 | 执行后的行为质量回顾（归 DMN） |
| 同步阻断 | 异步反思 |

AIMA 是器官，不是灵魂。Amygdala 提供物理拦截机制，拦截的具体规则由 soul.md 和 role 文件注入——框架只提供三段式判断骨架，不预设"什么是危险的"。

### 事件订阅

Amygdala 订阅 Event Bus 上的 `tool.pre_use` 事件（`INFO` 级）。

> ⚠️ **P0 已知限制（适配器依赖）**：Amygdala 的"执行前拦截"设计要求适配器在工具执行前同步回调（`pi-coding-agent` Extension API 的 `tool_call` 事件可返回 `{ block: true }`）。当前使用 `pi-agent-core` 适配器的情况下，`getSteeringMessages` 在工具调用**之间**触发，不是执行前同步——Amygdala 对单次工具调用的实时拦截不可依赖。
>
> **过渡期缓解**：高风险工具（`bash`、`file_write`、外部 API 工具）默认 BLOCK，等迁移到 `pi-coding-agent` 后再开放配置。本质：`pi-agent-core` 下 Amygdala 退化为"启动前静态白名单"，而非运行时动态判断。

---

## 二、工具风险分级

工具注册时声明 `risk_level`，决定 Amygdala 的介入程度：

| 风险等级 | 典型工具 | Amygdala 行为 |
|---|---|---|
| `low` | 读操作、记忆检索、状态查询 | 仅静态规则检查（注册时预计算，零运行时成本） |
| `medium` | 写操作、发送通知、文件修改 | 静态规则 + implicit 记忆匹配 |
| `high` | 删除操作、金额操作、权限变更、外部 API 调用 | 完整三段式评估（含 Haiku 评估） |

大多数工具是 `low` 级，Amygdala 的 LLM 成本只在 `high` 级别工具上发生。

---

## 三、三段式决策骨架

```
tool.pre_use 事件到达
  │
  ├─ Stage 1：静态规则匹配（零 LLM 成本）
  │    自定义规则集 + 默认 BLOCK/ALLOW 表
  │    命中 BLOCK 规则 → 立即拦截，写 Signal
  │    命中 ALLOW 规则 → 放行
  │    无命中 → 按 risk_level 决定后续步骤
  │
  ├─ Stage 2：implicit 记忆匹配（medium/high 风险工具）
  │    ⚠️ 待实现：当前为存根（const memoryResult = null）
  │    设计目标：从历史风险事件中学习的模式匹配
  │    依赖：pgvector 语义搜索（ILIKE 对 implicit 检索效果极差）
  │    命中高置信度风险模式 → 拦截
  │    命中低置信度 → 参考，进入 Stage 3
  │    无命中 → 按 risk_level 决定是否进入 Stage 3
  │
  └─ Stage 3：Haiku 一次性评估（high 风险工具）
       ⚠️ 待实现：当前 haiku_enabled = false
       设计目标：high 风险工具的默认行为（不是 fallback，是标准路径）
       输入：工具调用参数 + Stage 2 implicit 检索摘要
       输出：ALLOW / BLOCK / ESCALATE
```

**Stage 1 是基础**：确定性规则，命中即返回，不进入下一阶段。适用于所有 risk_level。

**Stage 2 是学习层**：从历史中积累的风险模式，语义匹配。Stage 2 存根期间，medium/high 工具的拦截质量全部依赖 Stage 1。

**Stage 3 是推理层**：针对 high 风险工具的 LLM 评估。Stage 3 不是兜底选项——它是 high 风险工具的**标准路径**，当 Stage 1/2 均未确定结论时必然触发。Stage 3 存根期间，high 风险工具依赖 Stage 1 静态规则（过渡期缓解措施：high 风险工具默认 BLOCK）。

---

## 四、决策结果

| 结果 | 含义 | 动作 |
|---|---|---|
| `allow` | 放行 | 工具正常执行 |
| `block` | 拒绝 | 向工作空间写中断 Signal，工具不执行 |
| `escalate` | 不自动拦截，需人工决策 | 写 `pending_observations` 给 DMN，等待人工或更高权限脑区决定 |

`ESCALATE` 是 Amygdala 在无把握时的保守选项——**不确定时走保守路径**，这是 AIMA 的整体设计原则。

---

## 五、信号机制

Amygdala 拦截时向认知工作空间的 `signals` 区域写入中断 Signal：

```typescript
{
  type: 'amygdala_interrupt'
  threadId: string          // 设计目标：per-thread 隔离
  toolName: string
  reason: string
  stage: 1 | 2 | 3
  significance_boost?: number
}
```

> ⚠️ **P1-B 已知 Bug（信号模型污染）**：当前代码按 `type`（`'amygdala_interrupt'`）存储信号，无 `threadId` 分隔。并发多 Thread 时，Thread-A 的 Amygdala 信号可能被 Thread-B 的 Brainstem 消费。
>
> **设计目标**：信号按 `${threadId}:${signalType}` 做 per-thread 隔离。修复方向：`Map<string, BrainSignal[]>`，key 包含 `threadId`。

### significance_boost

Amygdala 触发规则时，向 Event Bus 事件携带 `significance_boost: float`：

| 触发场景 | 效果 |
|---|---|
| 无匹配 | 不携带 |
| Stage 2 动态规则命中 | 较低正值 |
| Stage 1 静态规则命中 | 中等正值 |
| 硬底线触发 | 较高正值 |

DMN 事件响应读到该字段后，写 episodic 时对应增加 `base_importance`——风险相关经历编码更深，更容易在 Consolidation 回放时浮现，形成更高质量的 implicit 记忆。

---

## 六、implicit 记忆的反馈路径

静态规则命中的 BLOCK 是权威判断，不需要反馈校正。LLM 评估（Stage 3）产生的结果存在误判可能，需要反向反馈：

| 场景 | 反馈动作 |
|---|---|
| `ESCALATE` → 人工放行 | DMN 对触发该 ESCALATE 的 implicit 记忆调用 `markUsed(ids, 'negative')` |
| `ESCALATE` → 人工拒绝 | 强化信号，`markUsed(ids, 'positive')` |
| `BLOCK`（LLM 评估）→ 相同操作随后由更高权限成功执行 | DMN 心跳整合检测此模式，写 negative 反馈 |

Hippocampus Consolidation 在批量收敛时对 implicit 记忆同样适用——持续获得 negative 的模式，`base_importance` 下降，检索命中率降低，避免误判积累。

---

## 七、与 DMN 的分工

Amygdala 和 DMN 共同构成 AIMA 的行为保障机制，互补而非重叠：

| 维度 | Amygdala | DMN |
|---|---|---|
| **时序** | 执行前（pre-execution） | 执行后（事件响应）/ 定期前瞻（心跳整合） |
| **关注点** | 这个行为**该不该做** | 这个行为**做没做成** / 接下来应该做什么 |
| **性质** | 同步阻断 | 异步回顾 |
| **覆盖范围** | 工具调用风险 | 决策错误、行为偏差、长期模式 |
| **功能语义** | "这个不能做" | "刚才做错了" / "预计接下来会发生 X" |

Amygdala 不可能 100% 覆盖所有风险，DMN 事后反思是兜底机制。两者共同收敛行为质量，都是物理层机制，不包含认知判断。

---

## 八、与其他脑区的交互

Amygdala 不持有 LLM session，不走 BrainAdapter，不在 Thread/Slot 体系内。它通过以下路径与系统交互：

- **输入**：订阅 Event Bus `tool.pre_use` 事件
- **输出（拦截）**：向工作空间 `signals` 写中断 Signal
- **输出（上报）**：向工作空间 `pending_observations` 写 ESCALATE 条目，`target_brain` 由上层配置
- **输出（学习）**：向 Hippocampus Encoding 写 implicit 记忆（provisional 条目，由 DMN 心跳整合聚类归并为 canonical）
- **读取**：通过 Hippocampus Recall 的 `getByTags()` 检索 implicit 记忆
