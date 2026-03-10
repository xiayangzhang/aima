# AIMA SDK — 公共 API 规范

> **定位**：本文档只记录 AIMA 在 `pi-agent-core` 之上额外提供的接口。
> pi 本身的 API（`Agent.prompt()` / `subscribe()` / `AgentTool` 等）不在此重复。
>
> **原则**：暴露机制，不暴露策略。策略由上层应用决定。

---

## 一、AIMA 在 pi 之上提供什么

| 能力 | pi-agent-core | AIMA 额外提供 |
|------|--------------|--------------|
| Agent 循环 + 工具执行 | ✅ | — |
| 多通道输入路由 | ❌ | ✅ Thread + source_channel |
| 认知持久化 | ❌（内存） | ✅ PostgreSQL Thread/Slot |
| 崩溃恢复 | ❌ | ✅ Thread 重启 |
| 五脑路由（Limbic→Cortex→Brainstem） | ❌ | ✅ |
| 身份配置（SOUL/IDENTITY/ROLE） | ❌ | ✅ identityDir |
| 记忆系统 | ❌ | ✅ semantic/episodic/procedural |
| 合规事件总线 | ❌ | ✅ COMPLIANCE/ALERT/INFO/DEBUG/TRACE |
| 安全底线（Amygdala） | ❌ | ✅ 内置，不对外暴露 |

---

## 二、核心入口：createAIMAInstance

```typescript
const aima = await createAIMAInstance(config?: AIMAInstanceConfig)

interface AIMAInstanceConfig {
  apiKey?: string           // 默认读 ANTHROPIC_API_KEY 环境变量
  identityDir?: string      // 身份文件目录，默认 './identity'
                            // 内含 soul.md / identity.md / role.md
                            // 只读，运行时不可修改（防止身份篡改）
}
```

一个 `AIMAInstance` 对应一个虚拟员工（如 "Alex"）。多租户场景下每个员工一个实例。

### 身份文件约定（identityDir）

```
identity/
├── soul.md       — 核心价值观和行为底线（最高优先级，不可被覆盖）
├── identity.md   — 员工身份描述（姓名、角色、沟通风格）
└── role.md       — 当前部署角色（如"采购协调员"、"风险审核专员"）
```

三个文件在 `createAIMAInstance()` 时一次性读入，注入 Limbic Block 1/2（cache-friendly）。
Agent 运行时无法读取或修改这些文件路径。

---

## 三、消息接收

### 3.1 新对话：receive()

```typescript
const thread = await aima.receive({
  content: string              // 输入内容（来自 Teams 消息、邮件、调度器事件等）
  source_channel: string       // 来源通道，如 'teams', 'email', 'webhook', 'scheduler'
  source_account_id?: string   // 通道内 Bot/账户 ID（多账户场景）
                               // 例：同时运行两个 Teams Bot → 区分来自哪个 Bot
  source_external_id?: string  // 通道侧的原生对话 ID（用于 continue() 时关联）
  initiated_by?: string        // 发起人标识（如用户 AAD ObjectId）
  priority?: number            // 优先级 1-10，默认 5
}): Promise<Thread>
```

`receive()` **阻塞直到 thread 离开 `active` 状态**，返回条件：

| thread.state | 触发场景 | 上层行为 |
|---|---|---|
| `complete` | Limbic 输出 `RESPOND` / `NO_REPLY` 且流程结束；或 `EXECUTE` 且 Brainstem 已跑完；或 `ROUTE` 且 Cortex（及可能的 Brainstem）完成后 Limbic 发出最终回复 | 读取 `slots.limbic.output.mode` 决定是否向通道发送消息 |
| `interrupted` | 任意脑区出错 | 读取 `error_reason`，记录日志，必要时通知人工 |
| `waiting` | Limbic 输出 `DEFER` | 向用户发送 `output.content`（Agent 的追问），保留 thread_id，下条消息用 `continue()` 续接 |

> **EXECUTE 说明**：Limbic 输出 `EXECUTE` 后 Brainstem 继续运行，`receive()` 仍然等待，直到 Brainstem 完成、Thread 进入 `complete` 才返回。不存在"Limbic 输出 EXECUTE 时 receive() 中途返回 active"的情况。

> **注意**：DEFER 时 `receive()` 会返回（`thread.state = waiting`），而不是永久阻塞。
> 不返回的话，调用方被挂起，Agent 等待输入却没有输入来源，会死锁。
> DEFER 超时降级行为（群聊 → NO_REPLY，DM → RESPOND 说明）由 ThreadRunner 按通道配置执行。

适合 CLI / 调度任务场景。Teams 等需要即时 ACK 的通道，上层应先回复 typing indicator，再等待结果。

### 3.2 多轮对话：continue()

```typescript
const thread = await aima.continue(
  thread_id: string,
  content: string
): Promise<Thread>
```

续接已有 Thread，Limbic 从现有 session history 继续，无需重新加载记忆。
**上层应用负责**维护 `外部对话ID → thread_id` 的映射。

**前置条件：**

| Thread 当前状态 | continue() 行为 |
|---|---|
| `complete` | ✅ 正常续接，追加新输入 |
| `waiting` | ✅ 正常续接，提供 Agent 等待的输入 |
| `active` | ❌ 抛出错误（Thread 正在运行，不能并发输入） |
| `interrupted` | ❌ 抛出错误（Thread 已失败，需要人工介入，不能续接） |

**示例（Teams 多轮对话）：**

```typescript
async function onTeamsMessage(conversationId: string, text: string) {
  const threadId = await db.getThreadId(conversationId)
  const thread = threadId
    ? await alex.continue(threadId, text)
    : await alex.receive({
        content: text,
        source_channel: 'teams',
        source_external_id: conversationId,
      })
  await db.saveThreadId(conversationId, thread.thread_id)

  const output = thread.slots.limbic.output
  if (thread.state === 'waiting') {
    // DEFER：Agent 需要更多信息，发送追问文本，等待用户下一条消息
    await teamsClient.reply(conversationId, output!.content)
  } else if (output?.mode === 'RESPOND') {
    // RESPOND：正常回复
    await teamsClient.reply(conversationId, output.content)
  }
  // NO_REPLY / EXECUTE 完成后：静默，不向通道发消息
  // interrupted：记录日志，可选通知管理员
}
```

---

## 四、Thread 查询

```typescript
const thread = await aima.getThread(thread_id: string): Promise<Thread>

interface Thread {
  thread_id: string
  state: 'active' | 'waiting' | 'complete' | 'interrupted'
  error_reason: string | null    // interrupted 时的原因
  source_channel: string
  source_account_id: string | null
  source_external_id: string | null
  initiated_by: string | null
  priority: number
  created_at: Date
  updated_at: Date
  slots: {
    limbic: LimbicSlot
    cortex: CortexSlot
    brainstem: BrainstemSlot
  }
}
```

### 读取 Limbic 输出（虚拟员工的响应决策）

```typescript
const output = thread.slots.limbic.output

// output.mode 决定上层应用的行为：
// 'RESPOND'        → output.content 是给对方的回复文本
// 'NO_REPLY'       → 静默处理（如纯内部操作），不需要向通道发送消息
// 'ROUTE'          → 已路由 Cortex，thread.state=complete 后再读结果
// 'EXECUTE(intent)'→ Limbic 将操作意图写入工作空间并激活 Brainstem 直接执行；
//                    intent 包含结构化操作描述（如 {action:'send_email', draft_id:'...'}）；
//                    仅用于 Limbic 有足够信息且无需规划的简单情况；
//                    有歧义或多步骤时 Limbic 应使用 ROUTE 而非 EXECUTE
// 'DEFER'          → Agent 主动挂起，等待更多输入；output.content 是追问文本；
//                    thread.state = waiting，调用方应发送 output.content 后等待用户回复
```

---

## 五、记忆只读接口

> 记忆由 Agent 自己通过 Hippocampus 写入和管理，上层应用**不能直接写**。
> 但以下场景需要只读访问：Shadow Mode 审计、外部合规检查、调试。
> 内部实现为 `Hippocampus.Recall.search()`，公共 API 隐藏 Hippocampus 子模块细节。

```typescript
interface MemorySearchOptions {
  // implicit 类型不在公共 API 中暴露：风险模式是 Amygdala 的内部检测数据，
  // 对外暴露会泄露系统对哪些操作持有风险判断，影响安全边界。
  // Shadow Mode 审计和合规检查应通过 Event Bus（COMPLIANCE 级）而非记忆只读接口获取风险信息。
  types?: Array<'semantic' | 'episodic' | 'procedural' | 'working'>
  limit?: number          // 默认 20
  entity_id?: string      // 过滤指定实体的记录（如 "colleague:alice"）
  entity_depth?: number   // 实体关联展开深度（1-2），搭配 entity_id 使用
  situation?: string      // 情境描述，触发情境匹配模式（Cortex 场景 E）
  segment_id?: string     // 过滤指定事件段内的记录
  // min_relevance 预留给向量检索阶段（0-1 相关度过滤）
  // 当前实现为 ILIKE 全文搜索，无相关度分数，此参数暂不生效
  // min_relevance?: number
}

const results = await aima.memory.search(
  query: string,
  options?: MemorySearchOptions
): Promise<MemoryEntry[]>

interface MemoryEntry {
  memory_id:   string
  type:        'semantic' | 'episodic' | 'procedural' | 'working'
  content:     string
  entity_id:   string | null   // 这条记录描述的实体（如 "colleague:alice" / "segment:{uuid}"）
  segment_id:  string | null   // 所属事件段（episodic 专用；上层应用通常不需要直接使用）
  relevance:   number | null   // 全文搜索时为 null；向量检索上线后填充 0-1 分数
  created_at:  Date
  tags:        string[]
  // 注意：base_importance 和 usage_outcomes 是记忆系统内部字段，不暴露到公共 API
}
```

**Shadow Mode 示例：**

```typescript
// 审计员查看 Alex 对某类采购流程的理解
const memories = await alex.memory.search('采购审批超限流程', {
  types: ['procedural', 'semantic'],
  limit: 10,
})
```

---

## 六、事件总线（可观测性）

事件总线是**只读**公共 API。上层只能订阅，不能发布。

```typescript
import { getEventBus } from '@aima/core'

const unsub = getEventBus().subscribe(event => { ... })
const unsub = getEventBus().subscribeLevel('COMPLIANCE', event => { ... })
const unsub = getEventBus().subscribeBrain('limbic', event => { ... })
const unsub = getEventBus().subscribeThread(thread_id, event => { ... })
unsub()
```

### 事件级别

| 级别 | 用途 |
|------|------|
| `COMPLIANCE` | 有真实外部效果的动作（发送消息、修改数据）— 审计必须 |
| `ALERT` | Amygdala 中断、Escalation、脑区失败 — 报警 |
| `INFO` | 工具调用、记忆写入、Skill 调用 — 运营监控 |
| `DEBUG` | Cortex 推理步骤、Skill 加载 — 详细认知过程 |
| `TRACE` | 工作空间 Slot 写入、脑区激活/完成 — 内部状态调试 |

### 关键事件类型

```
tool.pre_use       — 工具调用前（含 tool name, args, causation_id）
tool.post_use      — 工具调用后（含 result, isError）
limbic.respond     — Limbic 产生回复（COMPLIANCE 级）
brain.activated    — 脑区被激活
brain.complete     — 脑区运行完成
brain.error        — 脑区出错（→ thread interrupted）
thread.recovered   — 崩溃恢复时重启某个 thread
```

### 多 instance 隔离

单进程多个 `AIMAInstance`（多名虚拟员工）共享同一 EventBus singleton。
订阅时通过 `subscribeThread(thread_id, fn)` 自动过滤，或手动检查 `event.thread_id`。

---

## 七、边界：不暴露什么

| 内部组件 | 原因 |
|----------|------|
| `CognitiveWorkspace` | Thread/Slot 持久化层，实现细节 |
| `ThreadRunner` | 路由引擎，未来可替换 |
| `PiAgentAdapter` / `ClaudeSDKAdapter` | LLM 适配器 |
| `BrainAdapter` interface | 脑区实现细节 |
| `MemoryService`（直接写入） | 记忆由 Agent 自己管理 |
| `Amygdala` | 内置安全层，不对外暴露 |

**上层应用只与以下接口交互：**

- `AIMAInstance`（`receive` / `continue` / `getThread` / `memory.search`）
- `getEventBus()`（只读订阅）
- `Thread` / `LimbicOutput` / `MemoryEntry` 等纯数据类型

---

## 八、`@aima/crew` — OpenClaw Fork

> **定位**：`@aima/crew` 是 OpenClaw 的 fork，将 OpenClaw 内部的 `pi-coding-agent` 替换为 AIMA 五脑架构，使 OpenClaw 获得认知持久化、记忆系统、合规审计等能力。
>
> - **`secondfirst/employee` 和其他 AIMA 项目**：直接依赖 `@aima/core`，不使用此包
> - **`@aima/crew`**：面向希望将 OpenClaw 升级为 AIMA 驱动的部署场景

### 8.1 架构关系

```
OpenClaw（原版）          @aima/crew（fork）
─────────────────        ──────────────────────────────
pi-coding-agent          @aima/core（五脑）
  └─ pi-agent-core    →    ├─ Limbic（对话/路由）
                           ├─ Cortex（规划推理）
                           ├─ Brainstem（工具执行）
                           ├─ Amygdala（安全底线）
                           └─ DMN（反思/记忆整合）

SessionManager（文件）   CognitiveWorkspace（PostgreSQL）
```

### 8.2 核心替换点

OpenClaw gateway 只需改一处调用：

```typescript
// 原来:
import { createAgentSession } from '@mariozechner/pi-coding-agent'
const session = await createAgentSession({ sessionManager, tools, model, ... })

// 改为:
import { createAIMASession } from '@aima/crew'
const session = await createAIMASession({
  instance: myAIMAInstance,        // AIMAInstance（如 "Alex"）
  sessionKey: params.sessionKey,   // OpenClaw session key → 映射到 thread_id
  accountId: params.accountId,     // Bot/账户 ID → source_account_id
  tools: channelTools,             // 通道工具（sendMessage 等）→ 全部给 Brainstem
  toolIndex: toolIndexMarkdown,    // 工具清单（Markdown）→ 注入 Cortex context
  channelContext: agentPromptStr,  // agentPrompt adapter 输出 → 追加到 Block 3
})
```

返回 `AIMAAgent`，对外实现 pi-agent-core `Agent` 接口（供 OpenClaw gateway 调用），
内部持有 `AIMAInstance` 并将调用转换为 AIMA 的 Thread/Slot 语义。
OpenClaw 其余代码不变。

```
OpenClaw gateway
    ↓  调用 pi-agent-core Agent 接口（prompt / subscribe / abort）
AIMAAgent（facade）
    ↓  转换为 Thread 操作
AIMAInstance（@aima/core）
    ↓  五脑路由
CognitiveWorkspace（PostgreSQL）
```

### 8.3 工具分工

OpenClaw 传入的所有外部工具（`sendMessage`、`addReaction`、`createCard` 等）全部注册到 **Brainstem**，不进入 Limbic 或 Cortex。Cortex 通过 Block 3 中注入的 `toolIndex`（Markdown 格式工具清单）理解可用工具及其语义，从而做出规划。

```
Cortex  → 读 toolIndex → 推理执行计划 → 写 Cortex Slot（intent=execute）
Brainstem → 读 Slot → 调用具体工具 → 写 Brainstem Slot
Limbic  → 读最终结果 → 决定回复内容（mode=RESPOND / NO_REPLY）
```

AIMA 内部工具（`workspace_read/write`、`memory_search` 等）各脑区按原设计使用，与外部工具完全隔离。

### 8.4 已知差异点

**SessionManager**：OpenClaw 用文件持久化；`@aima/crew` 用 PostgreSQL Thread/Slot，`sessionKey → thread_id` 为映射键。`CognitiveWorkspace.waitForComplete()` 提供等价的异步等待语义。

**System Prompt**：OpenClaw identity 文件 → AIMA Block 1/2（静态，走 prompt cache）；AIMA Block 3/4 每轮动态注入，OpenClaw 不感知。`channelContext` 追加到 Block 3。

**EventBus 隔离**：`AIMAAgent.subscribe()` 内部按 `thread_id` 自动过滤，只转发当前 session 事件给 OpenClaw 的 WebSocket 广播层。

**Amygdala 覆盖**：`pi-coding-agent` 内置工具（bash、文件 I/O）与外部工具走同一 `AgentTool` 注册路径。`@aima/crew` 通过 pi-coding-agent Extension API 的 `tool_call` 事件（在工具执行前触发，可返回 `{ block: true }` 阻断）接入 Amygdala，实现对全部工具的统一拦截，无覆盖缺口。

**Streaming**：当前不实现 token 级流式输出。Teams 等通道先发 typing indicator ACK，`receive()` 完成后发完整回复。

---

## 九、版本说明

当前实现状态与路线图见 [`05-status.md`](05-status.md)。
