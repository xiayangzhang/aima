---
work_package_id: WP05
title: DmnConsolidation — Implicit 聚类 + 集成
lane: planned
dependencies: []
subtasks: [T020, T021, T022, T023, T024]
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP05 — DmnConsolidation — Implicit 聚类 + 集成

## 目标

实现 implicit 记忆聚类合并（职责3），完成 DmnService 与 AIMAInstance 的集成，并更新公共导出。

## 上下文

- 依赖 WP01：`callLlm()`、`parseLlmJson()`
- 依赖 WP04：`DmnConsolidation.runOnce()` 的三项职责并发框架（WP04 中 `runImplicitClustering()` 留空）
- 修改文件：`src/dmn/consolidation/index.ts`（填充 `runImplicitClustering()`）
- 修改文件：`src/instance.ts`（AIMAInstance enableDmn 集成，WP01 已预留入口）
- 修改文件：`src/index.ts`（追加导出）
- 架构参考：`docs/01-agent-architecture.md` §七"implicit 记忆的写入权限"

## implicit 记忆的两类写入者

| 写入者 | 时机 | 语义 |
|---|---|---|
| Amygdala | 工具拦截时即时写入 | provisional（最佳努力，可能冗余）|
| DMN Reactive | 检测到行为错误模式后写入 | provisional（同上）|
| **DMN Consolidation** | 心跳批处理 | **canonical（最终仲裁，合并冗余）** |

合并规则：tag 取并集，`base_importance` 取较高值，被合并旧记录通过 `supersedes_ids` 软删除（设 `t_invalid`）。

## 实现指导

### T020 — 读近期 provisional implicit 记忆

```typescript
// 在 DmnConsolidation 类中实现 runImplicitClustering()
private async runImplicitClustering(): Promise<void> {
  // 读取最近时间窗口内的 provisional implicit 记忆
  // "provisional" 通过 tag 标识（Amygdala 和 DMN Reactive 写入时打 tag）
  const provisional = await this.config.workspace.searchMemory({
    type: 'implicit',
    tags: ['provisional'],  // Amygdala/DmnReactive 写入时须加此 tag
    excludeInvalid: true,   // 排除已被软删除的
    createdAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),  // 近 7 天
    limit: 100
  })

  if (provisional.length < 2) return  // 不足以聚类

  // 聚类 + 合并
  await this.clusterAndMerge(provisional)
}
```

**重要**：Amygdala 和 DmnReactive 写入 implicit 记忆时，必须加 `tags: ['provisional']`。在 WP03 的 `retroactiveCorrection()` 实现中，如果写入 implicit 记忆，需要加此 tag。Feature 002 的 Amygdala 也需要在写入 implicit 时加此 tag（检查 `src/amygdala/index.ts`，补充 tag 如缺失）。

---

### T021 — Haiku 语义相似度判断 + 聚类分组

```typescript
private async clusterAndMerge(entries: MemoryEntry[]): Promise<void> {
  // 限制单批聚类数量，防止 prompt 过长
  const batch = entries.slice(0, 20)

  const prompt = `You are clustering implicit memory entries to merge semantically similar ones.

Memory entries:
${batch.map((e, i) => `[${i}] id="${e.id}" content="${e.content.slice(0, 200)}" tags=[${e.tags?.join(',')}]`).join('\n')}

Identify groups of semantically similar entries that should be merged into one.
Two entries are similar if they describe the same risk pattern or behavior pattern.

Respond with JSON:
{
  "clusters": [
    {
      "indices": [0, 2, 5],  // indices of entries to merge (must have >= 2)
      "canonical_content": "merged description of the pattern",
      "merged_tags": ["tag1", "tag2"]
    }
  ]
}

Only include clusters with 2+ entries. Entries not in any cluster should not appear.`

  const response = await callLlm(prompt, this.config.llm, { maxTokens: 1024 })
  const result = parseLlmJson<{ clusters: Array<{
    indices: number[]
    canonical_content: string
    merged_tags: string[]
  }> }>(response, { clusters: [] })

  for (const cluster of result.clusters) {
    if (cluster.indices.length < 2) continue
    const toMerge = cluster.indices
      .filter(i => i >= 0 && i < batch.length)
      .map(i => batch[i])
      .filter((e): e is MemoryEntry => e !== undefined)

    await this.mergeCluster(toMerge, cluster.canonical_content, cluster.merged_tags)
  }
}
```

---

### T022 — Canonical 写入 + supersedes 软删除（幂等）

```typescript
private async mergeCluster(
  entries: MemoryEntry[],
  canonicalContent: string,
  mergedTags: string[]
): Promise<void> {
  const workspace = this.config.workspace

  // 幂等性检查：是否已有 canonical 记录覆盖这些 entries
  const existingCanonical = await workspace.searchMemory({
    type: 'implicit',
    tags: ['canonical'],
    excludeInvalid: true,
    // 检查是否有任意一条 entry 已被某 canonical supersede
    // （通过 supersedes_ids 字段匹配）
    limit: 10
  })

  // 简化版幂等检查：检查第一条 entry 是否已有 t_invalid（已被软删除 = 已被合并）
  const alreadyMerged = entries.every(e => {
    return existingCanonical.some(c =>
      // 假设 MemoryEntry 有 supersedes_ids 字段（Feature 001 schema）
      (c as any).supersedes_ids?.includes(e.id)
    )
  })
  if (alreadyMerged) return

  // base_importance 取最高值
  const maxImportance = Math.max(...entries.map(e => e.base_importance ?? 0.5))

  // 写入 canonical 记录
  const canonicalId = crypto.randomUUID()
  await workspace.writeMemory({
    type: 'implicit',
    content: canonicalContent,
    tags: [...new Set([...mergedTags, 'canonical'])],  // 合并 tags，去重，加 canonical 标记
    base_importance: Math.min(1.0, maxImportance),
    // supersedes_ids 通过 writeMemory 的扩展字段传入
    // （需确认 Feature 001 的 writeMemory 是否支持此字段）
  })

  // 软删除原有 entries（设置 t_invalid）
  for (const entry of entries) {
    await workspace.writeMemory({
      ...entry,
      // t_invalid = now，表示记录被新 canonical 取代
      // 通过 supersedes 机制：writeMemory 的 supersedesId 参数
    })
    // 实际上需要调用 workspace 的 invalidateMemory(id, canonicalId) 方法
    // 如果 Feature 001 没有此方法，需要通过 writeMemory 带 supersedesId 字段实现
    // 检查 src/workspace/index.ts 的 writeMemory 签名
  }
}
```

**注意**：需要检查 Feature 001 的 `writeMemory` 是否支持 `supersedes_ids` 字段。如果不支持，需要在 `src/workspace/index.ts` 中扩展接口（追加 `invalidateMemory(id: string, replacedById: string): Promise<void>`）。

---

### T023 — DmnService 集成验证

WP01 已在 `src/instance.ts` 预留了 `enableDmn` 集成入口。本任务验证集成正确性。

检查清单：
- [ ] `createAIMAInstance({ enableDmn: true, dmnConfig: { llm: { apiKey: '...' } } })` 创建 `DmnService`
- [ ] `instance.start()` → `dmnService.start()` → Reactive 订阅 EventBus + Consolidation 启动定时器
- [ ] `instance.stop()` → `dmnService.stop()` → Reactive 取消订阅 + Consolidation 清除定时器
- [ ] `enableDmn: false`（默认）时不创建 DmnService，不影响现有行为

如果 WP01 的集成入口有问题，在本任务中修复。

---

### T024 — src/index.ts 追加导出

**文件**：`src/index.ts`（在 Feature 002 导出末尾追加）

```typescript
// ============ Feature 003: DMN Reactive & Consolidation ============

export { DmnService, createDmnService } from './dmn/index'
export type { DmnConfig, DmnLlmConfig } from './dmn/index'
```

**不导出**：`DmnReactive`、`DmnConsolidation`（内部实现，不是公共 API）、`callLlm`（内部工具）

## 验收标准

- [ ] `runImplicitClustering()` 读取 `tags: ['provisional']` 的 implicit 记忆
- [ ] LLM 返回聚类结果后，canonical 记录写入，tag 含 'canonical'
- [ ] 被合并的旧记录 `t_invalid` 被设置（通过 supersedes 机制）
- [ ] 幂等性：重复运行不重复合并已合并的记录
- [ ] `DmnService` 和 `DmnConfig` 从 `@aima/core` 正确导出
- [ ] `bun run build` 成功，无类型错误

## 实现命令

```bash
spec-kitty implement WP05 --base WP04
```

注意：WP05 同时依赖 WP01（通过 WP04 的依赖链传递），--base 指定 WP04。
