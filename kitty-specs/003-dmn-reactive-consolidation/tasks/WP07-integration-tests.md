---
work_package_id: WP07
title: 集成测试 + smoke test
lane: planned
dependencies: []
subtasks: [T031, T032, T033, T034, T035]
history:
- 2026-03-11T00:00:00Z – system – lane=planned – Prompt created
---

# WP07 — 集成测试 + smoke test

## 目标

使用真实 PostgreSQL DB 验证 DMN 完整流程；选跑 Consolidation smoke test（需 ANTHROPIC_API_KEY）。

## 上下文

- 依赖 WP06：单元测试通过后再跑集成测试
- 测试工具：**Vitest**（`vitest.integration.config.ts`，Feature 002 已有）
- 测试目录：`tests/integration/dmn/`
- MockBrainAdapter 复用 Feature 002 的 `tests/integration/helpers/mock-brain-adapter.ts`
- 前置条件：`AIMA_TEST_DATABASE_URL` 环境变量，DB 已迁移

## 实现指导

### T031 — 集成测试 helper

**文件**：`tests/integration/dmn/helpers.ts`

```typescript
import { createAIMAInstance } from '../../../src/instance'
import type { AIMAInstance } from '../../../src/instance'

const DB_URL = process.env.AIMA_TEST_DATABASE_URL ?? 'postgresql://localhost:5432/aima_test'

/**
 * 创建带 DMN 的 AIMAInstance，使用真实 DB，mock LLM 调用。
 * LLM mock 通过替换 DmnService 内部的 llm config 实现。
 */
export async function createTestInstance(opts: {
  mockLlmResponse?: () => string  // 每次 callLlm 返回的 JSON 字符串
} = {}): Promise<AIMAInstance> {
  const instance = await createAIMAInstance({
    databaseUrl: DB_URL,
    adapter: 'claude-sdk',
    apiKey: 'mock-key-not-used',  // 不实际调用 LLM adapter
    enableDmn: true,
    dmnConfig: {
      llm: {
        apiKey: opts.mockLlmResponse ? 'mock' : process.env.ANTHROPIC_API_KEY,
      },
      consolidationIntervalMs: 999_999,  // 不自动触发心跳
    }
  })

  // 如果提供了 mock LLM，替换 DmnService 的 callLlm
  if (opts.mockLlmResponse) {
    const dmnService = (instance as any).dmnService
    if (dmnService) {
      // 注入 mock（根据实际实现路径调整）
      const mockFn = opts.mockLlmResponse
      ;(dmnService as any).reactive.config.llm._mockResponse = mockFn
      ;(dmnService as any).consolidation.config.llm._mockResponse = mockFn
    }
  }

  return instance
}
```

---

### T032 — 集成测试：错误恢复完整周期

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createTestInstance } from './helpers'
import { getEventBus } from '../../../src/eventbus/index'

describe('DMN 集成 — 错误恢复', () => {
  let instance: Awaited<ReturnType<typeof createTestInstance>>

  beforeAll(async () => {
    instance = await createTestInstance()
  })

  afterAll(async () => { await instance.stop() })

  test('ALERT 可重试 → Slot 重置 → Thread Runner 可感知', async () => {
    const workspace = (instance as any).workspace
    const bus = getEventBus()

    // 创建测试 Thread
    const threadId = await workspace.createThread({ status: 'active' })

    // 发射 ALERT 事件（模拟 Brainstem 工具超时）
    bus.emit({
      type: 'brain.error',
      level: 'ALERT',
      brain: 'brainstem',
      threadId,
      payload: { retryable: true, errorMessage: 'tool execution timeout' }
    })

    // 等待 DMN Reactive 处理
    await new Promise(r => setTimeout(r, 200))

    // 验证：Brainstem Slot 状态被重置为 pending
    const slot = await workspace.readSlot(threadId, 'brainstem')
    expect(slot?.status).toBe('pending')
    expect(slot?.output?.retryCount).toBe(1)
  })
})
```

---

### T033 — 集成测试：DEFER → pending → 记录存在

```typescript
describe('DMN 集成 — DEFER 调度', () => {
  test('Limbic DEFER Slot → pending 写入 DB', async () => {
    const instance = await createTestInstance()
    const workspace = (instance as any).workspace
    const bus = getEventBus()

    const threadId = await workspace.createThread({ status: 'active' })

    // 写 Limbic Slot（DEFER 输出）并发射事件
    await workspace.writeSlot({
      thread_id: threadId,
      brain: 'limbic',
      status: 'done',
      output: { mode: 'DEFER', timeout_ms: 60_000, defer_reason: 'channel_unavailable' }
    })

    bus.emit({
      type: 'slot.done',
      level: 'INFO',
      brain: 'limbic',
      threadId,
      payload: { output: { mode: 'DEFER', timeout_ms: 60_000, defer_reason: 'channel_unavailable' } }
    })

    await new Promise(r => setTimeout(r, 200))

    // 验证 DB 中 pending 存在
    const pending = await workspace.getPendingObservations()
    const deferPending = pending.filter((p: any) =>
      p.target_brain === 'limbic' && p.note?.includes('channel_unavailable')
    )
    expect(deferPending.length).toBeGreaterThan(0)
    expect(new Date(deferPending[0].trigger_at).getTime()).toBeGreaterThan(Date.now() + 50_000)

    await instance.stop()
  })
})
```

---

### T034 — 集成测试：brain.complete → episodic + segment + markUsed

```typescript
describe('DMN 集成 — brain.complete 四联职责', () => {
  test('brain.complete → episodic 写入 DB + segment_id + markUsed 计数递增', async () => {
    const instance = await createTestInstance()
    const workspace = (instance as any).workspace
    const bus = getEventBus()

    const threadId = await workspace.createThread({ status: 'active' })

    // 预置一条记忆（用于 injectedMemoryIds）
    const memId = await workspace.writeMemory({
      type: 'semantic',
      content: 'test knowledge',
      base_importance: 0.5,
      tags: []
    })

    // 发射 brain.complete
    bus.emit({
      type: 'brain.complete',
      level: 'INFO',
      brain: 'limbic',
      threadId,
      payload: {
        injectedMemoryIds: [memId],
        outputSlot: { status: 'done', output: { mode: 'RESPOND', content: 'Hello' } }
      }
    })

    await new Promise(r => setTimeout(r, 300))

    // 验证 episodic 记忆写入 DB
    const episodic = await workspace.searchMemory({ type: 'episodic', threadId, excludeInvalid: true })
    expect(episodic.length).toBeGreaterThan(0)
    expect(episodic[0].segment_id).toBeTruthy()
    expect(episodic[0].segment_seq).toBe(0)

    // 验证 markMemoryUsed 递增了 usage_outcomes
    const mem = await workspace.searchMemory({ type: 'semantic', excludeInvalid: true, limit: 10 })
    const updated = mem.find((m: any) => m.id === memId)
    // usage_outcomes.positive 应该 >= 1
    const outcomes = updated?.usage_outcomes
    expect(outcomes?.positive ?? 0).toBeGreaterThanOrEqual(1)

    await instance.stop()
  })
})
```

---

### T035 — Consolidation smoke test（需 ANTHROPIC_API_KEY）

```typescript
const describeWithApiKey = process.env.ANTHROPIC_API_KEY
  ? describe
  : describe.skip

describeWithApiKey('DMN Consolidation smoke test', () => {
  test('runConsolidationNow() 完成，无 DB 错误', async () => {
    const instance = await createAIMAInstance({
      databaseUrl: process.env.AIMA_TEST_DATABASE_URL ?? 'postgresql://localhost:5432/aima_test',
      adapter: 'claude-sdk',
      apiKey: process.env.ANTHROPIC_API_KEY,
      enableDmn: true,
    })

    try {
      // 写几条 episodic 记忆作为输入
      const workspace = (instance as any).workspace
      for (let i = 0; i < 3; i++) {
        await workspace.writeMemory({
          type: 'episodic',
          content: `test event ${i}`,
          base_importance: 0.5,
          tags: ['test']
        })
      }

      // 触发一次 Consolidation
      const dmnService = (instance as any).dmnService
      await dmnService.runConsolidationNow()

      // 不需要验证具体预测（LLM 输出不确定），只验证不崩溃
      expect(true).toBe(true)
    } finally {
      await instance.stop()
    }
  }, { timeout: 60_000 })
})
```

## 运行方式

```bash
# 集成测试（需要 DB）
AIMA_TEST_DATABASE_URL=postgresql://localhost:5432/aima_test \
  bun run test:integration -- tests/integration/dmn/

# Consolidation smoke test（需要 API Key + DB）
AIMA_TEST_DATABASE_URL=... ANTHROPIC_API_KEY=... \
  bun run test:integration -- tests/integration/dmn/
```

## 验收标准

- [ ] T032：ALERT 事件触发后 DB 中 Brainstem Slot 状态变为 pending（真实 DB 写入）
- [ ] T033：DEFER 事件触发后 DB 中 pending_observations 记录存在，trigger_at 正确
- [ ] T034：brain.complete 后 DB 中 episodic 记录有 segment_id；markUsed 使 usage_outcomes.positive 递增
- [ ] T035：smoke test 在有 API Key 时通过，无 API Key 时自动跳过

## 实现命令

```bash
spec-kitty implement WP07 --base WP06
```
