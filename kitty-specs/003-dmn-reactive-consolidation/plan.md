# Implementation Plan: DMN Reactive & Consolidation (Feature 003)

**Feature**: 003-dmn-reactive-consolidation
**Version**: 1.0
**Created**: 2026-03-11
**Depends on**: Feature 001 (@aima/core workspace), Feature 002 (BrainEventBus, BrainRunResult)

---

## 一、技术栈

| 层 | 选型 |
|---|---|
| 语言 | TypeScript strict, ESM-only, moduleResolution: Bundler |
| 运行时 | Bun v1.x |
| 格式 | Biome |
| 构建 | tsup（共用 Feature 001/002 配置） |
| LLM 调用 | @anthropic-ai/sdk（直接调用，不走 BrainAdapter） |
| 定时器 | Bun 原生 setInterval（Consolidation 心跳） |
| 数据层 | Feature 001 CognitiveWorkspace（Drizzle + PostgreSQL） |
| 测试 | Bun test（单元）+ Vitest（集成，需 DB） |

---

## 二、模块结构

```
src/
├── dmn/
│   ├── index.ts            # DmnService（顶层生命周期）+ DmnConfig 类型
│   ├── reactive/
│   │   └── index.ts        # DmnReactive（Event Bus 订阅器，7 项职责）
│   └── consolidation/
│       └── index.ts        # DmnConsolidation（心跳批处理，3 项职责）
└── index.ts                # 公共 API 扩展（追加 DmnService 导出）
```

不新增数据库表。所有持久化通过 CognitiveWorkspace 的现有接口。

---

## 三、关键设计决策

### DMN Reactive 的事件处理模型

**同步 subscribe + 异步 handler**：Event Bus 的 `subscribe()` 是同步回调，但 DMN Reactive 的每个职责（特别是 LLM 调用、DB 写入）是异步的。实现策略：

```typescript
eventBus.subscribe((event) => {
  // 同步入口，立即 launch 异步任务，不 await
  this.handleEventAsync(event).catch(err => {
    // 错误隔离：handler 失败不影响 Event Bus 其他订阅者
    this.emitInternalAlert(err)
  })
})
```

**不阻塞 Thread Runner**：handler 内的所有 DB 写入和 LLM 调用在独立的 Promise 链中执行，Event Bus emit 立即返回。

### 段分配的 current_segment 追踪

DMN Reactive 需要在内存中维护每个 Thread 当前的 segment 状态（segment_id + segment_seq）：

```typescript
// 内存 Map（进程级，随进程重启重置）
private threadSegments = new Map<string, {
  segmentId: string
  nextSeq: number
}>()
```

重启后新事件自动开启新 segment（重启本身是段边界），不需要从 DB 恢复。这是有意设计——Hippocampus Consolidation（Feature 004）负责精修跨重启的段边界。

### Haiku 一次性调用的封装

所有 DMN 的 LLM 调用通过统一的 `callHaiku(prompt: string): Promise<string>` 封装：

```typescript
async function callHaiku(prompt: string, config: DmnLlmConfig): Promise<string> {
  const anthropic = new Anthropic({ apiKey: config.apiKey })
  const msg = await anthropic.messages.create({
    model: config.model ?? 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }]
  })
  return msg.content[0].type === 'text' ? msg.content[0].text : ''
}
```

不持有客户端实例（每次调用新建，避免连接状态泄露），不走 BrainAdapter，不在 Thread/Slot 体系内。

### Consolidation 的增量追踪

`DmnConsolidation` 在内存中记录 `lastRunAt: Date`，每次心跳读取 `created_at > lastRunAt` 的 episodic 增量。进程重启后 `lastRunAt` 重置为当前时间减去一个心跳间隔（保证不遗漏），可能有轻微重复处理（幂等设计，可接受）。

### implicit 合并的幂等性

聚类合并通过 `supersedes_ids` 软删除实现。幂等性保证：
- 合并前先检查目标 canonical 记录是否已存在（通过 tags + content 指纹匹配）
- 若已存在则跳过（不重复合并）
- 新写入的 canonical 记录打上 `source: 'dmn_consolidation'` tag，便于识别

### 错误恢复的重试计数

重试次数通过 episodic 记忆中的计数追踪（不新建表）：
- 每次 DMN 写入 retry 指令，同时写入一条 working 记忆（`type: working`，`thread_id = threadId`，`content = '{"retryCount": N}'`）
- 下次 ALERT 触发时读取该 working 记忆的计数，判断是否超限
- Thread 完成后 working 记忆随 `clearWorkingMemory()` 自动清理

---

## 四、DmnReactive 职责实现概要

| 职责 | 触发事件 | LLM 调用 | 写入目标 |
|---|---|---|---|
| 错误恢复 | `ALERT`（brain 发射） | 可选（判断策略） | Thread Slot（retry）/ Thread status |
| 回溯纠错 | `brain.complete` | **必需**（Haiku 判断） | Workspace Signal（dmn_correction）|
| 段分配 | `brain.complete` | 可选（话题切换判断） | Memory（episodic 写入时附 segment_id）|
| 显著性处理 | 任何含 significance_boost 的事件 | 无 | Memory（写 episodic 时加 importance）|
| 记忆使用反馈 | `brain.complete`（含 injectedMemoryIds） | 可选（质量评估） | Memory.usage_outcomes（markUsed）|
| DEFER 调度 | Limbic Slot done + mode=DEFER | 无 | pending_observations |
| 信号捕获 | 任意 INFO+ 事件 | 可选（Haiku fallback） | pending_observations |

**关键路径**（`brain.complete` 触发 4 项职责）：
```
brain.complete 事件
  → 并发执行（Promise.all）：
    ├── 回溯纠错（Haiku）
    ├── 段分配（写 episodic，可选 Haiku）
    ├── 显著性处理（无 LLM）
    └── 记忆使用反馈（markUsed，可选 Haiku）
```

---

## 五、DmnConsolidation 实现概要

```
心跳触发（setInterval，默认 30分钟）
  → 读 episodic 增量（created_at > lastRunAt）
  → 并发执行（独立 Promise）：
      ├── 前瞻预测（Haiku/Sonnet，读 episodic+procedural+semantic，写 pending）
      ├── Pending 维护（Haiku，读 pending + 增量，决定保留/移除/更新）
      └── Implicit 聚类合并（Haiku，读近期 implicit provisional，写 canonical）
  → 更新 lastRunAt
```

三项职责独立 Promise，互不阻塞；任意一项失败不影响其他项。

---

## 六、DmnService 生命周期

```typescript
class DmnService {
  private reactive: DmnReactive
  private consolidation: DmnConsolidation

  async start(): Promise<void> {
    await this.reactive.start()       // 订阅 Event Bus
    await this.consolidation.start()  // 启动心跳定时器
  }

  async stop(): Promise<void> {
    await this.reactive.stop()        // 取消订阅，等待进行中 handler 完成
    await this.consolidation.stop()   // 清除定时器，等待当前批次完成
  }

  async runConsolidationNow(): Promise<void> {
    await this.consolidation.runOnce()
  }
}
```

`DmnService` 注入 `AIMAInstance`（Feature 002），作为认知运行时的可选组件启动。AIMAInstance 的 `start()` 可选启动 DmnService（通过 `config.enableDmn: boolean`）。

---

## 七、工作包规划

| WP | 内容 | 依赖 | 子任务数 |
|---|---|---|---|
| WP01 | DmnService 骨架 + DmnConfig + Haiku 调用封装 | — | 4 |
| WP02 | DmnReactive — 错误恢复 + DEFER 调度 + 信号捕获 | WP01 | 5 |
| WP03 | DmnReactive — brain.complete 四联职责（段分配/显著性/反馈/纠错） | WP01 | 5 |
| WP04 | DmnConsolidation — 前瞻预测 + Pending 维护 | WP01 | 5 |
| WP05 | DmnConsolidation — Implicit 聚类合并 + AIMAInstance 集成 | WP01, WP04 | 5 |
| WP06 | 单元测试（Reactive + Consolidation + DmnService） | WP01~WP05 | 6 |
| WP07 | 集成测试 + AIMAInstance 完整链路 smoke test | WP05, WP06 | 5 |

---

## 八、风险

| 风险 | 缓解 |
|---|---|
| Haiku 调用延迟影响 Reactive 响应时效 | handler 全异步，不阻塞 Event Bus；Haiku P95 < 5s 验证 |
| 段分配遗漏 brain.complete 事件 | 单元测试覆盖所有事件路径；Event Bus subscribe 在 start() 时立即注册 |
| Consolidation LLM 幻觉导致错误 pending | pending 的 note 包含原始 episodic 引用；Thread Runner 路由前脑区自行判断有效性 |
| 并发写 implicit 记忆时冲突 | Amygdala provisional 写不持锁（设计如此）；Consolidation 合并前检查 supersedes_ids 避免重复 |
| 进程重启导致 in-flight handler 丢失 | handler 失败幂等：DB 操作事务性，LLM 调用失败不写 DB，下次事件重新触发 |
