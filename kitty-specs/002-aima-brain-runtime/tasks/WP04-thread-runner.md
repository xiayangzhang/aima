---
work_package_id: "WP04"
title: "ThreadRunner（路由 + 崩溃恢复 + pending）"
lane: "planned"
dependencies: ["WP01", "WP02"]
subtasks: ["T017", "T018", "T019", "T020", "T021", "T022", "T023", "T024"]
history:
  - 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
---

# WP04 — ThreadRunner

## 目标

实现 AIMA 框架层核心编排器：监听 Slot 变化，按路由规则激活脑区，处理崩溃恢复和 pending_observations 路由。ThreadRunner 与适配器无关，对上层透明。

## 上下文

- 依赖 WP01：BrainAdapter 接口、CognitiveWorkspace Signals 扩展
- 依赖 WP02：assembleContext() 函数
- 新建文件：`src/runner/index.ts`
- 扩展文件：`src/workspace/index.ts`（追加 waitForComplete 和 onSlotChange 方法）
- 并发模型：Thread 间并行，Thread 内顺序（任意时刻单 Thread 只有一个脑区持有写权限）
- 架构参考：01-agent-architecture.md §四

## 路由规则（完整版）

来自 01-agent-architecture.md §四 激活触发条件表：

| 当前 Slot | 状态 | 路由到 |
|---|---|---|
| limbic | done，output.mode = 'RESPOND' 或 'NO_REPLY' | Thread complete |
| limbic | done，output.mode = 'ROUTE'（含 needs_analysis） | 激活 Cortex |
| limbic | done，output.mode = 'EXECUTE' | 激活 Brainstem（跳过 Cortex） |
| limbic | done，output.mode = 'DEFER' | 写 pending（trigger_at = now + timeout_ms） |
| cortex | done，output.intent = 'communicate' | 激活 Limbic |
| cortex | done，output.intent = 'execute' | 激活 Brainstem |
| cortex | done，output.intent = 'both' | 先激活 Limbic（试探），再激活 Brainstem |
| brainstem | done，Thread 的 Cortex Slot intent = 'both' | 再次激活 Limbic（最终确认） |

## 实现指导

### T017 — ThreadRunnerConfig 类型

**文件**：`src/runner/index.ts`（新建）

```typescript
import type { BrainAdapter, BrainRunParams } from '../adapters/index'
import type { BrainEventBus } from '../eventbus/index'
import type { CognitiveBrainType, CognitiveWorkspace, MemoryEntry } from '../types/index'
import type { ContextAssemblerConfig } from '../context/index'
import { assembleContext, assembleBlock12 } from '../context/index'

export interface ThreadRunnerConfig {
  workspace: CognitiveWorkspace
  eventBus: BrainEventBus
  adapters: Map<CognitiveBrainType, BrainAdapter>
  assemblerConfig: ContextAssemblerConfig
}
```

### T018 — ThreadRunner.start()：订阅变化 + 崩溃恢复

```typescript
export class ThreadRunner {
  private workspace: CognitiveWorkspace
  private eventBus: BrainEventBus
  private adapters: Map<CognitiveBrainType, BrainAdapter>
  private assemblerConfig: ContextAssemblerConfig
  private cachedBlock12: Record<CognitiveBrainType, string>
  private brainSessions: Map<string, string> = new Map()  // `${brain}:${threadId}` → sessionId
  private processingThreads: Set<string> = new Set()       // Thread 内顺序保证
  private running = false

  constructor(config: ThreadRunnerConfig) {
    this.workspace = config.workspace
    this.eventBus = config.eventBus
    this.adapters = config.adapters
    this.assemblerConfig = config.assemblerConfig
    // Block 1/2 在构造时生成一次，后续不变（prompt cache 前缀）
    this.cachedBlock12 = {
      limbic: assembleBlock12('limbic', config.assemblerConfig),
      cortex: assembleBlock12('cortex', config.assemblerConfig),
      brainstem: assembleBlock12('brainstem', config.assemblerConfig),
    }
  }

  async start(): Promise<void> {
    this.running = true
    await this.recoverInFlightThreads()
    this.workspace.onSlotChange((event) => { void this.route(event) })
    this.workspace.onThreadComplete((threadId) => {
      this.eventBus.emit({
        event_type: 'thread.complete',
        level: 'INFO',
        brain: 'dmn',
        thread_id: threadId,
        session_id: null,
        payload: { threadId },
      })
    })
  }

  stop(): void {
    this.running = false
  }
}
```

### T019 — ThreadRunner.route()：核心路由

```typescript
private async route(event: { threadId: string; brain: CognitiveBrainType; slotStatus: string }): Promise<void> {
  if (!this.running) return
  const { threadId, brain, slotStatus } = event
  if (slotStatus !== 'done') return

  // Thread 内顺序保证：同一 Thread 不并发路由
  if (this.processingThreads.has(threadId)) return
  this.processingThreads.add(threadId)

  try {
    const thread = await this.workspace.getThread(threadId)
    if (!thread || thread.state === 'complete' || thread.state === 'interrupted') return

    const slots = await this.workspace.getSlotsByThread(threadId)
    const slotMap = Object.fromEntries(slots.map(s => [s.brain, s]))

    if (brain === 'limbic') {
      const output = slotMap['limbic']?.output as Record<string, unknown> | null
      const mode = output?.['mode'] as string | undefined

      if (mode === 'RESPOND' || mode === 'NO_REPLY') {
        await this.workspace.updateThreadState(threadId, 'complete')
      } else if (mode === 'ROUTE') {
        await this.activateBrain('cortex', threadId)
      } else if (mode === 'EXECUTE') {
        await this.activateBrain('brainstem', threadId)
      } else if (mode === 'DEFER') {
        const timeoutMs = (output?.['timeout_ms'] as number) ?? 60_000
        const triggerAt = new Date(Date.now() + timeoutMs)
        await this.workspace.writePending({
          targetBrain: 'limbic',
          note: 'DEFER timeout — re-activate Limbic with channel downgrade',
          triggerAt,
          expiresAt: new Date(triggerAt.getTime() + 7 * 24 * 60 * 60 * 1000),
        })
      }
    } else if (brain === 'cortex') {
      const output = slotMap['cortex']?.output as Record<string, unknown> | null
      const intent = output?.['intent'] as string | undefined

      if (intent === 'communicate') {
        await this.activateBrain('limbic', threadId)
      } else if (intent === 'execute') {
        await this.activateBrain('brainstem', threadId)
      } else if (intent === 'both') {
        // 先激活 Limbic（试探性回复），Limbic done 后再激活 Brainstem（见 limbic 路由分支）
        // Limbic 在 Block 3 里看到 Brainstem Slot 不存在 → 给试探性回复
        await this.activateBrain('limbic', threadId)
        // Brainstem 的激活由第二次 Limbic done 触发（见下方 brainstem 分支）
      }
    } else if (brain === 'brainstem') {
      // Brainstem done：检查是否是 intent=both 路径（需要再次激活 Limbic 发最终确认）
      const cortexOutput = slotMap['cortex']?.output as Record<string, unknown> | null
      if (cortexOutput?.['intent'] === 'both') {
        await this.activateBrain('limbic', threadId)
      } else {
        await this.workspace.updateThreadState(threadId, 'complete')
      }
    }
  } finally {
    this.processingThreads.delete(threadId)
  }
}
```

**注意**：`intent=both` 的 Limbic 二次激活（试探性 vs 最终确认）靠 Limbic 读 Block 3 里的 Slot 状态区分：第一次激活时 Brainstem Slot 不存在，第二次时 Brainstem Slot status=done。Limbic 读状态即可区分，ThreadRunner 不需要额外字段。

### T020 — ThreadRunner.routePending()

```typescript
async routePending(): Promise<void> {
  if (!this.running) return
  const now = new Date()
  await this.workspace.removeExpiredPending(now)
  const pending = await this.workspace.getPendingObservations()

  for (const item of pending) {
    if (item.triggerAt !== null && item.triggerAt > now) continue

    const thread = await this.workspace.createThread({
      initiatedBy: 'dmn',
      trigger: item.note,
      sourceChannel: null,
    })

    await this.activateBrain(item.targetBrain as CognitiveBrainType, thread.id)
    await this.workspace.removePending(item.id)
  }
}
```

### T021 — ThreadRunner.activateBrain()

```typescript
private async activateBrain(brain: CognitiveBrainType, threadId: string): Promise<void> {
  const adapter = this.adapters.get(brain)
  if (!adapter) throw new Error(`No adapter for brain: ${brain}`)

  const sessionKey = `${brain}:${threadId}`
  const sessionId = this.brainSessions.get(sessionKey)

  // Context Assembly
  const { systemPrompt, injectedMemoryIds } = await assembleContext(
    brain, this.workspace, threadId, this.assemblerConfig, this.cachedBlock12[brain]
  )

  this.eventBus.emit({
    event_type: 'brain.activate',
    level: 'INFO',
    brain,
    thread_id: threadId,
    session_id: sessionId ?? null,
    payload: { brain, threadId },
  })

  const params: BrainRunParams = {
    brain,
    threadId,
    systemPrompt,
    initialPrompt: sessionId ? undefined : `Thread ${threadId} started`,
  }

  const result = await adapter.run(params)

  // 保存 session ID（供后续 Thread 内激活续接 session）
  this.brainSessions.set(sessionKey, result.sessionId)

  this.eventBus.emit({
    event_type: 'brain.complete',
    level: 'INFO',
    brain,
    thread_id: threadId,
    session_id: result.sessionId,
    payload: {
      brain,
      threadId,
      stopReason: result.stopReason,
      injectedMemoryIds,
    },
  })
}
```

### T022 — 崩溃恢复

```typescript
private async recoverInFlightThreads(): Promise<void> {
  const activeThreads = await this.workspace.getActiveThreads()
  for (const thread of activeThreads) {
    const slots = await this.workspace.getSlotsByThread(thread.id)
    const doneSlots = slots.filter(s => s.status === 'done')

    if (doneSlots.length === 0) {
      // Thread 创建了但 Limbic 还没激活过
      await this.activateBrain('limbic', thread.id)
    } else {
      // 找最后一个 done 的 Slot，激活下一个应该激活的脑区
      const lastDone = doneSlots.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
      if (lastDone) {
        // 复用路由逻辑（直接调用 route）
        void this.route({ threadId: thread.id, brain: lastDone.brain as CognitiveBrainType, slotStatus: 'done' })
      }
    }
  }
}
```

### T023 — Thread 内顺序保证（processingThreads flag）

已在 T019 的 route() 中实现（`processingThreads.add/delete`）。补充 edge case：
- `processingThreads` 是 `Set<string>`，防止同一 Thread 的两次 Slot done 事件并发路由
- `finally` 块保证即使 activateBrain 抛出也会释放锁

### T024 — CognitiveWorkspace 扩展：waitForComplete + onSlotChange

在 `src/workspace/index.ts` 追加（不改动已有方法）：

```typescript
// 内部 EventEmitter，供 ThreadRunner 订阅
private wsEmitter = new EventEmitter()

// 适配器写 Slot 完成后调用（由适配器 run() 完成时触发）
notifySlotDone(threadId: string, brain: CognitiveBrainType, slotStatus: string): void {
  this.wsEmitter.emit('slot_change', { threadId, brain, slotStatus })
}

// Thread 状态变为 complete 时触发
notifyThreadComplete(threadId: string): void {
  this.wsEmitter.emit('thread_complete', threadId)
}

// ThreadRunner 订阅 Slot 变化
onSlotChange(handler: (event: { threadId: string; brain: CognitiveBrainType; slotStatus: string }) => void): () => void {
  this.wsEmitter.on('slot_change', handler)
  return () => { this.wsEmitter.off('slot_change', handler) }
}

// ThreadRunner 订阅 Thread 完成
onThreadComplete(handler: (threadId: string) => void): () => void {
  this.wsEmitter.on('thread_complete', handler)
  return () => { this.wsEmitter.off('thread_complete', handler) }
}

// AIMAInstance.receive() 等待 Thread 完成
waitForComplete(threadId: string): Promise<void> {
  return new Promise((resolve) => {
    // 先检查当前状态（处理竞态：complete 在订阅前触发）
    this.getThread(threadId).then(thread => {
      if (thread?.state === 'complete' || thread?.state === 'interrupted') {
        resolve()
        return
      }
      const handler = (id: string) => {
        if (id === threadId) {
          this.wsEmitter.off('thread_complete', handler)
          resolve()
        }
      }
      this.wsEmitter.on('thread_complete', handler)
    }).catch(() => resolve())
  })
}
```

**重要**：适配器的 run() 完成后（BrainRunResult 返回后），需要把 Slot 写入工作空间并调用 `workspace.notifySlotDone()`。这个调用放在 ThreadRunner.activateBrain() 里，在 adapter.run() 返回后执行。

## Definition of Done

- [ ] T017: ThreadRunnerConfig 类型，ThreadRunner 类构造函数，cachedBlock12 预计算
- [ ] T018: start() 订阅工作空间变化，执行崩溃恢复
- [ ] T019: route() 覆盖所有 intent 分支（RESPOND/NO_REPLY/ROUTE/EXECUTE/DEFER/communicate/execute/both）
- [ ] T020: routePending() 从 pending_observations 创建 Thread 并激活
- [ ] T021: activateBrain() 调用 Context Assembly + adapter.run() + 发射 EventBus 事件
- [ ] T022: recoverInFlightThreads() 处理崩溃恢复
- [ ] T023: processingThreads flag 防止同 Thread 路由重入
- [ ] T024: CognitiveWorkspace 扩展 waitForComplete/onSlotChange/onThreadComplete
- [ ] bun run typecheck 零错误，biome check 通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
spec-kitty agent tasks move-task WP04 --to for_review --note "Ready: <summary>"
```
