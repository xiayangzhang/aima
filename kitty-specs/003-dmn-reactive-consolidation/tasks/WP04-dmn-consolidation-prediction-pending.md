---
work_package_id: WP04
title: DmnConsolidation — 前瞻预测 + Pending 维护
lane: planned
dependencies: []
subtasks: [T015, T016, T017, T018, T019]
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP04 — DmnConsolidation — 前瞻预测 + Pending 维护

## 目标

实现 DmnConsolidation 的心跳框架（定时器 + 增量追踪），以及职责1（前瞻预测）和职责2（pending 维护）的完整实现。

## 上下文

- 依赖 WP01：`DmnConfig`、`callLlm()`、`parseLlmJson()`、`DmnConsolidation` 骨架
- 修改文件：`src/dmn/consolidation/index.ts`（填充 WP01 骨架）
- Workspace 接口：`writePending`、`getPendingObservations`、`removePending`、`searchMemory`
- 架构参考：`docs/01-agent-architecture.md` §七"心跳整合"职责1/2

## 实现指导

### T015 — DmnConsolidation 类结构 + 心跳定时器

```typescript
// src/dmn/consolidation/index.ts

export class DmnConsolidation {
  private timer?: ReturnType<typeof setInterval>
  private running = false
  private lastRunAt: Date
  // 防止心跳重入（上一轮未完成时跳过本轮）
  private currentRun?: Promise<void>

  constructor(private config: DmnConfig) {
    // 首次运行时，回溯一个间隔，避免进程重启后遗漏事件
    const intervalMs = config.consolidationIntervalMs ?? 30 * 60 * 1000
    this.lastRunAt = new Date(Date.now() - intervalMs)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    const intervalMs = this.config.consolidationIntervalMs ?? 30 * 60 * 1000

    this.timer = setInterval(() => {
      if (this.currentRun) return  // 上一轮还在运行，跳过本轮
      this.currentRun = this.runOnce()
        .catch(err => {
          this.config.eventBus?.emit({
            type: 'dmn.consolidation_error',
            level: 'ALERT',
            brain: 'dmn',
            threadId: 'consolidation',
            payload: { error: String(err) }
          })
        })
        .finally(() => { this.currentRun = undefined })
    }, intervalMs)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    clearInterval(this.timer)
    // 等待当前批次完成
    if (this.currentRun) {
      await Promise.race([
        this.currentRun,
        new Promise<void>(r => setTimeout(r, 30_000))  // 最多等 30 秒
      ])
    }
  }

  async runOnce(): Promise<void> {
    const runStart = new Date()

    // 读取增量（created_at > lastRunAt）
    const increment = await this.readEpisodicIncrement()

    // 三项职责并发执行（互不阻塞）
    await Promise.allSettled([
      this.runPredictiveActivation(increment),
      this.runPendingMaintenance(increment),
      this.runImplicitClustering(),  // 在 WP05 实现，此处留空
    ])

    this.lastRunAt = runStart
  }
}
```

---

### T016 — 读 episodic 增量

```typescript
private async readEpisodicIncrement(): Promise<MemoryEntry[]> {
  // 按时间窗口读取 episodic 增量
  // CognitiveWorkspace.searchMemory 支持 createdAfter 过滤（确认 Feature 001 接口）
  const entries = await this.config.workspace.searchMemory({
    type: 'episodic',
    createdAfter: this.lastRunAt,   // 需要确认 searchMemory 是否支持此参数
    excludeInvalid: true,
    limit: 500   // 单批最大 500 条，防止内存溢出
  })

  return entries
}
```

**注意**：如果 Feature 001 的 `searchMemory` 不支持 `createdAfter` 参数，需要先扩展 `MemorySearchParams` 类型和 `searchMemory()` 实现（在 `src/workspace/index.ts` 中追加）。这是实现时需要检查的依赖点。

---

### T017 — 前瞻预测：读取记忆模式

```typescript
private async runPredictiveActivation(increment: MemoryEntry[]): Promise<void> {
  if (increment.length === 0) return

  // 读取支撑预测的三类记忆
  const [procedural, semantic] = await Promise.all([
    this.config.workspace.searchMemory({
      type: 'procedural',
      excludeInvalid: true,
      limit: 20
    }),
    this.config.workspace.searchMemory({
      type: 'semantic',
      excludeInvalid: true,
      limit: 20
    })
  ])

  // 构建 LLM 提示
  const prompt = buildPredictivePrompt(increment, procedural, semantic)
  const response = await callLlm(prompt, this.config.llm, {
    useComplexModel: increment.length > 50,  // 增量多时升级到 Sonnet
    maxTokens: 1024
  })

  const predictions = parseLlmJson<PredictionResult[]>(response, [])
  await this.writePredictions(predictions)
}
```

---

### T018 — 前瞻预测：LLM 判断 + pending 写入

```typescript
function buildPredictivePrompt(
  episodic: MemoryEntry[],
  procedural: MemoryEntry[],
  semantic: MemoryEntry[]
): string {
  return `You are analyzing recent activity patterns to predict future tasks.

Recent events (episodic, last ${episodic.length} entries):
${episodic.slice(-10).map(e => e.content).join('\n')}

Known procedures (procedural memory):
${procedural.slice(0, 5).map(e => `- ${e.content.slice(0, 150)}`).join('\n')}

Domain knowledge (semantic memory):
${semantic.slice(0, 5).map(e => `- ${e.content.slice(0, 150)}`).join('\n')}

Based on these patterns, identify upcoming tasks that should be scheduled.
Only predict tasks with clear, specific triggers from the patterns above.

Respond with a JSON array (empty array if no predictions):
[
  {
    "target_brain": "limbic" | "cortex" | "brainstem",
    "note": "specific task description with context",
    "trigger_at_hours": number,  // hours from now (0 = immediate)
    "confidence": "high" | "medium" | "low"
  }
]

Only include "high" or "medium" confidence predictions.`
}

interface PredictionResult {
  target_brain: 'limbic' | 'cortex' | 'brainstem'
  note: string
  trigger_at_hours: number
  confidence: 'high' | 'medium' | 'low'
}

private async writePredictions(predictions: PredictionResult[]): Promise<void> {
  for (const pred of predictions) {
    if (pred.confidence === 'low') continue  // 低置信度不写

    const triggerAt = new Date(Date.now() + pred.trigger_at_hours * 60 * 60 * 1000)
    await this.config.workspace.writePending({
      target_brain: pred.target_brain,
      note: `[DMN Prediction] ${pred.note}`,
      trigger_at: triggerAt,
      expires_at: new Date(triggerAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      base_importance: pred.confidence === 'high' ? 0.7 : 0.5
    })
  }
}
```

---

### T019 — Pending 维护（职责2）

```typescript
private async runPendingMaintenance(increment: MemoryEntry[]): Promise<void> {
  const pendingItems = await this.config.workspace.getPendingObservations()
  if (pendingItems.length === 0) return

  const prompt = `You are reviewing scheduled pending tasks to determine if they are still relevant.

Recent activity (last ${Math.min(increment.length, 10)} events):
${increment.slice(-10).map(e => e.content).join('\n')}

Pending tasks to evaluate:
${pendingItems.map((p, i) => `[${i}] target=${p.target_brain} note="${p.note}" added=${p.added_at}`).join('\n')}

For each pending task, decide: remove (task completed/no longer relevant), keep (still valid), or update (circumstances changed).

Respond with JSON array with one entry per pending task in the same order:
[
  {
    "action": "remove" | "keep" | "update",
    "updated_note": string | null  // only if action="update"
  }
]`

  const response = await callLlm(prompt, this.config.llm, { maxTokens: 1024 })
  const decisions = parseLlmJson<Array<{ action: string; updated_note: string | null }>>(
    response, pendingItems.map(() => ({ action: 'keep', updated_note: null }))
  )

  for (let i = 0; i < pendingItems.length; i++) {
    const item = pendingItems[i]
    const decision = decisions[i]
    if (!item || !decision) continue

    if (decision.action === 'remove') {
      await this.config.workspace.removePending(item.id)
    } else if (decision.action === 'update' && decision.updated_note) {
      // 更新：删旧写新（writePending 的 upsert 行为）
      await this.config.workspace.removePending(item.id)
      await this.config.workspace.writePending({
        ...item,
        note: decision.updated_note,
        // 保留原有 trigger_at 和 expires_at
      })
    }
    // 'keep' → 不操作
  }
}
```

## 验收标准

- [ ] `DmnConsolidation.start()` 以配置的间隔触发心跳，`stop()` 清除定时器
- [ ] 心跳重入保护：上一轮未完成时跳过本轮（`currentRun` 检查）
- [ ] `lastRunAt` 在每次 `runOnce()` 完成后更新为运行开始时间
- [ ] `runPredictiveActivation()` 读三类记忆，LLM 返回预测后写入 pending
- [ ] 低置信度预测（`confidence=low`）不写 pending
- [ ] `runPendingMaintenance()` 正确处理 remove/keep/update 三种决策

## 实现命令

```bash
spec-kitty implement WP04 --base WP01
```
