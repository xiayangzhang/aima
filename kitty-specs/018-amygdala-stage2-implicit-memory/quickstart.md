# Quickstart & Validation: Amygdala Stage 2 Implicit Memory

## 构建验证

```bash
cd /Volumes/leoyun/aima
bun test tests/unit/amygdala/
bun test
```

## 验证场景

### V1 — 记忆命中，返回 block，无 LLM 调用

```typescript
// mock workspace.getByTags(['amygdala_eval', 'spawn_execution_session'], undefined, 5)
//   → [{ content: '{"tool":"spawn_execution_session","decision":"block","reason":"dangerous spawn"}', createdAt: new Date() }]
const amygdala = new Amygdala(
  { haiku_enabled: true, riskLevels: { spawn_execution_session: 'medium' } },
  mockWorkspace,
  mockEventBus,
)
const result = await amygdala.check('spawn_execution_session', {})
assert(result.decision === 'block')
assert(result.reason === '[memory] dangerous spawn')
// callLlm mock 未被调用
assert(mockCallLlm.callCount === 0)
```

### V2 — 记忆命中，返回 allow

```typescript
// mock getByTags → [{ content: '{"tool":"spawn_execution_session","decision":"allow","reason":"safe context"}', createdAt: new Date() }]
const result = await amygdala.check('spawn_execution_session', {})
assert(result.decision === 'allow')
assert(result.reason.startsWith('[memory]'))
```

### V3 — 多条记录，取 createdAt 最新的

```typescript
const older = { content: '{"tool":"t","decision":"allow","reason":"old"}', createdAt: new Date(Date.now() - 10000), /* ...other MemoryEntry fields */ }
const newer = { content: '{"tool":"t","decision":"block","reason":"new"}', createdAt: new Date(), /* ...other MemoryEntry fields */ }
// mock getByTags → [older, newer]（注意顺序，老的在前）
const result = await amygdala.check('spawn_execution_session', {})
assert(result.decision === 'block')  // 应取 newer 那条
```

### V4 — 无历史，穿透到 Stage 3

```typescript
// mock getByTags → []
// mock callLlm → '{"decision":"allow","reason":"llm says ok"}'
const amygdala = new Amygdala(
  { haiku_enabled: true, riskLevels: { custom_tool: 'high' } },
  mockWorkspace,
  mockEventBus,
)
const result = await amygdala.check('custom_tool', {})
// callLlm 被调用（Stage 3 触发）
assert(mockCallLlm.callCount === 1)
```

### V5 — getByTags 抛出，穿透到 Stage 3，不抛异常

```typescript
// mock getByTags → throw new Error('db connection failed')
// mock callLlm → '{"decision":"escalate","reason":"llm fallback"}'
const result = await amygdala.check('custom_tool', {})
// check() 不抛异常
assert(result.decision !== undefined)
// Stage 3 正常触发
assert(mockCallLlm.callCount === 1)
```

### V6 — content 解析失败，穿透

```typescript
// mock getByTags → [{ content: 'not valid json', createdAt: new Date() }]
// check() 不抛异常，穿透到 Stage 3 或默认 allow
const result = await amygdala.check('spawn_execution_session', {})
assert(result.decision !== undefined)
// reason 不包含 '[memory]' 前缀（Stage 2 未命中）
assert(!result.reason.startsWith('[memory]'))
```

### V7 — 零回归

```bash
bun test
# 全部现有测试通过，无新 failure
```

## Definition of Done

- [ ] `grep -n "getByTags" src/types/index.ts` → ICognitiveWorkspace 含 getByTags 方法
- [ ] `grep -n "getByTags" src/workspace/index.ts` → CognitiveWorkspace 含 getByTags 实现
- [ ] `grep -n "memoryResult = null" src/amygdala/index.ts` → 0（存根已替换）
- [ ] `grep -n "\[memory\]" src/amygdala/index.ts` → Stage 2 含 reason 前缀逻辑
- [ ] V1-V6 场景均有对应 test case
- [ ] `bun test tests/unit/amygdala/` → 全通过
- [ ] `bun test` → 全量零新增 failure
