# Agent 审计日志与行为记录深度研究

> **研究日期**：2026-03-08
> **前置报告**：[20-audit-mechanisms.md](20-audit-mechanisms.md)（架构决策已定）、[03-government-ai-compliance.md](../../compliance/03-government-ai-compliance.md)（合规法规背景）
> **研究焦点**：本报告是报告 20 的深度补充，专注于六个之前未充分覆盖的领域：OTel Agent Spans 规范、WORM/Confidential Ledger 技术细节、行为回放与取证、现有实现参考、IRAP 具体审计要求、完整字段 Schema。

---

## 目录

1. [OpenTelemetry Agent Span 规范](#1-opentelemetry-agent-span-规范)
2. [不可篡改存储架构：WORM + Confidential Ledger](#2-不可篡改存储架构worm--confidential-ledger)
3. [行为回放与取证（Event Sourcing）](#3-行为回放与取证event-sourcing)
4. [现有实现参考分析](#4-现有实现参考分析)
5. [IRAP 与政府合规的具体审计要求](#5-irap-与政府合规的具体审计要求)
6. [完整审计记录 Schema 设计](#6-完整审计记录-schema-设计)
7. [结论与行动建议](#7-结论与行动建议)

---

## 1. OpenTelemetry Agent Span 规范

### 1.1 OTel GenAI Semantic Conventions（截至 2026-03）

OpenTelemetry 的 GenAI Semantic Conventions（`semconv/gen-ai`）在 2025 年进入 stable 状态，定义了 AI 系统的标准追踪属性。这是 Agent 审计与可观测性之间的桥梁——OTel Spans 用于实时监控，审计事件用于合规归档，两者互补而非替代。

**核心 Span 类型层次：**

```
Span: agent.session
  ├── Span: gen_ai.agent.invocation      ← 一次完整 Agent 激活
  │     ├── Span: gen_ai.chat             ← 一次 LLM 调用
  │     │     └── Event: gen_ai.choice   ← LLM 返回结果
  │     └── Span: gen_ai.tool.call       ← 工具调用
  │           └── Event: gen_ai.tool.result
  └── Span: gen_ai.agent.invocation      ← 下一轮激活
```

**关键属性（Stable）：**

```
# LLM 请求属性
gen_ai.system              = "anthropic" | "openai" | ...
gen_ai.request.model       = "claude-opus-4-5" | "claude-sonnet-4-6"
gen_ai.request.max_tokens  = 8192
gen_ai.request.temperature = 1.0
gen_ai.usage.input_tokens  = 12450
gen_ai.usage.output_tokens = 843
gen_ai.usage.total_tokens  = 13293

# 工具调用属性
gen_ai.tool.name           = "create_purchase_order"
gen_ai.tool.type           = "function"             ← function | mcp | retrieval

# Agent 属性（新增，experimental → stable 路径中）
gen_ai.agent.name          = "procurement-executor"
gen_ai.agent.description   = "Handles PO creation..."

# 多 Agent 追踪关键属性
gen_ai.agent.invocation_id = "inv_01HXYZ..."        ← 本次激活唯一 ID
gen_ai.thread.id           = "thread_01HABC..."     ← 同一对话线程
```

**Event 属性（OTel Log Events 挂载在 Span 上）：**

```
# gen_ai.system.message — 系统提示
gen_ai.event.content = "<system prompt content>"

# gen_ai.user.message — 用户输入
gen_ai.event.content = "<user message>"

# gen_ai.choice — LLM 输出
gen_ai.response.finish_reason = "tool_calls" | "end_turn" | "max_tokens"
gen_ai.response.id            = "msg_01XYZ..."
gen_ai.event.content          = "<assistant output>"

# gen_ai.tool.call — 工具调用参数（由 LLM 生成）
gen_ai.tool.call.id           = "toolu_01ABC..."
gen_ai.event.content          = '{"amount": 50000, "vendor_id": "V-123"}'

# gen_ai.tool.result — 工具返回值
gen_ai.tool.call.id           = "toolu_01ABC..."   ← 与调用 ID 对应
gen_ai.event.content          = '{"status": "created", "po_id": "PO-456"}'
```

### 1.2 OTel 与审计事件的关系

**OTel Span ≠ 审计记录**，两者有本质区别：

| 维度 | OTel Span | 审计事件 |
|------|-----------|---------|
| **目的** | 性能监控、调试、可观测性 | 合规归档、不可篡改记录 |
| **存储** | Jaeger/Tempo/Azure Monitor（可覆写） | WORM + Confidential Ledger（不可覆写） |
| **保留期** | 通常 30-90 天 | 7+ 年 |
| **完整性保证** | 无（采样、丢弃） | 密码学签名链 |
| **PII 处理** | 通常包含原始数据 | 必须脱敏 |
| **合规价值** | 技术调试 | 法律证据 |
| **采样** | 可采样（1%、10%） | 不可采样（100% 覆盖） |

**推荐做法**：两套并行，从同一 Hook 点产生两种输出：

```typescript
// PreToolUse Hook 内部：同时产生 OTel Span 和审计事件
const preToolUseHook = async (input: ToolInput, context: AgentContext) => {
  // 1. OTel Span（可观测性）
  const span = tracer.startSpan('gen_ai.tool.call', {
    attributes: {
      'gen_ai.tool.name': input.toolName,
      'gen_ai.tool.type': 'function',
      'gen_ai.agent.name': context.agentName,
      'gen_ai.thread.id': context.threadId,
    },
  });
  context.currentSpan = span; // 在 PostToolUse 中结束

  // 2. 审计事件（合规归档）— 100% 捕获，不采样
  await auditClient.emit({
    type: 'com.agentic.audit.tool.pre_use',
    auditId: input.toolUseId,
    toolName: input.toolName,
    inputHash: sha256(JSON.stringify(input.toolInput)),
    inputSanitized: presidio.sanitize(input.toolInput), // PII 脱敏
    otelTraceId: span.spanContext().traceId,    // 关联 OTel Trace
    otelSpanId: span.spanContext().spanId,
    ...context.auditBase,
  });
};
```

`otelTraceId` / `otelSpanId` 字段使审计记录与 OTel 追踪可互相关联——调查时可以从审计记录跳到 OTel Trace 查看完整性能数据。

### 1.3 LangSmith / LangFuse / Arize Phoenix 的审计数据模型

这些工具设计用于 LLM 开发调试，不满足政府合规审计要求，但其数据模型有参考价值：

**LangSmith Run Schema（核心字段）：**

```json
{
  "id": "uuid",
  "name": "ChatOpenAI",
  "run_type": "llm | chain | tool | retriever | prompt | parser | embedding",
  "inputs": { "messages": [...] },
  "outputs": { "generations": [...] },
  "error": null,
  "start_time": "2026-03-08T10:00:00Z",
  "end_time": "2026-03-08T10:00:03Z",
  "extra": {
    "metadata": {},
    "tags": [],
    "runtime": { "sdk": "langchain-python", "sdk_version": "0.3.x" }
  },
  "parent_run_id": "uuid",     // 因果链
  "session_id": "uuid",
  "total_tokens": 1243,
  "prompt_tokens": 800,
  "completion_tokens": 443
}
```

LangSmith 缺失的（对政府合规关键）：
- 不可篡改性：数据存在 LangChain 服务器，可被修改
- 无密码学签名
- 无 WORM 保证
- PII 以明文存储（违反数据主权要求）
- 无序列号/完整性验证

**结论**：LangSmith/LangFuse 适合开发期调试，不适合合规审计。Arize Phoenix 有更强的可解释性功能，但同样无合规级不可篡改性。我们的方案需要自建。

---

## 2. 不可篡改存储架构：WORM + Confidential Ledger

### 2.1 Azure Immutable Blob Storage（WORM）深度解析

**工作原理：**

Azure Immutable Blob Storage 实现了 WORM（Write Once Read Many）语义：数据写入后，在保留期内不能被修改或删除，即使是存储账户所有者也不能。

**两种不可变性策略：**

| 策略类型 | 机制 | 适用场景 |
|---------|------|---------|
| **Time-based Retention** | 设置最短保留期（如 7 年），期间内 blob 不可删改 | 合规归档（最常用） |
| **Legal Hold** | 无固定期限，显式解除前永久锁定 | 诉讼保全、监管调查 |

**Time-based Retention 的关键操作：**

```
1. 创建容器（Container）
2. 配置 Immutable Policy（时间锁）：
   PUT https://<storage>.blob.core.windows.net/<container>?comp=immutability-policy
   Body: { "immutabilityPeriodSinceCreationInDays": 2557 }  // 7年 = 2557天

3. 锁定 Policy（Locked 后无法缩短保留期，只能延长或等待到期）：
   POST .../immutability-policy?comp=lock

4. 写入数据：正常的 Blob 写操作
5. 尝试删除/修改：返回 409 Conflict（BlobImmutable）
```

**关键参数：**

- **Locked vs Unlocked**：Policy 在 Locked 前可以被删除（测试用）；Locked 后不可撤销，仅能延长期限
- **版本级别不可变性**（推荐）：启用 Blob Versioning 后，每个版本独立锁定；可以添加新版本（审计日志追加），但已有版本不可修改
- **容器级别不可变性**：整个容器的所有 Blob 适用同一策略；更简单但灵活性低

**合规认证**：Azure Immutable Blob Storage 通过了 SEC Rule 17a-4(f)、CFTC Rule 1.31(c)-(d)、FINRA Rule 4370 认证，满足金融监管对 WORM 的要求。对于 IRAP，Azure Australia East/Southeast 数据中心已通过 IRAP 评估，具体见下节。

**成本估算（审计日志场景）：**

```
假设：每个 Agent 每天产生 10,000 个审计事件，平均每条 2KB
每天写入量 = 10,000 × 2KB = 20MB/Agent/天
7年归档量 = 20MB × 365 × 7 ≈ 51GB/Agent

Azure Immutable Blob（LRS，Australia East）：
- 存储：≈$0.025/GB/月 × 51GB = $1.28/Agent/月
- 写入操作：10,000 ops/天 × $0.065/10,000 ≈ $0.065/Agent/天
- 读取：审计查询通常很少（合规场景），成本可忽略
总计 WORM 成本：~$3.25/Agent/月（含写入）
```

### 2.2 Azure Confidential Ledger 深度解析

**技术基础：**

Azure Confidential Ledger（ACL）基于 Microsoft Research 开发的 CCF（Confidential Consortium Framework），运行在 Intel SGX 可信执行环境（TEE）中。其核心保证：

1. **防篡改（Tamper-evident）**：每条记录产生一个 Merkle 树叶节点，整棵树的根哈希被所有节点共识维护
2. **防否认（Non-repudiation）**：写入后返回带有账本签名的回执（receipt），持有回执可向第三方证明该记录已存在
3. **机密计算（Confidential Computing）**：账本节点运行在 SGX Enclave 中，即使 Azure 工程师也无法访问明文数据

**写入流程：**

```typescript
// Azure Confidential Ledger SDK 写入示例（TypeScript）
import { ConfidentialLedgerClient } from "@azure/confidential-ledger";
import { DefaultAzureCredential } from "@azure/identity";

const client = new ConfidentialLedgerClient(
  "https://<ledger-id>.confidential-ledger.azure.com",
  new DefaultAzureCredential()
);

// 写入审计记录并获取 receipt
async function appendAuditRecord(event: AuditEvent): Promise<LedgerReceipt> {
  const entry = {
    contents: JSON.stringify({
      auditId: event.auditId,
      contentHash: sha256(JSON.stringify(event)), // 存哈希，不存明文
      sessionId: event.sessionId,
      tenantId: event.tenantId,
      eventType: event.type,
      timestamp: event.timestamp,
    }),
  };

  // 写入账本
  const poller = await client.beginCreateLedgerEntry(entry);
  const result = await poller.pollUntilDone();

  // 获取防篡改回执（receipt）— 这是法律证据的关键
  const receipt = await client.getLedgerEntry(result.transactionId);
  return receipt; // 存储到 PostgreSQL，便于查询
}

// 验证记录完整性（向监管机构证明）
async function verifyAuditRecord(
  transactionId: string,
  expectedHash: string
): Promise<boolean> {
  const entry = await client.getLedgerEntry(transactionId);
  const stored = JSON.parse(entry.contents);
  return stored.contentHash === expectedHash;
}
```

**Receipt 结构（是法律证据的核心）：**

```json
{
  "transactionId": "2.45",
  "receipt": {
    "cert": "<node certificate PEM>",
    "leaf": "<Merkle leaf hash>",
    "leafComponents": {
      "claimsDigest": "<hash of claims>",
      "commitEvidence": "<evidence of commit>",
      "writeSetDigest": "<hash of write set>"
    },
    "nodeId": "<node identifier>",
    "proof": ["<Merkle proof nodes>"],
    "signature": "<node signature over root>",
    "root": "<Merkle root hash>"
  }
}
```

**Receipt 验证原理**：持有 receipt 的任何人可以：
1. 用 `cert` 验证 `signature` 是由合法 CCF 节点签名
2. 用 `proof` 重新计算 Merkle 根，验证 `root` 正确
3. 用 `leaf` 验证特定记录在 Merkle 树中

这证明了"该记录在 timestamp T 时存在于账本中，且未被修改"——满足政府合规的法律证据要求。

**成本估算：**

```
Azure Confidential Ledger 定价（基于容量单元）：
- 计算：每小时按运行时间计费，~$0.40/小时（基础配置）
- 存储：~$0.25/GB/月
- 每月最低成本：~$290/月（固定计算成本，1个 ledger instance）

→ Confidential Ledger 是共享基础设施，按平台而非按 Agent 计费
→ 单租户每月 ledger 成本 ~$290，分摊到多个 Agent 后可忽略
→ 每条 ledger 记录的内容只存 hash（~200B），不存审计全文
   10,000 条/天/Agent × 365 × 7 = 25.5M 条记录，~5GB/Agent 存储
   但 ledger 记录极小，实际主要成本是计算（固定）
```

### 2.3 Service Bus → WORM 的数据流设计

```
Agent 进程
  │
  │ (1) 异步 emit（不阻塞工具执行，除 Strict Mode 外）
  ▼
Azure Service Bus Premium Tier
  ├── 消息持久化（写入 Service Bus 即为持久化，即使消费者宕机）
  ├── 消息锁定（处理中的消息不会丢失）
  ├── Dead Letter Queue（处理失败后的补偿路径）
  └── Session Support（同一 Session ID 的消息有序投递）
  │
  │ (2) Audit Service 消费（独立 AKS Pod，与 Agent 完全隔离）
  ▼
Audit Service（Consumer）
  ├── 验证 HMAC 签名（签名密钥在 Key Vault，Agent 无法访问）
  ├── 验证序列号连续性（检测丢失事件）
  ├── PII 二次扫描（Presidio，防止泄漏到长期存储）
  │
  ├── (3a) 写入 PostgreSQL（热存储，90天，实时查询）
  │         行级 Append-Only：INSERT only，禁止 UPDATE/DELETE
  │
  ├── (3b) 写入 Immutable Blob Storage（WORM，7年）
  │         按日期分区：auditlogs/2026/03/08/<sessionId>/<auditId>.json
  │
  └── (3c) 写入 Confidential Ledger（仅写哈希，永久）
            transactionId 存回 PostgreSQL，用于后续完整性验证
```

**关键设计决策**：

1. **三写是否并发**：建议顺序写入（PG → Blob → Ledger），失败时通过 Dead Letter Queue 补偿，而不是并发写（降低一致性问题）
2. **Ledger 只存哈希**：不存审计全文，避免将敏感数据（即使已脱敏）放入 TEE 处理链；哈希足以证明完整性
3. **Blob 存全量**：WORM Blob 存完整脱敏后的审计记录，是主归档；Ledger 仅作完整性证明
4. **PG 作查询入口**：Manager Dashboard 和合规报告都查 PG，不查 Blob/Ledger（PG 有 ledger transactionId 和 blob URL，可跳转验证）

---

## 3. 行为回放与取证（Event Sourcing）

### 3.1 事件溯源应用于 Agent 行为记录

Event Sourcing 模式（事件溯源）将系统状态表示为一系列不可变事件的序列。应用于 Agent 审计，意味着：

**传统日志思路（不够）：**
```
"Agent 在 10:05 创建了 PO-456，金额 $50,000"
→ 只记录结果，无法重建决策过程
```

**Event Sourcing 思路（正确）：**
```
Event 1: session_started      @ 10:00:00 → 触发：邮件 #E-789 "请批准供应商付款"
Event 2: reasoning_turn_start @ 10:00:01 → 模型读取上下文（含邮件内容、PO 历史）
Event 3: reasoning_turn_end   @ 10:00:04 → 决策：需要验证供应商资质
Event 4: tool_pre_use         @ 10:00:04 → 调用 search_vendor(vendor_id="V-123")
Event 5: tool_post_use        @ 10:00:05 → 返回：{vendor: "Acme", status: "approved", ...}
Event 6: reasoning_turn_start @ 10:00:05 → 模型分析供应商数据
Event 7: reasoning_turn_end   @ 10:00:08 → 决策：供应商合规，金额在授权范围内，创建 PO
Event 8: tool_pre_use         @ 10:00:08 → 调用 create_purchase_order({...})
Event 9: tool_post_use        @ 10:00:09 → 返回：{po_id: "PO-456", status: "created"}
Event 10: session_ended       @ 10:00:10 → 完成
```

通过重放这 10 个事件，审计员可以完全重建 Agent 的决策过程。

### 3.2 "Agent 看到了什么"的上下文快照

这是取证的关键难点：Agent 在决策时看到的上下文（context window 内容）与它执行的操作之间的关系。

**问题**：上下文窗口可达 200K tokens，如果全量存储，成本极高（每轮 ~50KB 脱敏后也要存）。

**解决方案：哈希 + 关键字段摘要**

```typescript
interface ReasoningTurnRecord {
  // 不存全量上下文，只存：
  contextHash: string;         // SHA-256(完整上下文)，用于完整性验证
  contextSummary: {
    messageCount: number;       // 上下文中的消息数
    toolResultsIncluded: string[]; // 本轮包含哪些工具的返回值（by name）
    injectedMemories: string[];    // 注入了哪些记忆 block（by key）
    tokenEstimate: number;         // 估算 token 数
  };
  // 对于高风险操作，才存完整的 sanitized 上下文
  fullContextSnapshot?: string;  // 仅高风险操作启用，脱敏后 gzip 压缩
  thinkingTokensSummary?: string; // Claude extended thinking 的摘要（不存原文）
}
```

**高风险操作的完整快照策略：**

- 触发条件：工具调用涉及金额 > 阈值、PII 写操作、删除类操作、审批类操作
- 存储：压缩后存 WORM Blob（大文件路径存在 PG 中）
- 保留：与主审计记录同期（7年）
- PII 处理：先 Presidio 脱敏，再 gzip 压缩，再存储

### 3.3 回放引擎设计

```typescript
class AgentReplayEngine {
  // 按 sessionId 重放完整会话
  async replaySession(sessionId: string): Promise<ReplayResult> {
    // 1. 从 PostgreSQL 获取该 session 的所有审计事件（按序列号排序）
    const events = await this.auditRepo.getEventsBySession(sessionId, {
      orderBy: 'auditseq ASC',
    });

    // 2. 验证序列号连续性（检测是否有事件丢失）
    const gaps = this.detectGaps(events);
    if (gaps.length > 0) {
      // 序列号不连续：触发告警，从 WORM Blob 尝试补全
      const missingEvents = await this.recoverFromWorm(sessionId, gaps);
      events.push(...missingEvents);
      events.sort((a, b) => a.auditseq - b.auditseq);
    }

    // 3. 验证每条记录的 Confidential Ledger 哈希
    for (const event of events) {
      if (event.ledgerTransactionId) {
        const valid = await this.ledger.verify(
          event.ledgerTransactionId,
          event.contentHash
        );
        if (!valid) throw new TamperDetectedError(event.auditId);
      }
    }

    // 4. 构建时间线视图
    const timeline = this.buildTimeline(events);

    return {
      sessionId,
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      eventCount: events.length,
      gaps: gaps,           // 如有间隙，列出（可能代表 bypass 尝试）
      timeline,
      integrityVerified: true,
    };
  }

  // 重建 Agent 在特定时间点"看到的"上下文
  async reconstructContextAt(sessionId: string, auditSeq: number): Promise<ContextSnapshot> {
    const events = await this.auditRepo.getEventsBySession(sessionId, {
      where: { auditseq: { lte: auditSeq } },
    });

    // 找到最近一次 reasoning_turn_start 事件（含上下文快照）
    const lastTurnStart = events
      .filter(e => e.type === 'com.agentic.audit.reasoning.turn_start')
      .slice(-1)[0];

    if (lastTurnStart?.fullContextSnapshot) {
      return {
        source: 'full_snapshot',
        content: decompress(lastTurnStart.fullContextSnapshot),
      };
    }

    // 如果没有完整快照，通过事件重建近似上下文
    return {
      source: 'reconstructed',
      toolResultsAvailable: this.extractToolResults(events),
      decisionChain: this.extractDecisionChain(events),
      note: 'Full context not snapshotted for this operation type',
    };
  }

  // 对比"计划做什么"vs"实际做了什么"
  async analyzePlanActualDiff(sessionId: string): Promise<PlanActualAnalysis> {
    const events = await this.auditRepo.getEventsBySession(sessionId);

    // 从 reasoning_turn_end 提取"计划"（Agent 的推理结论）
    const plannedActions = events
      .filter(e => e.type === 'com.agentic.audit.reasoning.turn_end')
      .map(e => e.data.plannedNextAction); // 需要在推理结束时记录计划

    // 从 tool_pre_use 提取"实际执行"
    const actualActions = events
      .filter(e => e.type === 'com.agentic.audit.tool.pre_use')
      .map(e => ({ tool: e.data.toolName, input: e.data.toolInputSanitized }));

    return {
      planned: plannedActions,
      actual: actualActions,
      divergences: this.findDivergences(plannedActions, actualActions),
    };
  }
}
```

### 3.4 跨 Session 的行为模式分析

单 Session 取证是第一步，跨 Session 分析是第二步（Manager Dashboard 的核心功能）：

```sql
-- 检测异常行为模式（PostgreSQL 查询示例）
-- 例：某 Agent 在非工作时间的高频工具调用
SELECT
  agent_id,
  DATE_TRUNC('hour', timestamp) AS hour,
  COUNT(*) AS tool_call_count,
  COUNT(DISTINCT tool_name) AS unique_tools,
  SUM(CASE WHEN success = false THEN 1 ELSE 0 END) AS failure_count
FROM audit_tool_invocations
WHERE
  timestamp >= NOW() - INTERVAL '30 days'
  AND EXTRACT(HOUR FROM timestamp) NOT BETWEEN 8 AND 18  -- 非工作时间
  AND EXTRACT(DOW FROM timestamp) NOT IN (0, 6)          -- 非周末
GROUP BY agent_id, hour
HAVING COUNT(*) > 100  -- 异常高频
ORDER BY tool_call_count DESC;

-- 检测金额异常
SELECT
  session_id,
  SUM((tool_input_sanitized->>'amount')::numeric) AS total_amount_in_session
FROM audit_tool_invocations
WHERE tool_name IN ('create_purchase_order', 'approve_payment', 'create_invoice')
GROUP BY session_id
HAVING SUM((tool_input_sanitized->>'amount')::numeric) > 100000  -- 超过单次授权上限
ORDER BY total_amount_in_session DESC;
```

---

## 4. 现有实现参考分析

### 4.1 LangFuse 的审计数据模型（详细）

LangFuse 是目前数据模型设计最完整的 LLM 可观测性平台，其 Trace/Span 体系对我们的设计有参考价值：

**LangFuse 核心实体：**

```
Trace（顶层会话）
  └── observations[]（观察，多态）
        ├── Span（任意过程，有 startTime/endTime）
        ├── Generation（LLM 调用，含 model、usage、cost）
        └── Event（离散事件，只有 startTime）
```

**Generation（LLM 调用）的字段：**

```typescript
{
  id: string,
  traceId: string,
  parentObservationId: string | null,  // 因果链
  name: string,
  startTime: Date,
  endTime: Date,
  model: string,                         // "claude-opus-4-5"
  modelParameters: {
    temperature: number,
    max_tokens: number,
    top_p: number,
  },
  input: { messages: [...] },            // 输入的完整消息（含 system prompt）
  output: { text: string, ... },         // 模型输出
  usage: {
    input: number,
    output: number,
    total: number,
    unit: "TOKENS",
    inputCost: number,                   // 美元成本
    outputCost: number,
    totalCost: number,
  },
  metadata: Record<string, unknown>,
  level: "DEFAULT" | "DEBUG" | "WARNING" | "ERROR",
  statusMessage: string | null,
}
```

**关键差异**：LangFuse 存原始 input/output（含 PII），没有脱敏机制，不适合政府场景。

### 4.2 Symphony 的 Proof of Work 机制

Symphony（工作管理 AI Agent）引入了 "Proof of Work" 概念来证明 Agent 的工作成果。其核心思路：

**Proof of Work 结构（根据公开文档推断）：**

```
每项完成的 Task 携带：
- 执行步骤记录（steps taken）
- 引用的信息源（information sources used）
- 决策理由（why this action was taken）
- 输出物的可验证性（output can be verified against source）
```

Symphony 的方法论对我们有一个重要启示：**审计记录不只是"做了什么"，还要记录"为什么认为这是正确的"**。这要求在每个 reasoning_turn_end 事件中记录 Agent 的判断依据（引用了哪些记忆、哪些工具返回值、哪些上下文）。

**我们的对应设计**：在 `reasoning_turn_end` 事件中加入 `decisionBasis` 字段：

```typescript
interface ReasoningTurnEnd {
  type: 'com.agentic.audit.reasoning.turn_end';
  data: {
    turnNumber: number;
    plannedNextAction: string;      // Agent 计划下一步做什么（自然语言摘要）
    decisionBasis: {
      toolResultsReferenced: string[];   // 引用了哪些工具的返回值
      memoriesReferenced: string[];      // 引用了哪些记忆 block
      thinkingTokensUsed: boolean;       // 是否使用了 extended thinking
      confidenceIndicator: 'high' | 'medium' | 'low' | 'escalation_needed';
    };
  };
}
```

### 4.3 OpenClaw 的现有审计能力

基于报告 19（OpenClaw 生态深度研究）的结论：

- OpenClaw 的 `src/hooks/` 目录提供 Plugin System，是 Inboard 机制，用于功能扩展，不是审计工具
- ClawHub 上有简单的 file-based logging Skill，但不满足合规要求
- **最有价值的参考**：OpenClaw 的 Gateway 架构——所有消息经过单一 Gateway，天然的 Inboard tap 点
- OpenClaw 没有 WORM、Confidential Ledger 或序列号完整性验证

**我们从 OpenClaw 借鉴的**：Gateway 作为消息级 tap 点，补充工具级 hook。不使用 OpenClaw 的任何 audit Skill。

### 4.4 有严肃审计/合规功能的开源框架

目前没有开源 Agent 框架具备政府级审计能力，但有几个相关的组件：

**Microsoft Presidio（PII 检测与脱敏）**

```python
# 在存储审计记录前脱敏 PII
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine

analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

def sanitize_for_audit(text: str, language: str = "en") -> str:
    results = analyzer.analyze(text=text, language=language)
    anonymized = anonymizer.anonymize(text=text, analyzer_results=results)
    return anonymized.text

# 示例：
# 输入: "Please pay $50,000 to John Smith (john@acme.com)"
# 输出: "Please pay $50,000 to <PERSON> (<EMAIL_ADDRESS>)"
```

Presidio 支持的 PII 类型：PERSON, PHONE_NUMBER, EMAIL_ADDRESS, CREDIT_CARD, IBAN_CODE, IP_ADDRESS, NRP (Australian ABN/TFN 等国家特定类型)

**Apache Kafka vs Azure Service Bus（事件总线选择）**

| 维度 | Kafka | Azure Service Bus Premium |
|------|-------|--------------------------|
| **消息顺序** | Partition 内有序（需要配置） | Session 内严格有序（原生） |
| **消息保证** | At-least-once（默认） | At-least-once（可配置 exactly-once） |
| **保留期** | 可配置（几乎无限） | 最长 14 天（之后需归档） |
| **Azure 集成** | 需要 Confluent Cloud 或自建 | 原生 Azure，与 Key Vault/Managed Identity 无缝 |
| **运维复杂度** | 高（需要管理 brokers、replication） | 低（全托管） |
| **死信队列** | 需要自建 | 原生 DLQ |
| **IRAP 合规** | 取决于部署 | Azure Australia East IRAP 认证 |

**结论**：Azure Service Bus Premium 是政府/IRAP 场景的明确选择，无需引入 Kafka 的运维复杂度。

---

## 5. IRAP 与政府合规的具体审计要求

### 5.1 澳大利亚 ISM（Information Security Manual）审计要求

澳大利亚 ISM（由 ACSC 维护，是 IRAP 评估的依据文件）对审计日志的要求：

**事件日志控制（ISM 章节 16 — Guidelines for System Monitoring）：**

| ISM 控制 ID | 要求 | 对我们的影响 |
|------------|------|------------|
| **ISM-0582** | 应记录事件：账户创建/修改/删除 | 虚拟员工的 Entra Agent ID 操作必须记录 |
| **ISM-0109** | 应记录事件：特权账户使用（创建/删除/修改） | Agent 使用 Service Principal 的每次操作 |
| **ISM-0111** | 应记录事件：系统配置变更 | 工具注册、Skill 配置变更 |
| **ISM-0113** | 应记录事件：访问控制失败 | Agent 权限不足的工具调用尝试 |
| **ISM-0114** | 应记录事件：所有访问到敏感数据的事件 | 读取 PROTECTED 级别数据 |
| **ISM-1405** | 日志服务器时钟与可信时源同步（NTP） | 所有 audit 事件时间戳使用 Azure 时间服务 |
| **ISM-0988** | 日志保留期：至少 7 年（PROTECTED 系统） | WORM Blob 锁定 2557 天（7年） |
| **ISM-1228** | 日志不可被修改或删除（直至保留期满） | WORM + Immutable Policy Locked |
| **ISM-0109** | 日志访问受控（独立于被审计系统） | Audit Service 有独立 Managed Identity |

**PROTECTED 级别的额外要求：**

- 日志必须存储在澳大利亚境内（Australia East 或 Australia Southeast）
- 日志加密必须使用 AES-256（Azure Blob 默认加密满足）
- 解密密钥必须由政府机构或其授权方控制（使用 Customer-Managed Key，CMK）
- 审计系统本身需要通过 IRAP 评估

**ISM 对"完整审计链"的理解：**

ISM 并没有明确要求"Agent 的推理链"，但要求"所有对受保护数据的访问"和"所有特权操作"可被追溯。对于 AI Agent：
- 每次读取 Dataverse 数据 = 数据访问事件（必须记录）
- 每次写入/修改 Dataverse 数据 = 特权操作（必须记录 + 批准链）
- 每次 API 调用（如 Graph API）= 外部系统访问（必须记录）

**这意味着工具级审计（而非 session 级审计）是 IRAP 合规的必要条件。**

### 5.2 IRAP PROTECTED 场景的架构约束

```
[IRAP PROTECTED 合规要求]
                │
                ├── 数据驻留澳大利亚
                │     → Audit Service 部署在 Azure Australia East
                │     → WORM Blob 在 Australia East（ZRS，跨区域冗余）
                │     → Confidential Ledger 在 Australia East
                │     → Service Bus Premium 在 Australia East
                │
                ├── 静态加密
                │     → Blob Storage CMK（Customer-Managed Key）
                │     → 密钥在 Azure Key Vault（Australia East）
                │     → Key Vault 使用 HSM 级别（Premium SKU）
                │
                ├── 传输加密
                │     → TLS 1.3（Service Bus、Blob、Ledger 均原生支持）
                │
                ├── 访问控制
                │     → Audit Service：独立 Managed Identity
                │     → WORM Blob：只写权限（Storage Blob Data Contributor，无 Delete）
                │     → Confidential Ledger：只写权限（Contributor）
                │     → PostgreSQL：行级插入权限，无 UPDATE/DELETE
                │
                └── 网络隔离
                      → Audit Service 在 AKS Private Cluster
                      → Service Bus 使用 Private Endpoint
                      → Blob Storage 使用 Private Endpoint
                      → 无公网入站（所有流量经 Private Link）
```

### 5.3 澳大利亚 Privacy Act 自动化决策透明义务（2026-12 生效）

Privacy Act 修正案要求披露"完全由计算机程序作出的决策"。对我们的具体含义：

**什么需要记录以支持透明义务：**

```typescript
interface AutomatedDecisionRecord {
  // 被 Privacy Act 要求披露的内容
  decisionType: string;         // "purchase_order_approval" | "invoice_processing" | ...
  basisForDecision: string;     // 非技术语言描述（给人类看）
  dataTypesUsed: string[];      // 用了哪些类型的个人信息（不是具体数据）
  wasFullyAutomated: boolean;   // true = 完全自动，false = 人类参与
  humanReviewAvailable: boolean; // 是否可以申请人类复查
  appealPath: string;            // 如何对结果提出异议
}
```

**实现建议**：每个 session 结束时生成一份 `AutomatedDecisionSummary`，与审计事件关联，用于响应数据主体的查询请求（Right of Access）。

### 5.4 政府 AI 合规的"新员工模型"文档要求

我们确定的合规定位是"新员工模型"——AI Agent 像新员工一样，有记录可追溯，但不承诺零错误。对应的文档要求：

| 文档 | 对应人类员工 | AI Agent 对应 |
|------|------------|-------------|
| 入职记录 | 入职日期、岗位、授权 | Agent 首次激活记录，Entra Agent ID 创建时间，初始 Skill 集 |
| 工作授权 | 职位描述、审批权限 | System Prompt 版本、Skill 白名单、权限配置（版本化 + 签名） |
| 操作记录 | 每日工作日志 | Session-level 审计摘要（每天生成）|
| 错误记录 | 工作失误报告 | tool_blocked + compliance_violation 事件聚合报告 |
| 绩效评估 | 年度评估 | 月度：任务完成率、升级率、错误率、人类纠正次数 |
| 离职记录 | 权限撤销、资产归还 | Agent 停用：Session 终止、Skill 撤销、密钥吊销 |

---

## 6. 完整审计记录 Schema 设计

### 6.1 基础事件结构（所有事件类型共用）

```typescript
// 所有审计事件的基础字段
interface AuditEventBase {
  // ── 标识字段 ──────────────────────────────────────
  specversion: '1.0';                    // CloudEvents 版本
  id: string;                            // UUID v7（时间有序，如 01HXYZ...）
  source: string;                        // urn:agentic:tenant:{tid}:agent:{aid}
  type: AuditEventType;                  // 见下方 AuditEventType

  // ── 时间字段 ──────────────────────────────────────
  time: string;                          // ISO 8601，UTC，精确到毫秒
  // 注：使用 Azure Time Service（NTP），满足 ISM-1405

  // ── 会话与追踪字段 ─────────────────────────────────
  auditId: string;                       // 本事件唯一 ID（= id）
  sessionId: string;                     // 会话 ID（同一激活链的所有事件相同）
  tenantId: string;                      // 租户 ID（用于多租户隔离）
  virtualEmployeeId: string;             // 虚拟员工的 Entra Agent ID

  // ── 因果链字段 ─────────────────────────────────────
  parentAuditId?: string;                // 触发本事件的父事件 ID（跨 Agent 追踪）
  rootSessionId: string;                 // 根会话 ID（多 Agent 委派时，追溯到用户触发的原始 session）
  cognitivePartition: string;            // 'planner' | 'executor' | 'analyst' | 'communicator'
  delegatedFrom?: string;               // 委派来源（如果是被其他分区激活）

  // ── 顺序保证字段 ───────────────────────────────────
  auditSeq: number;                      // 全局单调递增序列号（per sessionId）
  // 连续性验证：Audit Service 检测 gap

  // ── 完整性字段 ─────────────────────────────────────
  contentHash: string;                   // SHA-256(序列化后的 data 字段)
  signature: string;                     // HMAC-SHA256(auditId + contentHash + auditSeq)
  // 签名密钥在 Key Vault，Agent 进程无直接访问权
  signingKeyVersion: string;             // Key Vault 密钥版本（支持密钥轮换后的历史验证）

  // ── OTel 关联字段 ──────────────────────────────────
  otelTraceId?: string;                  // OpenTelemetry Trace ID（关联可观测性）
  otelSpanId?: string;                   // OpenTelemetry Span ID

  // ── 环境字段 ──────────────────────────────────────
  environment: 'production' | 'staging'; // 防止测试数据混入合规存储
  deploymentRegion: string;              // 'australiaeast' | 'australiasoutheast'
  agentVersion: string;                  // Agent 代码版本（Git commit SHA）
  systemPromptVersion: string;           // System Prompt 版本哈希（用于追踪配置变更）
}
```

### 6.2 各事件类型的完整字段

**Session 生命周期事件：**

```typescript
// com.agentic.audit.session.start
interface SessionStartEvent extends AuditEventBase {
  type: 'com.agentic.audit.session.start';
  data: {
    triggerSource: 'teams_dm' | 'teams_channel' | 'email' | 'platform_event' | 'scheduled';
    triggerEventId: string;           // 触发事件的原始 ID（如邮件 ID、Teams 消息 ID）
    triggerContentHash: string;       // SHA-256(触发事件内容)，不存明文
    triggerContentSanitized?: string; // 脱敏后的触发内容摘要（可选，视敏感度）
    assignedSkills: string[];         // 本 Session 激活的 Skill 列表
    modelId: string;                  // 初始模型（如 claude-opus-4-5）
    systemPromptHash: string;         // SHA-256(system prompt)
    initialMemoryKeys: string[];      // 注入了哪些记忆 key（不存内容）
    estimatedComplexity: 'simple' | 'medium' | 'complex'; // 触发时的复杂度预判
  };
}

// com.agentic.audit.session.end
interface SessionEndEvent extends AuditEventBase {
  type: 'com.agentic.audit.session.end';
  data: {
    completionStatus: 'completed' | 'escalated' | 'failed' | 'timeout' | 'cancelled';
    totalTurns: number;
    totalToolCalls: number;
    totalTokensUsed: { input: number; output: number; cacheHit?: number };
    totalDurationMs: number;
    totalCostUsd?: number;            // 成本追踪（可选，用于 COGS 精算）
    toolsUsed: string[];              // 使用过的工具名称列表
    hardLimitsTriggered: number;      // 被硬底线阻断的操作次数
    escalationReason?: string;        // 如果是 escalated，原因摘要
    outputDelivered: boolean;         // 是否成功向用户发送了响应
  };
}

// com.agentic.audit.session.compaction（仅 pi-mono 方案，无 Server-side compaction）
interface SessionCompactionEvent extends AuditEventBase {
  type: 'com.agentic.audit.session.compaction';
  data: {
    compactionReason: 'context_window_limit' | 'manual';
    messagesBeforeCompaction: number;
    messagesAfterCompaction: number;
    fullTranscriptBlobUrl?: string;   // compaction 前的完整对话存到 WORM Blob
    compactionSummaryHash: string;    // SHA-256(compaction 摘要文本)
  };
}
```

**工具调用事件：**

```typescript
// com.agentic.audit.tool.pre_use
interface ToolPreUseEvent extends AuditEventBase {
  type: 'com.agentic.audit.tool.pre_use';
  data: {
    toolName: string;                 // 工具名称
    toolVersion: string;              // 工具版本（MCP Server 版本）
    toolCategory: 'read' | 'write' | 'delete' | 'communicate' | 'search';
    riskLevel: 'low' | 'medium' | 'high' | 'critical'; // 工具的风险分级（静态配置）
    toolUseId: string;                // SDK 提供的工具调用唯一 ID（与 PostToolUse 关联）
    inputHash: string;                // SHA-256(JSON.stringify(toolInput))
    inputSanitized: unknown;          // 经 Presidio 脱敏后的输入（结构与原始相同，PII 替换）
    piiDetected: boolean;             // 是否检测到 PII（true 时 input 被脱敏）
    piiTypes?: string[];              // 检测到的 PII 类型列表（PERSON, EMAIL 等）
    hardLimitChecks: {
      amountLimitCheck?: { limit: number; actual: number; passed: boolean };
      dangerousCommandCheck?: { matched: boolean; pattern?: string };
      prohibitedOperationCheck?: { matched: boolean; operation?: string };
    };
    complianceChecksPassed: boolean;  // 所有硬底线检查是否通过
  };
}

// com.agentic.audit.tool.post_use
interface ToolPostUseEvent extends AuditEventBase {
  type: 'com.agentic.audit.tool.post_use';
  data: {
    toolName: string;
    toolUseId: string;                // 与 pre_use 对应
    success: boolean;
    errorCode?: string;               // 标准化错误码（如 PERMISSION_DENIED, TIMEOUT）
    errorMessage?: string;            // 脱敏后的错误消息
    outputHash?: string;              // SHA-256(JSON.stringify(toolOutput))，仅 success=true
    outputSanitized?: unknown;        // 脱敏后的输出摘要（仅关键字段，不存全量）
    outputPiiDetected?: boolean;
    durationMs: number;
    // 针对特定工具类型的额外字段
    resourceAffected?: {              // 写操作时记录受影响的资源
      type: string;                   // "dataverse_record" | "email" | "teams_message"
      id: string;                     // 资源 ID（如 PO-456）
      operation: 'created' | 'updated' | 'deleted' | 'sent';
    };
  };
}

// com.agentic.audit.tool.blocked（被硬底线阻断，不是 error）
interface ToolBlockedEvent extends AuditEventBase {
  type: 'com.agentic.audit.tool.blocked';
  data: {
    toolName: string;
    toolUseId: string;
    blockReason: 'amount_limit' | 'pii_protection' | 'prohibited_operation' | 'audit_unavailable' | 'permission_denied';
    blockDetails: string;             // 阻断原因的非敏感描述
    inputHash: string;
    escalationTriggered: boolean;     // 是否触发人工升级
  };
}
```

**推理事件：**

```typescript
// com.agentic.audit.reasoning.turn_start
interface ReasoningTurnStartEvent extends AuditEventBase {
  type: 'com.agentic.audit.reasoning.turn_start';
  data: {
    turnNumber: number;               // 本 session 的第几轮推理
    modelId: string;                  // 实际使用的模型（可能与 session 初始不同）
    contextHash: string;              // SHA-256(序列化后的上下文)
    contextMessageCount: number;
    contextTokenEstimate: number;
    toolResultsIncluded: string[];    // 本轮上下文包含了哪些工具的返回值
    memoriesInjected: string[];       // 注入了哪些记忆 key
    steeringMessagesActive: boolean;  // 是否有 steering messages（如审计告警注入）
    // 高风险操作时记录完整上下文快照
    fullContextSnapshotBlobUrl?: string; // WORM Blob URL（仅高风险操作）
    fullContextSnapshotHash?: string;    // 完整快照的哈希
  };
}

// com.agentic.audit.reasoning.turn_end
interface ReasoningTurnEndEvent extends AuditEventBase {
  type: 'com.agentic.audit.reasoning.turn_end';
  data: {
    turnNumber: number;
    durationMs: number;
    tokenUsage: { input: number; output: number; cacheHit?: number; thinking?: number };
    finishReason: 'tool_calls' | 'end_turn' | 'max_tokens' | 'stop_sequence';
    plannedNextAction: string;        // Agent 本轮推理后计划的下一步（自然语言，LLM 输出摘要）
    decisionBasis: {
      toolResultsReferenced: string[];
      memoriesReferenced: string[];
      externalContextSources: string[];
      thinkingTokensUsed: boolean;
      confidenceIndicator: 'high' | 'medium' | 'low' | 'escalation_needed';
    };
    outputContentHash: string;        // SHA-256(LLM 的完整输出)
    thinkingContentHash?: string;     // SHA-256(extended thinking 内容)，如使用 extended thinking
  };
}
```

**合规事件：**

```typescript
// com.agentic.audit.compliance.violation
interface ComplianceViolationEvent extends AuditEventBase {
  type: 'com.agentic.audit.compliance.violation';
  data: {
    violationType: 'hard_limit_breach' | 'pii_exposure' | 'unauthorized_access' | 'prompt_injection_suspected';
    severity: 'low' | 'medium' | 'high' | 'critical';
    detectedAt: 'pre_tool_use' | 'post_tool_use' | 'gateway';
    relatedAuditId: string;           // 触发此违规事件的审计事件 ID
    description: string;              // 非技术性的违规描述（给 Manager Dashboard）
    actionTaken: 'blocked' | 'allowed_with_warning' | 'escalated';
    escalationId?: string;            // 如果升级，升级工单 ID
  };
}

// com.agentic.audit.compliance.escalation（人工干预记录）
interface ComplianceEscalationEvent extends AuditEventBase {
  type: 'com.agentic.audit.compliance.escalation';
  data: {
    escalationReason: string;
    escalatedTo: string;              // 被分配给哪个人类审阅者（用户 ID，不是姓名）
    escalatedAt: string;              // 升级时间
    humanDecision?: 'approved' | 'rejected' | 'modified';
    humanRespondedAt?: string;
    humanResponderId?: string;
    responseTimeMs?: number;
    humanModificationHash?: string;   // 如果 modified，修改后内容的哈希
  };
}
```

### 6.3 数据保留策略

```
事件类型                    热存储（PG）    冷存储（WORM）    完整性（Ledger）
────────────────────────────────────────────────────────────────────────────
session.start/end           90天           7年             永久
tool.pre_use               90天           7年             永久
tool.post_use              90天           7年             永久
tool.blocked               90天           7年             永久（重要！合规证据）
reasoning.turn_start       90天           7年             仅高风险 session
reasoning.turn_end         90天           7年             仅高风险 session
compliance.violation       180天          永久            永久
compliance.escalation      180天          永久            永久
session.compaction         90天           7年             否（内容已在 blob 中）
full_context_snapshot      N/A（不存PG）  7年             否（内容太大）
────────────────────────────────────────────────────────────────────────────
Ledger 写入策略：每条工具调用事件写入 Ledger；推理事件仅高风险 session 写入
（降低 Ledger API 调用量，专注于有法律价值的记录）
```

### 6.4 多 Agent 因果链追踪

当 Planner 分区将任务委派给 Executor 分区时，因果链追踪通过以下字段实现：

```
Planner Session
  sessionId: "sess_AAAA"
  rootSessionId: "sess_AAAA"  ← 根会话就是自身

  ↓ 委派任务给 Executor

Executor Session
  sessionId: "sess_BBBB"       ← 新会话
  rootSessionId: "sess_AAAA"   ← 追溯到根会话
  parentAuditId: "evt_1234"    ← 具体是哪个 Planner 事件触发了委派
  delegatedFrom: "planner"     ← 来自哪个分区

  Executor 内的工具调用
    parentAuditId: "evt_5678"  ← 该分区内具体哪个 reasoning_turn_end 触发了工具调用
    rootSessionId: "sess_AAAA" ← 依然追溯到用户触发的根会话
```

**查询整个委派链：**

```sql
-- 找出根会话 sess_AAAA 涉及的所有审计事件（跨多个子会话）
SELECT *
FROM audit_events
WHERE root_session_id = 'sess_AAAA'
ORDER BY time ASC, audit_seq ASC;

-- 这一个查询可以重建完整的多 Agent 决策链
```

---

## 7. 结论与行动建议

### 7.1 本报告补充了报告 20 的哪些内容

| 领域 | 报告 20 | 本报告（23） |
|------|---------|------------|
| Inboard/Outboard 架构 | ✅ 完整 | 参考 |
| pi-mono vs Claude SDK hooks | ✅ 完整 | 参考 |
| OTel GenAI Semantic Conventions | ❌ 未覆盖 | ✅ 第 1 节 |
| OTel 与 Audit 的关系/并行方案 | ❌ 未覆盖 | ✅ 第 1.2 节 |
| WORM 技术细节 + 成本 | 概念 | ✅ 第 2.1 节 |
| Confidential Ledger 技术细节 + Receipt | 概念 | ✅ 第 2.2 节 |
| Service Bus → WORM 数据流详细设计 | 高层 | ✅ 第 2.3 节 |
| Event Sourcing 回放引擎 | ❌ 未覆盖 | ✅ 第 3 节 |
| "Agent 看到了什么"上下文快照策略 | ❌ 未覆盖 | ✅ 第 3.2 节 |
| LangFuse/LangSmith schema 参考 | ❌ 未覆盖 | ✅ 第 4.1 节 |
| Symphony Proof of Work 启示 | ❌ 未覆盖 | ✅ 第 4.2 节 |
| ISM 具体控制 ID 映射 | ❌ 未覆盖 | ✅ 第 5.1 节 |
| IRAP PROTECTED 架构约束图 | 概念 | ✅ 第 5.2 节 |
| Privacy Act 自动化决策透明义务 | 法规层面 | ✅ 实现层面 第 5.3 节 |
| 新员工模型文档对照表 | ❌ 未覆盖 | ✅ 第 5.4 节 |
| 完整 TypeScript AuditEvent Schema | 部分 | ✅ 第 6 节（完整） |
| 数据保留策略表格 | ❌ 未覆盖 | ✅ 第 6.3 节 |
| 多 Agent 因果链追踪 SQL | 概念 | ✅ 第 6.4 节 |

### 7.2 需要提炼到 docs/08-platform-integration.md 的结论

以下新结论应合并到 `docs/08-platform-integration.md` 的"审计追踪架构"章节：

1. **OTel 与 Audit 并行**：从同一 Hook 点产生两种输出；OTel Span 含 `otelTraceId`/`otelSpanId` 与审计记录双向关联
2. **Ledger 只存哈希**：不存明文或脱敏数据，只存 `contentHash`（SHA-256），避免敏感数据进入 TEE 处理链
3. **WORM 使用 Version-level Immutability**：启用 Blob Versioning + Time-based Retention Locked；仅追加，不修改已有版本
4. **IRAP PROTECTED 要求 CMK**：密钥在 Key Vault HSM（Australia East），Blob Storage 使用 Customer-Managed Key
5. **Ledger Receipt 是法律证据**：每条工具调用事件写入 Ledger 后，Receipt 存回 PostgreSQL；调查时可用 Receipt 向监管机构证明记录未被篡改
6. **`rootSessionId` 字段**：所有审计事件携带，实现跨 Agent 委派链的单次 SQL 查询重建
7. **高风险操作完整上下文快照**：触发条件为金额超阈值/PII 写操作/删除操作；脱敏 + gzip 后存 WORM Blob；路径存 PostgreSQL

### 7.3 开放问题（需后续决策）

1. **`planning_next_action` 字段的来源**：要记录"Agent 计划做什么"，需要在 reasoning_turn_end 时从 LLM 输出中提取。是让 LLM 输出结构化 JSON（有输出格式约束，影响自然度），还是在 Hook 中用小模型对 LLM 输出做摘要（增加成本）？建议：用小模型（Haiku）对 Sonnet/Opus 的输出做单句摘要，成本极低（输出通常 <1000 token）

2. **Confidential Ledger 的 Quorum 设置**：ACL 默认单节点部署；PROTECTED 级别可能需要多节点（3-node quorum），成本 3x。待 IRAP assessor 确认最低要求

3. **Presidio 澳大利亚特定 PII 类型覆盖**：需确认 Presidio 是否原生支持 ABN（Australian Business Number）和 TFN（Tax File Number）识别；如不支持，需添加自定义 recognizer

4. **PostgreSQL 的 Append-Only 强制**：单纯依靠应用层禁止 UPDATE/DELETE 不够强；可以考虑 PostgreSQL Row-Level Security (RLS) + 只有 INSERT 权限的 DB 用户；或使用 TimescaleDB 的 Chunks（历史 chunk 自动变为只读）

---

## 参考资料

- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Azure Immutable Blob Storage — WORM](https://learn.microsoft.com/azure/storage/blobs/immutable-storage-overview)
- [Azure Confidential Ledger — Overview](https://learn.microsoft.com/azure/confidential-ledger/overview)
- [Azure Confidential Ledger — SDK](https://learn.microsoft.com/azure/confidential-ledger/quickstart-python)
- [CCF — Confidential Consortium Framework](https://microsoft.github.io/CCF/)
- [Microsoft Presidio — PII Detection](https://microsoft.github.io/presidio/)
- [LangFuse Tracing SDK Reference](https://langfuse.com/docs/sdk/typescript/guide)
- [ISM — Information Security Manual (ACSC 2026)](https://www.cyber.gov.au/resources-business-and-government/essential-cyber-security/ism)
- [ISM Chapter 16: Guidelines for System Monitoring](https://www.cyber.gov.au/ism/guidelines-for-system-monitoring)
- [Privacy Act 1988 — Automated Decision Transparency (Dec 2026)](https://www.legislation.gov.au/Series/C2004A03712)
- [Azure Service Bus Premium Messaging](https://learn.microsoft.com/azure/service-bus-messaging/service-bus-premium-messaging)
- [NIST SP 800-53 Rev 5 — AU-2 through AU-16 (Audit Controls)](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final)
- [报告 20 — Inboard/Outboard 架构决策](20-audit-mechanisms.md)
- [报告 03 — 政府 AI 合规法规背景](../../compliance/03-government-ai-compliance.md)
- [报告 09 — 多通道集成与可审计性](../../integration/09-multichannel-integration-auditability.md)
