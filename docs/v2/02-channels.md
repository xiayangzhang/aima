# AIMA 通道设计

> **版本**: v2.0
> **状态**: 草稿

---

## 外部通道

AIMA 有两个对外接口，分别对应两种性质不同的输入来源。这两个接口平行存在，不存在"唯一对外通道"。

### 人类通道（→ Limbic）

以下输入进入 Limbic：

- **Teams DM**：用户直接发给 Alex 的私信
- **Teams Group Channel**：群频道中的 @ 提及或被动提到
- **人发起的 Email**：由人类撰写并发送的邮件
- 任何需要社交/关系处理的输入

**Limbic 的职责**：
- 语气判断：这条消息的情绪状态、语气轻重
- 关系上下文：发件人是谁、当前关系状态、沟通历史
- 路由决策：用 LLM 判断这条输入是否需要 Cortex 参与，还是可以直接回复，还是需要 Brainstem 执行操作
- 对外输出：所有发给人类的回复，经 Limbic 的 `reply` 字段发出

Limbic 不需要对每条输入都响应。群聊中频繁的"不回复"比低质量的即时回复更像真实的人类协作者行为。

### 系统通道（→ Brainstem）

以下输入进入 Brainstem：

- **Webhook**：外部系统推送的事件
- **定时触发（Scheduler）**：按时间周期触发的任务
- **Dataverse 事件**：微软 Dataverse 的数据变更通知
- **自动化系统事件**：Power Automate、其他系统自动触发的信号

**Brainstem 的职责**：
- 技术事件解析：识别事件类型，查 `event-routing.md` Skill 对照表
- 执行路由：已知事件类型直接按 Skill 处理；未知/复杂事件标记 `needs_analysis`，触发 Cortex 分析
- 系统操作执行：将抽象指令翻译为具体 API 调用、CRUD、文件操作并执行

Brainstem 的路由是规则驱动（非 LLM），保持确定性和低延迟。

---

## 输出路径

| 输出目标 | 路径 | 机制 |
|---|---|---|
| 向人类输出 | 经 Limbic | Slot output 的 `reply` 字段 |
| 向系统输出 | 经 Brainstem | 工具调用（API 调用、CRUD、文件操作） |

向人类的输出始终经过 Limbic，即使是 Brainstem 执行完某个任务后需要通知用户，也是通过 `next: 'limbic'` 将结果路由回 Limbic，由 Limbic 组织语言后回复——Brainstem 不直接发用户消息。

---

## Brain Event Bus（内部通道）

Brain Event Bus 是 AIMA 内部各组件之间的通信基础设施。外部审计系统可订阅，但 AIMA 本身不实现 Audit 逻辑——Audit 是外部关注点。

### 事件字段结构

每个事件必须包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `event_id` | UUID | 事件唯一标识 |
| `event_type` | string | 如 `tool.pre_use`、`brain.complete`、`memory.write` |
| `level` | Level | TRACE / DEBUG / INFO / COMPLIANCE / ALERT |
| `occurred_at` | timestamp | 事件发生时间 |
| `brain` | BrainType | 发射脑区 |
| `thread_id` | string \| null | 所属 Thread（横切信号时为 null） |
| `session_id` | string | 当前脑区 Session ID |
| `causation_id` | UUID \| null | 直接触发本事件的上一个事件 ID |
| `schema_version` | string | 事件格式版本号（框架自动注入） |
| `payload` | object | 事件内容（工具名、参数、结果等） |

### 五个事件层级

| Level | 含义 | 发射场景 |
|---|---|---|
| `TRACE` | 内部状态转换 | 工作空间 Slot 写入（开发调试） |
| `DEBUG` | 详细认知过程 | Cortex 推理步骤、Skill 加载 |
| `INFO` | 显著行为 | 工具调用、记忆写入、Skill 调用、脑区激活/完成 |
| `COMPLIANCE` | 合规相关 | 有真实外部效果的动作（发送消息、修改数据、执行操作） |
| `ALERT` | 需要关注 | Amygdala 中断、Escalation、Cortex 判断失败 |

### 内部订阅方

**Amygdala** 订阅 `tool.pre_use`（INFO 级）：
- 工具执行前同步回调，判断是否拦截
- 拦截时序依赖适配器实现——需要适配器在工具**执行前**同步触发（如 pi-coding-agent Extension API 的 `tool_call` 事件）
- 当前 pi-agent-core 适配器的触发时序在工具调用**之间**，不是执行前同步，Amygdala 对单次工具调用的实时拦截在迁移到 pi-coding-agent 之前不可完全依赖

**DMN** 订阅 INFO 及以上（作为 Action Log 来源）：
- 实时响应脑区激活、工具调用、错误事件
- 驱动错误恢复、回溯纠错、记忆使用反馈等逻辑

### 外部订阅（由集成方实现）

| 订阅方 | 订阅级别 | 用途 |
|---|---|---|
| Audit 系统 | COMPLIANCE + ALERT | 合规审计、不可变记录 |
| 可观测性系统 | INFO | 行为监控、链路追踪 |
| 其他 AIMA 实例 | ALERT | 跨实例协调 |

AIMA 只保证事件的结构化发射，不关心谁在消费。

### causation_id 因果链

`thread_id` 和 `causation_id` 两个字段独立：

- `thread_id`：一次外部输入触发的全部事件共享同一 thread_id（横切关联）
- `causation_id`：直接触发本事件的上一个事件 ID（单步因果）

链条起点（外部输入触发的第一个事件、DMN 心跳自发触发的事件）`causation_id = null`。

两者共同支撑可观测性和 replay。单步因果链由 Event Bus 提供，全链追溯需要应用层按 `thread_id` 过滤后自行重建。

---

## Brain Signals（横切信号）

信号是优先于 Thread 内正常流程的横切机制，存储在工作空间的 `signals[]` 中。

### 信号类型

| 信号 | 发出方 | 接收方 | 含义 |
|---|---|---|---|
| Amygdala 中断信号 | Amygdala | Brainstem | 立即停止当前工具操作 |
| DMN 纠错通知 | DMN | Thread Runner | 中断当前 Thread，写入纠错 Thread |
| DMN 预测通知 | DMN | Thread Runner | 插入新 Thread，优先级可配置 |

### 信号优先级

```
1. Amygdala 中断信号 → 最高优先级，立即停止当前 Brainstem 操作
2. DMN 纠错通知 → 中断当前 Thread，写入新的纠错 Thread
3. DMN 预测通知 → 插入新 Thread，优先级可配置
```

### per-thread 隔离（设计目标与已知缺陷）

**设计目标**：信号应以 `threadId` 为 key 隔离，每个 Thread 只消费属于自己的信号，并发多 Thread 时互不干扰。

**当前已知缺陷（P1-B）**：代码当前按 `type`（如 `'amygdala_interrupt'`）存储信号，无 `threadId` 分隔。并发多 Thread 时，Thread-A 的 Amygdala 信号可能被 Thread-B 的 Brainstem 消费，导致跨 Thread 干扰。

修复方案：信号存储改为 `Map<string, BrainSignal[]>`，key = `${threadId}:${signalType}`。

---

## pending_observations（延迟路由）

`pending_observations` 是工作空间的一个字段（PostgreSQL JSONB），存储 DMN 写入的"待路由"条目，由 Thread Runner 在每次轮询时判断哪些条目已成熟并执行路由。

### 结构

```typescript
{
  id:           UUID,
  target_brain: BrainType,            // 路由目标脑区
  note:         string,               // LLM 生成的自然语言描述，供 Cortex 理解上下文
  trigger_at:   timestamp | null,     // null = 立即路由；non-null = 不早于此时刻路由
  expires_at:   timestamp,            // 必填；超过此时刻 Thread Runner 自动跳过并删除
  added_at:     timestamp
}
```

### 写入方

| 写入方 | 触发时机 | 典型场景 |
|---|---|---|
| **DMN Reactive**（事件响应） | 检测到触发信号时，毫秒级 | 错误恢复指令、DEFER 超时调度、即时前瞻 |
| **DMN Consolidation**（心跳 batch） | 每 30 分钟-1 小时 | 深度前瞻预测、Skill Review 触发、跨 Thread 任务创建 |

两者可能同时写入，使用 `SELECT FOR UPDATE` 锁定 workspace 行后再追加，避免 JSONB 覆写竞态。

### 读取方

**Thread Runner `routePending()`**：每次轮询时扫描 `pending_observations`，跳过未到 `trigger_at` 的条目，删除已过 `expires_at` 的条目，对成熟条目按 `target_brain` 激活对应脑区。

### 容量上限与淘汰策略

`pending_observations` 条目数量有上限（上层配置项）。超出时按 `base_importance` 最低的条目优先淘汰。

**淘汰原则**：`time-to-trigger`（距触发时间的远近）不是价值的代理指标——长期预测（`trigger_at` 较远）往往是最有价值的，不应因时间距离远而被优先丢弃。基于重要性淘汰，而非基于时间。

### DEFER 超时的实现路径

Limbic 输出 `next: 'self'` 时（DEFER），DMN Reactive 检测到该事件后写入一条 `pending_observations`：

```typescript
{
  target_brain: 'limbic',
  note:         'DEFER 超时，执行渠道降级',
  trigger_at:   event.occurred_at + defer_timeout_ms,
  expires_at:   trigger_at + 7 * 24 * 60 * 60 * 1000
}
```

到期后由 Thread Runner `routePending()` 重新激活 Limbic，按渠道配置执行降级行为。Thread Runner 本身不内置定时器，DEFER 超时完全通过 pending 机制实现。
