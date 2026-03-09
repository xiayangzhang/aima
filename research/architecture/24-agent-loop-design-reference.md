# Agent Loop 设计参考：深度调研综合报告

> **研究日期**：2026-03-08
> **调研来源**：Spacebot（spacedriveapp/spacebot）源码、Symphony（openai/symphony）源码、OpenAI Agents JS 源码、Claude Code Agent Teams 文档、AutoForge（AutoForgeAI/autoforge）源码、Agent 审计架构深度研究（见报告 23）
> **用途**：为虚拟员工平台 Feature 002（单分区 Agent Loop）及后续架构设计提供实现参考

---

## 目录

1. [进程分工模型](#一进程分工模型spacebot)
2. [Context Fork 模式（Branch）](#二context-fork-模式branch)
3. [Worker 生命周期与 Human-in-the-Loop](#三worker-生命周期与-human-in-the-loop)
4. [Context 压缩（Compactor）](#四context-压缩compactor)
5. [Status Block 注入](#五status-block-注入)
6. [Cortex：系统观察者与 Memory Bulletin](#六cortex系统观察者与-memory-bulletin)
7. [Typed Memory Graph](#七typed-memory-graph)
8. [混合检索（Hybrid Search + RRF）](#八混合检索hybrid-search--rrf)
9. [Model Routing](#九model-routing)
10. [委派模式：asTool vs Handoff](#十委派模式astool-vs-handoff)
11. [结构化终止（outputType + Zod）](#十一结构化终止outputtype--zod)
12. [Skill as Markdown Document](#十二skill-as-markdown-document)
13. [MCP as State Layer](#十三mcp-as-state-layer)
14. [任务队列与 Claim 防竞态](#十四任务队列与-claim-防竞态)
15. [行为记录与审计追踪](#十五行为记录与审计追踪)
16. [rootSessionId 与多 Agent 因果链](#十六rootsessionid-与多-agent-因果链)
17. [行为回放与取证](#十七行为回放与取证)
18. [对我们架构的映射与设计建议](#十八对我们架构的映射与设计建议)（含各框架等权重贡献总结 + 我们自己的综合设计）

---

## 一、进程分工模型（Spacebot）

**来源**：Spacebot `src/agent/` 目录

### 核心哲学

> "Delegation is the only way work gets done."

单体 session 模型的问题：一个 LLM 线程串行处理对话、思考、工具执行、记忆检索、context 压缩——任意一步阻塞，整个系统暂停。

Spacebot 将其拆分为五种专职进程：

| 进程 | 是否 LLM | 职责 | 工具集 | Context |
|------|---------|------|--------|---------|
| **Channel** | ✅ | 用户对话，永不阻塞，只委派 | reply, branch, spawn_worker, route | 持久化历史 |
| **Branch** | ✅ | 独立思考，返回结论，然后销毁 | memory_recall, memory_save, task_* | clone of channel history |
| **Worker** | ✅（可插拔） | 执行具体任务，不含对话上下文 | shell, file, exec, browser, set_status | fresh prompt + task desc |
| **Compactor** | ❌ 程序化 | 监控 context size，触发压缩 | 无 | N/A |
| **Cortex** | ✅ | 系统观察，生成 Memory Bulletin | memory_recall, memory_save | fresh per bulletin run |

**关键设计原则**：
- Channel 的工具列表里**没有** `memory_recall`——记忆检索是 Branch 的专属职责
- Worker 获得 fresh context（无对话历史），专注执行
- Cortex 是唯一能观察全局所有进程活动的进程

---

## 二、Context Fork 模式（Branch）

**来源**：Spacebot `src/agent/channel_dispatch.rs`

### 实现细节

```rust
// Branch spawn 时做完整深拷贝
let history = {
    let h = state.history.read().await;   // Arc<RwLock<Vec<Message>>>
    h.clone()                             // 独立副本，Branch 的变更不影响 Channel
};
```

### 完整生命周期

```
1. Channel 调用 `branch` 工具
2. spawn_branch() 检查 max_concurrent_branches
3. 克隆 channel history → Branch 私有副本
4. 创建隔离 ToolServer（branch 专属工具集）
5. tokio::spawn() → Branch 作为独立 Tokio task 启动
6. Branch UUID + JoinHandle 存入 active_branches
7. Branch 运行（最多 max_turns 轮工具调用）
8. Branch 完成 → 发送 ProcessEvent::BranchResult{conclusion}
9. Channel 事件循环收到 → 存入 pending_results（不直接写 history）
10. 500ms debounce 后 retrigger → 生成合成 User 消息
    "[Branch abc1 completed]: <conclusion text>"
11. Channel LLM 以此为 prompt → 通过 reply 工具向用户输出
12. Branch JoinHandle drop，资源清理
```

**关键发现**：Branch 结论从不直接注入 history。走 `PendingResult → retrigger → LLM relay → reply` 路径，保持 history 语义纯洁性。

### 多 Branch 并发

多个 Branch 同时运行，结果通过 `pending_results` 累积，在同一个 retrigger 消息中批量注入（ID-tagged 列表）。顺序由事件到达顺序决定，非 spawn 顺序。

---

## 三、Worker 生命周期与 Human-in-the-Loop

**来源**：Spacebot `src/agent/worker.rs`

### 状态机

```
Running ──────────────────→ Done（终态）
   │                          ↑
   ├──→ WaitingForInput ───────┤
   │         │                │
   │         └──→ Running     │
   │                          │
   └──────────────────────────→ Failed（终态）
```

合法转换：`Running→WaitingForInput`, `Running→Done`, `Running→Failed`, `WaitingForInput→Running`, `WaitingForInput→Failed`。

### WaitingForInput 实现

```rust
// Interactive Worker 创建时返回 (Worker, mpsc::Sender<String>)
// Channel 保存 Sender 在 worker_inputs HashMap 中

// Worker 执行完初始任务后：
if let Some(mut input_rx) = self.input_rx.take() {
    self.state = WorkerState::WaitingForInput;
    self.hook.send_worker_idle();   // 通知 Cortex：此 Worker 不计超时

    while let Some(follow_up) = input_rx.recv().await {
        self.state = WorkerState::Running;
        // 以 follow_up 为 prompt 继续 LLM 调用
    }
}
```

Channel 通过 `route` 工具向指定 Worker 的 Sender 发消息：`worker_inputs[worker_id].send(text)`。

### Fire-and-forget vs Interactive

| | Fire-and-forget | Interactive |
|-|----------------|-------------|
| 构造 | `Worker::new()` | `Worker::new_interactive()` |
| input_rx | None | Some(mpsc::Receiver) |
| 完成后 | 直接 Done | 进入 WaitingForInput loop |
| Cortex 超时 | 活跃时计时 | idle 状态不超时（is_idle=true） |

---

## 四、Context 压缩（Compactor）

**来源**：Spacebot `src/agent/compactor.rs`

### 三级阈值（可配置）

```rust
if usage >= emergency_threshold {      // 约 0.95
    CompactionAction::EmergencyTruncate  // 同步，无 LLM，直接删除 50%
} else if usage >= aggressive_threshold { // 约 0.85
    CompactionAction::Aggressive         // 异步 Worker，LLM 摘要，删 50%
} else if usage >= background_threshold { // 约 0.80
    CompactionAction::Background         // 异步 Worker，LLM 摘要，删 30%
}
```

### Context Size 测量

```rust
fn estimate_history_tokens(history: &[Message]) -> usize {
    // Text: chars / 4
    // Image/Audio/Video: 500 字符估算
    // Document: 1000 字符估算
}
```

### 压缩流程（非阻塞）

1. `tokio::spawn()` 启动独立 compaction task（Channel 继续运行）
2. `is_compacting: Arc<RwLock<bool>>` 防重复启动
3. 写锁 drain 最旧 N 条消息
4. Compactor LLM（haiku 级）生成摘要，期间可调用 `memory_save` 工具提取记忆
5. 在 history 头部插入 `[Compaction Summary]: <text>`

**Branch 的轻量压缩**（非 Compactor）：Branch 自带 `maybe_compact_history()`（70% 时删 50%，无 LLM）。

---

## 五、Status Block 注入

**来源**：Spacebot `src/agent/channel_prompt.rs`

### 内容格式

```
Current date/time: <ISO8601>

## Active Workers
- [<uuid>] <task> (<start HH:MM>, <N> tool calls): <status>

## Active Branches
- [<uuid>] <description> (started HH:MM:SS)

## Recently Completed
- [branch|worker] <description>: <result_summary, max 500 chars>
```

### 注入机制

Status Block **注入 system prompt**，不是 history 消息。Channel 每次 LLM 调用前重新构建 system prompt，自动包含最新 Status Block。

Worker 通过 `set_status("working on X")` 更新状态：
```
event_tx.send(ProcessEvent::WorkerStatus { worker_id, status: "working on X" })
```

`completed_items`：只显示未 relay 的，最多 5 条，5 分钟后已 relay 的 prune。

---

## 六、Cortex：系统观察者与 Memory Bulletin

**来源**：Spacebot `src/agent/cortex.rs`

### Memory Bulletin 注入

```rust
// Cortex 更新时：
deps.runtime_config.memory_bulletin.store(Arc::new(Some(bulletin_text)));

// Channel 每次构建 system prompt 时（无锁读取）：
let bulletin = memory_bulletin.load();
// 拼接进 system prompt
```

`ArcSwap<Option<String>>` 实现无锁原子更新，Channel 下次调用自动用最新值，无需通知机制。

### Cortex 健康监控

- 追踪所有 Worker 的 `last_activity_at`
- `run_health_tick()` 周期比较 `now - last_activity_at >= worker_timeout`
- Idle Worker（`is_idle=true`）跳过超时检查

### Circuit Breaker（当前为观察模式）

```rust
// key = "worker_type:xxx" 或 "tool:xxx"
// 连续 3 次失败 → tripped = true
// 当前版本：action_taken = "observe_only"（记录不阻断）
// Circuit Open 后 30 分钟冷却自动重置
```

**注意**：Spacebot 的 circuit breaker 目前只记录、不阻断，是未来功能。

### Bulletin 失败退避

指数退避：30s → 60s → 120s → 240s → 480s → 600s（上限）。连续 3 次失败触发 circuit open，1800s 冷却。

---

## 七、Typed Memory Graph

**来源**：Spacebot `src/memory/store.rs`，LanceDB 集成

### SQLite Schema

```sql
CREATE TABLE memories (
    id               TEXT PRIMARY KEY,
    content          TEXT NOT NULL,
    memory_type      TEXT NOT NULL,  -- 见下表
    importance       REAL NOT NULL,  -- 0.0 ~ 1.0（静态，无自动衰减）
    created_at       DATETIME NOT NULL,
    updated_at       DATETIME NOT NULL,
    last_accessed_at DATETIME NOT NULL,
    access_count     INTEGER NOT NULL DEFAULT 0,
    source           TEXT,
    channel_id       TEXT,
    forgotten        INTEGER NOT NULL DEFAULT 0  -- 软删除
);

CREATE TABLE associations (
    id            TEXT PRIMARY KEY,
    source_id     TEXT NOT NULL REFERENCES memories(id),
    target_id     TEXT NOT NULL REFERENCES memories(id),
    relation_type TEXT NOT NULL,  -- 见下表
    weight        REAL NOT NULL DEFAULT 0.5,
    created_at    DATETIME NOT NULL,
    UNIQUE(source_id, target_id, relation_type)
);
```

### 记忆类型与默认重要性

| 类型 | 默认 importance | 含义 |
|------|----------------|------|
| Identity | 1.0 | Agent/用户身份信息 |
| Goal | 0.9 | 当前目标 |
| Decision | 0.8 | 已做决策 |
| Todo | 0.8 | 待办事项 |
| Preference | 0.7 | 偏好设置 |
| Fact | 0.6 | 事实知识 |
| Event | 0.4 | 已发生事件 |
| Observation | 0.3 | 观察记录 |

**关键**：`importance` 是静态值，无衰减公式。`access_count` 记录访问频率但不影响 importance。

### 图边类型

| 边类型 | RRF 权重倍数 | 含义 |
|--------|------------|------|
| Updates | 1.5× | 更新/修正 |
| CausedBy/ResultOf | 1.3× | 因果关系 |
| RelatedTo | 1.0× | 相关 |
| PartOf | 0.8× | 包含关系 |
| Contradicts | 0.5× | 矛盾关系 |

---

## 八、混合检索（Hybrid Search + RRF）

**来源**：Spacebot `src/memory/` + LanceDB 集成

### 三路并行

```
Query
  ├─→ FTS（LanceDB inverted index）→ [(memory_id, score), ...]
  ├─→ Vector Similarity（LanceDB HNSW）→ [(memory_id, 1.0-distance), ...]
  └─→ Graph Traversal（BFS depth=2，从 importance≥0.8 种子出发）→ [(memory_id, score), ...]
         └── 图边权重 × 关系类型倍数
```

### RRF 融合公式

```
RRF_score(doc) = Σ  1 / (k + rank_in_list)    （k=60）
                各列表中包含该 doc 的列表

同一文档在多列表出现时累加分数：
  三列表均排第1 → 3 × (1/61) ≈ 0.049
  仅在一列表排第1 → 1/61 ≈ 0.016
```

融合后按 `min_score` 过滤，取 top N。

### 实现关键

- Vector search：先用 embedding model 对 query 做 embedding，再 HNSW 近邻搜索
- FTS：LanceDB 内置倒排索引（Tantivy）
- Graph traversal：BFS 沿 `RelatedTo` 和 `PartOf` 边扩展（其余边类型只计分不扩展）
- 嵌入模型：FastEmbed（本地，无 API 调用）

---

## 九、Model Routing

**来源**：Spacebot `src/routing/` — **注意：README 描述的"prompt 复杂度评分"在源码中不存在**

### 实际实现：静态查表

```rust
pub fn resolve(&self, process_type: ProcessType, task_type: Option<&str>) -> &str {
    // 1. task_type override（Worker/Branch 专用）
    if let Some(task) = task_type
        && let Some(model) = self.task_overrides.get(task) {
        return model;  // e.g., "coding" → sonnet
    }
    // 2. process_type 默认
    match process_type {
        ProcessType::Channel   => &self.channel,    // 最强对话模型
        ProcessType::Branch    => &self.branch,     // 同 channel 或稍弱
        ProcessType::Worker    => &self.worker,     // 便宜执行模型
        ProcessType::Compactor => &self.compactor,  // 最便宜
        ProcessType::Cortex    => &self.cortex,     // haiku 级
    }
}
```

### Fallback Chain

```
触发条件：HTTP 429/500/502/503/504，rate limit，timeout，empty response
MAX_FALLBACK_ATTEMPTS = 3
MAX_RETRIES_PER_MODEL = 3
RETRY_BASE_DELAY_MS = 500（指数退避）
429 触发模型级 cooldown（默认 60s）
Context overflow → compaction 路径（不走 fallback）
```

### 典型双层配置（OpenRouter）

| 进程类型 | 模型 |
|---------|------|
| Channel / Branch | claude-sonnet-4 |
| Worker / Compactor / Cortex | claude-haiku-4.5 |
| Worker（coding task） | claude-sonnet-4（override） |

---

## 十、委派模式：asTool vs Handoff

**来源**：OpenAI Agents JS `src/agents/`

### asTool()：子 Agent 作为工具

```typescript
const subAgent = new Agent({
  name: "Researcher",
  instructions: "...",
  outputType: ResearchResultSchema,  // Zod schema
});

const tool = subAgent.asTool({
  toolName: "research_topic",
  toolDescription: "Research a topic",
  parameters: z.object({ query: z.string() }),
  inputBuilder: (params, context) => `Research: ${params.query}`,
  // customOutputExtractor: (result) => result.finalOutput.summary
});
```

**执行流程**：
1. 父 Agent LLM 生成 function call
2. `inputBuilder(params)` → 生成子 Agent 输入文本（子 Agent 无父历史）
3. 子 Agent 独立 run loop 完成
4. 输出提取：`customOutputExtractor` → `result.finalOutput` → raw text
5. 作为 tool result 注入父 Agent history，父 Agent 继续

### Handoff：对话控制权转交

```typescript
// 接收方看到完整历史（可用 inputFilter 过滤）
handoff(targetAgent, {
  inputFilter: (data) => ({
    ...data,
    inputHistory: data.inputHistory.slice(-5)  // 只保留最近 5 条
  })
})
```

### 本质区别

| 维度 | asTool | Handoff |
|------|--------|---------|
| 历史传递 | 无（子 Agent 从空白开始） | 完整历史（可过滤） |
| 控制权 | 父 Agent 保持 | 转移给接收方 |
| 返回值 | string（注入父历史） | 无返回 |
| 适用场景 | 任务委派（"帮我查X"） | 对话转接（"让billing agent接着谈"） |
| Token 成本 | 低（子 Agent 上下文干净） | 高（接收方看全量历史） |

---

## 十一、结构化终止（outputType + Zod）

**来源**：OpenAI Agents JS `src/agents/turnResolution.ts`

### 循环退出的代码路径

```
LLM response → processModelResponse() 分类 output items
  ↓
resolveTurn()：
  若 outputType === 'text'：
    无 pending tool calls → next_step_final_output（退出）
  若 outputType 是 Zod schema：
    取 assistant message text → schema.parse(text)
    parse 失败 → throw ModelBehaviorError（不重试，直接报错）
    parse 成功 → next_step_final_output（退出）
  若有 tool calls → next_step_run_again（继续）
  若有 handoff → 切换 agent，继续

runLoop()：
  case 'next_step_final_output':
    await runOutputGuardrails(state, guardrails, output)
    return new RunResult(state)  ← 真正退出
```

**设计价值**：`outputType` 将"何时完成"的判断内置到循环终止逻辑，不依赖"无工具调用=完成"的隐式判断。

---

## 十二、Skill as Markdown Document

**来源**：Symphony `openai/symphony`，`.codex/skills/` 目录

### 实现机制

Skill = 一个 Markdown 文件，放在代码库 `.codex/skills/<name>/SKILL.md`。

```markdown
# Land Skill

## Purpose
Merge a pull request after all checks pass.

## Steps
1. Check CI status: `gh pr checks`
2. If all green, merge: `gh pr merge --squash`
3. Update issue state to Done
4. Comment on PR with merge summary
```

Agent 通过**读文件系统**来调用 Skill：WORKFLOW.md 的 prompt body 里写 `Follow .codex/skills/land/SKILL.md`。

没有工具调用、没有注册表、没有特殊协议。**Skill = 写给 Agent 看的自然语言指令文档**。

### WORKFLOW.md 结构（Symphony）

```yaml
---
# YAML frontmatter：基础设施配置
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 10
codex:
  approval_policy: never
  turn_timeout_ms: 3600000
---
# Markdown body：Liquid 模板 → Agent prompt
You are working on issue {{ issue.identifier }}: {{ issue.title }}
Follow .codex/skills/land/SKILL.md when merging.
```

**价值**：Agent 行为、并发配置、Skill 定义全部版本控制化，随分支演进。

---

## 十三、MCP as State Layer

**来源**：AutoForge `AutoForgeAI/autoforge`

### 设计原则

Agent 永远不直接访问数据库，只通过 MCP 工具读写状态。MCP server 是状态的单一权威来源。

### Feature Table Schema（推断）

```python
class Feature(Base):
    id            = Column(Integer, primary_key=True)
    name          = Column(String, nullable=False)
    description   = Column(Text)
    priority      = Column(Integer)   # 越小越高优先
    status        = Column(Enum('pending', 'in_progress', 'passing', 'skipped'))
    tests_passing = Column(Integer, default=0)
    tests_failing = Column(Integer, default=0)
    created_at    = Column(DateTime)
    updated_at    = Column(DateTime)
```

### MCP 工具集

| 工具 | 作用 |
|------|------|
| `feature_get_next()` | 取最高优先级 pending feature（原子操作，防并发重取） |
| `feature_mark_passing(id)` | 标记完成 |
| `feature_skip(id)` | 移到队列末尾 |
| `feature_get_stats()` | 整体进度统计 |
| `feature_create_bulk(list)` | 批量创建（Initializer 调用） |
| `feature_get_for_regression()` | 随机取 passing feature 用于回归 |

### 跨 Session 恢复

```
三层恢复依据：
  1. SQLite DB → feature_get_next() 自动返回未完成的最高优先级 feature
     （查询语义本身 = 断点续传，无需显式续点逻辑）
  2. Git commits → 每个完成 feature 对应一个 commit
  3. claude-progress.txt → session notes 供下一 session 读取
```

### 并发防重

`feature_get_next()` 原子性地将 status 更新为 `in_progress`，防止两个 Agent 取同一个 feature（乐观锁）。

---

## 十四、任务队列与 Claim 防竞态

**来源**：Claude Code Agent Teams 文档

### 文件系统实现

```
~/.claude/teams/{team-name}/config.json   ← 成员列表，任意 teammate 可读
~/.claude/tasks/{team-name}/              ← 任务目录，每个任务一个 JSON 文件
```

### 任务状态机

```
created → claimed → in_progress → completed
                                → failed → retry
```

依赖追踪：pending 任务的 blocked_by 全部完成后自动解锁。

### 防竞态：文件锁（flock）

多个 Teammate 同时 claim 同一任务时，OS 级 `flock()` 确保只有一个成功。

### 质量门 Hooks

```
TeammateIdle hook：Teammate 进入 idle 时触发
  exit code 2 → 向 Teammate 发反馈，保持工作状态（质量验收）

TaskCompleted hook：任务即将标记完成时触发
  exit code 2 → 拦截完成，发反馈（验收检查）
```

### 成员发现（P2P 通信基础）

任意 Teammate 读取 `config.json` 发现其他成员，直接发消息（不需要 Lead 中转）。

**分布式部署替换**：文件系统 → Redis（inbox: Pub/Sub，任务队列: PostgreSQL）

---

## 十五、行为记录与审计追踪

**来源**：报告 23（`research/architecture/23-agent-audit-deep-dive.md`），OTel GenAI Semantic Conventions

### 两套系统，同一 Hook 点

```
Agent Hook（每次 LLM 调用前后，每次工具调用前后）
  ├─→ OTel Span（可观测性）
  │     目的：调试、性能监控、实时告警
  │     保留：30-90天，可采样
  │     存储：Application Insights / Jaeger
  │     完整性：无密码学保证
  │
  └─→ Audit Event（合规归档）
        目的：法律合规、行为追溯、监管报告
        保留：PostgreSQL 90-180天（热）+ WORM 永久（冷）
        存储：Azure Immutable Blob + Confidential Ledger
        完整性：SHA-256 hash + Merkle Receipt（法律证据）
```

两者通过 `otelTraceId` / `otelSpanId` 双向关联。

### Audit Event Schema（核心字段）

```typescript
interface AuditEventBase {
  // 身份
  eventId:         string;    // UUID v4
  eventType:       AuditEventType;
  timestamp:       string;    // ISO8601 UTC
  schemaVersion:   string;    // "1.0"

  // 因果链追踪
  rootSessionId:   string;    // 贯穿整个多 Agent 会话（见第十六节）
  sessionId:       string;    // 当前分区 session
  parentEventId:   string | null;

  // 可观测性关联
  otelTraceId:     string;
  otelSpanId:      string;

  // Agent 身份
  agentId:         string;    // 虚拟员工 ID（如 "alex-001"）
  partitionType:   string;    // "communicator"|"executor"|"planner"|"auditor"
  partitionId:     string;

  // 用户身份
  userId:          string;    // AAD Object ID
  userEmail:       string;
  organizationId:  string;

  // 决策依据（满足 Proof of Work 要求）
  decisionBasis: {
    toolResultsReferenced: string[];   // 工具调用 ID 列表
    memoriesReferenced:    string[];   // 记忆 ID 列表
    planningContext:       string;     // 简短摘要（Haiku 生成，<50 token）
  };

  // 完整性
  contentHash:     string;    // SHA-256(完整事件内容，含真实 PII)
  signingKeyVersion: string;
}
```

### 工具调用审计（最细粒度）

```typescript
interface ToolAuditEvent extends AuditEventBase {
  eventType: 'tool.pre_use' | 'tool.post_use' | 'tool.blocked';
  toolName:       string;
  toolCategory:   'read' | 'write' | 'delete' | 'external_api' | 'mcp';
  toolInput:      Record<string, unknown>;  // 保留真实 PII（法律证据要求），通过访问控制保护
  toolOutput:     Record<string, unknown> | null;
  durationMs:     number;
  success:        boolean;
  errorCode:      string | null;
  dataverseTables: string[];  // 涉及的 Dataverse 表（满足 ISM-0114）
}
```

### 不可篡改存储

```
Audit Event 写入流程：

Agent → Service Bus（Premium，有序 Session）
  → Audit Consumer
      ├─→ PostgreSQL（热存储，90天，append-only RLS）
      │       write: INSERT only（无 UPDATE/DELETE 权限）
      │
      └─→ 内容哈希计算 → Confidential Ledger（写入 contentHash + Merkle Receipt）
              └─→ Azure Immutable Blob（写入完整 gzip 事件，Version-level，2557天锁定）
```

**Azure Confidential Ledger**：基于 Intel SGX TEE + CCF，每条记录产生 Merkle Receipt。只存 `contentHash`，不存明文，避免敏感数据进入 TEE 处理链。Merkle Receipt 是向监管机构证明记录未被篡改的**法律证据**。

### IRAP/ISM 关键合规控制

| ISM 控制 | 要求 | 我们的实现 |
|---------|------|-----------|
| ISM-0988 | PROTECTED 系统日志保留 7 年 | WORM Blob 2557天 |
| ISM-1228 | 日志不可修改或删除 | Immutable Blob Locked Policy |
| ISM-0114 | 记录所有敏感数据访问 | 工具级 tool.pre_use/post_use |
| ISM-1405 | 时钟与 NTP 同步 | Azure 托管时钟 |

---

## 十六、rootSessionId 与多 Agent 因果链

**来源**：报告 23

### 问题

多个分区（Communicator → Executor → Planner）协作处理一个用户请求时，如何在事后重建完整的因果链？

### 解决方案：rootSessionId

```
用户发起一个请求 → 生成 rootSessionId（UUID）

Communicator 分区处理：
  sessionId = comm-001
  rootSessionId = ROOT-001
  parentEventId = null

Communicator 委派给 Executor：
  sessionId = exec-001
  rootSessionId = ROOT-001（继承）
  parentEventId = comm-event-042

Executor 调用 Planner：
  sessionId = plan-001
  rootSessionId = ROOT-001（继承）
  parentEventId = exec-event-018
```

**重建因果链**（单次 SQL）：
```sql
SELECT * FROM audit_events
WHERE root_session_id = 'ROOT-001'
ORDER BY timestamp ASC;
```

一个请求涉及的所有分区、所有工具调用，全部按时间排序，完整因果链。

### Privacy Act 2026-12 合规

每个 Session 结束时生成：
```typescript
interface AutomatedDecisionSummary {
  sessionId:              string;
  rootSessionId:          string;
  decisionType:           string;      // 如 "procurement_approval"
  personalInfoCategories: string[];    // 如 ["name", "ABN", "contact"]
  isFullyAutomated:       boolean;
  humanReviewAvailable:   boolean;
  appealPath:             string;      // URL 或联系方式
  generatedAt:            string;      // ISO8601
}
```

---

## 十七、行为回放与取证

**来源**：报告 23（AgentReplayEngine 设计）

### Event Sourcing 模式

Agent 状态 = 事件序列。每个事件包含序列号，回放引擎按序重建决策过程。

```typescript
class AgentReplayEngine {
  async replay(rootSessionId: string): Promise<ReplayResult> {
    const events = await db.query(
      'SELECT * FROM audit_events WHERE root_session_id = $1 ORDER BY sequence_number ASC',
      [rootSessionId]
    );
    // 按序应用每个事件，重建状态
  }
}
```

### Context Snapshot 策略

完整 context 快照（200K token）成本极高，**且通常不必要**——context 可以从已存档的部分重建：

```
Context 重建四要素（已由审计事件覆盖）：
  1. System Prompt 版本号 → 对应 Git commit / 配置版本，可重新加载
  2. 消息序列 → audit_events 中 turn.start / tool.pre_use / tool.post_use 完整记录
  3. 注入记忆 ID 列表 → 每次 LLM 调用的 memoriesReferenced 字段
  4. Memory Bulletin 版本 → 对应 HR Agent 生成时间戳，可重新加载

真正需要快照的 external state：
  - 第三方 API 响应（非 Dataverse，内容不在我们系统中）
  - 外部网页内容（browser 工具抓取，不可复现）
```

```typescript
const SNAPSHOT_TRIGGERS = [
  // 仅对"内容无法从系统重建"的 external state 快照
  (event) => event.toolCategory === 'external_api' && event.toolName !== 'dataverse_*',
  (event) => event.toolName === 'browser_fetch',
];

if (SNAPSHOT_TRIGGERS.some(t => t(event))) {
  // 只存 tool output（不是全量 context）到 WORM Blob
  await wormStorage.store(`snapshots/${event.eventId}.gz`, gzip(event.toolOutput));
}
```

**关键区别**：Dataverse 的写操作结果在 Dataverse 历史版本中永久保存，无需另存快照。只有"调用时存在、之后消失"的外部内容才需要存档。

### planActualDiff

对比 Agent 计划做什么 vs 实际执行了什么：
- `decisionBasis.planningContext`：Agent 在工具调用前的计划摘要
- `tool.post_use` 事件：实际调用结果
- 差异分析：用于发现 Agent 行为偏离预期的情况

---

## 十八、对我们架构的映射与设计建议

### 18.1 各框架贡献总结

本报告调研了五个框架，每个框架贡献了不同的设计洞见。以下是等权重视角的贡献总结：

| 框架 | 核心贡献领域 | 我们采纳的具体机制 |
|------|------------|-----------------|
| **Spacebot** | 进程分工、Context Fork、Worker 状态机、记忆架构、系统观察 | Channel/Worker 分离模型；Branch→PendingResult 路径；WorkerState 状态机；Typed Memory Graph（8类型）；Memory Bulletin via ArcSwap；三级 Compaction 阈值 |
| **OpenAI Agents JS** | 委派语义、结构化退出条件 | asTool（子 Agent 无父历史，返回字符串）vs Handoff（历史转移，控制权转交）语义区分；outputType Zod schema 驱动循环退出，不靠隐式"无工具调用=完成" |
| **Symphony** | Skill 定义与版本控制化行为 | Skill as Markdown（无注册表、无特殊协议，Agent 读文件即调用）；WORKFLOW.md 将行为配置、并发配置、Skill 引用全部纳入版本控制 |
| **AutoForge** | 状态层设计、跨 Session 恢复 | MCP as State Layer（Agent 不直接访问 DB）；`feature_get_next()` 原子 claim 防并发重取；查询语义本身 = 断点续传，无需额外续点逻辑 |
| **Claude Code Teams** | 任务 claim 防竞态、成员 P2P 发现 | 原子任务队列（flock→Redis 替换）；任务状态机 created→claimed→in_progress→completed；quality gate hooks（exit code 2 拦截完成）；成员读 config.json 直接通信 |

**重要说明**：Spacebot 在本报告中占有较大篇幅，是因为其源码最接近"生产就绪的单 Agent 进程模型"，细节最丰富。但它面向的是个人/团队工具场景，我们不能照搬其整体设计——特别是其消息路由、个人记忆偏好等部分在企业多租户场景中不适用。

---

### 18.2 我们自己的架构综合

以下是不来自任何单一框架、而是基于我们产品定位推导出的独特设计判断：

#### 1. 入口多样性（非单一通道）

任何框架都假设"用户通过 X 与 Agent 对话"。我们的入口是多源异步的：

```
入口类型                  交互模式        触发者
──────────────────────────────────────────────────
Teams DM / Channel       同步交互        人类用户
Email                    异步触发        人类用户
Dataverse Webhook        事件驱动        业务系统（无人触发）
Power Automate Flow      工作流集成      调度器 / 业务规则
```

这意味着 Communicator 分区需要处理"无人在线"的异步请求，必须能在没有实时用户的情况下完成任务并异步回复。这一需求在所有调研框架中都不存在。

#### 2. 虚拟员工身份模型

```
外部视角：       用户看到 "Alex"（一个具体的虚拟同事）
                  ↕ 通过 Teams/Email 与 "Alex" 沟通
内部视角：       Communicator（对外面具，统一输出）
                  ↕ 委派
                 Executor / Planner / HR Agent（对等分区）

多租户：         每个客户组织的 "Alex" 是独立部署实例
                 共享 Skill 库（平台层），私有记忆（租户层）
```

没有框架处理过"一个 AI 在企业组织内被所有员工视为真实同事"的场景。Spacebot 是个人工具；AutoForge 是内部开发工具；Claude Code Teams 是开发团队协作。我们需要自己设计身份持续性、角色认知、组织关系图。

#### 3. Skill 即知识资产（超越 Symphony）

Symphony 的 Skill 是**操作指令**（"如何合并 PR"）。我们的 Skill 是**业务领域知识**：

```
Symphony Skill：
  "Run `gh pr merge --squash` after CI passes"  ← 程序步骤

我们的 Skill：
  "澳大利亚政府采购评估规则：
   - 10万以下：3 报价要求
   - 10万以上：公开招标流程
   - 联邦采购框架协议：优先选用
   - 例外情形：紧急采购条款 CPR 4.7"  ← 领域知识
```

Skill 是产品护城河——当 LLM 框架更换时，Skill 库（知识资产）可以迁移。Skill 的积累速度决定产品的护城河深度。

#### 4. 治理而非编排

AutoForge 的 PM→Architect→QA 是编排。Claude Code Teams 的 Lead 分发任务是编排。Spacebot 的 Cortex 监控 Worker 超时接近编排。

我们的设计原则：**分区地位对等，执行路径由 Agent 自主决定**。

```
编排思维（我们不做）：
  Orchestrator → "现在你去做 Step 2"

治理思维（我们的方向）：
  分区有目标 + 能力边界（工具 allow/deny 列表）
  分区自主决定：调用哪个工具、是否需要委派、委派给谁
  审计层事后验证：做了什么、为什么这样做（decisionBasis）
  硬底线在基础设施层：PII/金额/不可逆操作，基础设施拦截
```

#### 5. Shadow Mode 作为导入机制

所有调研框架都假设 Agent 一开始就有权限执行操作。我们的产品设计了三阶段导入：

```
观察期（Shadow Mode）：
  Executor 工具集 = 空（allow list = []）
  Communicator 仍与用户沟通，提出"如果我有权限，我会这样做"
  Human 标注 Agent 判断 vs 实际操作的差异 → 进入记忆

协同期：
  Executor 有有限工具集（只读 + 低风险写）
  高风险操作申请 Human Review
  审批通过后写入记忆（强化正确行为）

自主期：
  全工具集开放
  人类监督降低为抽样审计
```

这一机制不来自任何框架，是我们自己基于"新员工上岗"模型设计的。架构需要支持 Executor 工具集的动态调整（不是代码部署，是配置变更）。

#### 6. Context 重建而非快照

见第十七节修正版——Context 可从四要素重建，无需全量快照。这影响审计存储设计：我们不需要"context snapshot"字段，只需记录消息序列 + 注入状态的版本引用。

#### 7. 审计 PII：访问控制分层而非脱敏

审计日志**保留真实 PII**，因为监管机构要求"谁、对谁的数据、做了什么"——脱敏后的日志无法满足政府审计要求。

保护机制：
```
字段级加密（audit_events.tool_input 列）：
  AES-256-GCM，密钥存 Azure Key Vault

行级安全（PostgreSQL RLS）：
  基础审计：Compliance Officer 角色可读
  PII 字段：需要额外 PRIVACY_AUDITOR 角色
  解密：只有 GDPR/Privacy Act 调查情况下

Confidential Ledger：
  只存 contentHash（不含明文），Merkle Receipt 作法律证据
  即使 Ledger 被攻破，也无明文可读
```

---

### 18.3 分区类型映射

| 我们的分区 | 对应参考 | 关键差异 |
|-----------|---------|---------|
| **Communicator** | Spacebot Channel + 多入口扩展 | 处理 Teams/Email/Webhook 三类异步入口；不只是对话，也处理无人触发的事件 |
| **Executor** | Spacebot Worker + AutoForge MCP State Layer | 工具集 = Dataverse MCP + MS Graph；状态通过 MCP 读写，不直接访 DB |
| **Planner** | Spacebot Branch + OpenAI Agents asTool 语义 | 按需激活（非常驻）；结论通过 PendingResult 路径回传，不直接注入历史 |
| **HR Agent** | Spacebot Cortex | Memory Bulletin 生成；与 Spacebot Cortex 最相似 |
| **Auditor** | 无对应（独有） | Inboard 硬底线拦截 + Outboard 合规存档；是我们政府市场定位的核心差异化 |

**Compactor**：各分区内置，程序化三级阈值（80%/85%/95%），无需 LLM，参照 Spacebot Compactor 实现。

---

### 18.4 Feature 002 必须实现的

1. **Communicator/Executor 分离**：Communicator 不执行任务，只委派；Executor 无对话历史，只有任务描述
2. **WorkerState 状态机**：`Running → WaitingForInput → Running → Done/Failed`（源自 Spacebot Worker）
3. **Status Block 注入**：每轮 LLM 调用前重建 system prompt，包含活跃 Executor/Planner 状态（源自 Spacebot Status Block）
4. **outputType 结构化终止**：Zod schema 驱动退出，不靠"无工具调用=完成"的隐式判断（源自 OpenAI Agents JS）
5. **工具 allow/deny 列表**：分区能力边界治理（Shadow Mode 的技术基础）
6. **`content`/`details` 分离**：工具结果对 LLM 的文本表示 vs 结构化审计数据分离

### 18.5 Feature 003（记忆层）参考

- **Typed Memory**：8 类型，PostgreSQL（identity/goal/decision/todo/preference/fact/event/observation）— 源自 Spacebot
- **Hybrid Search**：Vector（pgvector）+ FTS（pg_trgm）+ RRF 融合 — 源自 Spacebot
- **Memory Bulletin**：HR Agent 定期生成，system prompt 注入 — 源自 Spacebot Cortex
- **Skill 作为知识资产**：Markdown 文档，版本控制，无注册表 — 源自 Symphony，语义扩展

### 18.6 Feature 004+（审计层）参考

- **双轨系统**：OTel（可观测性）+ Audit Events（合规），同一 Hook 点产生 — 源自报告 23
- **rootSessionId**：贯穿所有委派事件，单次 SQL 重建完整因果链
- **WORM + Confidential Ledger**：只存 contentHash + Merkle Receipt 作法律证据
- **工具级审计**：`tool.pre_use` / `tool.post_use` 满足 IRAP ISM-0114
- **PII 保护**：访问控制分层（RBAC + 字段级加密），不做脱敏
- **Context 重建**：通过消息序列 + 系统提示版本 + 记忆 ID 重建，无需全量快照

### 18.7 不采用的部分

| 来源 | 不采用的内容 | 原因 |
|------|------------|------|
| Spacebot | 个人偏好记忆、消息合并 | 面向个人用户场景，企业多租户不适用 |
| Spacebot | Circuit Breaker 阻断实现 | 源码当前为 observe_only，生产化后再参考 |
| Symphony | Elixir/BEAM 基础设施 | TypeScript 平台 |
| Claude Code Teams | 文件系统消息总线 | AKS 多节点不可用，替换为 Redis |
| Inngest | Inngest 平台依赖 | 引入外部云服务依赖，政府合规风险 |
| KaibanJS | Redux 状态机任务流转 | 编排思维，违反治理哲学 |
| AutoForge | 固定角色 pipeline（PM→Arch→QA） | 编排思维，违反治理哲学 |
| 所有框架 | 单一对话入口假设 | 我们需要支持 Teams/Email/Webhook 多源异步入口 |
