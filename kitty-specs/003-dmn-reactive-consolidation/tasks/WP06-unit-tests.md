---
work_package_id: WP06
title: 单元测试
lane: "done"
dependencies: []
subtasks: [T025, T026, T027, T028, T029, T030]
agent: "claude"
shell_pid: "87885"
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP06 — 单元测试

## 目标

纯单元测试：无真实 DB，无真实 LLM（全部 mock），覆盖 DmnReactive 和 DmnConsolidation 的核心路径。

## 上下文

- 依赖 WP01~WP05：测试目标代码
- 测试目录：`tests/unit/dmn/`
- 测试工具：**Bun test**（`bun test`）
- Mock 策略：mock workspace（内存 Map 模拟 DB）+ mock callLlm（返回固定 JSON 字符串）

## Mock 工厂（所有测试共用）

```typescript
// tests/unit/dmn/helpers.ts

import { mock } from 'bun:test'

export function makeMockWorkspace() {
  const memories: any[] = []
  const pending: any[] = []
  const signals: Record<string, any[]> = {}
  const threads: Record<string, { status: string }> = {}
  const slots: Record<string, any> = {}

  return {
    searchMemory: mock(async (opts: any) => memories.filter(m =>
      (!opts.type || m.type === opts.type) &&
      (!opts.threadId || m.threadId === opts.threadId) &&
      (!opts.tags || opts.tags.every((t: string) => m.tags?.includes(t)))
    )),
    writeMemory: mock(async (entry: any) => {
      const id = entry.id ?? crypto.randomUUID()
      memories.push({ ...entry, id, created_at: new Date().toISOString() })
      return id
    }),
    markMemoryUsed: mock(async (ids: string[], outcome: string) => {}),
    writePending: mock(async (p: any) => {
      const id = crypto.randomUUID()
      pending.push({ ...p, id, added_at: new Date().toISOString() })
      return id
    }),
    getPendingObservations: mock(async () => pending),
    removePending: mock(async (id: string) => {
      const idx = pending.findIndex(p => p.id === id)
      if (idx >= 0) pending.splice(idx, 1)
    }),
    pushSignal: mock(async (threadId: string, signal: any) => {
      if (!signals[threadId]) signals[threadId] = []
      signals[threadId].push(signal)
    }),
    popSignal: mock(async (threadId: string, type: string) => {
      const list = signals[threadId] ?? []
      const idx = list.findIndex(s => s.type === type)
      if (idx >= 0) return list.splice(idx, 1)[0]
      return null
    }),
    updateThreadState: mock(async (threadId: string, status: string) => {
      threads[threadId] = { status }
    }),
    writeSlot: mock(async (slot: any) => {
      slots[`${slot.thread_id}:${slot.brain}`] = slot
    }),
    clearWorkingMemory: mock(async (threadId: string) => {}),
    // 测试辅助：直接读内部状态
    _memories: memories,
    _pending: pending,
    _signals: signals,
    _threads: threads,
    _slots: slots,
  }
}

export function makeMockEventBus() {
  const handlers: ((e: any) => void)[] = []
  const emitted: any[] = []
  return {
    subscribe: mock((handler: (e: any) => void) => {
      handlers.push(handler)
      return () => { const i = handlers.indexOf(handler); if (i >= 0) handlers.splice(i, 1) }
    }),
    subscribeLevel: mock(() => () => {}),
    subscribeBrain: mock(() => () => {}),
    emit: mock((event: any) => { emitted.push(event) }),
    // 测试辅助
    _trigger: (event: any) => handlers.forEach(h => h(event)),
    _emitted: emitted,
  }
}

/** mock callLlm：返回固定 JSON 字符串 */
export function mockCallLlm(returnValue: any) {
  return mock(async () => JSON.stringify(returnValue))
}
```

## 实现指导

### T025 — DmnService 生命周期单元测试

**文件**：`tests/unit/dmn/dmn-service.test.ts`

```typescript
import { describe, test, expect, mock } from 'bun:test'
import { DmnService } from '../../../src/dmn/index'
import { makeMockWorkspace, makeMockEventBus } from './helpers'

function makeService(overrides = {}) {
  return new DmnService({
    workspace: makeMockWorkspace() as any,
    eventBus: makeMockEventBus() as any,
    llm: { apiKey: 'test' },
    consolidationIntervalMs: 999_999,  // 不实际触发心跳
    ...overrides
  })
}

describe('DmnService', () => {
  test('start() 幂等：多次调用不报错', async () => {
    const svc = makeService()
    await svc.start()
    await svc.start()  // 第二次应该无操作
    await svc.stop()
  })

  test('stop() 幂等：未启动时调用不报错', async () => {
    const svc = makeService()
    await svc.stop()  // 未 start 直接 stop
  })

  test('runConsolidationNow() 可在 start 后调用', async () => {
    const svc = makeService()
    await svc.start()
    await svc.runConsolidationNow()  // 不应报错
    await svc.stop()
  })
})
```

---

### T026 — DmnReactive 错误恢复单元测试

**文件**：`tests/unit/dmn/dmn-reactive-error.test.ts`

```typescript
import { describe, test, expect } from 'bun:test'
import { DmnReactive } from '../../../src/dmn/reactive/index'
import { makeMockWorkspace, makeMockEventBus } from './helpers'

function makeReactive(wsOverrides = {}) {
  const ws = { ...makeMockWorkspace(), ...wsOverrides }
  const bus = makeMockEventBus()
  const reactive = new DmnReactive({
    workspace: ws as any,
    eventBus: bus as any,
    llm: { apiKey: 'test' },
    maxRetries: 3,
  })
  return { reactive, ws, bus }
}

describe('DmnReactive — 错误恢复', () => {
  test('可重试错误 → Slot 重置为 pending', async () => {
    const { reactive, ws, bus } = makeReactive()
    await reactive.start()

    bus._trigger({
      type: 'brain.error',
      level: 'ALERT',
      brain: 'brainstem',
      threadId: 't1',
      payload: { retryable: true, errorMessage: 'timeout' }
    })

    await new Promise(r => setTimeout(r, 50))  // 等待异步处理

    const slot = ws._slots['t1:brainstem']
    expect(slot?.status).toBe('pending')
    expect(slot?.output?.retryCount).toBe(1)

    await reactive.stop()
  })

  test('不可重试错误 → Thread 标记 interrupted', async () => {
    const { reactive, ws, bus } = makeReactive()
    await reactive.start()

    bus._trigger({
      type: 'brain.error',
      level: 'ALERT',
      brain: 'limbic',
      threadId: 't2',
      payload: { retryable: false, errorMessage: 'permission denied' }
    })

    await new Promise(r => setTimeout(r, 50))

    expect(ws._threads['t2']?.status).toBe('interrupted')

    await reactive.stop()
  })

  test('超过 maxRetries → Thread 标记 interrupted', async () => {
    const { reactive, ws, bus } = makeReactive()
    // 预置 3 次重试计数（达到上限）
    ws._memories.push({
      type: 'working', threadId: 't3',
      content: JSON.stringify({ count: 3, brain: 'cortex' }),
      tags: ['dmn_retry_count']
    })

    await reactive.start()

    bus._trigger({
      type: 'brain.error',
      level: 'ALERT',
      brain: 'cortex',
      threadId: 't3',
      payload: { retryable: true, errorMessage: 'rate limit' }
    })

    await new Promise(r => setTimeout(r, 50))

    expect(ws._threads['t3']?.status).toBe('interrupted')

    await reactive.stop()
  })
})
```

---

### T027 — DmnReactive DEFER 调度单元测试

```typescript
describe('DmnReactive — DEFER 调度', () => {
  test('Limbic DEFER Slot → pending 写入正确 trigger_at', async () => {
    const { reactive, ws, bus } = makeReactive()
    await reactive.start()

    const beforeMs = Date.now()
    bus._trigger({
      type: 'slot.done',
      level: 'INFO',
      brain: 'limbic',
      threadId: 't4',
      payload: {
        output: { mode: 'DEFER', timeout_ms: 3_600_000, defer_reason: 'channel unavailable' }
      }
    })

    await new Promise(r => setTimeout(r, 50))

    expect(ws._pending).toHaveLength(1)
    const p = ws._pending[0]
    expect(p.target_brain).toBe('limbic')
    expect(new Date(p.trigger_at).getTime()).toBeGreaterThanOrEqual(beforeMs + 3_600_000 - 1000)
    expect(p.note).toContain('channel unavailable')

    await reactive.stop()
  })
})
```

---

### T028 — DmnReactive brain.complete 单元测试（段分配 + markUsed）

```typescript
describe('DmnReactive — brain.complete', () => {
  test('新 Thread 第一个 brain.complete → 新 segment_id', async () => {
    const { reactive, ws, bus } = makeReactive()
    await reactive.start()

    bus._trigger({
      type: 'brain.complete',
      level: 'INFO',
      brain: 'limbic',
      threadId: 'new-thread',
      payload: {
        injectedMemoryIds: [],
        outputSlot: { status: 'done', output: { mode: 'RESPOND' } }
      }
    })

    await new Promise(r => setTimeout(r, 50))

    const episodic = ws._memories.filter(m => m.type === 'episodic')
    expect(episodic).toHaveLength(1)
    expect(episodic[0].segment_id).toBeTruthy()
    expect(episodic[0].segment_seq).toBe(0)

    await reactive.stop()
  })

  test('同 Thread 连续两个 brain.complete → 同一 segment，segment_seq 递增', async () => {
    const { reactive, ws, bus } = makeReactive()
    await reactive.start()

    const triggerComplete = () => bus._trigger({
      type: 'brain.complete', level: 'INFO', brain: 'limbic', threadId: 'same-thread',
      payload: { injectedMemoryIds: [], outputSlot: { status: 'done', output: { mode: 'RESPOND' } } }
    })

    triggerComplete()
    await new Promise(r => setTimeout(r, 50))
    triggerComplete()
    await new Promise(r => setTimeout(r, 50))

    const episodic = ws._memories.filter(m => m.type === 'episodic')
    expect(episodic).toHaveLength(2)
    expect(episodic[0].segment_id).toBe(episodic[1].segment_id)
    expect(episodic[1].segment_seq).toBe(1)

    await reactive.stop()
  })

  test('injectedMemoryIds 非空 → markMemoryUsed 被调用', async () => {
    const { reactive, ws, bus } = makeReactive()
    await reactive.start()

    bus._trigger({
      type: 'brain.complete', level: 'INFO', brain: 'limbic', threadId: 't5',
      payload: {
        injectedMemoryIds: ['mem-1', 'mem-2'],
        outputSlot: { status: 'done', output: { mode: 'RESPOND' } }
      }
    })

    await new Promise(r => setTimeout(r, 50))

    expect(ws.markMemoryUsed).toHaveBeenCalledWith(['mem-1', 'mem-2'], 'positive')

    await reactive.stop()
  })

  test('significance_boost → base_importance 叠加', async () => {
    const { reactive, ws, bus } = makeReactive()
    await reactive.start()

    bus._trigger({
      type: 'brain.complete', level: 'INFO', brain: 'brainstem', threadId: 't6',
      payload: {
        injectedMemoryIds: [],
        outputSlot: { status: 'done', output: { mode: 'RESPOND' } },
        significance_boost: 0.3
      }
    })

    await new Promise(r => setTimeout(r, 50))

    const episodic = ws._memories.find(m => m.type === 'episodic' && m.threadId === 't6')
    expect(episodic?.base_importance).toBeGreaterThan(0.5)  // 0.5 + 0.3 = 0.8

    await reactive.stop()
  })
})
```

---

### T029 — 回溯纠错单元测试（Haiku mock）

```typescript
import { describe, test, expect, mock, spyOn } from 'bun:test'
import * as llmModule from '../../../src/dmn/llm'

describe('DmnReactive — 回溯纠错', () => {
  test('Haiku 判断需要纠错 → pushSignal(dmn_correction) 被调用', async () => {
    // Mock callLlm 返回"需要纠错"
    const spy = spyOn(llmModule, 'callLlm').mockResolvedValue(JSON.stringify({
      needs_correction: true,
      correction_type: 'reasoning_error',
      correction_message: 'The previous step incorrectly assumed X'
    }))

    const { reactive, ws, bus } = makeReactive()
    // 预置足够的 episodic 记录（触发 Haiku 调用条件）
    for (let i = 0; i < 5; i++) {
      ws._memories.push({ type: 'episodic', threadId: 'tc', content: `event ${i}`, tags: [] })
    }

    await reactive.start()

    bus._trigger({
      type: 'brain.complete', level: 'INFO', brain: 'cortex', threadId: 'tc',
      payload: {
        injectedMemoryIds: [],
        outputSlot: { status: 'done', output: { mode: 'ROUTE' } }
      }
    })

    await new Promise(r => setTimeout(r, 100))

    const signals = ws._signals['tc'] ?? []
    expect(signals.some(s => s.type === 'dmn_correction')).toBe(true)

    spy.mockRestore()
    await reactive.stop()
  })

  test('Haiku 判断无需纠错 → 不写 Signal', async () => {
    const spy = spyOn(llmModule, 'callLlm').mockResolvedValue(JSON.stringify({
      needs_correction: false, correction_type: null, correction_message: ''
    }))

    const { reactive, ws, bus } = makeReactive()
    for (let i = 0; i < 5; i++) {
      ws._memories.push({ type: 'episodic', threadId: 'tn', content: `event ${i}`, tags: [] })
    }
    await reactive.start()
    bus._trigger({
      type: 'brain.complete', level: 'INFO', brain: 'limbic', threadId: 'tn',
      payload: { injectedMemoryIds: [], outputSlot: { status: 'done', output: { mode: 'RESPOND' } } }
    })
    await new Promise(r => setTimeout(r, 100))

    expect(ws._signals['tn'] ?? []).toHaveLength(0)

    spy.mockRestore()
    await reactive.stop()
  })
})
```

---

### T030 — DmnConsolidation 前瞻预测 + Pending 维护单元测试

```typescript
import { describe, test, expect, spyOn } from 'bun:test'
import * as llmModule from '../../../src/dmn/llm'
import { DmnConsolidation } from '../../../src/dmn/consolidation/index'
import { makeMockWorkspace } from './helpers'

describe('DmnConsolidation — 前瞻预测', () => {
  test('LLM 返回高置信度预测 → pending 写入', async () => {
    const spy = spyOn(llmModule, 'callLlm').mockResolvedValue(JSON.stringify([
      { target_brain: 'brainstem', note: 'Process payment check', trigger_at_hours: 24, confidence: 'high' }
    ]))

    const ws = makeMockWorkspace()
    ws._memories.push({ type: 'episodic', content: 'contract signed', tags: [], created_at: new Date().toISOString() })

    const consolidation = new DmnConsolidation({
      workspace: ws as any,
      llm: { apiKey: 'test' },
      consolidationIntervalMs: 999_999
    })

    await consolidation.runOnce()

    expect(ws._pending.some(p => p.target_brain === 'brainstem')).toBe(true)
    spy.mockRestore()
  })

  test('低置信度预测（confidence=low）不写 pending', async () => {
    const spy = spyOn(llmModule, 'callLlm').mockResolvedValue(JSON.stringify([
      { target_brain: 'limbic', note: 'maybe check something', trigger_at_hours: 0, confidence: 'low' }
    ]))

    const ws = makeMockWorkspace()
    ws._memories.push({ type: 'episodic', content: 'some event', tags: [], created_at: new Date().toISOString() })

    const consolidation = new DmnConsolidation({
      workspace: ws as any, llm: { apiKey: 'test' }, consolidationIntervalMs: 999_999
    })
    await consolidation.runOnce()

    expect(ws._pending).toHaveLength(0)
    spy.mockRestore()
  })
})

describe('DmnConsolidation — Pending 维护', () => {
  test('LLM 决定 remove → pending 被删除', async () => {
    const spy = spyOn(llmModule, 'callLlm').mockResolvedValue(JSON.stringify([
      { action: 'remove', updated_note: null }
    ]))

    const ws = makeMockWorkspace()
    ws._pending.push({ id: 'p1', target_brain: 'limbic', note: 'old task', added_at: new Date().toISOString() })

    const consolidation = new DmnConsolidation({
      workspace: ws as any, llm: { apiKey: 'test' }, consolidationIntervalMs: 999_999
    })
    await consolidation.runOnce()

    expect(ws._pending).toHaveLength(0)
    spy.mockRestore()
  })
})
```

## 运行方式

```bash
bun test tests/unit/dmn/
```

## 验收标准

- [ ] 所有测试通过 `bun test tests/unit/dmn/`，无报错
- [ ] T025：DmnService 生命周期幂等性验证通过
- [ ] T026：可重试/不可重试/超限三种错误路径各有测试
- [ ] T027：DEFER pending 写入参数（trigger_at、target_brain）正确
- [ ] T028：segment_id 分配、segment_seq 递增、markUsed 被调用、significance_boost 叠加
- [ ] T029：Haiku mock 控制回溯纠错结果，Signal 写入与否正确
- [ ] T030：预测写 pending（高置信度）、不写 pending（低置信度）、Pending 维护 remove

## 实现命令

```bash
spec-kitty implement WP06 --base WP05
```

## Activity Log

- 2026-03-10T15:08:13Z – claude – shell_pid=87885 – lane=doing – Started implementation via workflow command
- 2026-03-10T15:14:15Z – claude – shell_pid=87885 – lane=for_review – Ready for review: helpers.ts mock factory + 39 comprehensive tests (T025-T032). All 174 unit tests pass.
