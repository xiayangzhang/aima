---
work_package_id: "WP01"
title: "BrainAdapter 接口 + BrainEventBus"
lane: "doing"
dependencies: []
subtasks: ["T001", "T002", "T003", "T004", "T005", "T006"]
agent: "claude"
shell_pid: "1331"
history:
  - 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
---

# WP01 — BrainAdapter 接口 + BrainEventBus

## 目标

定义所有运行时组件共用的接口类型，实现进程级结构化事件总线。这是 Feature 002 所有其他 WP 的基础。

## 上下文

- 所在 repo：/Volumes/leoyun/aima/
- Feature 001 已合并到 main，src/types/index.ts / src/workspace/index.ts 等文件不可破坏
- 新建文件：src/adapters/index.ts、src/eventbus/index.ts
- 扩展文件：src/types/index.ts（追加新类型）、src/workspace/index.ts（追加 Signals 方法）、src/index.ts（追加导出）
- 语言：TypeScript strict, ESM-only, moduleResolution: Bundler
- 格式：Biome

## 实现指导

### T001 — BrainAdapter 接口 + 核心类型

**文件**：`src/adapters/index.ts`（新建）

BrainAdapter 接口与 @mariozechner/pi-agent-core 的 Agent 类对齐：

```typescript
import type { BrainType, CognitiveBrainType } from '../types/index'

// 脑区信号类型（Amygdala 中断 / DMN 纠错）
export type BrainSignalType = 'amygdala_interrupt' | 'dmn_correction'

export interface BrainSignal {
  type: BrainSignalType
  message: string
  causationId?: string
}

export interface BrainRunParams {
  brain: CognitiveBrainType
  threadId: string
  systemPrompt: string       // Context Assembly 组装结果（Block 1-4）
  initialPrompt?: string     // 触发内容；不传则 resume 当前 session（continue）
}

export interface BrainRunResult {
  sessionId: string
  output: Record<string, unknown>    // 脑区写入 Slot 的结构化结果
  stopReason: 'done' | 'interrupted' | 'error'
  injectedMemoryIds: string[]        // Block 4 注入的记忆 IDs，供 DMN 使用
}

// BrainAdapter 接口与 pi-coding-agent Agent 接口对齐，AIMA 额外添加 inject/abort
export interface BrainAdapter {
  // 启动或续接脑区 Loop，阻塞直到完成
  run(params: BrainRunParams): Promise<BrainRunResult>
  // 向正在运行的 Loop 注入信号（Amygdala 中断 / DMN 纠错）
  inject(signal: BrainSignal): Promise<void>
  // 中止当前 Loop（cooperative cancellation）
  abort(): void
}
```

### T002 — BrainEvent 类型 + EventLevel

在 `src/adapters/index.ts` 追加（或单独放在 src/eventbus/index.ts，选一处）：

```typescript
export type EventLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'COMPLIANCE' | 'ALERT'

export interface BrainEvent {
  event_id: string           // UUID，自动生成
  event_type: string         // 如 'tool.pre_use', 'brain.complete', 'memory.write'
  level: EventLevel
  occurred_at: Date
  brain: BrainType
  thread_id: string | null
  session_id: string | null
  causation_id: string | null   // null = 因果链起点
  schema_version: string        // 框架自动注入，当前 '1.0'
  payload: Record<string, unknown>
}
```

### T003 — BrainEventBus 类

**文件**：`src/eventbus/index.ts`（新建）

```typescript
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { BrainType } from '../types/index'
import type { BrainEvent, EventLevel } from '../adapters/index'

type EmitParams = {
  event_type: string
  level: EventLevel
  brain: BrainType
  thread_id?: string | null
  session_id?: string | null
  causation_id?: string | null
  payload?: Record<string, unknown>
}

export class BrainEventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  emit(params: EmitParams): BrainEvent {
    const event: BrainEvent = {
      event_id: randomUUID(),
      event_type: params.event_type,
      level: params.level,
      occurred_at: new Date(),
      brain: params.brain,
      thread_id: params.thread_id ?? null,
      session_id: params.session_id ?? null,
      causation_id: params.causation_id ?? null,
      schema_version: '1.0',
      payload: params.payload ?? {},
    }
    this.emitter.emit('event', event)
    this.emitter.emit(`level:${event.level}`, event)
    this.emitter.emit(`brain:${event.brain}`, event)
    return event
  }

  // 订阅全量事件，返回取消订阅函数
  subscribe(handler: (event: BrainEvent) => void): () => void {
    this.emitter.on('event', handler)
    return () => { this.emitter.off('event', handler) }
  }

  // 订阅指定级别及以上事件
  subscribeLevel(minLevel: EventLevel, handler: (event: BrainEvent) => void): () => void {
    const levels: EventLevel[] = ['TRACE', 'DEBUG', 'INFO', 'COMPLIANCE', 'ALERT']
    const minIdx = levels.indexOf(minLevel)
    const relevant = new Set(levels.slice(minIdx))
    const wrapped = (event: BrainEvent) => { if (relevant.has(event.level)) handler(event) }
    this.emitter.on('event', wrapped)
    return () => { this.emitter.off('event', wrapped) }
  }

  // 订阅特定脑区的事件
  subscribeBrain(brain: BrainType, handler: (event: BrainEvent) => void): () => void {
    this.emitter.on(`brain:${brain}`, handler)
    return () => { this.emitter.off(`brain:${brain}`, handler) }
  }
}
```

### T004 — getEventBus() 进程级单例

在 `src/eventbus/index.ts` 追加：

```typescript
let _bus: BrainEventBus | null = null
export function getEventBus(): BrainEventBus {
  if (!_bus) _bus = new BrainEventBus()
  return _bus
}
```

### T005 — CognitiveWorkspace 扩展：Signals 内存存储

**文件**：`src/workspace/index.ts`（已有，追加方法）

CognitiveWorkspace 类内部维护一个 Signals Map，供适配器查询和清除：

```typescript
// 在 CognitiveWorkspace 类中追加（不改动已有方法）：
private signals: Map<string, BrainSignal[]> = new Map()

pushSignal(signal: BrainSignal): void {
  const key = signal.type
  const existing = this.signals.get(key) ?? []
  existing.push(signal)
  this.signals.set(key, existing)
}

popSignal(type: BrainSignalType): BrainSignal | undefined {
  const list = this.signals.get(type) ?? []
  const item = list.shift()
  if (list.length === 0) this.signals.delete(type)
  else this.signals.set(type, list)
  return item
}

hasSignal(type: BrainSignalType): boolean {
  return (this.signals.get(type)?.length ?? 0) > 0
}
```

需要从 src/adapters/index.ts 导入 BrainSignal / BrainSignalType 类型。

### T006 — src/index.ts 更新导出

追加导出（不删除 Feature 001 的任何导出）：

```typescript
// ── Brain Runtime ──────────────────────────────────────────────────────────
export type { BrainAdapter, BrainRunParams, BrainRunResult, BrainSignal, BrainSignalType } from './adapters/index'
export type { BrainEvent, EventLevel } from './adapters/index'
export { BrainEventBus, getEventBus } from './eventbus/index'
```

## Definition of Done

- [ ] T001: BrainAdapter 接口、BrainRunParams/Result/Signal 类型在 src/adapters/index.ts
- [ ] T002: BrainEvent 类型、EventLevel 枚举定义
- [ ] T003: BrainEventBus 类，三种订阅方式均可用
- [ ] T004: getEventBus() 返回同一实例（进程级单例）
- [ ] T005: CognitiveWorkspace 有 pushSignal/popSignal/hasSignal 方法
- [ ] T006: src/index.ts 导出更新，bun run build 成功，bun run typecheck 零错误，biome check 通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
# 完成后：
spec-kitty agent tasks move-task WP01 --to for_review --note "Ready: <summary>"
```

## Activity Log

- 2026-03-10T12:57:01Z – claude – shell_pid=21643 – lane=doing – Started implementation via workflow command
- 2026-03-10T13:01:35Z – claude – shell_pid=21643 – lane=for_review – Ready for review: BrainAdapter interface + BrainEventBus implemented. All 6 subtasks complete, typecheck clean, biome clean, 9 unit tests passing, build succeeds.
- 2026-03-10T13:45:04Z – claude – shell_pid=1331 – lane=doing – Started review via workflow command
