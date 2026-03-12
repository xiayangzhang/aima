# Quickstart & Validation: Session Context Retrieval

## 构建验证

```bash
cd /Volumes/leoyun/aima
bun test tests/unit/workspace/workspace-session-context.test.ts
bun test  # 全量，确认零回归
```

## 验证场景

### V1 — 正常返回多条 episodic 记录

**目的**：验证 FR-001 (events 正确) + FR-002 (anchor = 最早)

```typescript
const m1 = await workspace.writeMemory({ type: 'episodic', content: 'first event', sessionId: 'sess-A' })
// 等待 1ms 保证 createdAt 有序
const m2 = await workspace.writeMemory({ type: 'episodic', content: 'second event', sessionId: 'sess-A' })
const m3 = await workspace.writeMemory({ type: 'episodic', content: 'third event', sessionId: 'sess-A' })

const ctx = await workspace.getSessionContext('sess-A')

assert(ctx.anchor !== null)
assert(ctx.anchor.id === m1.id)             // anchor = 最早
assert(ctx.events.length === 3)             // 全量返回
assert(ctx.events[0].id === m1.id)          // 升序第一
assert(ctx.events[2].id === m3.id)          // 升序最后
```

**期望**：pass

---

### V2 — 空 session（不存在的 sessionId）

**目的**：验证 FR-005 (不抛异常，返回空结果)

```typescript
const ctx = await workspace.getSessionContext('session-does-not-exist')

assert(ctx.anchor === null)
assert(ctx.events.length === 0)
```

**期望**：pass，不抛异常

---

### V3 — 跨 session 隔离

**目的**：验证 FR-003 (严格按 sessionId 过滤，不混入其他 session)

```typescript
await workspace.writeMemory({ type: 'episodic', content: 'sess-B event', sessionId: 'sess-B' })

const ctx = await workspace.getSessionContext('sess-A')

// sess-A 的结果中不含 sess-B 的记录
assert(ctx.events.every(e => e.sessionId === 'sess-A'))
```

**期望**：pass

---

### V4 — 软删除过滤

**目的**：验证 FR-004 (软删除条目不出现)

```typescript
const m = await workspace.writeMemory({ type: 'episodic', content: 'to delete', sessionId: 'sess-C' })
await workspace.invalidateMemory(m.id)

const ctx = await workspace.getSessionContext('sess-C')

assert(ctx.anchor === null)
assert(ctx.events.length === 0)
```

**期望**：pass

---

### V5 — 非 episodic 记忆不返回

**目的**：验证 FR-003 的记忆类型过滤语义（只查 episodic）

```typescript
await workspace.writeMemory({ type: 'working', content: 'working mem', sessionId: 'sess-D' })
await workspace.writeMemory({ type: 'semantic', content: 'semantic mem', sessionId: 'sess-D' })

const ctx = await workspace.getSessionContext('sess-D')

assert(ctx.anchor === null)
assert(ctx.events.length === 0)
```

**期望**：pass

---

### V6 — 单条记录：anchor === events[0]

**目的**：验证 US2 场景 2（一条记录时 anchor 和 events 都指向同一条）

```typescript
const m = await workspace.writeMemory({ type: 'episodic', content: 'only one', sessionId: 'sess-E' })

const ctx = await workspace.getSessionContext('sess-E')

assert(ctx.anchor !== null)
assert(ctx.anchor.id === m.id)
assert(ctx.events.length === 1)
assert(ctx.events[0].id === m.id)
```

**期望**：pass

---

### V7 — 零回归检查

```bash
cd /Volumes/leoyun/aima && bun test
```

**期望**：全部现有测试继续通过，无新 failure。

## Definition of Done

- [ ] `grep -n "getSessionContext" src/types/index.ts` → 有方法签名
- [ ] `grep -n "getSessionContext" src/workspace/index.ts` → 有实现
- [ ] `bun test tests/unit/workspace/workspace-session-context.test.ts` → 全通过
- [ ] `bun test` → 全量零回归
- [ ] V1-V6 场景在测试中均有对应 test case
