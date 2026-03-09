> **[已过时 — 见 17/18/19]** pi-mono × OpenClaw 整合方案的前提已变。核心框架选型仍在评估中（方案 A/D/E），不是"基于 OpenClaw"。参见 17（pi-mono 生态更新）、18（Claude Agent SDK 生态）、19（OpenClaw 生态深度研究）。

# pi-mono × OpenClaw 整合方案：虚拟员工平台技术蓝图

> 研究日期：2026-03-06
> 研究员：高级系统架构师
> 参考源码：pi-mono, OpenClaw, OpenAI Agents SDK, Swarms
> 关联文档：`research/06-pi-mono-deep-dive.md`, `research/07-openclaw-architecture.md`, `research/08-dynamic-agent-swarm-architecture.md`

---

## 摘要

本报告基于对 pi-mono（`pi-ai` + `pi-agent-core`）和 OpenClaw 源码的深度逆向分析，为 Agentic 虚拟员工平台设计一个具体的、可落地的技术整合方案。核心挑战在于：**将一个为交互式编码设计的单 Agent 循环，改造为支持长期运行、多 Agent 协作、事件驱动的虚拟员工运行时**。

报告涵盖五大核心内容：
1. Agent Loop 的生产化改造方案（含 TypeScript 伪代码）
2. 五层对接方案的具体设计
3. 四种技术方案的对比决策
4. 推荐方案的详细技术路线图
5. 关键接口定义和代码级架构

---

## 目录

1. [核心问题：Agent Loop 的生产化](#1-核心问题agent-loop-的生产化)
2. [五层对接方案](#2-五层对接方案)
3. [技术方案对比决策](#3-技术方案对比决策)
4. [技术路线图](#4-技术路线图)
5. [风险与缓解](#5-风险与缓解)

---

## 1. 核心问题：Agent Loop 的生产化

### 1.1 从单次交互到长期运行的虚拟员工

#### 问题分析

pi-agent-core 的 `agentLoop()`（源码位于 `packages/agent/src/agent-loop.ts`）是一个 **请求-响应式** 的循环：

```
用户消息 → agentLoop() → [LLM 推理 → 工具调用]* → 最终回复 → 结束
```

它的生命周期绑定在单次交互中——`stream.end(newMessages)` 后一切结束。而虚拟员工需要的是一个 **持续运行的守护进程**：

```
虚拟员工启动 → [
  等待事件（定时/外部/内部）
  → 唤醒 Agent Loop 处理
  → 可能需要等待人类审批（挂起）
  → 恢复后继续处理
  → 记录审计日志
  → 回到等待状态
]* → 永不主动结束（除非被停止）
```

#### 架构方案：Virtual Employee Runtime

核心思路是在 pi-agent-core 的 `Agent` 类之上构建一个 **Runtime Shell**，将单次交互的 Agent Loop 封装为长期运行的虚拟员工。

```
┌─────────────────────────────────────────────────────────┐
│  VirtualEmployeeRuntime（长期运行的守护进程）              │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ EventLoop   │  │ Scheduler    │  │ StateManager  │  │
│  │ (事件驱动)   │  │ (定时任务)    │  │ (持久化状态)   │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                   │          │
│         ▼                ▼                   ▼          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ TaskQueue（任务队列 — 优先级 + 去重 + 限流）       │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │ AgentSession（封装 pi-agent-core 的 Agent）        │   │
│  │ ● 每个任务创建一个 AgentSession                    │   │
│  │ ● 复用 Agent.prompt() / Agent.continue()          │   │
│  │ ● 添加: checkpoint/resume, 超时熔断, 审计记录      │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ HumanInTheLoop（人类审批网关）                      │   │
│  │ ● Agent 触发 request_approval 工具                 │   │
│  │ ● 任务挂起 → 持久化状态到 DB                       │   │
│  │ ● 人类审批后 → 从 checkpoint 恢复                  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

#### TypeScript 伪代码：VirtualEmployeeRuntime

```typescript
// ═══════════════════════════════════════════════════════
// VirtualEmployeeRuntime — 长期运行的虚拟员工运行时
// ═══════════════════════════════════════════════════════

import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { type Model } from "@mariozechner/pi-ai";

// ---- 核心类型 ----

interface VirtualEmployeeConfig {
  id: string;
  tenantId: string;
  roleDefinition: RoleDefinition;     // 从 YAML 加载
  model: Model<any>;
  tools: AgentTool[];
  schedules: ScheduleRule[];          // 定时任务
  eventSubscriptions: EventFilter[];  // 事件订阅
  limits: {
    maxTokensPerTask: number;
    maxIterationsPerTask: number;
    taskTimeoutMs: number;
  };
}

interface TaskContext {
  taskId: string;
  trigger: "event" | "schedule" | "human_request";
  priority: "critical" | "high" | "normal" | "low";
  payload: Record<string, unknown>;
  checkpoint?: CheckpointData;        // 断点续传
}

interface CheckpointData {
  messages: AgentMessage[];
  pendingApprovals: ApprovalRequest[];
  metadata: Record<string, unknown>;
  savedAt: Date;
}

// ---- 运行时实现 ----

class VirtualEmployeeRuntime {
  private agent: Agent;
  private taskQueue: PriorityQueue<TaskContext>;
  private stateStore: StateStore;       // PostgreSQL 持久化
  private eventBus: EventBus;           // Azure Service Bus
  private scheduler: CronScheduler;
  private isProcessing = false;

  constructor(
    private config: VirtualEmployeeConfig,
    private deps: RuntimeDependencies,
  ) {
    // 创建底层 pi-agent-core Agent 实例
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.buildSystemPrompt(),
        model: config.model,
        tools: [
          ...config.tools,
          this.createApprovalTool(),     // 注入人类审批工具
          this.createEscalationTool(),   // 注入升级工具
        ],
      },
      // 上下文转换：注入业务规则检查结果
      transformContext: async (messages) => {
        const ruleResults = await this.deps.rulesEngine.preCheck(messages);
        if (ruleResults.length > 0) {
          // 将规则检查结果作为 steering message 注入
          return [...messages, {
            role: "user",
            content: [{ type: "text", text: this.formatRuleResults(ruleResults) }],
            timestamp: Date.now(),
          }];
        }
        return messages;
      },
      // 上下文裁剪：防止超出 token 限制
      convertToLlm: (messages) => {
        const filtered = messages.filter(
          m => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
        );
        return this.pruneToTokenBudget(filtered, this.config.limits.maxTokensPerTask);
      },
    });

    this.taskQueue = new PriorityQueue();
    this.stateStore = deps.stateStore;
    this.eventBus = deps.eventBus;
    this.scheduler = deps.scheduler;
  }

  // 启动虚拟员工（长期运行）
  async start(): Promise<void> {
    // 1. 恢复未完成的任务（断点续传）
    const pendingTasks = await this.stateStore.getPendingTasks(this.config.id);
    for (const task of pendingTasks) {
      this.taskQueue.enqueue(task);
    }

    // 2. 注册事件订阅
    for (const filter of this.config.eventSubscriptions) {
      this.eventBus.subscribe(filter, (event) => {
        this.taskQueue.enqueue({
          taskId: crypto.randomUUID(),
          trigger: "event",
          priority: this.classifyPriority(event),
          payload: event.data,
        });
      });
    }

    // 3. 注册定时任务
    for (const schedule of this.config.schedules) {
      this.scheduler.register(schedule, () => {
        this.taskQueue.enqueue({
          taskId: crypto.randomUUID(),
          trigger: "schedule",
          priority: "normal",
          payload: { scheduleId: schedule.id },
        });
      });
    }

    // 4. 主循环 — 持续处理任务
    while (true) {
      const task = await this.taskQueue.dequeue(); // 阻塞等待
      await this.processTask(task);
    }
  }

  // 处理单个任务
  private async processTask(task: TaskContext): Promise<void> {
    const session = await this.stateStore.createSession(task);

    try {
      // 如果有 checkpoint，从断点恢复
      if (task.checkpoint) {
        this.agent.replaceMessages(task.checkpoint.messages);
        await this.agent.continue();
      } else {
        // 正常执行
        const prompt = this.buildTaskPrompt(task);
        await this.agent.prompt(prompt);
      }

      // 等待 agent 完成（包括所有 tool calls）
      await this.agent.waitForIdle();

      // 记录审计日志
      await this.recordAudit(session, this.agent.state.messages);

      // 后置业务规则校验
      await this.deps.rulesEngine.postValidate(session);

    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        // 人类审批挂起：保存 checkpoint
        await this.stateStore.saveCheckpoint(task.taskId, {
          messages: this.agent.state.messages,
          pendingApprovals: error.approvals,
          metadata: { suspendedAt: new Date() },
          savedAt: new Date(),
        });
        // 通知人类审批者
        await this.deps.notifier.requestApproval(error.approvals);
        return; // 任务挂起，不标记完成
      }

      // 超时或错误 → 升级到人类
      await this.deps.notifier.escalate(task, error);
      await this.stateStore.markFailed(session.id, error);

    } finally {
      // 清理 agent 状态，准备下一个任务
      this.agent.reset();
    }
  }

  // 人类审批回调（从外部触发）
  async onApprovalResponse(taskId: string, decision: ApprovalDecision): Promise<void> {
    const checkpoint = await this.stateStore.getCheckpoint(taskId);
    if (!checkpoint) throw new Error(`No checkpoint for task ${taskId}`);

    // 将审批结果作为新的上下文加入
    checkpoint.messages.push({
      role: "user",
      content: [{ type: "text", text: this.formatApprovalDecision(decision) }],
      timestamp: Date.now(),
    });

    // 重新入队处理
    this.taskQueue.enqueue({
      taskId,
      trigger: "human_request",
      priority: "high",
      payload: { approvalDecision: decision },
      checkpoint,
    });
  }

  // 创建人类审批工具（注入到 Agent 的 tool set）
  private createApprovalTool(): AgentTool {
    return {
      name: "request_human_approval",
      label: "Request Human Approval",
      description: "Request approval from a human supervisor for a decision",
      parameters: Type.Object({
        action: Type.String({ description: "The action requiring approval" }),
        reason: Type.String({ description: "Why approval is needed" }),
        urgency: Type.Enum({ low: "low", medium: "medium", high: "high" }),
        options: Type.Array(Type.String(), { description: "Available options" }),
      }),
      execute: async (toolCallId, params) => {
        // 抛出特殊错误，让 processTask 捕获并挂起
        throw new ApprovalRequiredError([{
          action: params.action,
          reason: params.reason,
          urgency: params.urgency,
          options: params.options,
        }]);
      },
    };
  }
}
```

### 1.2 Coordinator → Worker 的 Agent 协作

#### 问题分析

pi-agent-core 是 **单 Agent 设计**——一个 `Agent` 实例只有一个 system prompt、一组 tools、一个 message 上下文。它没有"子 Agent"或"Agent 委派"的概念。

OpenClaw 的子 Agent 机制（`acp-spawn.ts`）是通过 gateway 创建独立的 session，然后父 Agent 通过 stream relay 监听子 Agent 的输出。但它是简单的父→子单向委派，没有 Coordinator 级别的动态路由和结果汇总。

我们需要的是一个 **Coordinator 编排层**，它：
1. 分析任务，决定需要哪些 Worker
2. 动态启动/选择 Worker Agent
3. 监控 Worker 执行进度
4. 汇总 Worker 结果并做最终决策

#### TypeScript 伪代码：Agent 编排层

```typescript
// ═══════════════════════════════════════════════════════
// Agent 编排层 — Coordinator + Worker Pool
// ═══════════════════════════════════════════════════════

// ---- Worker Agent 定义 ----

interface WorkerAgentDefinition {
  id: string;
  name: string;
  description: string;             // 用于 Coordinator 选择
  capabilities: string[];          // 能力标签
  systemPrompt: string;
  tools: AgentTool[];
  triggerPatterns?: RegExp[];      // 规则匹配模式
  maxConcurrency: number;
}

// ---- 两阶段路由器 ----

class TwoPhaseRouter {
  constructor(
    private workerDefs: Map<string, WorkerAgentDefinition>,
    private llmModel: Model<any>,
  ) {}

  // 阶段 1：规则优先匹配（确定性，零成本）
  private ruleBasedRoute(task: TaskContext): WorkerAgentDefinition | null {
    for (const [id, def] of this.workerDefs) {
      if (!def.triggerPatterns) continue;
      for (const pattern of def.triggerPatterns) {
        if (pattern.test(JSON.stringify(task.payload))) {
          return def;
        }
      }
    }
    // 检查事件类型 → Worker 的直接映射
    const eventType = task.payload.eventType as string;
    const directMapping: Record<string, string> = {
      "po_submitted": "approval-worker",
      "email_received": "email-worker",
      "calendar_conflict": "calendar-worker",
      "data_entry_request": "data-entry-worker",
    };
    if (eventType && directMapping[eventType]) {
      return this.workerDefs.get(directMapping[eventType]) ?? null;
    }
    return null;
  }

  // 阶段 2：LLM 兜底（灵活，有成本）
  private async llmBasedRoute(task: TaskContext): Promise<WorkerAgentDefinition> {
    const workerCatalog = Array.from(this.workerDefs.values()).map(d => ({
      id: d.id,
      name: d.name,
      description: d.description,
      capabilities: d.capabilities,
    }));

    const routingPrompt = `You are a task router. Given the following task and available workers, select the best worker.

Task: ${JSON.stringify(task.payload)}

Available Workers:
${workerCatalog.map(w => `- ${w.id}: ${w.name} — ${w.description} (capabilities: ${w.capabilities.join(", ")})`).join("\n")}

Respond with ONLY the worker ID.`;

    const result = await completeSimple(this.llmModel, {
      systemPrompt: routingPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: "Route this task." }], timestamp: Date.now() }],
      tools: [],
    });

    const selectedId = result.content
      .filter(c => c.type === "text")
      .map(c => c.text.trim())
      .join("");

    return this.workerDefs.get(selectedId) ?? this.getDefaultWorker();
  }

  // 两阶段组合
  async route(task: TaskContext): Promise<WorkerAgentDefinition> {
    // 阶段 1
    const ruleResult = this.ruleBasedRoute(task);
    if (ruleResult) return ruleResult;
    // 阶段 2
    return this.llmBasedRoute(task);
  }
}

// ---- Coordinator Agent ----

class CoordinatorAgent {
  private router: TwoPhaseRouter;
  private workerPool: WorkerPool;
  private agent: Agent;  // Coordinator 自身也是一个 Agent

  constructor(
    private config: CoordinatorConfig,
    private deps: RuntimeDependencies,
  ) {
    this.router = new TwoPhaseRouter(
      config.workerDefinitions,
      config.routingModel,
    );
    this.workerPool = new WorkerPool(config.workerDefinitions, deps);

    // Coordinator 有自己的 Agent 实例，用于：
    // 1. 分析复杂任务（需要分解时）
    // 2. 汇总 Worker 结果
    // 3. 做最终决策
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.buildCoordinatorPrompt(),
        model: config.coordinatorModel,
        tools: [
          this.createDelegateToWorkerTool(),
          this.createSummarizeResultsTool(),
          this.createEscalateToHumanTool(),
        ],
      },
    });
  }

  // 处理一个任务
  async handleTask(task: TaskContext): Promise<TaskResult> {
    // 1. 路由决策
    const workerDef = await this.router.route(task);

    // 2. 简单任务：直接委派给 Worker
    if (this.isSimpleTask(task)) {
      return this.delegateToWorker(workerDef, task);
    }

    // 3. 复杂任务：Coordinator Agent 介入分析和编排
    const analysisPrompt = `Analyze this task and create an execution plan.

Task: ${JSON.stringify(task.payload)}

You can delegate subtasks to workers using the delegate_to_worker tool.
After all workers complete, use summarize_results to produce the final output.`;

    await this.agent.prompt(analysisPrompt);
    await this.agent.waitForIdle();

    // 返回 Coordinator Agent 的最终结果
    return this.extractResult(this.agent.state.messages);
  }

  // 委派给 Worker
  private async delegateToWorker(
    workerDef: WorkerAgentDefinition,
    task: TaskContext,
  ): Promise<TaskResult> {
    const worker = await this.workerPool.acquire(workerDef.id);

    try {
      // Worker 是一个独立的 Agent 实例
      worker.agent.setSystemPrompt(workerDef.systemPrompt);
      worker.agent.setTools(workerDef.tools);

      const taskPrompt = this.buildWorkerPrompt(task);
      await worker.agent.prompt(taskPrompt);
      await worker.agent.waitForIdle();

      const result = this.extractResult(worker.agent.state.messages);
      return result;

    } finally {
      worker.agent.reset();
      this.workerPool.release(worker);
    }
  }

  // 创建"委派给 Worker"工具
  private createDelegateToWorkerTool(): AgentTool {
    return {
      name: "delegate_to_worker",
      label: "Delegate to Worker",
      description: "Delegate a subtask to a specialized worker agent",
      parameters: Type.Object({
        workerId: Type.String({ description: "ID of the worker to delegate to" }),
        subtask: Type.String({ description: "Description of the subtask" }),
        context: Type.Optional(Type.String({ description: "Additional context" })),
      }),
      execute: async (_toolCallId, params) => {
        const workerDef = this.config.workerDefinitions.get(params.workerId);
        if (!workerDef) {
          return {
            content: [{ type: "text", text: `Worker ${params.workerId} not found` }],
            details: { error: true },
          };
        }

        const subtask: TaskContext = {
          taskId: crypto.randomUUID(),
          trigger: "human_request",
          priority: "normal",
          payload: { description: params.subtask, context: params.context },
        };

        const result = await this.delegateToWorker(workerDef, subtask);

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { workerId: params.workerId, status: "completed" },
        };
      },
    };
  }
}

// ---- Worker Pool ----

class WorkerPool {
  private pools: Map<string, WorkerInstance[]> = new Map();
  private busy: Set<string> = new Set();

  constructor(
    private definitions: Map<string, WorkerAgentDefinition>,
    private deps: RuntimeDependencies,
  ) {}

  async acquire(workerId: string): Promise<WorkerInstance> {
    const def = this.definitions.get(workerId);
    if (!def) throw new Error(`Unknown worker: ${workerId}`);

    // 从池中获取空闲实例，或创建新实例
    const pool = this.pools.get(workerId) ?? [];
    const idle = pool.find(w => !this.busy.has(w.instanceId));

    if (idle) {
      this.busy.add(idle.instanceId);
      return idle;
    }

    // 检查并发限制
    const busyCount = pool.filter(w => this.busy.has(w.instanceId)).length;
    if (busyCount >= def.maxConcurrency) {
      // 等待一个实例释放
      return new Promise((resolve) => {
        const check = setInterval(() => {
          const freed = pool.find(w => !this.busy.has(w.instanceId));
          if (freed) {
            clearInterval(check);
            this.busy.add(freed.instanceId);
            resolve(freed);
          }
        }, 100);
      });
    }

    // 创建新实例
    const instance = this.createWorkerInstance(def);
    pool.push(instance);
    this.pools.set(workerId, pool);
    this.busy.add(instance.instanceId);
    return instance;
  }

  release(worker: WorkerInstance): void {
    this.busy.delete(worker.instanceId);
  }

  private createWorkerInstance(def: WorkerAgentDefinition): WorkerInstance {
    return {
      instanceId: crypto.randomUUID(),
      workerId: def.id,
      agent: new Agent({
        initialState: {
          systemPrompt: def.systemPrompt,
          model: this.deps.defaultModel,
          tools: def.tools,
        },
      }),
    };
  }
}

interface WorkerInstance {
  instanceId: string;
  workerId: string;
  agent: Agent;
}
```

### 1.3 Agent 的动态模块加载

#### 问题分析

不同岗位（采购员、HR、项目经理）需要不同的 tools 和 skills。理想状态是：

```yaml
# roles/procurement-officer.yaml
role:
  id: procurement-officer
  name: 采购审批专员
  model: claude-sonnet-4.6

workers:
  - id: approval-worker
    tools:
      - dataverse-po-reader
      - dataverse-po-updater
      - budget-checker
    skills:
      - procurement-approval-flow

  - id: email-worker
    tools:
      - graph-email-reader
      - graph-email-sender
    skills:
      - professional-government-communication

schedules:
  - id: daily-po-review
    cron: "0 9 * * MON-FRI"
    task: "Review all pending purchase orders"

rules:
  - id: dual-approval-above-50k
    type: hard
    condition: "po.amount > 50000"
    action: require_dual_approval
```

#### 设计方案：融合 pi-mono Extension + OpenClaw Plugin Registry

**核心思想**：从 OpenClaw 的 `PluginRegistry` 借鉴注册/发现模式，但适配为我们的虚拟员工场景。OpenClaw 的 Plugin Registry（`src/plugins/registry.ts`）提供了一个出色的范式：`createPluginRegistry()` → `createApi()` → 通过 API 注册 tools、hooks、channels、services。

```typescript
// ═══════════════════════════════════════════════════════
// 动态模块加载系统
// ═══════════════════════════════════════════════════════

// ---- 模块定义（YAML → 类型） ----

interface RoleDefinition {
  id: string;
  name: string;
  model: string;
  workers: WorkerDefinition[];
  schedules: ScheduleDefinition[];
  rules: RuleDefinition[];
  channels: string[];
}

interface WorkerDefinition {
  id: string;
  tools: string[];       // 工具 ID 引用
  skills: string[];      // 技能 ID 引用
  systemPromptTemplate?: string;
}

// ---- 模块注册表（借鉴 OpenClaw PluginRegistry） ----

interface ModuleRegistry {
  tools: Map<string, ToolModule>;
  skills: Map<string, SkillModule>;
  channels: Map<string, ChannelModule>;
  rules: Map<string, RuleModule>;
}

interface ToolModule {
  id: string;
  name: string;
  description: string;
  category: string;
  // 工厂函数 — 延迟加载
  factory: (ctx: ToolContext) => AgentTool | AgentTool[];
  // 依赖声明（其他工具或服务）
  dependencies?: string[];
}

interface SkillModule {
  id: string;
  name: string;
  description: string;
  // 技能提供系统提示片段和预配置的工具组合
  systemPromptFragment: string;
  requiredTools: string[];
  configuration?: Record<string, unknown>;
}

// ---- 动态加载器 ----

class ModuleLoader {
  private registry: ModuleRegistry;
  private loadedModules: Map<string, any> = new Map();

  constructor() {
    this.registry = {
      tools: new Map(),
      skills: new Map(),
      channels: new Map(),
      rules: new Map(),
    };
  }

  // 扫描并注册所有可用模块（启动时执行）
  async discoverModules(moduleDirs: string[]): Promise<void> {
    for (const dir of moduleDirs) {
      const manifests = await glob(`${dir}/**/module.json`);
      for (const manifestPath of manifests) {
        const manifest = await loadJson(manifestPath);
        this.registerModule(manifest, path.dirname(manifestPath));
      }
    }
  }

  // 根据角色定义动态加载所需模块
  async loadForRole(roleDefinition: RoleDefinition): Promise<LoadedRoleModules> {
    const tools: AgentTool[] = [];
    const systemPromptParts: string[] = [];
    const rules: RuleModule[] = [];

    // 加载所有 Worker 需要的工具
    for (const worker of roleDefinition.workers) {
      for (const toolId of worker.tools) {
        const toolModule = this.registry.tools.get(toolId);
        if (!toolModule) throw new Error(`Tool not found: ${toolId}`);

        // 延迟实例化（工厂模式）
        const toolInstances = toolModule.factory({
          tenantId: roleDefinition.tenantId,
          roleId: roleDefinition.id,
        });
        const toolArray = Array.isArray(toolInstances) ? toolInstances : [toolInstances];
        tools.push(...toolArray);
      }

      // 加载技能（提供 prompt 片段和工具组合）
      for (const skillId of worker.skills) {
        const skill = this.registry.skills.get(skillId);
        if (!skill) throw new Error(`Skill not found: ${skillId}`);
        systemPromptParts.push(skill.systemPromptFragment);
      }
    }

    // 加载业务规则
    for (const ruleDef of roleDefinition.rules) {
      const ruleModule = this.registry.rules.get(ruleDef.type);
      if (ruleModule) rules.push(ruleModule);
    }

    return { tools, systemPromptParts, rules };
  }

  // 运行时热加载新模块（无需重启）
  async hotLoad(moduleId: string, modulePath: string): Promise<void> {
    const manifest = await loadJson(path.join(modulePath, "module.json"));
    this.registerModule(manifest, modulePath);
    // 通知所有活跃的 VirtualEmployeeRuntime 刷新
    this.emit("module:updated", { moduleId });
  }
}
```

#### 模块目录结构

```
modules/
├── tools/
│   ├── dataverse-crud/
│   │   ├── module.json          # 模块清单
│   │   ├── index.ts             # 工具工厂
│   │   └── schemas/             # TypeBox 参数定义
│   ├── graph-email/
│   ├── graph-calendar/
│   ├── power-automate/
│   └── budget-checker/
├── skills/
│   ├── procurement-approval/
│   │   ├── module.json
│   │   ├── prompt.md            # 系统提示片段
│   │   └── config.yaml
│   ├── hr-onboarding/
│   └── project-management/
├── channels/
│   ├── teams-adapter/
│   ├── email-adapter/
│   └── webhook-adapter/
└── rules/
    ├── dual-approval/
    ├── budget-threshold/
    └── compliance-check/
```

---

## 2. 五层对接方案

### 层次 1：LLM 抽象层

#### pi-ai 的对接策略：直接使用 + 薄封装

pi-ai（`@mariozechner/pi-ai`）的设计极其精练。核心是 `api-registry.ts` 中的 Registry Pattern + `stream.ts` 中的四个统一入口函数。它支持 23 个 LLM 提供商，使用 `EventStream` 异步迭代器统一流式输出。

**结论：直接 `npm install @mariozechner/pi-ai`，不 fork 不修改。** 只需在上层添加薄封装。

#### 具体对接方案

```typescript
// ═══════════════════════════════════════════════════════
// LLM 抽象层 — 基于 pi-ai 的薄封装
// ═══════════════════════════════════════════════════════

import {
  getModel,
  registerApiProvider,
  streamSimple,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

// ---- 1. 多租户 API Key 管理 ----

interface TenantLLMConfig {
  tenantId: string;
  providers: {
    [provider: string]: {
      apiKey: string;            // 加密存储在 Key Vault
      baseUrl?: string;          // 自定义端点
      maxTokensPerMonth: number; // 成本控制
      usedTokensThisMonth: number;
    };
  };
  defaultProvider: string;
  defaultModel: string;
  fallbackChain: string[];       // 故障转移链
}

class TenantLLMManager {
  private keyVault: AzureKeyVault;
  private usageTracker: UsageTracker;

  // 为指定租户获取 API Key（动态解析，支持轮换）
  async getApiKey(tenantId: string, provider: string): Promise<string> {
    const secretName = `llm-${tenantId}-${provider}`;
    return this.keyVault.getSecret(secretName);
  }

  // 创建租户级别的 stream 函数
  createTenantStreamFn(tenantId: string): StreamFn {
    return async (model, context, options) => {
      // 检查用量限制
      const canProceed = await this.usageTracker.checkBudget(tenantId, model.provider);
      if (!canProceed) {
        throw new Error(`Token budget exceeded for tenant ${tenantId}`);
      }

      // 注入租户 API Key
      const apiKey = await this.getApiKey(tenantId, model.provider);
      const enrichedOptions: SimpleStreamOptions = {
        ...options,
        apiKey,
      };

      // 调用 pi-ai 的 streamSimple
      const stream = streamSimple(model, context, enrichedOptions);

      // 追踪用量（异步，不阻塞）
      this.trackUsageAsync(tenantId, model, stream);

      return stream;
    };
  }
}

// ---- 2. 政府云端点配置 ----

type CloudEnvironment = "commercial" | "gcc" | "gcc_high" | "dod";

interface GovernmentCloudEndpoints {
  azureOpenAI: {
    baseUrl: string;
    apiVersion: string;
  };
  // 对于非 Azure 提供商，使用标准端点
  // 但需要确保数据路由符合政府要求
}

const GOVERNMENT_ENDPOINTS: Record<CloudEnvironment, GovernmentCloudEndpoints> = {
  commercial: {
    azureOpenAI: {
      baseUrl: "https://{resource}.openai.azure.com",
      apiVersion: "2024-12-01-preview",
    },
  },
  gcc: {
    azureOpenAI: {
      baseUrl: "https://{resource}.openai.azure.com",
      apiVersion: "2024-12-01-preview",
    },
  },
  gcc_high: {
    azureOpenAI: {
      baseUrl: "https://{resource}.openai.azure.us",
      apiVersion: "2024-12-01-preview",
    },
  },
  dod: {
    azureOpenAI: {
      baseUrl: "https://{resource}.openai.azure.us",
      apiVersion: "2024-12-01-preview",
    },
  },
};

// 在初始化时根据租户配置选择端点
function createModelForTenant(
  tenantConfig: TenantLLMConfig,
  cloudEnv: CloudEnvironment,
): Model<any> {
  const provider = tenantConfig.defaultProvider;
  const modelId = tenantConfig.defaultModel;

  if (provider === "azure-openai-responses") {
    const endpoints = GOVERNMENT_ENDPOINTS[cloudEnv];
    // pi-ai 的 getModel 支持自定义 baseUrl
    return getModel(provider, modelId);
    // baseUrl 通过 options.headers 或环境变量传入
  }

  // 非 Azure 提供商：直接使用 pi-ai 的标准模型
  return getModel(provider, modelId);
}

// ---- 3. 扩展 pi-ai 支持自定义提供商 ----

// 如果需要接入 pi-ai 不支持的 LLM（如自托管模型），
// 使用其 registerApiProvider API：
function registerCustomProvider(config: {
  apiName: string;
  baseUrl: string;
  // ... provider-specific config
}): void {
  registerApiProvider({
    api: config.apiName as any,
    stream: (model, context, options) => {
      // 自定义流式实现
      return customStreamImplementation(config.baseUrl, model, context, options);
    },
    streamSimple: (model, context, options) => {
      return customStreamSimpleImplementation(config.baseUrl, model, context, options);
    },
  });
}
```

### 层次 2：Agent 运行时

#### pi-agent-core 的适配策略

pi-agent-core 的 `Agent` 类（`packages/agent/src/agent.ts`）提供了一个精良的基础：
- 双层循环：内层 tool calls + steering → 外层 followUp
- `transformContext` + `convertToLlm` 两阶段上下文转换
- `AbortController` 全链路取消
- `EventStream` 事件系统

**我们不修改 pi-agent-core 源码**，而是在其上层构建扩展。

#### 需要扩展的接口

| 扩展点 | pi-agent-core 现有 | 我们需要添加 |
|--------|-------------------|-------------|
| 状态持久化 | 内存中的 `AgentState` | `StateStore` 接口 → PostgreSQL |
| 多 Agent 协作 | 单 Agent | `CoordinatorAgent` + `WorkerPool` |
| 事件驱动 | 请求-响应 | `EventLoop` + `TaskQueue` |
| 会话管理 | `sessionId` 字符串 | `SessionManager` + 数据库 |
| 自定义消息类型 | `CustomAgentMessages` 声明合并 | 添加审批/升级/通知类型 |
| 审计日志 | 无 | `AuditLogger` 中间件 |

#### 持久化策略

```typescript
// ═══════════════════════════════════════════════════════
// 持久化层 — 从内存到数据库
// ═══════════════════════════════════════════════════════

// pi-agent-core 的 AgentMessage 扩展自定义类型
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    approval_request: {
      role: "approval_request";
      approvalId: string;
      action: string;
      reason: string;
      options: string[];
      deadline: Date;
      timestamp: number;
    };
    approval_response: {
      role: "approval_response";
      approvalId: string;
      decision: string;
      decidedBy: string;
      timestamp: number;
    };
    escalation: {
      role: "escalation";
      reason: string;
      escalatedTo: string;
      timestamp: number;
    };
    system_notification: {
      role: "system_notification";
      message: string;
      severity: "info" | "warning" | "error";
      timestamp: number;
    };
  }
}

// ---- StateStore 接口 ----

interface StateStore {
  // Session 管理
  createSession(task: TaskContext): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  updateSession(sessionId: string, update: Partial<SessionRecord>): Promise<void>;

  // Checkpoint（断点续传）
  saveCheckpoint(taskId: string, checkpoint: CheckpointData): Promise<void>;
  getCheckpoint(taskId: string): Promise<CheckpointData | null>;
  deleteCheckpoint(taskId: string): Promise<void>;

  // 消息历史（从内存 → 数据库）
  saveMessages(sessionId: string, messages: AgentMessage[]): Promise<void>;
  loadMessages(sessionId: string): Promise<AgentMessage[]>;

  // 任务队列
  enqueueTasks(tasks: TaskContext[]): Promise<void>;
  getPendingTasks(employeeId: string): Promise<TaskContext[]>;
  markTaskCompleted(taskId: string, result: TaskResult): Promise<void>;
  markTaskFailed(taskId: string, error: Error): Promise<void>;
}

// ---- PostgreSQL 实现 ----

class PostgresStateStore implements StateStore {
  constructor(private pool: Pool) {}

  async createSession(task: TaskContext): Promise<SessionRecord> {
    const result = await this.pool.query(`
      INSERT INTO agent_sessions (
        id, task_id, tenant_id, employee_id,
        trigger_type, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'running', NOW())
      RETURNING *
    `, [
      crypto.randomUUID(),
      task.taskId,
      task.tenantId,
      task.employeeId,
      task.trigger,
    ]);
    return result.rows[0];
  }

  async saveCheckpoint(taskId: string, checkpoint: CheckpointData): Promise<void> {
    // 使用 JSONB 存储消息历史
    await this.pool.query(`
      INSERT INTO agent_checkpoints (task_id, messages, metadata, saved_at)
      VALUES ($1, $2::jsonb, $3::jsonb, NOW())
      ON CONFLICT (task_id) DO UPDATE SET
        messages = $2::jsonb,
        metadata = $3::jsonb,
        saved_at = NOW()
    `, [
      taskId,
      JSON.stringify(checkpoint.messages),
      JSON.stringify(checkpoint.metadata),
    ]);
  }

  async saveMessages(sessionId: string, messages: AgentMessage[]): Promise<void> {
    // 增量保存 — 只保存新消息
    const batch = messages.map((msg, idx) => ({
      sessionId,
      turnNumber: idx,
      role: msg.role,
      content: JSON.stringify(msg.content),
      timestamp: msg.timestamp,
    }));

    await this.pool.query(`
      INSERT INTO agent_messages (session_id, turn_number, role, content, timestamp)
      SELECT * FROM unnest($1::uuid[], $2::int[], $3::text[], $4::jsonb[], $5::bigint[])
      ON CONFLICT (session_id, turn_number) DO NOTHING
    `, [
      batch.map(b => b.sessionId),
      batch.map(b => b.turnNumber),
      batch.map(b => b.role),
      batch.map(b => b.content),
      batch.map(b => b.timestamp),
    ]);
  }
}
```

#### 数据库 Schema

```sql
-- 核心表结构

CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  employee_id VARCHAR(255) NOT NULL,
  trigger_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'running',
  model_id VARCHAR(255),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  total_tokens_used INTEGER DEFAULT 0,
  total_cost_usd DECIMAL(10,6) DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

CREATE TABLE agent_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES agent_sessions(id),
  turn_number INTEGER NOT NULL,
  role VARCHAR(50) NOT NULL,
  content JSONB NOT NULL,
  token_count INTEGER,
  timestamp BIGINT NOT NULL,
  UNIQUE (session_id, turn_number)
);

CREATE TABLE agent_checkpoints (
  task_id UUID PRIMARY KEY,
  messages JSONB NOT NULL,
  pending_approvals JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  saved_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_tool_invocations (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES agent_sessions(id),
  tool_name VARCHAR(255) NOT NULL,
  input_params JSONB NOT NULL,
  output_result JSONB,
  is_error BOOLEAN DEFAULT FALSE,
  duration_ms INTEGER,
  invoked_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE human_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  session_id UUID NOT NULL REFERENCES agent_sessions(id),
  action VARCHAR(500) NOT NULL,
  reason TEXT,
  options JSONB,
  urgency VARCHAR(50) DEFAULT 'normal',
  status VARCHAR(50) DEFAULT 'pending',
  decided_by VARCHAR(255),
  decision TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  deadline TIMESTAMPTZ
);

-- 索引
CREATE INDEX idx_sessions_tenant ON agent_sessions(tenant_id);
CREATE INDEX idx_sessions_employee ON agent_sessions(employee_id);
CREATE INDEX idx_sessions_status ON agent_sessions(status);
CREATE INDEX idx_messages_session ON agent_messages(session_id);
CREATE INDEX idx_approvals_status ON human_approvals(status);
CREATE INDEX idx_approvals_task ON human_approvals(task_id);
```

### 层次 3：多通道接入

#### 借鉴 OpenClaw ChannelPlugin 的设计

OpenClaw 的 `ChannelPlugin` 接口（`src/channels/plugins/types.plugin.ts`）采用组合式设计——一个 channel 不需要实现所有 adapter，只需实现它支持的部分：

```typescript
// OpenClaw 的 ChannelPlugin（简化版）
type ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter;
  outbound?: ChannelOutboundAdapter;      // 发送消息
  gateway?: ChannelGatewayAdapter;        // 接收消息
  threading?: ChannelThreadingAdapter;    // 线程管理
  streaming?: ChannelStreamingAdapter;    // 流式输出
  // ... 20+ 可选 adapter
};
```

#### 我们的 ChannelAdapter 设计

我们简化 OpenClaw 的设计，聚焦企业场景的三个核心通道。

```typescript
// ═══════════════════════════════════════════════════════
// 多通道接入层 — 借鉴 OpenClaw ChannelPlugin 模式
// ═══════════════════════════════════════════════════════

// ---- 统一事件格式（CloudEvents） ----

interface InboundEvent {
  id: string;
  type: string;                    // e.g., "email.received", "teams.message"
  source: string;                  // 通道标识
  tenantId: string;
  timestamp: Date;
  data: {
    senderId: string;
    senderName: string;
    content: string;
    attachments?: Attachment[];
    threadId?: string;
    replyTo?: string;
    metadata: Record<string, unknown>;
  };
}

interface OutboundMessage {
  channelId: string;
  tenantId: string;
  recipientId: string;
  threadId?: string;
  content: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

// ---- ChannelAdapter 接口（组合式） ----

interface ChannelAdapter {
  id: string;
  meta: {
    name: string;
    description: string;
    icon: string;
  };
  capabilities: {
    canReceive: boolean;
    canSend: boolean;
    canThread: boolean;
    canStream: boolean;
    canAttach: boolean;
    maxMessageLength: number;
  };

  // 必选：初始化和配置
  initialize(config: ChannelConfig): Promise<void>;
  healthCheck(): Promise<HealthStatus>;

  // 接收消息（事件驱动）
  onMessage?: (handler: (event: InboundEvent) => Promise<void>) => void;

  // 发送消息
  send?: (message: OutboundMessage) => Promise<SendResult>;

  // 线程管理（可选）
  threading?: {
    createThread(parentId: string, title: string): Promise<string>;
    replyInThread(threadId: string, message: string): Promise<void>;
  };

  // 流式输出（可选 — Teams 支持，Email 不支持）
  streaming?: {
    startStream(recipientId: string): StreamHandle;
    pushChunk(handle: StreamHandle, chunk: string): void;
    endStream(handle: StreamHandle): Promise<void>;
  };
}

// ---- Teams 通道适配器 ----

class TeamsChannelAdapter implements ChannelAdapter {
  id = "teams";
  meta = { name: "Microsoft Teams", description: "M365 Agents SDK", icon: "teams" };
  capabilities = {
    canReceive: true,
    canSend: true,
    canThread: true,
    canStream: true,    // Teams 支持 streaming
    canAttach: true,
    maxMessageLength: 28000,
  };

  // 基于 M365 Agents SDK（替代已 EOL 的 Bot Framework）
  private teamsApp: TeamsApp;

  async initialize(config: ChannelConfig): Promise<void> {
    // M365 Agents SDK 初始化
    this.teamsApp = new TeamsApp({
      appId: config.appId,
      appPassword: await this.keyVault.getSecret(config.passwordSecretName),
      // M365 Agents SDK 原生支持 MCP
      mcpEnabled: true,
    });
  }

  onMessage = (handler: (event: InboundEvent) => Promise<void>) => {
    this.teamsApp.onMessage(async (context) => {
      const event: InboundEvent = {
        id: context.activity.id,
        type: "teams.message",
        source: "teams",
        tenantId: context.activity.channelData?.tenant?.id,
        timestamp: new Date(context.activity.timestamp),
        data: {
          senderId: context.activity.from.id,
          senderName: context.activity.from.name,
          content: context.activity.text,
          threadId: context.activity.conversation.id,
          metadata: {
            channelId: context.activity.channelId,
            isGroup: context.activity.conversation.isGroup,
          },
        },
      };
      await handler(event);
    });
  };

  send = async (message: OutboundMessage): Promise<SendResult> => {
    return this.teamsApp.sendMessage(
      message.recipientId,
      message.content,
      { threadId: message.threadId },
    );
  };
}

// ---- Email 通道适配器 ----

class EmailChannelAdapter implements ChannelAdapter {
  id = "email";
  meta = { name: "Email", description: "MS Graph API", icon: "email" };
  capabilities = {
    canReceive: true,
    canSend: true,
    canThread: true,   // Email threading via In-Reply-To / References
    canStream: false,   // Email 不支持流式
    canAttach: true,
    maxMessageLength: Infinity,
  };

  async initialize(config: ChannelConfig): Promise<void> {
    // 使用 MS Graph API Change Notifications（非轮询）
    this.graphClient = await this.createGraphClient(config);
    await this.subscribeToMailbox(config.mailboxAddress);
  }

  // 通过 Graph API webhook 接收新邮件通知
  onMessage = (handler: (event: InboundEvent) => Promise<void>) => {
    this.webhookServer.on("notification", async (notification) => {
      const email = await this.graphClient.getMessage(notification.resourceData.id);
      const event: InboundEvent = {
        id: email.id,
        type: "email.received",
        source: "email",
        tenantId: this.config.tenantId,
        timestamp: new Date(email.receivedDateTime),
        data: {
          senderId: email.from.emailAddress.address,
          senderName: email.from.emailAddress.name,
          content: email.body.content,
          threadId: email.conversationId,  // 使用 Immutable ID
          replyTo: email.internetMessageId,
          attachments: email.attachments?.map(this.convertAttachment),
          metadata: {
            subject: email.subject,
            importance: email.importance,
            categories: email.categories,
          },
        },
      };
      await handler(event);
    });
  };
}

// ---- Power Automate Webhook 适配器 ----

class PowerAutomateAdapter implements ChannelAdapter {
  id = "power-automate";
  meta = { name: "Power Automate", description: "HTTP Webhook", icon: "flow" };
  capabilities = {
    canReceive: true,
    canSend: true,
    canThread: false,
    canStream: false,
    canAttach: false,
    maxMessageLength: 65536,
  };

  // 接收 Power Automate HTTP 触发的 webhook
  onMessage = (handler: (event: InboundEvent) => Promise<void>) => {
    this.httpServer.post("/webhooks/power-automate/:tenantId", async (req, res) => {
      // 验证 webhook 签名
      if (!this.verifySignature(req)) {
        res.status(401).send("Unauthorized");
        return;
      }

      const event: InboundEvent = {
        id: req.body.correlationId,
        type: `power-automate.${req.body.triggerType}`,
        source: "power-automate",
        tenantId: req.params.tenantId,
        timestamp: new Date(),
        data: {
          senderId: req.body.initiator,
          senderName: req.body.initiatorName,
          content: JSON.stringify(req.body.payload),
          metadata: req.body.metadata,
        },
      };

      await handler(event);
      res.status(200).json({ status: "accepted" });
    });
  };
}

// ---- 通道注册和路由 ----

class ChannelRegistry {
  private adapters: Map<string, ChannelAdapter> = new Map();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(channelId: string): ChannelAdapter | undefined {
    return this.adapters.get(channelId);
  }

  // 统一消息路由：所有通道 → EventBus → Agent 处理
  async initializeAll(configs: Record<string, ChannelConfig>): Promise<void> {
    for (const [channelId, config] of Object.entries(configs)) {
      const adapter = this.adapters.get(channelId);
      if (!adapter) continue;
      await adapter.initialize(config);

      // 注册消息处理器 → 发送到统一 EventBus
      adapter.onMessage?.(async (event) => {
        await this.eventBus.publish(event);
      });
    }
  }
}
```

#### 通道安全和认证

```typescript
// ---- 通道安全层 ----

interface ChannelSecurityConfig {
  // Webhook 签名验证
  webhookSecret?: string;

  // Azure AD / Entra ID 认证
  entraIdConfig?: {
    tenantId: string;
    clientId: string;
    // 证书认证（政府要求）
    certificateThumbprint: string;
    certificatePath: string;
  };

  // IP 白名单（政府环境）
  allowedIpRanges?: string[];

  // 消息加密
  encryptionEnabled: boolean;
}

class ChannelSecurityMiddleware {
  // 验证入站消息的来源
  async validateInbound(event: InboundEvent, config: ChannelSecurityConfig): Promise<boolean> {
    // 1. IP 白名单检查
    if (config.allowedIpRanges) {
      if (!this.isIpAllowed(event.sourceIp, config.allowedIpRanges)) {
        return false;
      }
    }

    // 2. Webhook 签名验证
    if (config.webhookSecret && event.signature) {
      if (!this.verifyHmac(event.rawBody, config.webhookSecret, event.signature)) {
        return false;
      }
    }

    // 3. Entra ID token 验证
    if (config.entraIdConfig) {
      const token = event.authToken;
      if (!await this.validateEntraIdToken(token, config.entraIdConfig)) {
        return false;
      }
    }

    return true;
  }
}
```

### 层次 4：Agent 编排

编排层的核心设计已在 1.2 节中详细描述。此处补充几个关键的运维能力。

#### Coordinator 健康监控

```typescript
// ═══════════════════════════════════════════════════════
// Agent 编排 — 监控和运维
// ═══════════════════════════════════════════════════════

class AgentOrchestrator {
  private coordinator: CoordinatorAgent;
  private metrics: MetricsCollector;

  // 实时监控指标
  getHealthMetrics(): OrchestratorHealth {
    return {
      activeWorkers: this.coordinator.workerPool.activeCount(),
      queuedTasks: this.coordinator.taskQueue.size(),
      averageTaskDurationMs: this.metrics.getAverage("task.duration"),
      errorRate: this.metrics.getRate("task.error", "1h"),
      escalationRate: this.metrics.getRate("task.escalation", "1h"),
      tokenUsage: {
        last1h: this.metrics.getSum("tokens.used", "1h"),
        last24h: this.metrics.getSum("tokens.used", "24h"),
      },
      workerHealth: this.coordinator.workerPool.getHealthMap(),
    };
  }

  // Worker 自动扩缩容
  async autoScale(): Promise<void> {
    const queueDepth = this.coordinator.taskQueue.size();
    const activeWorkers = this.coordinator.workerPool.activeCount();

    if (queueDepth > activeWorkers * 2) {
      // 扩容：增加 Worker 实例
      await this.coordinator.workerPool.scaleUp(
        Math.min(queueDepth - activeWorkers, 10),
      );
    }

    if (queueDepth === 0 && activeWorkers > 1) {
      // 缩容：保留最少 1 个实例
      await this.coordinator.workerPool.scaleDown(activeWorkers - 1);
    }
  }

  // 任务超时熔断
  private setupCircuitBreaker(): void {
    this.coordinator.on("task:timeout", async (task) => {
      // 1. 中止当前 Agent（利用 pi-agent-core 的 AbortController）
      this.coordinator.abortTask(task.taskId);

      // 2. 保存断点
      await this.stateStore.saveCheckpoint(task.taskId, {
        messages: task.agent.state.messages,
        metadata: { timedOutAt: new Date() },
        savedAt: new Date(),
      });

      // 3. 升级到人类
      await this.notifier.escalate(task, new Error("Task timed out"));
    });
  }
}
```

### 层次 5：业务规则引擎

#### 确定性逻辑 vs LLM 判断的边界

```
┌──────────────────────────────────────────────────────┐
│                  任务入站                              │
└────────────────────┬─────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────┐
│  PRE-CHECK（业务规则引擎，不经过 LLM）                  │
│                                                       │
│  ● 合规检查（hard rules）— 违反则直接拒绝               │
│  ● 审批阈值（金额 > X 则需要 Y 级审批）                 │
│  ● 数据验证（schema validation）                       │
│  ● 权限检查（调用者是否有权限触发此操作）                │
│                                                       │
│  输出：PASS / BLOCK(reason) / NEEDS_ESCALATION        │
└────────────────────┬─────────────────────────────────┘
                     │ PASS
                     ▼
┌──────────────────────────────────────────────────────┐
│  AGENT 处理（LLM 判断）                                │
│                                                       │
│  ● 理解自然语言请求的意图                               │
│  ● 判断需要哪些信息和步骤                               │
│  ● 撰写专业沟通内容                                    │
│  ● 处理模糊或不完整的请求                               │
│  ● 选择工具和执行策略                                   │
└────────────────────┬─────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────┐
│  POST-VALIDATION（业务规则引擎，不经过 LLM）            │
│                                                       │
│  ● 验证 Agent 输出符合业务规则                          │
│  ● 检查是否遗漏必填字段                                 │
│  ● 确认金额/日期等关键数据的合理性                       │
│  ● 验证 Agent 没有超越其权限范围                        │
│                                                       │
│  输出：APPROVED / REJECTED(reason) / NEEDS_REVIEW     │
└──────────────────────────────────────────────────────┘
```

#### 规则引擎实现

```typescript
// ═══════════════════════════════════════════════════════
// 业务规则引擎 — 确定性逻辑
// ═══════════════════════════════════════════════════════

type RuleType = "hard" | "soft";
type RuleResult =
  | { status: "pass" }
  | { status: "block"; reason: string; rule: string }
  | { status: "escalate"; reason: string; escalateTo: string };

interface BusinessRule {
  id: string;
  name: string;
  type: RuleType;
  // 确定性评估函数 — 不调用 LLM
  evaluate: (context: RuleContext) => RuleResult | Promise<RuleResult>;
  // 规则优先级
  priority: number;
}

interface RuleContext {
  tenantId: string;
  employeeId: string;
  taskType: string;
  payload: Record<string, unknown>;
  previousDecisions?: RuleResult[];
}

class BusinessRulesEngine {
  private rules: Map<string, BusinessRule> = new Map();

  register(rule: BusinessRule): void {
    this.rules.set(rule.id, rule);
  }

  // 前置检查（在 Agent 处理之前）
  async preCheck(context: RuleContext): Promise<RuleResult[]> {
    const results: RuleResult[] = [];
    const sortedRules = Array.from(this.rules.values())
      .filter(r => r.type === "hard")
      .sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      const result = await rule.evaluate(context);
      results.push(result);
      // Hard rule 失败 → 立即停止
      if (result.status === "block") {
        return results;
      }
    }
    return results;
  }

  // 后置验证（在 Agent 处理之后）
  async postValidate(session: SessionRecord): Promise<RuleResult[]> {
    const results: RuleResult[] = [];
    const softRules = Array.from(this.rules.values())
      .filter(r => r.type === "soft")
      .sort((a, b) => b.priority - a.priority);

    for (const rule of softRules) {
      const result = await rule.evaluate({
        tenantId: session.tenantId,
        employeeId: session.employeeId,
        taskType: session.taskType,
        payload: session.result,
      });
      results.push(result);
    }
    return results;
  }
}

// ---- 预置规则示例 ----

const dualApprovalRule: BusinessRule = {
  id: "dual-approval-above-50k",
  name: "Dual Approval for PO > $50,000",
  type: "hard",
  priority: 100,
  evaluate: (ctx) => {
    const amount = ctx.payload.amount as number;
    if (amount > 50000) {
      const approvals = (ctx.payload.approvals as any[]) ?? [];
      if (approvals.length < 2) {
        return {
          status: "escalate",
          reason: `PO amount $${amount} exceeds $50,000 threshold. Requires dual approval (${approvals.length}/2 received).`,
          escalateTo: "department-head",
        };
      }
    }
    return { status: "pass" };
  },
};

const budgetCheckRule: BusinessRule = {
  id: "budget-availability",
  name: "Budget Availability Check",
  type: "hard",
  priority: 90,
  evaluate: async (ctx) => {
    const amount = ctx.payload.amount as number;
    const budgetCode = ctx.payload.budgetCode as string;

    // 直接查询数据库（不经过 LLM）
    const available = await queryBudgetBalance(ctx.tenantId, budgetCode);

    if (amount > available) {
      return {
        status: "block",
        reason: `Insufficient budget. Requested: $${amount}, Available: $${available}`,
        rule: "budget-availability",
      };
    }
    return { status: "pass" };
  },
};

const dataCompleteness: BusinessRule = {
  id: "po-data-completeness",
  name: "PO Data Completeness",
  type: "soft",
  priority: 80,
  evaluate: (ctx) => {
    const requiredFields = ["supplier_id", "line_items", "delivery_date", "budget_code"];
    const missing = requiredFields.filter(f => !ctx.payload[f]);

    if (missing.length > 0) {
      return {
        status: "block",
        reason: `Missing required fields: ${missing.join(", ")}`,
        rule: "po-data-completeness",
      };
    }
    return { status: "pass" };
  },
};
```

---

## 3. 技术方案对比决策

### 方案概览

| 方案 | 描述 |
|------|------|
| **A** | pi-ai + pi-agent-core 作为基础，自研编排层 |
| **B** | 完全自研，仅借鉴 pi/claw 的设计模式 |
| **C** | 基于 OpenAI Agents SDK（Python）构建 |
| **D** | 基于 M365 Agents SDK + Teams AI Library 构建 |

### 方案 A：pi-ai + pi-agent-core + 自研编排层

**描述**：直接 npm install pi-ai 和 pi-agent-core，在其上构建 VirtualEmployeeRuntime、CoordinatorAgent、ModuleLoader 等编排组件。借鉴 OpenClaw 的 ChannelPlugin 和 PluginRegistry 模式设计多通道和模块系统。

**优点**：
- pi-ai 提供 23 个 LLM 提供商的统一抽象，免去大量适配工作
- pi-agent-core 的 Agent Loop 经过 OpenClaw 大规模生产验证
- TypeScript 全栈，与 M365 Agents SDK（JS/TS GA）生态一致
- `transformContext` / `convertToLlm` / `steer()` / `followUp()` 直接适配我们的业务规则注入需求
- `CustomAgentMessages` 声明合并机制天然支持自定义消息类型
- 编排层完全自主控制，不受框架约束

**缺点**：
- 编排层需要自研（约 4-6 周工作量）
- pi-mono 是社区项目，不保证商业支持
- Agent Loop 为单 Agent 设计，多 Agent 协作需要自行构建
- 需要自行实现持久化（pi-agent-core 纯内存）

**开发工作量**：中等（12-16 周）
- LLM 层：0 周（直接 npm install）
- Agent 运行时：2-3 周（封装 + 持久化 + 事件驱动）
- 编排层：4-6 周（Coordinator + WorkerPool + 路由器）
- 通道接入：3-4 周（Teams + Email + Webhook）
- 规则引擎：2-3 周

**风险**：
- pi-mono 的版本更新可能引入 breaking changes（缓解：锁定版本 + 集成测试）
- 社区项目的维护可持续性（缓解：核心依赖仅两个包，代码量小，必要时可 fork）

**长期可维护性**：高。核心编排逻辑完全自有，底层依赖轻量且可替换。

### 方案 B：完全自研

**描述**：不引入 pi-ai / pi-agent-core，仅学习其设计模式（Registry Pattern、EventStream、双层循环），从零构建。

**优点**：
- 完全自主控制所有代码
- 无外部依赖风险
- 可以一开始就为虚拟员工场景优化

**缺点**：
- LLM 适配层工作量巨大（23 个提供商 = 数万行代码）
- Agent Loop 需要自行处理：流式解析、tool call 验证、上下文管理、错误恢复
- 重复造轮子，延迟上市时间
- 团队需要深入理解每个 LLM API 的细节和边界情况

**开发工作量**：高（20-28 周）
- LLM 层：6-8 周
- Agent 运行时：4-6 周
- 编排层：4-6 周
- 通道接入：3-4 周
- 规则引擎：2-3 周

**风险**：高。工程量大，容易在底层细节上耗费过多时间。

**长期可维护性**：中。所有代码自有，但维护成本也全部自担。

### 方案 C：基于 OpenAI Agents SDK（Python）

**描述**：使用 OpenAI 官方的 Agents SDK（Python），利用其 Handoff 机制实现 Agent 协作。

**优点**：
- 官方支持，文档完善
- 内置 Handoff 和 guardrail 机制
- 内置 tracing 和 observability
- MCP 集成开箱即用

**缺点**：
- **Python 生态与 M365 Agents SDK（JS/TS）不一致**——需要跨语言调用或重写
- 与 Power Platform / Dataverse 的 TypeScript SDK 生态断裂
- Handoff 机制是简单的"交出控制权"，不是 Coordinator → Worker 的并行委派
- 绑定 OpenAI 提供商（虽然支持自定义 model client，但设计中心是 OpenAI）
- 无法利用 pi-ai 的 23 提供商抽象
- M365 Agents SDK 的 Python 版本尚未 GA（截至 2026-03-06）

**开发工作量**：中等（14-18 周）
- Agent 层：2-3 周（快速启动）
- 但跨语言整合：4-6 周（Python ↔ TypeScript 桥接）
- 通道接入：4-5 周（Python 生态中 Teams 集成不如 JS/TS 成熟）
- 规则引擎：2-3 周

**风险**：高。跨语言架构增加复杂性；Python 在 M365 生态中是二等公民。

**长期可维护性**：低-中。双语言维护成本高，团队需要同时精通两个生态。

### 方案 D：基于 M365 Agents SDK + Teams AI Library

**描述**：完全基于微软的 M365 Agents SDK 构建，使用 Teams AI Library 处理 LLM 交互。

**优点**：
- 与 M365 / Power Platform 深度集成
- 原生支持 Teams channel
- 内置 Entra ID 认证
- 微软商业支持
- MCP 和 A2A 协议支持

**缺点**：
- **高度绑定微软生态**——非 M365 场景受限
- Teams AI Library 的 LLM 抽象远不如 pi-ai 丰富（主要支持 Azure OpenAI）
- 没有"Agent Loop"概念——需要自行构建 Agent 循环和工具调用链
- 文档和社区较新，成熟度不足
- **无法支持自托管 LLM**（政府隔离环境的需求）
- Agent 编排能力有限——SDK 更偏向"单 Bot"而非"Agent Swarm"

**开发工作量**：中等（14-18 周）
- Teams 集成：2-3 周（最快的部分）
- LLM 抽象层：4-6 周（需要自行扩展以支持非 Azure 提供商）
- Agent 循环：4-5 周（SDK 不提供，需自行构建）
- 规则引擎：2-3 周

**风险**：中。微软 SDK 变动频繁（Bot Framework 已 EOL 就是前车之鉴）。

**长期可维护性**：中。微软平台的长期支持性好，但深度绑定限制了灵活性。

### 推荐决策

| 维度 | 方案 A | 方案 B | 方案 C | 方案 D |
|------|--------|--------|--------|--------|
| 开发速度 | **快** | 慢 | 中 | 中 |
| 灵活性 | **高** | 高 | 中 | 低 |
| M365 集成 | 中（需适配） | 中 | 低 | **高** |
| LLM 多样性 | **高**（23+） | 高（自研） | 中 | 低 |
| 长期可维护 | **高** | 中 | 低 | 中 |
| 风险 | **低** | 高 | 高 | 中 |
| 前瞻性 | **高** | 中 | 中 | 中 |

**推荐：方案 A — pi-ai + pi-agent-core + 自研编排层**

理由：
1. **最优的投入产出比**：利用 pi-ai 节省 6-8 周 LLM 适配工作，利用 pi-agent-core 节省 Agent Loop 开发
2. **编排层完全自主**：我们的核心 IP（Dynamic Hierarchical MoE、YAML 驱动的角色配置）不受框架约束
3. **TypeScript 全栈统一**：与 M365 Agents SDK、Power Platform SDK 生态一致
4. **渐进式集成**：先用 pi-ai + pi-agent-core 快速验证，后续可逐步替换任何组件
5. **前瞻性**：pi-ai 的 Registry Pattern 天然支持新 LLM 提供商注册；MCP 工具发现可直接集成

**补充策略**：Teams 通道层面使用 M365 Agents SDK（方案 D 的这部分），但 Agent 运行时和编排层使用方案 A。这是一个混合方案——取方案 A 的核心架构 + 方案 D 的 Teams 接入层。

---

## 4. 技术路线图

### Phase 0：环境搭建和概念验证（2 周）

**目标**：验证核心技术组件可行性，搭建开发环境。

| 周 | 任务 | 产出 |
|----|------|------|
| 第 1 周 | 1. 创建 monorepo 项目结构（TypeScript + pnpm workspaces）<br>2. npm install `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`<br>3. 搭建 PostgreSQL + Azure Service Bus 本地开发环境<br>4. 创建基础 CI/CD（GitHub Actions） | 可运行的空项目骨架 |
| 第 2 周 | 1. POC：用 pi-agent-core 的 Agent 类实现一个简单的"采购审批虚拟员工"<br>2. 验证 `transformContext` 注入业务规则<br>3. 验证 `steer()` / `followUp()` 的中断/续传行为<br>4. 验证 pi-ai 连接 Azure OpenAI 和 Anthropic | 可运行的 POC demo |

**Phase 0 的关键验证点**：
- [ ] pi-agent-core 的 Agent.prompt() 能否被外部事件触发（非交互式）
- [ ] transformContext 能否稳定注入业务规则上下文
- [ ] Agent.reset() 后能否复用同一实例处理下一个任务
- [ ] pi-ai 的 streamSimple 能否通过 getApiKey 动态传入租户 API Key

### Phase 1：核心 Agent 运行时（4 周）

**目标**：构建 VirtualEmployeeRuntime + 持久化 + 基础编排。

| 周 | 任务 | 产出 |
|----|------|------|
| 第 3 周 | 1. 实现 `StateStore` 接口 + PostgreSQL 实现<br>2. 数据库 schema 设计和迁移（sessions, messages, checkpoints）<br>3. 实现 `VirtualEmployeeRuntime` 基础框架（事件循环 + 任务队列）<br>4. 自定义 AgentMessage 类型（approval, escalation） | 持久化 Agent 运行时 |
| 第 4 周 | 1. 实现 `TwoPhaseRouter`（规则匹配 + LLM 兜底）<br>2. 实现 `CoordinatorAgent` 基础版<br>3. 实现 `WorkerPool` 和 Worker 生命周期管理<br>4. 集成测试：Coordinator 委派任务给 Worker | 基础编排能力 |
| 第 5 周 | 1. 实现 `ModuleLoader`（YAML 角色定义 → 动态加载）<br>2. 实现模块注册表（tools, skills, rules）<br>3. 创建第一组模块：采购审批（4-5 个 tools + 1 个 skill）<br>4. YAML 配置驱动的角色创建端到端验证 | 动态模块加载 |
| 第 6 周 | 1. 实现断点续传（checkpoint save/restore）<br>2. 实现人类审批工具（request_approval → 挂起 → 恢复）<br>3. 实现 `TenantLLMManager`（多租户 API Key + 用量追踪）<br>4. 集成测试 + 性能基准测试 | 完整的 Agent 运行时 |

### Phase 2：多通道接入和编排增强（4 周）

**目标**：接入 Teams + Email + Webhook，完善编排能力。

| 周 | 任务 | 产出 |
|----|------|------|
| 第 7 周 | 1. 实现 `ChannelAdapter` 接口<br>2. 实现 `TeamsChannelAdapter`（基于 M365 Agents SDK）<br>3. 实现 `ChannelRegistry` 和统一事件路由<br>4. Teams 通道端到端测试 | Teams 通道接入 |
| 第 8 周 | 1. 实现 `EmailChannelAdapter`（MS Graph API + Change Notifications）<br>2. 实现 `PowerAutomateAdapter`（HTTP Webhook）<br>3. 实现 `ChannelSecurityMiddleware`（签名验证 + Entra ID）<br>4. 多通道端到端测试 | Email + Webhook 通道 |
| 第 9 周 | 1. 编排增强：任务超时熔断 + 自动扩缩容<br>2. 审计日志记录（三层存储：PG + Blob + Ledger 的热层）<br>3. 实现 `AuditLogger` 中间件（集成到 Agent 事件流）<br>4. 政府云端点配置策略实现 | 编排增强 + 审计 |
| 第 10 周 | 1. 实现第二组角色模块：HR 助理<br>2. 实现第三组角色模块：项目经理<br>3. 多租户隔离测试<br>4. 端到端集成测试（多通道 → Coordinator → Worker → 回复） | 多角色支持 |

### Phase 3：业务规则引擎和生产化（4 周）

**目标**：完善规则引擎，生产化准备。

| 周 | 任务 | 产出 |
|----|------|------|
| 第 11 周 | 1. 实现 `BusinessRulesEngine`（pre-check + post-validate）<br>2. 实现预置规则：双重审批、预算检查、数据完整性<br>3. 规则配置化：从 YAML/JSON 加载规则定义<br>4. 规则引擎与 Agent 运行时的集成测试 | 规则引擎 |
| 第 12 周 | 1. 可观测性：OpenTelemetry 集成<br>2. 监控仪表板：Agent 健康、任务吞吐、错误率<br>3. 告警规则：升级率、错误率、延迟<br>4. 成本追踪：每租户 token 用量和费用 | 可观测性 |
| 第 13 周 | 1. Terraform 基础设施代码（AKS + PostgreSQL + Service Bus）<br>2. Docker 容器化 + Helm Chart<br>3. 安全加固：Managed Identity、Key Vault 集成、证书认证<br>4. 负载测试 + 性能调优 | 生产化部署 |
| 第 14 周 | 1. 端到端验收测试（采购审批全流程）<br>2. 文档：部署指南、运维手册、API 文档<br>3. 安全审计和渗透测试<br>4. 客户 Demo 环境搭建 | 发布就绪 |

### 路线图可视化

```
Week:  1  2 | 3  4  5  6 | 7  8  9  10 | 11 12 13 14
       ─────┼────────────┼─────────────┼───────────
P0:    ████ |            |             |
P1:         | ████████████|             |
P2:         |            | ████████████ |
P3:         |            |             | ████████████
```

---

## 5. 风险与缓解

### 技术风险

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|---------|
| pi-mono 停止维护 | 低 | 中 | 核心依赖仅 pi-ai（~3000 行）和 pi-agent-core（~400 行），代码量极小，必要时可 fork 维护 |
| pi-mono Breaking Changes | 中 | 低 | 锁定 npm 版本 + 集成测试覆盖 + 薄封装层隔离 |
| M365 Agents SDK 不成熟 | 中 | 中 | Teams 通道做好降级方案（可切换到 Bot Framework v5）；SDK 层做抽象 |
| 政府客户拒绝非微软 LLM | 中 | 高 | 架构支持纯 Azure OpenAI 模式；pi-ai 已支持 azure-openai-responses |
| Agent Loop 在长任务中内存泄漏 | 低 | 高 | 每个任务后 Agent.reset()；监控内存使用；设置任务超时 |
| 多 Agent 并发竞争条件 | 中 | 中 | WorkerPool 的实例隔离 + 任务级别的 agent.reset() 保证无状态共享 |

### 业务风险

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|---------|
| LLM 幻觉导致错误审批 | 中 | 高 | 三层规则保障（pre-check → 执行时断言 → post-validation）；关键操作强制人类审批 |
| 客户不信任 AI 做审批 | 高 | 中 | 决策/执行分离架构；完整审计追踪；从"辅助推荐"起步，逐步提升自主权 |
| 数据泄露 | 低 | 极高 | 决策/执行分离（敏感数据不出客户边界）；零保留 LLM 端点；加密 + 隔离 |

---

## 附录 A：项目目录结构（推荐）

```
agentic/
├── packages/
│   ├── core/                      # VirtualEmployeeRuntime + StateStore
│   │   ├── src/
│   │   │   ├── runtime/           # VirtualEmployeeRuntime
│   │   │   ├── orchestration/     # CoordinatorAgent + WorkerPool
│   │   │   ├── state/             # PostgreSQL StateStore
│   │   │   ├── events/            # EventLoop + TaskQueue
│   │   │   └── audit/             # AuditLogger
│   │   └── package.json
│   │
│   ├── llm/                       # TenantLLMManager 封装
│   │   ├── src/
│   │   │   ├── tenant-manager.ts
│   │   │   ├── government-endpoints.ts
│   │   │   └── usage-tracker.ts
│   │   └── package.json
│   │
│   ├── channels/                  # 多通道适配器
│   │   ├── src/
│   │   │   ├── registry.ts
│   │   │   ├── adapters/
│   │   │   │   ├── teams.ts
│   │   │   │   ├── email.ts
│   │   │   │   └── power-automate.ts
│   │   │   └── security/
│   │   └── package.json
│   │
│   ├── rules/                     # 业务规则引擎
│   │   ├── src/
│   │   │   ├── engine.ts
│   │   │   ├── presets/
│   │   │   └── loader.ts
│   │   └── package.json
│   │
│   └── modules/                   # 动态模块加载器
│       ├── src/
│       │   ├── loader.ts
│       │   └── registry.ts
│       └── package.json
│
├── modules/                       # 可插拔模块
│   ├── tools/
│   │   ├── dataverse-crud/
│   │   ├── graph-email/
│   │   ├── graph-calendar/
│   │   └── budget-checker/
│   ├── skills/
│   │   ├── procurement-approval/
│   │   ├── hr-onboarding/
│   │   └── project-management/
│   └── rules/
│       ├── dual-approval/
│       └── budget-threshold/
│
├── roles/                         # YAML 角色定义
│   ├── procurement-officer.yaml
│   ├── hr-assistant.yaml
│   └── project-manager.yaml
│
├── infra/                         # 基础设施代码
│   ├── terraform/
│   ├── helm/
│   └── docker/
│
├── docs/
├── research/
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

## 附录 B：关键依赖版本

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@mariozechner/pi-ai` | ^0.56.x | LLM 统一抽象层 |
| `@mariozechner/pi-agent-core` | ^0.56.x | Agent Loop 运行时 |
| `@microsoft/microsoft-graph-client` | ^3.x | Graph API 调用 |
| `@azure/msal-node` | ^2.x | OAuth 2.0 认证 |
| `@azure/identity` | ^4.x | Managed Identity |
| `@azure/keyvault-secrets` | ^4.x | Key Vault 集成 |
| `@azure/service-bus` | ^7.x | 事件总线 |
| `pg` + `@types/pg` | ^8.x | PostgreSQL |
| `@sinclair/typebox` | ^0.34.x | 工具参数验证（pi-agent-core 依赖） |
| TypeScript | ^5.8.x | 开发语言 |
| Node.js | ^22.x | 运行时 |

---

> **总结**：本方案的核心策略是"站在巨人的肩膀上"——用 pi-ai 解决 LLM 抽象问题，用 pi-agent-core 解决 Agent Loop 问题，把精力集中在真正的差异化价值上：Dynamic Hierarchical MoE 编排、YAML 驱动的角色配置、确定性业务规则引擎、以及企业/政府级别的安全和审计。
