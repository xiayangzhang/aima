---
work_package_id: WP03
title: DmnReactive — brain.complete 四联职责
lane: "for_review"
dependencies: []
subtasks: [T010, T011, T012, T013, T014]
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP03 — DmnReactive — brain.complete 四联职责

## 目标

实现 `brain.complete` 事件触发的四项并发职责：段分配（职责3）、显著性处理（职责4）、记忆使用反馈（职责5）、回溯纠错（职责2）。

## 上下文

- 依赖 WP01：`DmnConfig`、`callLlm()`、`parseLlmJson()`
- 依赖 WP02：`DmnReactive` 类框架（在 WP02 的 `handleEvent()` 中已预留 brain.complete 分支）
- 修改文件：`src/dmn/reactive/index.ts`（追加 brain.complete handler）
- `BrainEvent.type = 'brain.complete'` 由 Feature 002 的 Adapter 发射，`payload.injectedMemoryIds` 来自 `BrainRunResult`
- 架构参考：`docs/01-agent-architecture.md` §七"事件响应"职责2/3/4/5

## 段分配的核心数据结构

```typescript
// DmnReactive 类内部 Map（进程级，重启后重置）
private threadSegments = new Map<string, {
  segmentId: string   // 当前段 ID（UUID）
  nextSeq: number     // 下一条 episodic 的 segment_seq
}>()
```

重启后第一个 `brain.complete` 事件自动开启新 segment（重启本身是天然段边界）。

## brain.complete 事件 payload 结构

Feature 002 的 Adapter 在 `brain.complete` 时发射：
```typescript
{
  type: 'brain.complete',
  level: 'INFO',
  brain: 'limbic' | 'cortex' | 'brainstem',
  threadId: string,
  payload: {
    injectedMemoryIds: string[],    // Context Assembly 注入的记忆 ID
    outputSlot: {                   // 脑区写入的 Slot 结果
      status: 'done' | 'error',
      output: Record<string, any>
    },
    significance_boost?: number,    // Amygdala 触发时携带
    stopReason?: string             // 'end_turn' | 'error' | 'max_tokens'
  }
}
```

**注意**：如果 Feature 002 的 Adapter 当前没有在 `brain.complete` payload 中携带所有这些字段，实现时需要同步确认并补充。

## 实现指导

### T010 — brain.complete 事件 handler 入口（四项职责并发）

在 WP02 的 `handleEvent()` 中追加 brain.complete 分支（在 WP03 实现）：

```typescript
// 追加到 handleEvent() 的路由分支
if (event.type === 'brain.complete') {
  await this.handleBrainComplete(event)
}

private async handleBrainComplete(event: BrainEvent): Promise<void> {
  // 四项职责并发执行，互不依赖
  await Promise.all([
    this.assignSegmentAndWriteEpisodic(event),  // 职责3 + 职责4（段分配含显著性）
    this.feedbackMemoryUsage(event),             // 职责5
    this.retroactiveCorrection(event),           // 职责2
  ])
}
```

显著性处理（职责4）内嵌在段分配中（同一次 episodic 写入时应用 significance_boost），所以是 3 个并发 Promise 而非 4 个。

---

### T011 — 段分配 + episodic 写入（职责3）

```typescript
private async assignSegmentAndWriteEpisodic(event: BrainEvent): Promise<void> {
  const { brain, threadId, payload } = event
  const workspace = this.config.workspace

  // 判断是否需要开启新 segment
  const needNewSegment = await this.shouldStartNewSegment(event)

  let segState = this.threadSegments.get(threadId)
  if (!segState || needNewSegment) {
    segState = { segmentId: crypto.randomUUID(), nextSeq: 0 }
    this.threadSegments.set(threadId, segState)
  }

  const segmentId = segState.segmentId
  const segmentSeq = segState.nextSeq++

  // 显著性叠加（职责4 内嵌）
  const significanceBoost = payload?.significance_boost ?? 0
  const baseImportance = 0.5 + significanceBoost  // 基础值 + boost

  // 写入 episodic 记忆
  await workspace.writeMemory({
    type: 'episodic',
    brain,
    threadId,
    segmentId,
    segmentSeq,
    content: this.buildEpisodicContent(event),
    base_importance: Math.min(1.0, baseImportance),  // 上限 1.0
    tags: ['brain_complete', brain],
  })
}

private async shouldStartNewSegment(event: BrainEvent): Promise<boolean> {
  const { threadId, payload } = event

  // 确定性触发条件（无需 LLM）
  if (!this.threadSegments.has(threadId)) return true  // 新 Thread
  if (payload?.outputSlot?.status === 'error') return true  // 错误恢复触发
  if (payload?.outputSlot?.output?.mode === 'ROUTE' &&
      payload?.outputSlot?.output?.needs_analysis) return true  // 目标变更

  // 话题切换：Haiku 判断（仅当有足够上下文时触发）
  // 为避免每次都调用 LLM，只对 RESPOND 输出判断（最终回复才有话题语义）
  if (payload?.outputSlot?.output?.mode === 'RESPOND' &&
      this.threadSegments.get(threadId)!.nextSeq > 5) {
    return await this.isTopicSwitch(event)
  }

  return false
}

private async isTopicSwitch(event: BrainEvent): Promise<boolean> {
  // 读最近 3 条 episodic（当前 segment 内）判断话题是否切换
  const recent = await this.config.workspace.searchMemory({
    type: 'episodic',
    threadId: event.threadId,
    limit: 3,
    excludeInvalid: true
  })
  if (recent.length < 2) return false

  const prompt = `Compare these two consecutive brain outputs and determine if the topic has significantly shifted.

Previous output summary: ${recent[1]?.content?.slice(0, 200) ?? 'N/A'}
Current output: ${JSON.stringify(event.payload?.outputSlot?.output ?? {}).slice(0, 200)}

Respond with JSON: {"topic_switched": boolean, "reason": string}`

  const response = await callLlm(prompt, this.config.llm)
  const result = parseLlmJson<{ topic_switched: boolean }>(response, { topic_switched: false })
  return result.topic_switched
}

private buildEpisodicContent(event: BrainEvent): string {
  const { brain, threadId, payload } = event
  return JSON.stringify({
    brain,
    threadId,
    status: payload?.outputSlot?.status,
    mode: payload?.outputSlot?.output?.mode,
    intent: payload?.outputSlot?.output?.intent,
    stopReason: payload?.stopReason,
    timestamp: new Date().toISOString()
  })
}
```

---

### T012 — 显著性处理（职责4）

已内嵌在 T011 的 `assignSegmentAndWriteEpisodic()` 中（`base_importance = 0.5 + significance_boost`）。

补充：如果 `significance_boost > 0`，额外写一条 `episodic` 记忆标记显著性事件：

```typescript
if (significanceBoost > 0) {
  await workspace.writeMemory({
    type: 'episodic',
    brain,
    threadId,
    segmentId,
    segmentSeq: segState.nextSeq++,  // 紧接着上一条
    content: JSON.stringify({
      event_type: 'significance_mark',
      boost: significanceBoost,
      trigger: 'amygdala',
      original_brain: brain
    }),
    base_importance: Math.min(1.0, 0.7 + significanceBoost),
    tags: ['significance_mark', 'amygdala'],
  })
}
```

---

### T013 — 记忆使用反馈（职责5）

```typescript
private async feedbackMemoryUsage(event: BrainEvent): Promise<void> {
  const { payload } = event
  const injectedIds = payload?.injectedMemoryIds ?? []
  if (injectedIds.length === 0) return

  const outcome = this.evaluateOutcome(event)
  await this.config.workspace.markMemoryUsed(injectedIds, outcome)
}

private evaluateOutcome(event: BrainEvent): 'positive' | 'negative' | 'neutral' {
  const { payload } = event

  // 确定性规则（无需 LLM）
  if (payload?.outputSlot?.status === 'error') return 'negative'
  if (payload?.stopReason === 'error') return 'negative'
  if (payload?.outputSlot?.output?.mode === 'RESPOND') return 'positive'
  if (payload?.outputSlot?.output?.mode === 'EXECUTE') return 'positive'

  return 'neutral'
}
```

**设计说明**：outcome 评估使用确定性规则，不调用 LLM（避免每次 brain.complete 都有 LLM 延迟）。Haiku 调用只用于语义模糊的边界情况（暂不实现，标记为 TODO）。

---

### T014 — 回溯纠错（职责2）

```typescript
private async retroactiveCorrection(event: BrainEvent): Promise<void> {
  const { brain, threadId } = event
  const windowSize = this.config.retroactionWindowSize ?? 20

  // 读最近 N 条事件（通过 episodic 记忆，不直接查 Event Bus 历史）
  const recentEvents = await this.config.workspace.searchMemory({
    type: 'episodic',
    threadId,
    limit: windowSize,
    excludeInvalid: true
  })

  if (recentEvents.length < 2) return  // 数据不足，跳过

  const prompt = `You are reviewing recent brain activity for potential errors requiring correction.

Brain: ${brain}
Thread: ${threadId}
Recent activity (most recent last):
${recentEvents.map(e => e.content).slice(-5).join('\n---\n')}

Current output: ${JSON.stringify(event.payload?.outputSlot?.output ?? {})}

Determine if any correction is needed. Respond with JSON:
{
  "needs_correction": boolean,
  "correction_type": "factual_error" | "reasoning_error" | "task_deviation" | null,
  "correction_message": string  // instruction for the correcting agent
}

Only set needs_correction=true if there is a clear, significant error. Be conservative.`

  const response = await callLlm(prompt, this.config.llm)
  const result = parseLlmJson<{
    needs_correction: boolean
    correction_type: string | null
    correction_message: string
  }>(response, { needs_correction: false, correction_type: null, correction_message: '' })

  if (result.needs_correction && result.correction_message) {
    // 写 dmn_correction Signal 到 workspace
    await this.config.workspace.pushSignal(threadId, {
      type: 'dmn_correction',
      message: result.correction_message,
      correctionType: result.correction_type,
      timestamp: new Date().toISOString()
    })

    this.config.eventBus.emit({
      type: 'dmn.correction_issued',
      level: 'COMPLIANCE',
      brain: 'dmn',
      threadId,
      payload: { correctionType: result.correction_type, targetBrain: brain }
    })
  }
}
```

## 验收标准

- [ ] `brain.complete` 事件触发三个并发 Promise（段分配+显著性、记忆反馈、回溯纠错）
- [ ] episodic 记忆写入含正确 `segment_id` 和 `segment_seq`（同 Thread 内递增）
- [ ] 新 Thread / 错误恢复 / 目标变更 → 新 segment_id
- [ ] `significance_boost > 0` 时 `base_importance` 叠加正确
- [ ] `injectedMemoryIds` 非空时 `markMemoryUsed` 被调用，outcome 符合规则
- [ ] Haiku 判断结果为需要纠错时，`pushSignal(threadId, 'dmn_correction')` 被调用

## 实现命令

```bash
spec-kitty implement WP03 --base WP01
```

## Activity Log

- 2026-03-10T15:01:24Z – unknown – lane=for_review – Ready for review: brain.complete 四联职责全实现，8 unit tests passing
