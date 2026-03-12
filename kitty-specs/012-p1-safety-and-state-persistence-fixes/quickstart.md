# Quickstart: P1 Safety & State Persistence Fixes

## 验证场景

### Fix 1 — DEFER 状态崩溃恢复

```typescript
// 1. 创建 Thread，激活 Limbic，输出 DEFER
const thread = await workspace.createThread({ initiatedBy: 'external', trigger: 'test' })
// 模拟 Limbic 输出 DEFER
await workspace.writeSlot(thread.id, 'limbic', {
  status: 'done',
  output: { mode: 'DEFER', timeout_ms: 300_000 }
})
// 触发 route()
// 预期：Thread 状态变为 'waiting'，pending_observations 写入一条记录

const updated = await workspace.getThread(thread.id)
assert(updated.state === 'waiting')

const pending = await workspace.getPendingObservations()
assert(pending.some(p => p.targetBrain === 'limbic'))

// 2. 模拟进程重启（新建 ThreadRunner 实例）
const runner2 = new ThreadRunner(...)
await runner2.start()  // recoverInFlightThreads() 运行

// 预期：waiting 状态的 Thread 未被重新激活
// 验证：Thread 状态仍为 'waiting'
const afterRestart = await workspace.getThread(thread.id)
assert(afterRestart.state === 'waiting')
```

---

### Fix 2 — Signal 线程隔离

```typescript
// 1. 推送两个不同 Thread 的信号
workspace.pushSignal({ type: 'amygdala_interrupt', threadId: 'thread-A', message: 'block tool X' })
workspace.pushSignal({ type: 'amygdala_interrupt', threadId: 'thread-B', message: 'block tool Y' })

// 2. Thread-B 查询：只能看到属于自己的信号
const signalForB = workspace.popSignal('amygdala_interrupt', 'thread-B')
assert(signalForB?.message === 'block tool Y')

// 3. Thread-A 的信号未被消费
const signalForA = workspace.popSignal('amygdala_interrupt', 'thread-A')
assert(signalForA?.message === 'block tool X')

// 4. 无信号时返回 undefined
const noSignal = workspace.popSignal('amygdala_interrupt', 'thread-C')
assert(noSignal === undefined)
```

---

### Fix 3 — Segment State 跨重启持久化

```typescript
// 1. DMN 写入 episodic 记录，建立分段
// 假设 threadId = 'thread-X'，分段 S1 建立后 nextSeq = 3

// 2. 验证 DB 中 segment_state 已更新
const thread = await workspace.getThread('thread-X')
assert(thread.segmentState?.segmentId === 'S1')
assert(thread.segmentState?.nextSeq === 3)

// 3. 模拟进程重启
const dmn2 = new DmnReactive(...)
await dmn2.start()

// 4. 新实例恢复了分段状态
// 继续写入 episodic 记录
// 预期：新记录的 segmentSeq === 3（从 nextSeq 继续）
// 而非 0（重新开始）
```

---

## 运行测试

```bash
# 单元测试
bun test tests/unit/runner/defer.test.ts
bun test tests/unit/workspace/signals.test.ts

# 集成测试（需要 PostgreSQL）
bun test tests/integration/workspace/signals.integration.test.ts
bun test tests/integration/dmn/segment-persistence.integration.test.ts

# 全套
bun test

# 类型检查 + Lint
bun run typecheck
bunx biome check src/
```

## Definition of Done

- [ ] `bun run typecheck` 零错误
- [ ] `biome check` 通过
- [ ] Feature 002 原有 39 项测试全部通过
- [ ] 3 个新 Fix 各有独立集成测试（边界覆盖：空信号、并发信号、重启恢复）
- [ ] Thread `waiting` 状态在 DB 中可查询
- [ ] Migration 文件存在且可执行
