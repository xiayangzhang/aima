---
work_package_id: "WP01"
title: "DmnService 骨架 + Haiku 封装"
lane: "planned"
dependencies: []
subtasks: ["T001", "T002", "T003", "T004"]
history:
  - 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP01 — DmnService 骨架 + Haiku 封装

## 目标

建立 DMN 模块基础：类型定义、一次性 Haiku 调用封装、DmnService 顶层生命周期类骨架，以及 AIMAInstance 的集成入口。

## 上下文

- 新建目录：`src/dmn/`（含 `index.ts`、`reactive/index.ts`、`consolidation/index.ts`）
- 依赖 Feature 002：`BrainEventBus`、`getEventBus()`（来自 `src/eventbus/index.ts`）
- 依赖 Feature 001：`CognitiveWorkspace`（来自 `src/workspace/index.ts`）
- 不修改任何 Feature 001/002 的现有文件（除 `src/instance.ts` 和 `src/index.ts`）
- 架构参考：`docs/01-agent-architecture.md` §七

## 实现指导

### T001 — DmnConfig 类型

**文件**：`src/dmn/index.ts`（新建）

```typescript
import type { CognitiveWorkspace } from '../workspace/index'
import type { BrainEventBus } from '../eventbus/index'

export interface DmnLlmConfig {
  apiKey?: string          // 如未设置，从 process.env.ANTHROPIC_API_KEY 读
  model?: string           // 默认 'claude-haiku-4-5-20251001'
  complexModel?: string    // 升级用（Consolidation 跨流程分析），默认 'claude-sonnet-4-6'
  maxTokens?: number       // 默认 512（Reactive）/ 1024（Consolidation）
}

export interface DmnConfig {
  workspace: CognitiveWorkspace
  eventBus?: BrainEventBus          // 如未设置，使用 getEventBus() 单例
  llm: DmnLlmConfig
  consolidationIntervalMs?: number   // 默认 30 * 60 * 1000（30分钟）
  maxRetries?: number                // 错误恢复最大重试次数，默认 3
  retroactionWindowSize?: number     // 回溯纠错读取最近 N 条事件，默认 20
}
```

---

### T002 — callHaiku() 一次性 LLM 调用封装

**文件**：`src/dmn/llm.ts`（新建，供 Reactive 和 Consolidation 共用）

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { DmnLlmConfig } from './index'

/**
 * 一次性 LLM 调用，无对话历史，不走 BrainAdapter，不在 Thread/Slot 体系内。
 * DMN 所有 LLM 判断均通过此函数发起。
 */
export async function callLlm(
  prompt: string,
  config: DmnLlmConfig,
  opts: { useComplexModel?: boolean; maxTokens?: number } = {}
): Promise<string> {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('DMN: No API key configured')

  const model = opts.useComplexModel
    ? (config.complexModel ?? 'claude-sonnet-4-6')
    : (config.model ?? 'claude-haiku-4-5-20251001')

  const maxTokens = opts.maxTokens ?? config.maxTokens ?? 512

  const anthropic = new Anthropic({ apiKey })
  const msg = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  })

  const block = msg.content[0]
  return block.type === 'text' ? block.text : ''
}

/**
 * 解析 LLM 返回的 JSON，失败时返回 fallback 值。
 */
export function parseLlmJson<T>(text: string, fallback: T): T {
  try {
    // 提取 markdown code block 内的 JSON（如有）
    const match = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/)
    const raw = match ? match[1] : text.trim()
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
```

**注意**：每次调用新建 `Anthropic` 实例（无状态，无 session），不持有客户端引用。

---

### T003 — DmnService 类骨架

**文件**：`src/dmn/index.ts`（续写）

```typescript
import { getEventBus } from '../eventbus/index'
import { DmnReactive } from './reactive/index'
import { DmnConsolidation } from './consolidation/index'

export class DmnService {
  private reactive: DmnReactive
  private consolidation: DmnConsolidation
  private running = false

  constructor(private config: DmnConfig) {
    const eventBus = config.eventBus ?? getEventBus()
    this.reactive = new DmnReactive({ ...config, eventBus })
    this.consolidation = new DmnConsolidation(config)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.reactive.start()
    await this.consolidation.start()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    await this.reactive.stop()
    await this.consolidation.stop()
  }

  /** 立即触发一次 Consolidation（测试/手动触发用）*/
  async runConsolidationNow(): Promise<void> {
    await this.consolidation.runOnce()
  }
}

export function createDmnService(config: DmnConfig): DmnService {
  return new DmnService(config)
}
```

同时在 `src/dmn/reactive/index.ts` 和 `src/dmn/consolidation/index.ts` 创建空骨架类（供 TypeScript 编译通过）：

```typescript
// src/dmn/reactive/index.ts
export class DmnReactive {
  constructor(private config: any) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

// src/dmn/consolidation/index.ts
export class DmnConsolidation {
  constructor(private config: any) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async runOnce(): Promise<void> {}
}
```

WP02/WP03/WP04/WP05 会填充实际实现。

---

### T004 — AIMAInstance 集成

**文件**：`src/instance.ts`（修改，在 AIMAInstanceConfig 和 constructor 末尾追加）

在 `AIMAInstanceConfig` 中追加：
```typescript
enableDmn?: boolean          // 默认 false（显式启用）
dmnConfig?: Partial<Pick<DmnConfig, 'consolidationIntervalMs' | 'maxRetries' | 'llm'>>
```

在 `AIMAInstance` 类中追加：
```typescript
private dmnService?: DmnService

// constructor 末尾
if (config.enableDmn) {
  this.dmnService = new DmnService({
    workspace: this.workspace,
    eventBus: this.eventBus,
    llm: {
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...config.dmnConfig?.llm
    },
    ...config.dmnConfig
  })
}

// start() 末尾
if (this.dmnService) {
  await this.dmnService.start()
}

// stop() 前
if (this.dmnService) {
  await this.dmnService.stop()
}
```

**验收**：`createAIMAInstance({ ..., enableDmn: true })` 编译无错误，DMN 随实例启停。

## 验收标准

- [ ] `src/dmn/index.ts` 导出 `DmnService`、`DmnConfig`、`DmnLlmConfig`、`createDmnService`
- [ ] `src/dmn/llm.ts` 导出 `callLlm`、`parseLlmJson`
- [ ] `DmnService.start()` / `stop()` 幂等（多次调用不报错）
- [ ] `AIMAInstance` 传 `enableDmn: true` 时 `dmnService` 被创建
- [ ] `bun run typecheck` 无错误

## 实现命令

```bash
spec-kitty implement WP01
```
