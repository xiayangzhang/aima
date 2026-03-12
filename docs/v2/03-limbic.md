# Limbic — Communicator + Router

> **版本**: v2.0
> **状态**: 草稿

---

## 角色定位

Limbic 是 AIMA 与人类协作者之间的唯一双向通道。所有来自人类的输入首先进入 Limbic，所有发向人类的 `reply` 由 Limbic 发出。Limbic 负责判断输入的性质——直接处理、路由给 Cortex 分析，还是路由给 Brainstem 执行——并维护对话节奏、语气和关系上下文。

**Limbic 不负责推理，不负责执行。** 它负责沟通和判断。复杂任务的分析交给 Cortex，操作类任务的执行交给 Brainstem。Limbic 是认知入口，不是全能处理器。

**关于"对外通道"的重要澄清**：Limbic 是人类方向的对外通道，但 Brainstem 是系统方向（Webhook、Scheduler、Dataverse 事件）的对外通道。二者都是合法的 Thread 入口。"只有 Limbic 能对外"是错误的理解——AIMA 对输入来源不作假设。

---

## 触发方式

以下情况激活 Limbic：

1. **人类输入到达**：Teams 消息、邮件、DM——所有来自人类协作者的输入
2. **Brainstem 执行完成，需要告知人类**：Brainstem 完成后 `next: 'limbic'`，Limbic 组织最终回复
3. **Cortex 分析完成，结果需要对外表达**：Cortex 输出 `next: 'limbic'`，Limbic 将分析结论转化为人类可读的回复
4. **DEFER 超时**：Limbic 之前输出 `next: 'self'`，Thread Runner 计时到期后重新激活 Limbic 执行渠道降级
5. **DMN pending 路由**：DMN 心跳整合判断某个预测需要通过人类通道处理

---

## Input

Limbic 激活时，Thread Slot 的 input 区域包含：

- **触发内容**：人类输入的原始消息（或来自上游脑区的 handoff 内容）
- **上游 handoff**：若由 Cortex/Brainstem 路由而来，包含上游脑区的分析结论或执行结果（`result`/`handoff` 字段内容）
- **工作空间状态**（Block 3）：当前活跃 Thread 列表、待处理事项、本 Thread 历史 Slot 状态
- **身份与沟通风格**（Block 1）：来自 soul.md 和 role 文件，定义语气、人格和关系底色
- **冷启动记忆**（Block 4，可选）：Thread Runner 根据触发内容预注入的相关记忆，无结果时省略

---

## Output Model

```typescript
{
  next?:             'cortex' | 'brainstem' | 'self' | null
  reply?:            string        // 对外输出：发向人类，人类可见
  handoff?:          string        // 内部备注：给下一脑区的上下文说明
  defer_timeout_ms?: number        // 仅 next='self' 时有效，单位毫秒
}
```

三个字段**完全独立**，可同时存在。`next` 是路由指令，`reply` 是对外通道，`handoff` 是脑间通道——互不耦合。

| `next` | `reply` | 含义 |
|---|---|---|
| `null` | 有 | 直接回复，流程结束 |
| `null` | 无 | 接收但不响应（群聊积累上下文等场景） |
| `'cortex'` | 无 | 路由给 Cortex 内部分析，人类不感知 |
| `'cortex'` | 有 | 先告知人类"我在分析"，同时触发 Cortex（少见） |
| `'brainstem'` | 有 | 立即回复人类的同时触发执行，无需特殊 `both` 逻辑 |
| `'brainstem'` | 无 | 静默执行，无需通知人类 |
| `'self'` | 有/无 | DEFER：等待更多信息，超时后 Thread Runner 重新激活并执行渠道降级 |

**`next=null` 无 reply 不是错误**，是 Limbic 合法的"沉默"输出。尤其在群聊场景中，频繁的低质量回复不如不回。

### DEFER 超时降级行为

超时降级行为按渠道配置（由 soul.md/role 文件定义），框架提供容器，不内置规则：

- 群聊 → `next: null`，无 reply（上下文已过去，沉默是正确行为）
- DM → `next: null`，reply 说明需要更多信息
- 异步频道 → `next: null`，reply 书面确认当前状态

不允许无限等待。`defer_timeout_ms` 必须在 `next='self'` 时提供。

---

## LLM Session 模型

- **session key 格式**：`limbic:{thread_id}`
- **跨激活持久化**：同一 Thread 内，Limbic 的多次激活共享同一 LLM session。对话历史得以延续——第二次激活时 Limbic "记得"之前的交流内容
- **跨 Thread 隔离**：不同 Thread 的 Limbic session 完全独立，防止上下文污染
- **模型**：Sonnet（社交判断、语气调节需要足够的语言能力，但不需要 Opus 级深度推理）

---

## 工具集

### Hippocampus 工具（推理中主动拉取）

| 工具 | 用途 |
|---|---|
| `memory_get_entity(entityId)` | 推理中发现实体名（同事、项目、系统），立即展开关系网络和历史互动记录 |
| `memory_search(query)` | 通用检索兜底，当上述专项工具不适用时使用 |

**使用时机**：Block 4 的冷启动记忆是起点，不是终点。推理过程中识别出实体（如提到某个人名、项目名）时，Limbic 应主动调 `memory_get_entity` 展开完整上下文，而不是依赖 Block 4 的预判。

---

## 典型轨迹

### 轨迹一：简单问候或直接可答的问题

```
输入：人类发来 "明天的会议几点？"
Limbic 检索记忆，直接回答
输出：{ next: null, reply: "明天下午 2 点，Teams 会议室 B" }
```

流程结束，无需其他脑区参与。

### 轨迹二：复杂分析请求，路由 Cortex

```
输入：人类发来 "帮我分析一下这份合同里的付款条款风险"
Limbic 判断：需要深度分析，自己无法直接处理
输出：{ next: 'cortex', handoff: '用户请求分析合同付款条款风险，合同内容见 Thread 附件' }
```

Cortex 分析完后路由回 Limbic，Limbic 组织人类可读的回复。

### 轨迹三：立即执行 + 同时告知用户

```
输入：人类发来 "帮我把这个文件发给 Alice"
Limbic 判断：明确的操作请求，无需规划，直接执行，且应告知用户
输出：{ next: 'brainstem', reply: '好的，我现在发给 Alice。', handoff: '发送文件 X 给 Alice，文件路径见附件' }
```

Brainstem 执行完后若有结果需要确认，可再路由回 Limbic。

### 轨迹四：群聊无需响应

```
场景：群聊中两位同事在讨论与 Limbic 无关的话题，消息中没有 @Alex
Limbic 判断：不需要介入
输出：{ next: null }（无 reply）
```

沉默是正确的行为，不强行插入对话。

### 轨迹五：等待补充信息（DEFER）

```
输入：人类发来 "帮我起草一封给客户的邮件"（信息不完整，不知道客户是谁、主题是什么）
Limbic 判断：需要更多信息才能推进
输出：{ next: 'self', reply: '好的，请告诉我客户是谁，以及邮件的主要内容是什么？', defer_timeout_ms: 300000 }
```

Thread 进入 `waiting` 状态，等待人类回复。5 分钟超时后，Thread Runner 重新激活 Limbic 执行渠道降级逻辑。

---

## 边界：不做什么

- **不执行操作**：调用 API、写文件、发送邮件——这些是 Brainstem 的职责
- **不做复杂推理**：多步骤分析、任务规划、研究——这些是 Cortex 的职责
- **不直接处理系统事件**：Webhook、Scheduler 触发的事件首先进入 Brainstem，不经过 Limbic
- **不持有跨 Thread 的全局视野**：Limbic 只能看到当前 Thread 的上下文；跨 Thread 的模式感知是 DMN 的职责
- **不判断认知对错**：Limbic 的语气调节和路由判断来自 soul.md 定义的价值观，AIMA 框架本身不内置立场
