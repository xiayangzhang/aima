# Quickstart & Validation: Amygdala Stage 3 LLM Eval

## 构建验证

```bash
cd /Volumes/leoyun/aima
bun test tests/unit/amygdala/
bun test
```

## 验证场景

### V1 — LLM 返回 allow

```typescript
// mock callLlm → '{"decision":"allow","reason":"safe read context"}'
const result = await amygdala.check('bash', { cmd: 'ls /tmp' })
assert(result.decision === 'allow')
assert(result.reason === 'safe read context')
// writeMemory 被调用，type='implicit', tags 含 'allow'
```

### V2 — LLM 返回 block

```typescript
// mock callLlm → '{"decision":"block","reason":"destructive command detected"}'
const result = await amygdala.check('bash', { cmd: 'rm -rf /' })
assert(result.decision === 'block')
```

### V3 — LLM 调用失败 → escalate

```typescript
// mock callLlm → throw new Error('network timeout')
const result = await amygdala.check('bash', {})
assert(result.decision === 'escalate')
// 不抛异常
// writeMemory 仍被调用（记录失败回退）
```

### V4 — LLM 返回非法 decision → escalate

```typescript
// mock callLlm → '{"decision":"unknown","reason":"..."}'
const result = await amygdala.check('bash', {})
assert(result.decision === 'escalate')
```

### V5 — haiku_enabled=false：Stage 3 不触发

```typescript
const amygdala = new Amygdala({ haiku_enabled: false }, workspace, eventBus)
// callLlm mock 未被调用
const result = await amygdala.check('bash', {})
assert(callLlmMock.callCount === 0)
```

### V6 — medium risk：Stage 3 不触发

```typescript
// file_read 是 medium risk
const result = await amygdala.check('file_read', {})
assert(callLlmMock.callCount === 0)
```

### V7 — 记忆写入失败不影响决策

```typescript
// mock workspace.writeMemory → throw
// check() 正常返回决策，不传播异常
const result = await amygdala.check('bash', {})
assert(result.decision !== undefined)
```

### V8 — 零回归

```bash
bun test
# 全部现有测试通过，无新 failure
```

## Definition of Done

- [ ] `grep -n "evaluateWithLlm\|writeEvalMemory" src/amygdala/index.ts` → 两个新方法存在
- [ ] `grep -n "llm\?" src/amygdala/index.ts` → AmygdalaConfig 含 llm 字段
- [ ] `grep -n "_args" src/amygdala/index.ts` → 0（参数已改为 args）
- [ ] V1-V7 场景均有对应 test case
- [ ] `bun test tests/unit/amygdala/` → 全通过
- [ ] `bun test` → 全量零新增 failure
