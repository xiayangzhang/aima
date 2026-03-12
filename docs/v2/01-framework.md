# AIMA 框架设计

> **版本**: v2.0
> **状态**: 草稿

---

## 设计哲学

### 三层能力模型

AIMA 内部的所有内容按性质严格分成三层，彼此不越界：

| 层 | 内容 | 实现方式 |
|---|---|---|
| **基础设施层** | 执行、I/O、工具注册、事件总线 | 代码 |
| **配置层** | 超时阈值、重试次数、模型选择、log level | 环境变量 |
| **认知层** | 业务规则、行为模式、判断依据、知识 | Skill（Markdown） |

判断标准只有一条：这是一个**动作**（执行）还是一个**判断**（推理）？动作留在代码，判断留在 Skill。

### AIMA 是器官，不是灵魂

AIMA 是认知个体的物理基础，不是认知判断者。

AIMA 负责：生命周期机制（Thread/Slot/崩溃恢复）、记忆基底（写入/检索/巩固基础设施）、通信基础设施（Event Bus、工具注册、脑区间路由）、安全层（Amygdala 拦截、审计链）——这是"肉体"。

**什么值得记忆、应该学习什么、"正确"意味着什么**，由外部注入的身份（`soul.md`）、角色（role 文件）和技能（Skill 文件）定义——这是"心智"。

推论：
- 脑区的 output model 是纯信号传递，不包含立场、情绪或价值判断
- Hippocampus 巩固观察到的模式，不判断对错——"正确"是上下文定义的
- Amygdala 和 DMN 是物理层机制，不是认知判断者

这个原则是所有 API 设计的判断标准：**物理机制进代码，认知判断进 Skill。**

### Loop 是基础设施，不是业务逻辑

每个脑区的 Agent Loop 只做三件事：组装系统提示词、执行工具调用、终止并返回结构化结果。所有业务逻辑、行为规则、判断依据均通过 Skill 和记忆注入——Loop 本身不携带任何业务含义。

---

## Thread / Slot 模型

### Thread 是认知上下文的边界单元

一个 Thread 对应一件正在处理的事（一段对话、一个任务、一次事件响应）。

各脑区的 LLM session 以 Thread 为粒度：
- 同一 Thread 内的多次脑区激活共享同一 session（对话历史得以延续）
- 不同 Thread 之间不共享 session（上下文完全隔离）
- 跨 Thread 的知识通过记忆系统（Block 4）流通，不走 session 历史

**Thread 的创建是应用层决策**：AIMA 提供 Thread 数据结构和调度机制，但"什么触发新 Thread、什么消息归并进已有 Thread"由上层配置规则决定。AIMA 不预设这些规则。

### Thread 状态机

```
active → waiting → active   （DEFER 超时后恢复）
active → complete            （正常结束）
active → interrupted         （崩溃或不可重试错误）
```

| 状态 | 含义 |
|---|---|
| `active` | 当前有脑区持有写权限，正在处理 |
| `waiting` | Limbic 输出 DEFER，等待超时或外部触发重新激活 |
| `complete` | 所有 Slot 处理完成，Thread 关闭 |
| `interrupted` | 崩溃恢复或不可重试错误，需人工介入 |

### Slot 结构

每个 Thread 包含三个核心 Slot，分别对应三个认知脑区：

```typescript
// Limbic Slot
{
  input:  string,
  output: {
    next:              'cortex' | 'brainstem' | 'self' | null,
    reply?:            string,        // 对外输出，发给用户/外部系统
    handoff?:          string,        // 给下一脑区的内部上下文
    defer_timeout_ms?: number         // 仅 next='self' 时有效
  },
  status: 'pending' | 'running' | 'done' | 'error'
}

// Cortex Slot
{
  input:  string,
  output: {
    next:             'limbic' | 'brainstem' | null,
    handoff:          string,         // 规划摘要或任务描述
    complexity_hint?: 'simple' | 'complex'  // 可选，供 Brainstem 判断是否 spawn
  },
  status: 'pending' | 'running' | 'done' | 'error'
}

// Brainstem Slot
{
  input:                string,
  output: {
    next:    'limbic' | 'cortex' | null,
    result?: string
  },
  status:               'pending' | 'running' | 'done' | 'error',
  execution_session_id: string | null  // 子执行 session ID
}
```

**output 字段说明**：`next`、`reply`、`handoff` 三个字段相互独立，可同时存在。`next` 是路由指令，`reply` 是对外通道，`handoff` 是脑间通道——三者解耦，互不限制。

> ⚠️ **P1-C 已知缺口（output model 迁移待完成）**：当前代码使用 `mode: 'RESPOND' | 'ROUTE' | 'EXECUTE' | 'DEFER'` 枚举作为输出模型，尚未迁移到三字段解耦结构。枚举模型的核心缺陷是无法同时表达"回复用户 + 路由给下一脑区"——`reply + next` 并发场景在当前实现中不可能。迁移需要同步修改所有脑区的 output schema、Thread Runner 的路由逻辑和 BrainAdapter 接口，是一次协调性变更。

典型组合举例：

| next | reply | 含义 |
|---|---|---|
| `null` | 有 | 直接回复，流程结束 |
| `null` | 无 | 接收但不响应（群聊积累上下文） |
| `'cortex'` | 无 | 路由给 Cortex 分析，用户不感知 |
| `'brainstem'` | 有 | 立即回复用户，同时触发执行 |
| `'brainstem'` | 无 | 静默执行，无需告知用户 |
| `'self'` | 有 | DEFER：告知用户已收到，等待超时后降级 |

---

## Thread Runner

### 角色：轨道语法校验器，不是决策者

脑区之间不直接互相调用。通信通过 Slot output 的 `next` 字段加 Thread Runner 完成：

1. 当前脑区处理完成，在 Slot output 中写入 `next`，Loop 终止
2. Thread Runner 读取 `next`，校验该转换是否合法，合法则激活目标脑区

Thread Runner 只验证"这个转换合不合法"，不理解转换的原因。路由决策在脑区的认知输出里，不在 Thread Runner 的代码里。

### 轨道语法表

所有未列出的转换均非法：

| 来源 | 合法 next 值 | 说明 |
|---|---|---|
| 外部输入 / DMN pending | `limbic` \| `brainstem` | 触发入口 |
| `limbic` | `cortex` \| `brainstem` \| `self` \| `null` | `self` = DEFER，`null` = 流程结束 |
| `cortex` | `limbic` \| `brainstem` \| `null` | |
| `brainstem` | `limbic` \| `cortex` \| `null` | `null` = 执行完成无需通知 |
| `dmn` | `limbic` \| `cortex` \| `brainstem` | DMN 内部驱动 |

### 典型轨迹举例

轨迹是动态的，由每个脑区的 `next` 选择自然形成：

```
1. 外部输入 → 完整执行链：
   limbic → cortex → brainstem → limbic → null

2. 系统事件 → 感知后输出：
   brainstem → cortex → limbic → null

3. 肌肉记忆（绕过 Cortex）：
   limbic → brainstem → limbic → null

4. DMN 内部驱动：
   dmn → cortex → brainstem → null

5. 简单对话（直接回复）：
   limbic → null
```

### 不走 Thread Runner 的组件

**DMN** 和 **Amygdala** 不持有 LLM session，不持有持续 session，不经过 Thread Runner 的 `activateBrain()` 路径：
- DMN Reactive（事件响应器）：代码驱动，偶发一次性 LLM 调用
- DMN Consolidation（心跳 batch）：定期唤醒，Haiku 辅助分析
- Hippocampus Consolidation（每日 batch）：每日低负载时段运行
- Amygdala：事件拦截，规则优先 + Haiku 降级

以上组件直接读写 PostgreSQL 状态，不经过 BrainAdapter。

---

## Context Assembly

每次激活脑区前，Thread Runner 组装四块 Context：

### 四块结构

| Block | 内容 | Limbic | Cortex | Brainstem |
|---|---|---|---|---|
| **Block 1** | 身份 | 人格 + 关系 + 沟通风格 | 推理角色 + 当前任务 | 系统权限 + API 清单 |
| **Block 2** | Skill | Skill Index + 固化/适配 Skill | 分析方法论 | 操作 Skill + 执行参数模板 |
| **Block 3** | 状态 | 工作空间状态 + 待处理 Thread | 当前分析任务 + 中间结论 | 待执行队列 + 系统状态 |
| **Block 4** | 记忆 | semantic + episodic（冷启动引导） | semantic + episodic（冷启动引导） | procedural（冷启动引导） |

### 缓存效率

Block 1（身份）和 Block 2（Skill Index）内容稳定，构成 LLM prompt cache 的固定前缀。同一 Session 内这两块几乎零成本（cache hit）。每轮的真实开销只在 Block 3/4。

这是持久化历史不允许重写的原因之一：重写会使 Block 1/2 之后的 cache 前缀失效，导致全量重新计费。

### Block 3 的时间感知

脑区的时间感知（当前时间、时区、星期几）通过 Block 3 注入：

```
## Current Context
- local_time: 2026-03-10T14:23:45+11:00
- timezone: Australia/Sydney
```

Block 1/2 内禁止出现任何时间戳或日期——哪怕是 `last_updated` 这类字段也会导致 cache 永远 miss。

### Block 4 是冷启动引导，不是完整记忆注入

使用 Thread trigger 作为检索 query，给脑区一个起点，不追求完整。无结果时直接省略，脑区基于 Block 1/2/3 运行。

脑区在推理过程中若需要更多上下文，通过 Hippocampus 工具主动查询——这是记忆访问的主要路径。

---

## Skill 体系

### Skill 是什么

Skill 是 Markdown 文件，承载"认知层"的所有内容：业务规则、行为模式、判断依据、操作步骤、事件路由表。Skill 是代码与业务逻辑的边界——动作留在代码，判断留在 Skill。

### Skill 三层分类

| 类型 | 来源 | 可修改 | 说明 |
|---|---|---|---|
| `reference` | 外部提供 | 否 | 只读参考，外部方维护；如 `event-routing.md` |
| `adapted` | 基于 reference 改编 | 是 | 保留原始引用，融入实例自身上下文；header 必须声明 `derived_from` |
| `first-party` | 从实践中生成 | 是 | 纯实例经验，无外部来源 |

**Skill 最小 header 规范**：

```markdown
---
type: reference | adapted | first-party
scope: <适用场景一句话>
derived_from: <reference_skill_id>   # adapted 类型必填
version: <语义版本号>
---
```

### Skill 是实体

每个 Skill 文件对应一个稳定的 `entity_id`（如 `skill:procurement-approval`）。Skill 实体（认知层，在记忆系统中）与 Skill 文件（操作层，在文件系统中）分离：文件是运行时读取的可执行知识，实体记录是 AIMA 对这个 Skill 的认知积累——使用历史、版本关系、适用场景模式。

### Skill 生命周期

```
外部 reference ──→ Cortex 学习 ──→ adapted Skill
新任务经验 ──→ Cortex 推理 ──→ first-party Skill
                              ↓ 重复使用、稳定
              DMN 心跳整合检测到固化模式
              → pending_observations 给 Cortex
              → Cortex Skill Review：评估、固化或废弃
                              ↓ 环境变化、失效
              DMN 检测漂移 → Cortex 重新学习
```

Skill Review 由 Cortex 执行——评估 Skill 质量是认知判断，不是数据维护。Hippocampus 只维护 Skill 的索引元数据，提供使用统计供 Cortex 判断。

---

## Brain Event Bus（概述）

Brain Event Bus 是 AIMA 内部的通信基础设施，详见 `02-channels.md`。

### 五级事件层级

| Level | 含义 | 典型发射场景 |
|---|---|---|
| `TRACE` | 内部状态转换 | 工作空间 Slot 写入（开发调试） |
| `DEBUG` | 详细认知过程 | Cortex 推理步骤、Skill 加载 |
| `INFO` | 显著行为 | 工具调用、记忆写入、脑区激活/完成 |
| `COMPLIANCE` | 合规相关 | 有真实外部效果的动作（发送消息、修改数据） |
| `ALERT` | 需要关注 | Amygdala 中断、Escalation、脑区判断失败 |

### causation_id 因果链

每个事件携带：
- `thread_id`：本次外部输入触发的全部事件共享同一 thread_id
- `causation_id`：直接触发本事件的上一个事件 ID（链条起点为 null）

两者独立，共同支撑可观测性和 replay。全链追溯需要应用层自行重建。
