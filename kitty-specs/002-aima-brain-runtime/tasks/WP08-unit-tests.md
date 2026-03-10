---
work_package_id: WP08
title: 单元测试（ThreadRunner / EventBus / ContextAssembler）
lane: planned
dependencies: []
subtasks: [T045, T046, T047, T048, T049, T050, T051]
history:
- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
---

# WP08 — 单元测试

## 目标

覆盖核心路由逻辑、EventBus 行为、ContextAssembler 输出格式，以及 Amygdala 三段决策。所有测试无需真实 DB 或 LLM（使用 mock）。

## 上下文

- 依赖 WP01/02/03/04：测试目标代码
- 测试文件目录：`src/__tests__/unit/`
- 测试工具：**Bun test**（`bun test`，不是 Vitest）
- Mock 策略：在测试文件内用工厂函数构造假的 workspace/adapter/memory
- 不需要真实 PostgreSQL 连接

## 实现指导

### T045 — BrainEventBus 单元测试

**文件**：`src/__tests__/unit/eventbus.test.ts`

测试场景：

```typescript
import { describe, test, expect, mock } from 'bun:test'
import { BrainEventBus, getEventBus } from '../../eventbus/index'

describe('BrainEventBus', () => {
  test('emit() 触发对应 subscribe() 回调', async () => {
    const bus = new BrainEventBus()
    const received: any[] = []
    bus.subscribe((e) => received.push(e))
    bus.emit({ type: 'brain.complete', level: 'INFO', brain: 'limbic', threadId: 't1', payload: {} })
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('brain.complete')
  })

  test('subscribeLevel() 只收指定级别及以上事件', async () => {
    const bus = new BrainEventBus()
    const received: any[] = []
    bus.subscribeLevel('COMPLIANCE', (e) => received.push(e))
    
    bus.emit({ type: 'tool.post_use', level: 'INFO', brain: 'limbic', threadId: 't1', payload: {} })
    bus.emit({ type: 'tool.blocked', level: 'COMPLIANCE', brain: 'limbic', threadId: 't1', payload: {} })
    bus.emit({ type: 'system.alert', level: 'ALERT', brain: 'limbic', threadId: 't1', payload: {} })
    
    // INFO 不收，COMPLIANCE 和 ALERT 都收
    expect(received).toHaveLength(2)
  })

  test('subscribeBrain() 只收指定脑区事件', async () => {
    const bus = new BrainEventBus()
    const received: any[] = []
    bus.subscribeBrain('limbic', (e) => received.push(e))
    
    bus.emit({ type: 'brain.complete', level: 'INFO', brain: 'limbic', threadId: 't1', payload: {} })
    bus.emit({ type: 'brain.complete', level: 'INFO', brain: 'cortex', threadId: 't1', payload: {} })
    
    expect(received).toHaveLength(1)
    expect(received[0].brain).toBe('limbic')
  })

  test('getEventBus() 返回进程级单例', () => {
    const a = getEventBus()
    const b = getEventBus()
    expect(a).toBe(b)  // 严格相同实例
  })
  
  test('unsubscribe 后不再收事件', () => {
    const bus = new BrainEventBus()
    const received: any[] = []
    const unsub = bus.subscribe((e) => received.push(e))
    unsub()
    bus.emit({ type: 'brain.complete', level: 'INFO', brain: 'limbic', threadId: 't1', payload: {} })
    expect(received).toHaveLength(0)
  })
})
```

---

### T046 — ContextAssembler 单元测试

**文件**：`src/__tests__/unit/context-assembler.test.ts`

核心验证：Block 1/2 静态性（两次调用结果相同），Block 3 含时间，Block 4 按脑区路由。

```typescript
import { describe, test, expect, mock } from 'bun:test'
import { assembleBlock12, assembleContext } from '../../context/index'

// Mock workspace
function makeMockWorkspace(slots: any[] = [], signals: any[] = []) {
  return {
    getSlots: mock(async (threadId: string) => slots),
    popSignal: mock(async () => null),
    // 其他方法...
  }
}

// Mock memory service（Block 4）
function makeMockMemory(entries: any[] = []) {
  return {
    search: mock(async () => entries),
    getEntityContext: mock(async () => entries),
    findSimilarSituations: mock(async () => ({ episodes: entries, procedures: [] })),
    getProcedure: mock(async () => entries),
  }
}

const baseConfig = {
  timezone: 'UTC',
  instanceId: 'test-instance',
}

describe('assembleBlock12', () => {
  test('两次调用返回相同字符串（静态性）', () => {
    const a = assembleBlock12(baseConfig)
    const b = assembleBlock12(baseConfig)
    expect(a).toBe(b)
  })

  test('不包含当前时间（无动态内容）', () => {
    const result = assembleBlock12(baseConfig)
    // Block 1/2 不应包含任何 ISO 时间戳格式
    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })
})

describe('assembleContext Block 3', () => {
  test('包含当前时间', async () => {
    const before = new Date().toISOString().slice(0, 16)  // YYYY-MM-DDTHH:MM
    const { systemPrompt } = await assembleContext(
      'limbic',
      makeMockWorkspace(),
      'thread-1',
      baseConfig,
      ''  // 空 block12
    )
    const after = new Date().toISOString().slice(0, 16)
    // systemPrompt 中应该包含 before 或 after（允许分钟边界误差）
    expect(systemPrompt).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('assembleContext Block 4 — 脑区路由', () => {
  test('Limbic 调用 getEntityContext（不调用 getProcedure）', async () => {
    const memory = makeMockMemory()
    const ws = makeMockWorkspace()
    
    await assembleContext('limbic', ws, 't1', { ...baseConfig, memoryService: memory }, '')
    
    // Limbic 使用实体中心检索，不使用过程检索
    expect(memory.getEntityContext).toHaveBeenCalled()
    expect(memory.getProcedure).not.toHaveBeenCalled()
  })

  test('Brainstem 调用 getProcedure（不调用 getEntityContext）', async () => {
    const memory = makeMockMemory()
    const ws = makeMockWorkspace()
    
    await assembleContext('brainstem', ws, 't1', { ...baseConfig, memoryService: memory }, '')
    
    expect(memory.getProcedure).toHaveBeenCalled()
    expect(memory.getEntityContext).not.toHaveBeenCalled()
  })
})
```

---

### T047 — Amygdala 单元测试

**文件**：`src/__tests__/unit/amygdala.test.ts`

```typescript
import { describe, test, expect, mock } from 'bun:test'
import { Amygdala } from '../../amygdala/index'
import { BrainEventBus } from '../../eventbus/index'

function makeMockWorkspace() {
  return {
    pushSignal: mock(async () => {}),
    popSignal: mock(async () => null),
  }
}

function makeAmygdala(overrides = {}) {
  return new Amygdala({
    eventBus: new BrainEventBus(),
    workspace: makeMockWorkspace() as any,
    model: 'claude-haiku-4-5-20251001',
    getApiKey: () => 'test-key',
    ...overrides
  })
}

describe('Amygdala.check() — 静态规则', () => {
  test('bash → BLOCK（默认规则）', async () => {
    const amygdala = makeAmygdala()
    const result = await amygdala.check('bash', { command: 'rm -rf /' })
    expect(result.block).toBe(true)
    expect(result.reason).toContain('bash')
  })

  test('file_write → BLOCK（默认规则）', async () => {
    const amygdala = makeAmygdala()
    const result = await amygdala.check('file_write', { path: '/etc/passwd' })
    expect(result.block).toBe(true)
  })

  test('memory_search → ALLOW（默认规则）', async () => {
    const amygdala = makeAmygdala()
    const result = await amygdala.check('memory_search', { query: 'test' })
    expect(result.block).toBe(false)
  })

  test('workspace_read_slot → ALLOW（默认规则）', async () => {
    const amygdala = makeAmygdala()
    const result = await amygdala.check('workspace_read_slot', { threadId: 't1', brain: 'limbic' })
    expect(result.block).toBe(false)
  })

  test('未知工具 → 走降级路径（Haiku mock）', async () => {
    // mock Haiku 调用返回 ALLOW
    const mockCheck = mock(async () => ({ block: false, reason: 'ok', source: 'llm' }))
    const amygdala = makeAmygdala()
    // 注入 mock（根据实际实现方式注入）
    ;(amygdala as any).llmFallback = mockCheck
    
    const result = await amygdala.check('custom_unknown_tool', {})
    // 不确定是 ALLOW 还是 BLOCK，但不应该报错
    expect(typeof result.block).toBe('boolean')
  })
})
```

---

### T048 — ThreadRunner 路由单元测试 — Limbic RESPOND → complete

**文件**：`src/__tests__/unit/thread-runner-route.test.ts`

```typescript
import { describe, test, expect, mock } from 'bun:test'
import { ThreadRunner } from '../../runner/index'
import { BrainEventBus } from '../../eventbus/index'

// Mock workspace
function makeMockWorkspace(slots: Record<string, any> = {}) {
  const callbacks: Function[] = []
  return {
    onSlotChange: mock((cb: Function) => {
      callbacks.push(cb)
      return () => {}  // unsubscribe
    }),
    getSlot: mock(async (threadId: string, brain: string) => slots[`${threadId}:${brain}`] ?? null),
    getActiveThreads: mock(async () => []),
    waitForComplete: mock(async () => {}),
    notifySlotDone: mock(async () => {}),
    pushSignal: mock(async () => {}),
    popSignal: mock(async () => null),
    // 触发 slot change 事件（测试辅助）
    _trigger: (event: any) => callbacks.forEach(cb => cb(event)),
  }
}

// Mock adapter（返回固定 slot 结果）
function makeMockAdapter(brain: string, threadId: string, outputSlot: any) {
  return {
    run: mock(async (params: any) => {
      // 模拟写 slot 到 workspace
      return { brain, threadId, sessionId: 'mock-session', injectedMemoryIds: [] }
    }),
    inject: mock(async () => {}),
    abort: mock(async () => {}),
  }
}

describe('ThreadRunner 路由 — Limbic RESPOND', () => {
  test('Limbic done + mode=RESPOND → Thread complete', async () => {
    const workspace = makeMockWorkspace()
    const bus = new BrainEventBus()
    const limbicAdapter = makeMockAdapter('limbic', 't1', {})
    
    const runner = new ThreadRunner({
      workspace: workspace as any,
      eventBus: bus,
      adapters: { limbic: limbicAdapter as any },
      assemblerConfig: { timezone: 'UTC' } as any,
      block12: 'mock-block12'
    })
    
    await runner.start()
    
    // 模拟 Limbic Slot done + mode=RESPOND
    workspace._trigger({
      type: 'slot_changed',
      threadId: 't1',
      brain: 'limbic',
      status: 'done',
      output: { mode: 'RESPOND', content: 'Hello back' }
    })
    
    // Thread 应该完成（waitForComplete 被调用或 notifySlotDone 触发）
    await new Promise(r => setTimeout(r, 10))  // 等待异步路由处理
    
    // 验证：Cortex 没有被激活
    const cortexAdapter = { run: mock(async () => ({})) }
    expect(cortexAdapter.run).not.toHaveBeenCalled()
    
    await runner.stop()
  })
})
```

---

### T049 — ThreadRunner 路由 — Limbic ROUTE → Cortex → Limbic

```typescript
describe('ThreadRunner 路由 — Limbic ROUTE → Cortex → Limbic', () => {
  test('Limbic ROUTE 激活 Cortex，Cortex intent=communicate 激活 Limbic', async () => {
    const workspace = makeMockWorkspace()
    const bus = new BrainEventBus()
    
    const activationOrder: string[] = []
    
    const limbicAdapter = {
      run: mock(async (params: any) => {
        activationOrder.push(`limbic:${activationOrder.length}`)
        return { brain: 'limbic', threadId: params.threadId, sessionId: 'sid', injectedMemoryIds: [] }
      }),
      inject: mock(async () => {}),
      abort: mock(async () => {}),
    }
    
    const cortexAdapter = {
      run: mock(async (params: any) => {
        activationOrder.push('cortex')
        return { brain: 'cortex', threadId: params.threadId, sessionId: 'sid', injectedMemoryIds: [] }
      }),
      inject: mock(async () => {}),
      abort: mock(async () => {}),
    }
    
    const runner = new ThreadRunner({
      workspace: workspace as any,
      eventBus: bus,
      adapters: { limbic: limbicAdapter as any, cortex: cortexAdapter as any },
      assemblerConfig: { timezone: 'UTC' } as any,
      block12: ''
    })
    
    await runner.start()
    
    // 1. Limbic done + mode=ROUTE
    workspace._trigger({
      type: 'slot_changed', threadId: 't1', brain: 'limbic', status: 'done',
      output: { mode: 'ROUTE', needs_analysis: true }
    })
    await new Promise(r => setTimeout(r, 10))
    
    // 2. Cortex done + intent=communicate
    workspace._trigger({
      type: 'slot_changed', threadId: 't1', brain: 'cortex', status: 'done',
      output: { intent: 'communicate' }
    })
    await new Promise(r => setTimeout(r, 10))
    
    // 3. Limbic done + mode=RESPOND（最终）
    workspace._trigger({
      type: 'slot_changed', threadId: 't1', brain: 'limbic', status: 'done',
      output: { mode: 'RESPOND', content: 'Final response' }
    })
    await new Promise(r => setTimeout(r, 10))
    
    expect(activationOrder).toEqual(['limbic:0', 'cortex', 'limbic:1'])
    
    await runner.stop()
  })
})
```

---

### T050 — ThreadRunner 路由 — Cortex intent=both（完整三段序列）

```typescript
describe('ThreadRunner 路由 — Cortex intent=both', () => {
  test('Limbic(试探) → Brainstem → Limbic(最终确认) 序列', async () => {
    const workspace = makeMockWorkspace()
    const bus = new BrainEventBus()
    const activations: string[] = []
    
    const makeAdapter = (name: string) => ({
      run: mock(async (p: any) => { activations.push(name); return { brain: name, threadId: p.threadId, sessionId: 's', injectedMemoryIds: [] } }),
      inject: mock(async () => {}),
      abort: mock(async () => {}),
    })
    
    const runner = new ThreadRunner({
      workspace: workspace as any,
      eventBus: bus,
      adapters: {
        limbic: makeAdapter('limbic') as any,
        cortex: makeAdapter('cortex') as any,
        brainstem: makeAdapter('brainstem') as any
      },
      assemblerConfig: { timezone: 'UTC' } as any,
      block12: ''
    })
    
    await runner.start()
    
    // Limbic ROUTE
    workspace._trigger({ type: 'slot_changed', threadId: 't1', brain: 'limbic', status: 'done', output: { mode: 'ROUTE' } })
    await new Promise(r => setTimeout(r, 10))
    
    // Cortex intent=both
    workspace._trigger({ type: 'slot_changed', threadId: 't1', brain: 'cortex', status: 'done', output: { intent: 'both' } })
    await new Promise(r => setTimeout(r, 10))
    
    // Limbic 试探完成（RESPOND 或其他，但 ThreadRunner 还不结束 — 因为 Brainstem 还没跑）
    workspace._trigger({ type: 'slot_changed', threadId: 't1', brain: 'limbic', status: 'done', output: { mode: 'RESPOND' } })
    await new Promise(r => setTimeout(r, 10))
    
    // Brainstem done
    workspace._trigger({ type: 'slot_changed', threadId: 't1', brain: 'brainstem', status: 'done', output: {} })
    await new Promise(r => setTimeout(r, 10))
    
    // Limbic 最终确认
    workspace._trigger({ type: 'slot_changed', threadId: 't1', brain: 'limbic', status: 'done', output: { mode: 'RESPOND' } })
    await new Promise(r => setTimeout(r, 10))
    
    // 验证激活顺序
    expect(activations).toContain('cortex')
    expect(activations).toContain('brainstem')
    // Limbic 应该激活至少两次（试探 + 最终确认）
    expect(activations.filter(a => a === 'limbic').length).toBeGreaterThanOrEqual(2)
    
    await runner.stop()
  })
})
```

---

### T051 — ThreadRunner pending 路由单元测试

```typescript
describe('ThreadRunner — pending_observations 路由', () => {
  test('pending trigger_at <= now 时激活 Limbic', async () => {
    const pendingObs = {
      id: 'pending-1',
      thread_id: 't2',
      trigger_at: new Date(Date.now() - 1000).toISOString(),  // 1秒前，已过期
      content: 'pending content'
    }
    
    const workspace = makeMockWorkspace()
    workspace.getPendingObservations = mock(async () => [pendingObs])
    workspace.deletePendingObservation = mock(async () => {})
    
    const limbicRuns: any[] = []
    const limbicAdapter = {
      run: mock(async (p: any) => { limbicRuns.push(p); return { brain: 'limbic', threadId: p.threadId, sessionId: 's', injectedMemoryIds: [] } }),
      inject: mock(async () => {}),
      abort: mock(async () => {}),
    }
    
    const runner = new ThreadRunner({
      workspace: workspace as any,
      eventBus: new BrainEventBus(),
      adapters: { limbic: limbicAdapter as any },
      assemblerConfig: { timezone: 'UTC' } as any,
      block12: ''
    })
    
    await runner.start()
    await runner.routePending()
    
    // Limbic 应该被激活（处理 pending）
    expect(limbicAdapter.run).toHaveBeenCalled()
    expect(workspace.deletePendingObservation).toHaveBeenCalledWith('pending-1')
    
    await runner.stop()
  })
})
```

## 运行方式

```bash
# 运行所有单元测试
bun test src/__tests__/unit/

# 运行单个文件
bun test src/__tests__/unit/eventbus.test.ts
```

## 验收标准

- [ ] 所有测试通过 `bun test` 运行，无报错
- [ ] T045：EventBus 的 emit/subscribe/subscribeLevel/subscribeBrain/singleton/unsubscribe 均有测试
- [ ] T046：Block 1/2 静态性验证通过（两次输出相同），Block 4 脑区路由测试通过
- [ ] T047：bash/file_write BLOCK，memory_search ALLOW，静态规则覆盖
- [ ] T048-T050：ThreadRunner 路由的三条主要路径（RESPOND/ROUTE→Cortex/intent=both）有测试
- [ ] T051：pending 路由有测试
- [ ] 所有 mock 清晰，测试无真实网络或 DB 调用

## 实现命令

```bash
spec-kitty implement WP08 --base WP04
```

注意：WP08 依赖 WP01-WP04，用 WP04 作为 --base（WP04 已合并 WP01/WP02 的内容）。
