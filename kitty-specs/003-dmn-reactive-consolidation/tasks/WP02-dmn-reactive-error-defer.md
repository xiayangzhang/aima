---
work_package_id: WP02
title: DmnReactive — 错误恢复 + DEFER + 信号捕获
lane: "for_review"
dependencies: []
subtasks: [T005, T006, T007, T008, T009]
agent: "claude"
shell_pid: "52157"
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP02 — DmnReactive — 错误恢复 + DEFER + 信号捕获

## 目标

实现 DmnReactive 的事件订阅框架，以及职责1（错误恢复）、职责6（DEFER 调度）、职责7（信号捕获）三项职责的完整实现。

## 上下文

- 依赖 WP01：`DmnConfig`、`callLlm()`、`DmnReactive` 骨架
- 修改文件：`src/dmn/reactive/index.ts`（填充 WP01 骨架）
- Event Bus 事件类型参考：`src/eventbus/index.ts`（`BrainEvent.type` 枚举）
- Workspace 接口参考：`src/workspace/index.ts`（`writeSlot`, `writePending`, `writeMemory`）
- 架构参考：`docs/01-agent-architecture.md` §七"事件响应"职责1/6/7

## 核心架构：异步 Handler 隔离

DmnReactive 的所有事件处理必须遵循"同步入口 + 异步执行 + 错误隔离"模式：

```typescript
// src/dmn/reactive/index.ts

export class DmnReactive {
  private unsubscribe?: () => void
  private inFlightHandlers = new Set<Promise<void>>()

  async start(): Promise<void> {
    const eventBus = this.config.eventBus
    this.unsubscribe = eventBus.subscribe((event) => {
      // 同步入口：立即 launch，不 await
      const p = this.handleEvent(event).catch((err) => {
        // 错误隔离：handler 失败不影响 Event Bus 其他订阅者
        eventBus.emit({
          type: 'dmn.handler_error',
          level: 'ALERT',
          brain: 'dmn',
          threadId: event.threadId ?? 'unknown',
          payload: { error: String(err), originalEvent: event.type }
        })
      })
      // 追踪进行中的 handler（供 stop() 等待完成）
      this.inFlightHandlers.add(p)
      p.finally(() => this.inFlightHandlers.delete(p))
    })
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    // 等待所有进行中的 handler 完成（最多 10 秒）
    await Promise.race([
      Promise.all([...this.inFlightHandlers]),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000))
    ])
  }

  private async handleEvent(event: BrainEvent): Promise<void> {
    // 按事件类型分发
    if (event.level === 'ALERT' && event.payload?.errorType) {
      await this.handleError(event)
    }
    if (event.type === 'brain.complete' && event.payload?.outputSlot?.output?.mode === 'DEFER') {
      await this.handleDefer(event)
    }
    // 信号捕获：对所有 INFO+ 事件尝试规则匹配
    await this.handleSignalCapture(event)
  }
}
```

## 实现指导

### T005 — DmnReactive 类结构 + Event Bus 订阅

按上方"核心架构"完整实现 `start()` / `stop()` / `handleEvent()` 框架。

**`handleEvent()` 的事件路由完整版**（WP02 实现职责1/6/7，WP03 实现职责2/3/4/5）：

```typescript
private async handleEvent(event: BrainEvent): Promise<void> {
  const { type, level, brain, threadId, payload } = event

  // 职责1：错误恢复（ALERT 事件）
  if (level === 'ALERT' && payload?.retryable !== undefined) {
    await this.handleErrorRecovery(event)
  }

  // 职责6：DEFER 调度（Limbic Slot done + mode=DEFER）
  if (type === 'slot.done' && brain === 'limbic' && payload?.output?.mode === 'DEFER') {
    await this.handleDefer(event)
  }

  // 职责7：信号捕获（INFO+ 事件）
  if (['INFO', 'COMPLIANCE', 'ALERT'].includes(level)) {
    await this.handleSignalCapture(event)
  }

  // 职责2/3/4/5 在 WP03 实现（brain.complete）
}
```

---

### T006 — 错误恢复 handler（职责1）

```typescript
private async handleErrorRecovery(event: BrainEvent): Promise<void> {
  const { brain, threadId, payload } = event
  const workspace = this.config.workspace
  const maxRetries = this.config.maxRetries ?? 3

  // 读取当前重试计数
  const retryMemories = await workspace.searchMemory({
    type: 'working',
    threadId,
    // 通过 tag 过滤 retry 计数记录
    tags: ['dmn_retry_count'],
    excludeInvalid: true,
    limit: 1
  })

  const retryRecord = retryMemories[0]
  const retryData = retryRecord
    ? (JSON.parse(retryRecord.content) as { count: number; brain: string })
    : { count: 0, brain }

  if (payload?.retryable && retryData.count < maxRetries) {
    // 可重试：写 retry Slot，Thread Runner 下次轮询重新激活
    await workspace.writeSlot({
      thread_id: threadId,
      brain,
      status: 'pending',   // 重置为 pending，触发重新激活
      output: {
        retry: true,
        retryCount: retryData.count + 1,
        lastError: payload.errorMessage ?? 'unknown'
      }
    })

    // 更新重试计数（写 working 记忆）
    await workspace.writeMemory({
      type: 'working',
      threadId,
      content: JSON.stringify({ count: retryData.count + 1, brain }),
      tags: ['dmn_retry_count'],
      base_importance: 1.0,  // working 记忆重要度设最高，确保不被 evict
    })

    this.config.eventBus.emit({
      type: 'dmn.retry_scheduled',
      level: 'INFO',
      brain: 'dmn',
      threadId,
      payload: { targetBrain: brain, retryCount: retryData.count + 1 }
    })
  } else {
    // 不可重试 or 超限：标记 Thread interrupted
    await workspace.updateThreadState(threadId, 'interrupted')

    this.config.eventBus.emit({
      type: 'dmn.thread_interrupted',
      level: 'ALERT',
      brain: 'dmn',
      threadId,
      payload: {
        reason: payload?.retryable ? 'max_retries_exceeded' : 'non_retryable_error',
        errorMessage: payload?.errorMessage
      }
    })
  }
}
```

---

### T007 — DEFER 调度 handler（职责6）

```typescript
private async handleDefer(event: BrainEvent): Promise<void> {
  const { threadId, payload } = event
  const workspace = this.config.workspace

  const timeoutMs = payload?.output?.timeout_ms ?? 3_600_000  // 默认 1 小时
  const deferReason = payload?.output?.defer_reason ?? 'unspecified'
  const triggerAt = new Date(Date.now() + timeoutMs)

  await workspace.writePending({
    target_brain: 'limbic',
    note: `[DEFER recovery] Original reason: ${deferReason}. Thread: ${threadId}`,
    trigger_at: triggerAt,
    expires_at: new Date(triggerAt.getTime() + 7 * 24 * 60 * 60 * 1000),  // TTL 7天
    base_importance: 0.5
  })

  this.config.eventBus.emit({
    type: 'dmn.defer_scheduled',
    level: 'INFO',
    brain: 'dmn',
    threadId,
    payload: { triggerAt: triggerAt.toISOString(), reason: deferReason }
  })
}
```

---

### T008 — 信号捕获 handler（职责7）

信号捕获使用两层决策：确定性规则优先，无规则命中时 Haiku fallback。

```typescript
// 确定性规则表（可通过 DmnConfig 覆盖）
const DEFAULT_SIGNAL_RULES: SignalRule[] = [
  {
    // 规则示例：跨 Thread 任务完成信号
    match: (event) => event.type === 'brain.complete' && event.payload?.output?.creates_followup,
    handle: async (event, workspace) => {
      await workspace.writePending({
        target_brain: event.payload.output.followup_brain ?? 'limbic',
        note: event.payload.output.followup_note ?? 'Follow-up from completed task',
        trigger_at: new Date(),  // 立即可路由
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        base_importance: 0.6
      })
    }
  }
  // 更多规则由上层应用通过 DmnConfig.signalRules 注入
]

export interface SignalRule {
  match: (event: BrainEvent) => boolean
  handle: (event: BrainEvent, workspace: CognitiveWorkspace) => Promise<void>
}

private async handleSignalCapture(event: BrainEvent): Promise<void> {
  const rules = this.config.signalRules ?? DEFAULT_SIGNAL_RULES

  for (const rule of rules) {
    if (rule.match(event)) {
      await rule.handle(event, this.config.workspace)
      return  // 第一条匹配规则处理后退出
    }
  }

  // 无规则命中 + 高风险事件 → Haiku fallback
  if (event.level === 'ALERT' && !event.payload?.retryable) {
    await this.haikusignalFallback(event)
  }
}

private async haikusignalFallback(event: BrainEvent): Promise<void> {
  const prompt = `You are analyzing an AIMA brain event to determine if it requires a follow-up action.

Event: ${JSON.stringify(event, null, 2)}

Respond with JSON:
{
  "requires_followup": boolean,
  "target_brain": "limbic" | "cortex" | "brainstem" | null,
  "note": string  // description for pending observation
}

Only set requires_followup=true if there is a clear, actionable follow-up needed.`

  const response = await callLlm(prompt, this.config.llm)
  const result = parseLlmJson<{ requires_followup: boolean; target_brain: string | null; note: string }>(
    response, { requires_followup: false, target_brain: null, note: '' }
  )

  if (result.requires_followup && result.target_brain) {
    await this.config.workspace.writePending({
      target_brain: result.target_brain as any,
      note: result.note,
      trigger_at: new Date(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      base_importance: 0.4
    })
  }
}
```

---

### T009 — 重试计数追踪

重试计数通过 `working` 类型记忆存储（利用已有接口，不新建表）。

在 T006 已实现。补充：**Thread 完成时自动清理**——`working` 记忆在 `workspace.clearWorkingMemory(threadId)` 时随 Thread 完成自动删除，不需要 DMN 手动清理。

验证：在 `workspace.clearWorkingMemory()` 的实现中确认它删除所有 `type='working' AND thread_id=?` 的记录（Feature 001 应已实现，确认即可）。

## 验收标准

- [ ] `DmnReactive.start()` 订阅 Event Bus，`stop()` 取消订阅并等待进行中 handler
- [ ] ALERT 可重试事件 → Slot status 重置为 pending，retry 计数写入 working 记忆
- [ ] ALERT 不可重试 or 超过 maxRetries → Thread status = interrupted
- [ ] Limbic DEFER Slot → pending 写入正确 trigger_at（now + timeout_ms）
- [ ] 信号捕获规则命中 → pending 写入；无命中 + ALERT → Haiku fallback
- [ ] Handler 抛出异常时，Event Bus 发射 `dmn.handler_error` 事件，不传播到调用方

## 实现命令

```bash
spec-kitty implement WP02 --base WP01
```

## Activity Log

- 2026-03-10T14:35:42Z – claude – shell_pid=52157 – lane=doing – Started implementation via workflow command
- 2026-03-10T14:53:40Z – claude – shell_pid=52157 – lane=for_review – Ready for review: DmnReactive full implementation — event subscription with handler isolation, error recovery (retry via working memory), DEFER scheduling, signal capture with rule engine + Haiku fallback. 7 unit tests passing.
