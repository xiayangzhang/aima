# 自研编排层设计

> **研究日期**：2026-03-07
> **状态**：✅ 已决定部分 / ⏳ 延后到原型后验证
> **关联文档**：`docs/02-agent-architecture.md`（第 2 节）、`docs/08-platform-integration.md`、`research/architecture/06-pi-mono-deep-dive.md`、`research/architecture/19-openclaw-ecosystem-deep-dive.md`

---

## 背景

方案 A（pi-mono TypeScript）已确定作为核心框架。pi-ai + pi-agent-core 处理 LLM 抽象和单 Agent Loop，但**多认知分区协调、记忆系统、任务生命周期**需要自研编排层。本文记录设计讨论结论。

---

## 1. 执行模型：对等分区 Swarm ✅

### 决定

**不采用主从层级**（Planner 作为 Master 派发任务），而是**对等分区网络**：

- 每个认知分区是独立的 Agent 实例，有自己的 Loop、工具集、记忆
- 分区之间地位平等，没有固定的指挥链
- 任何分区都可以委派其他分区协助工作
- 入口分区由触发事件类型决定（邮件/Teams 消息 → Communicator 先接；数据事件 → Analyst 先接）

```
触发事件
  ↓
路由层（按事件类型选择入口分区）
  ↓
入口分区的 Agent Loop
  ├── 自主处理任务
  └── 需要专业能力时 → 委派给其他分区 → 获取结果 → 继续
```

### 分区定义

| 分区内部名 | 对外身份 | 模型 | 主要职责 | 典型入口场景 |
|-----------|---------|------|---------|------------|
| `analyst` | Alex（内部） | Sonnet | 数据读取、规律分析、合规核查 | Dataverse 事件触发 |
| `executor` | Alex（内部） | Sonnet | 系统操作、状态更新、工具执行 | 内部委派 |
| `communicator` | **Alex**（对外） | Sonnet | 邮件、Teams 消息、沟通管理 | 邮件/Teams 触发 |
| `planner` | Alex（内部） | Opus | 复杂任务规划、风险判断 | 高复杂度任务，按需激活 |
| `auditor` | — | Haiku | 合规验证、操作后核查（hook） | 每次工具调用后自动 |

**"Alex" 只是对外的统一名称**。分区内部各有内部名，用于日志和调试。Communicator 负责所有对外输出，统一以 Alex 身份发出。

### 并发策略

- **默认：队列顺序执行**，紧急事件可调整优先级
- **大型独立任务**：spawn 新 session 并行处理（如一个大型项目值得独立 session）
- **无需复杂并发原语**：目前场景以串行为主，原型阶段不考虑并行执行

---

## 2. 委派协议 ⏳（延后到原型后）

### 问题识别

OpenClaw 的委派存在根本性缺陷：
- 上下文传递不精确（传太多贵，传太少 Agent 做错判断）
- 结果格式不可靠（自由文本，委派方难以机器解析）
- 无强制验证步骤（委派方盲目信任结果）
- 失败反馈模糊（不知道失败在哪一步）

### 设计方向（待验证）

半结构化合约 + 强制验证步骤：
- 委派方提供：目标（自然语言）+ 结构化输入 + 成功标准
- 被委派方返回：状态枚举（completed/partial/failed）+ 结构化输出 + 未完成项
- 委派方收到结果后必须执行 Reflection 验证，不直接信任

**结论：先用最简单的实现（同步委派 + 自由文本结果），跑原型，从真实失败模式中设计合约格式。**

---

## 3. 记忆架构 ✅

### 两层设计

```
READ LAYER（只读，Agent 从这里消费）
  partitions/{partition_name}/entity_knowledge.md
  partitions/{partition_name}/experience.md
  partitions/{partition_name}/diary.md
  shared/team_rules.md
  shared/team_consensus.md
  shared/process_patterns.md
  ↑ 由渲染管道从 WRITE LAYER 生成，Agent 不能直接修改

WRITE LAYER（结构化存储，写入目标）
  PostgreSQL memories 表
  ↑ 两个写入来源：行为系统自动写 + Agent 工具调用写
```

**为什么不直接用 Markdown 写入（区别于 OpenClaw）**：
- 写入有验证（schema 强制，Agent 写不进格式错误的记忆）
- 可机器查询（SQL 过滤、按重要性排序）
- 可清理（过期、衰减、矛盾检测）
- 可追溯（task_id、source 字段）
- 代价：额外的渲染管道，少量性能开销 — 接受

### 记忆类型分类

| 类型 | 描述 | 默认归属 | 典型过期 |
|------|------|---------|---------|
| `entity_knowledge` | 关于特定实体的事实（供应商、项目、人） | shared | 无 |
| `process_pattern` | 工作流中观察到的规律 | shared | 无 |
| `exception_playbook` | 特定异常的处理方案 | shared | 1 年 |
| `stakeholder_profile` | 沟通对象的偏好和风格 | shared | 无 |
| `team_consensus` | 分区间达成的共识和决策 | shared | 无 |
| `task_reflection` | 单次任务的反思和学习 | partition | 6 个月 |
| `rule` | 组织规则/政策 | shared | 无（只读）|

### 记忆 Schema

```typescript
interface Memory {
  id: string                    // uuid
  type: MemoryType
  partition: string | "shared"  // 归属分区或共享

  content: string               // 自然语言，LLM 直接读
  tags: string[]                // ["supplier", "acme-corp"]
  entities: string[]            // ["supplier:acme-corp", "po:1234"]

  importance: number            // 0.0 - 1.0
  confidence: number            // 0.0 - 1.0

  created_at: Date
  last_accessed: Date
  access_count: number
  expires_at: Date | null

  source: "behavioral_system" | "agent_self" | "memory_agent"
  task_id: string | null

  contradicts: string[]         // 与哪些 memory_id 有矛盾
  superseded_by: string | null  // 被哪条记忆取代
}
```

### 写入来源

**1. 行为系统自动写入（代码层，无 LLM）**

来自现有 Audit Hook，每次事件自动触发，无额外 token 消耗：
- 任务完成 → 写 `task_reflection`（摘要、结果、耗时）
- 异常发生 → 写 `exception_playbook`（类型、处理方式、结果）
- 人工升级 → 写升级原因和经理决策结果
- 首次遇到实体 → 写 `entity_knowledge`（基础信息）

**2. Agent 工具调用写入（LLM 主动）**

Agent 在 Reflexion 步骤或任务中途主动调用 `memory_write` 工具：
- Reflexion 步骤：任务结束后总结学到了什么
- 观察记录：发现规律时主动写下
- 矛盾修正：发现旧记忆有误时写入修正

### 检索与注入

**被动注入（transformContext hook）**：

```
当前任务上下文
  → 提取关键实体和任务类型
  → SQL 查询：按 entities/tags 过滤，按 importance × recency 排序
  → 取 top K（由 token budget 决定，不固定）
  → 格式化为自然语言块 → 注入 context
```

**主动检索（Agent 工具调用）**：

Agent 可以主动调用 `memory_search(query, type?, tags?)` 查询特定记忆，不依赖 transformContext 自动注入。

### Context 策略

**不压缩，不摘要替换原文**。Context 是能力上限的保障，为节省 token 而压缩是错误的权衡。通过精准的记忆筛选控制注入量，而非压缩内容本身。

### Memory Agent（周期维护）

独立运行的维护进程，使用 Batch API（50% 折扣）：

| 频率 | 任务 |
|------|------|
| 每日（夜间） | 清理过期记忆；重要性衰减（未访问 >7 天 × 0.9）；矛盾检测 |
| 每周 | 将多条 task_reflection 提炼为 process_pattern；重新渲染全部 Markdown |
| 写入触发式 | 检测新记忆与已有记忆的矛盾，更新 contradicts 字段 |

---

## 4. 任务生命周期 ⏳（延后到原型后）

### 问题识别

虚拟员工需要处理跨天等待的任务（如：等待供应商回复邮件、等待经理审批）。现有框架（pi-agent-core）是内存态，无原生持久化等待机制。

### 设计方向（待验证）

**Event-driven Wait Pattern**：Agent 通过 tool call 声明自己在等待什么事件，基础设施持久化 Agent 状态，事件到达时恢复执行。比 heartbeat 轮询更精准，无浪费。

两种可能的实现路径：
- **Loop 周期加载任务队列**：每次 loop 开始前加载当前待处理任务，处理完毕检查是否有等待中的任务需要被唤醒
- **便宜模型轮询**：Haiku 级别的 Watchdog Agent，周期检查任务状态，满足条件时唤醒主 Agent

**结论：两种方案各有优劣，原型阶段先用最简单的轮询，再从实际问题中决定最终方案。**

---

## 5. 与 pi-agent-core Hooks 的对应关系

| Hook | 编排层用途 |
|------|-----------|
| `transformContext` | 注入记忆（被动）+ 分区专属上下文 + 组织规则 |
| `convertToLlm` | 多 Provider 适配（pi-ai 处理，编排层不干预）|
| `getSteeringMessages` | 紧急事件注入（人工中断、告警）|
| `getFollowUpMessages` | 异步任务排队（Reflexion 循环触发）|

---

## 6. 原型范围（最小可验证）

在完整编排层设计之前，先跑通单 Agent 原型：

**包含：**
- 单分区 Agent（Analyst + Executor 合一，不拆 Swarm）
- pi-agent-core + pi-ai（TypeScript）
- 一个 MCP Skill（Dataverse 读写）
- 行为系统自动写入记忆（无 Memory Agent）
- PostgreSQL 审计日志（Inboard hook）
- 单通道触发（Dataverse webhook）

**延后到原型后：**
- 多认知分区拆分和委派协议
- 跨天任务等待/唤醒机制
- Memory Agent 和 Markdown 渲染管道
- 多通道（Teams / Email）

---

## 参考

- [pi-mono 深度分析](06-pi-mono-deep-dive.md) — Agent Loop 可扩展性、hooks 机制
- [OpenClaw 生态深度研究](19-openclaw-ecosystem-deep-dive.md) — 借鉴的设计模式
- [Audit 机制架构研究](20-audit-mechanisms.md) — 行为系统自动写入的审计基础
- [Token-Rich 自主 Agent](16-token-rich-autonomous-agent.md) — Reflexion 学习循环
