---
work_package_id: WP03
title: 步骤 2：段序列回放
lane: planned
dependencies: []
subtasks: [T013, T014, T015, T016, T017]
assignee: claude
agent: claude
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP03 — 步骤 2：段序列回放

## 目标

实现 `runSequenceReplay()`：选取最近 N 天内按重要度/recency 排序的 top-K 段，对每段发起一次性 LLM 分析，将提炼的事实/流程/风险模式分别写入 semantic/procedural/implicit 记忆，通过 supersedesId 避免重复写入。

## 上下文

- **修改文件**：`src/hippocampus/index.ts`（将 stub `runSequenceReplay` 替换为完整实现）
- 依赖 WP01：`callLlm`、`parseLlmJson`（`src/llm.ts`）；`getSegmentsByTimeRange`、`getSegmentSequence`、`searchMemory`、`writeMemory`、`invalidateMemory`（CognitiveWorkspace）
- **运行顺序**：步骤 2 在步骤 1（段精修）完成后执行，利用精修后的正确 segment_id 读取完整段序列
- LLM 调用：每个段 1 次，top-K 段最多 K 次（默认 K=5，即最多 5 次 Haiku 调用/天）
- 架构参考：`docs/02-memory-architecture.md` §七 2. 段序列回放

## 实现指导

### T013 — runSequenceReplay：选取 top-K 段

在 `src/hippocampus/index.ts` 中将 `private async runSequenceReplay()` stub 替换为：

```typescript
private async runSequenceReplay(): Promise<void> {
  const now = new Date()
  const from = new Date(now.getTime() - this.config.lookbackDays * 24 * 60 * 60 * 1000)
  const segments = await this.workspace.getSegmentsByTimeRange({ from, to: now })

  // 排序：avgImportance DESC，recency（maxCreatedAt DESC）次之
  segments.sort((a, b) => {
    const importanceDiff = b.avgImportance - a.avgImportance
    if (Math.abs(importanceDiff) > 0.01) return importanceDiff
    return b.maxCreatedAt.getTime() - a.maxCreatedAt.getTime()
  })

  const topK = segments.slice(0, this.config.replayTopK)
  console.log(`[Hippocampus] Sequence replay: ${topK.length}/${segments.length} segments selected`)

  for (const segment of topK) {
    try {
      await this.replaySegment(segment)
    } catch (err) {
      console.warn(`[Hippocampus] Replay failed for segment ${segment.segmentId}:`, err)
    }
  }
}
```

---

### T014 — 获取段序列并组装 LLM Prompt

```typescript
private async replaySegment(segment: {
  segmentId: string
  eventCount: number
  avgImportance: number
}): Promise<void> {
  const events = await this.workspace.getSegmentSequence(segment.segmentId)

  // 段太短，跳过（少于 2 条事件无法提取跨事件模式）
  if (events.length < 2) {
    console.log(`[Hippocampus] Skip segment ${segment.segmentId}: only ${events.length} event(s)`)
    return
  }

  const eventSummary = events
    .map((e, i) => `[${i + 1}] ${e.content.slice(0, 300)}`)
    .join('\n\n')

  const prompt = `You are analyzing a sequence of cognitive events from an AI agent to extract reusable knowledge.

Segment ID: ${segment.segmentId}
Events (${events.length} total, importance: ${segment.avgImportance.toFixed(2)}):

${eventSummary}

Extract reusable knowledge from this event sequence. Return JSON only:
{
  "semantic": [
    {"content": "factual statement about the world or entities", "entityId": "entity-name-or-null", "tags": ["tag1"]}
  ],
  "procedural": [
    {"content": "step-by-step procedure for a task type", "tags": ["tag1", "tag2"]}
  ],
  "implicit": [
    {"content": "behavioral pattern or risk pattern to watch for", "tags": ["risk", "pattern"]}
  ]
}

Rules:
- semantic: facts, relationships, entity attributes that are generally true
- procedural: repeatable task procedures with clear steps
- implicit: behavioral tendencies, risk patterns, warning signs
- Omit arrays that have no entries (return empty array [])
- Keep content concise but specific (under 500 chars each)
- Use null for entityId if the fact is not entity-specific`

  const response = await callLlm(prompt, this.config.llm, { maxTokens: 2048 })
  await this.processReplayResult(response, segment.segmentId, segment.avgImportance)
}
```

---

### T015 — LLM 调用 + 解析 + 写入 semantic/procedural

```typescript
private async processReplayResult(
  llmResponse: string,
  segmentId: string,
  avgImportance: number,
): Promise<void> {
  const parsed = parseLlmJson<{
    semantic?: { content: string; entityId: string | null; tags: string[] }[]
    procedural?: { content: string; tags: string[] }[]
    implicit?: { content: string; tags: string[] }[]
  }>(llmResponse, {})

  // 写入 semantic
  for (const item of parsed.semantic ?? []) {
    if (!item.content?.trim()) continue
    await this.writeWithSupersedes('semantic', item.content, {
      entityId: item.entityId ?? undefined,
      tags: ['replay', segmentId, ...(item.tags ?? [])],
      baseImportance: Math.min(avgImportance + 0.05, 1.0),
      sourceBrain: 'hippocampus',
    })
  }

  // 写入 procedural
  for (const item of parsed.procedural ?? []) {
    if (!item.content?.trim()) continue
    await this.writeWithSupersedes('procedural', item.content, {
      tags: ['replay', segmentId, ...(item.tags ?? [])],
      baseImportance: avgImportance,
      sourceBrain: 'hippocampus',
    })
  }

  // 写入 implicit（见 T016）
  for (const item of parsed.implicit ?? []) {
    if (!item.content?.trim()) continue
    await this.writeWithSupersedes('implicit', item.content, {
      tags: ['replay', segmentId, ...(item.tags ?? [])],
      baseImportance: Math.max(avgImportance * 0.8, 0.3),
      sourceBrain: 'hippocampus',
    })
  }
}
```

---

### T016 — writeWithSupersedes：去重写入

```typescript
private async writeWithSupersedes(
  type: 'semantic' | 'procedural' | 'implicit',
  content: string,
  params: {
    entityId?: string
    tags: string[]
    baseImportance: number
    sourceBrain: string
  }
): Promise<void> {
  // 检查是否存在相似记忆（ILIKE content 匹配前 100 字符）
  const existing = await this.workspace.searchMemory({
    type,
    query: content.slice(0, 100),
    limit: 1,
  })

  let supersedesId: string | undefined
  if (existing.length > 0) {
    const old = existing[0]!
    supersedesId = old.id
    // 软删除旧记录（tInvalid 标记）
    await this.workspace.invalidateMemory(old.id)
  }

  await this.workspace.writeMemory({
    type,
    content,
    entityId: params.entityId,
    tags: params.tags,
    baseImportance: params.baseImportance,
    sourceBrain: params.sourceBrain,
    supersedesId,
  })
}
```

**注意**：`searchMemory` 使用 ILIKE 全文搜索。内容完全不同的新知识不会被误匹配——ILIKE 前 100 字符匹配是粗粒度查重，避免完全重复的描述产生多条记录。

---

### T017 — 错误处理 + 注册到 runConsolidation

- `replaySegment` 内部抛出（LLM 超时/JSON 解析完全失败/writeMemory 报错）：被 `runSequenceReplay` 的 try/catch 捕获，warn 日志 + 继续下一段
- 空段（events < 2）：直接 return，不发起 LLM 调用
- `parseLlmJson` 失败时返回空对象 `{}`，semantic/procedural/implicit 均为空数组，不写入任何记忆（幂等安全）
- `runConsolidation` 中步骤 2 为 `await this.runSequenceReplay()`，整体 throw 时步骤 3 不执行

**验证**：
- `bun run typecheck` 无错误
- `biome check` 通过

## Definition of Done

- [ ] T013: `runSequenceReplay` 获取 lookbackDays 内段列表，按 avgImportance DESC + recency DESC 排序，取 top-K
- [ ] T014: `replaySegment` 获取段序列（< 2 条跳过），组装含事件摘录的 prompt
- [ ] T015: `processReplayResult` 解析 LLM JSON，写入 semantic/procedural（`writeWithSupersedes`）
- [ ] T016: `writeWithSupersedes` 先 searchMemory 查重，存在时 invalidateMemory + 设置 supersedesId，再 writeMemory
- [ ] T017: 单段失败 warn + 继续，整体 runSequenceReplay 不因单段失败而抛出
- [ ] `bun run typecheck` 零错误，`biome check` 通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
spec-kitty agent tasks move-task WP03 --to for_review --note "Ready: <summary>"
```
