# Implementation Plan: Brain Output Model Migration

**Branch**: `013-brain-output-model-migration` | **Date**: 2026-03-12 | **Spec**: [spec.md](./spec.md)

---

## Summary

将所有脑区的输出结构从 `mode/intent` 枚举体系迁移到 `{next?, reply?, handoff?}` 三字段解耦结构。核心变更点有三处：**TypeScript 类型系统**（新增 `BrainOutput` 类型，删除 `Intent`/`ComplexityHint` 类型）、**Thread Runner 路由逻辑**（统一读取 `next` 字段，处理 `reply`，传递 `handoff`，废除 `intent=both` 三步路由硬编码）、**各脑区 LLM 输出 Schema**（更新 Limbic/Cortex/Brainstem 的结构化输出工具定义）。同步清理：删除 `slots.intent`/`slots.complexity_hint` 数据库列，更新 DMN Reactive 中 4 处 `mode`/`intent` 引用。

---

## Technical Context

**Language/Version**: TypeScript 5.x (Bun runtime)
**Primary Dependencies**: Drizzle ORM, PostgreSQL, pi-coding-agent / claude-sdk adapters
**Storage**: PostgreSQL — `slots` 表有 `intent` 和 `complexity_hint` 列需要删除
**Testing**: `bun test` — 当前 407 项测试全部须保持通过
**Target Platform**: Node-compatible Bun runtime，服务器部署
**Project Type**: TypeScript library (AIMA core framework)
**Performance Goals**: 无性能目标变化；迁移是结构性重构
**Constraints**: 零回归（407 项测试），旧字段 `mode`/`intent` 从代码库完全消失
**Scale/Scope**: 影响范围：`src/types/index.ts`、`src/runner/index.ts`、`src/schema/slots.ts`、`src/workspace/index.ts`、`src/dmn/reactive/index.ts`、各脑区 adapter 的 output schema 定义、一次数据库 migration

---

## Constitution Check

无 constitution 文件（`.kittify/memory/constitution.md` 不存在），跳过此检查。

---

## Project Structure

### Documentation (this feature)

```
kitty-specs/013-brain-output-model-migration/
├── plan.md          ← 本文件
├── data-model.md    ← BrainOutput 类型 + Slot schema 变更
├── quickstart.md    ← 验证场景 / DoD
└── tasks/           ← 由 /spec-kitty.tasks 生成
```

### Source Code (affected files)

```
src/
├── types/index.ts              ← 新增 BrainOutput，删除 Intent/ComplexityHint
├── runner/index.ts             ← 核心路由逻辑重写
├── schema/slots.ts             ← 删除 intent/complexityHint 列
├── workspace/index.ts          ← 更新 WriteSlotParams，移除 intent/complexityHint 读写
├── dmn/reactive/index.ts       ← 4 处 mode/intent 引用更新
└── adapters/
    ├── pi-agent/index.ts       ← 更新 Limbic/Cortex/Brainstem output schema
    ├── claude-sdk/index.ts     ← 同上
    └── pi-coding-agent/index.ts ← 同上（如有脑区 schema 定义）

drizzle/migrations/
└── 0002_remove_slot_intent_columns.sql  ← 新 migration
```

---

## Root Cause Analysis

### 当前问题：枚举互斥导致表达力缺失

**Limbic 输出（`mode` 枚举）**：
```
'RESPOND' | 'NO_REPLY' | 'ROUTE' | 'EXECUTE' | 'DEFER'
```
- `RESPOND` → 回复用户 + 结束 Thread
- `NO_REPLY` → 不回复 + 结束 Thread
- `ROUTE` → 路由 Cortex（不回复）
- `EXECUTE` → 路由 Brainstem（不回复）
- `DEFER` → 延时等待（不回复）

**核心问题**：Limbic 无法同时表达"回复用户 + 路由 Brainstem"——枚举要求二选一。

**Cortex 输出（`intent` 枚举）**：
```
'communicate' | 'execute' | 'both'
```
- `both` 触发 Thread Runner 中硬编码的三步路由：`limbic → brainstem → limbic`
- Brainstem 完成后的回 Limbic 路由，取决于 Cortex 事先设置了 `intent=both`——Brainstem 自己没有自主权

**Thread Runner 中的硬编码**（`src/runner/index.ts:155-164`）：
```typescript
} else if (currentBrain === 'brainstem') {
  const cortexOutput = slotMap.cortex?.output as Record<string, unknown> | null
  if (cortexOutput?.intent === 'both') {
    nextBrain = 'limbic'
  } else {
    await this.workspace.updateThreadState(threadId, 'complete')
    ...
  }
}
```
这段逻辑将"Brainstem 完成后是否通知用户"的决定权绑定到了 Cortex 的 `intent=both`，而非 Brainstem 自身输出。

---

## Migration Design

### 新统一类型：`BrainOutput`

```typescript
export interface BrainOutput {
  next?: CognitiveBrainType | 'self' | null  // 路由目标；null/undefined = Thread 结束
  reply?: string                              // 对外输出；undefined = 不发消息
  handoff?: string                           // 脑间上下文；传递给 next 脑区
}
```

**映射关系（旧 → 新）**：

| 旧格式 | 新格式 |
|--------|--------|
| `mode: 'RESPOND', reply: '...'` | `{ reply: '...' }` |
| `mode: 'NO_REPLY'` | `{}` |
| `mode: 'ROUTE'` | `{ next: 'cortex' }` |
| `mode: 'EXECUTE'` | `{ next: 'brainstem' }` |
| `mode: 'DEFER', timeout_ms: N` | `{ next: 'self', timeout_ms: N }` |
| `intent: 'communicate'` | `{ next: 'limbic' }` |
| `intent: 'execute'` | `{ next: 'brainstem' }` |
| `intent: 'both'` | `{ next: 'brainstem', reply: '...' }` （先回复，再路由）|
| Brainstem 完成后通知 | `{ next: 'limbic', handoff: '执行结果摘要' }` |

### 合法路由转换表（Track Grammar）

基于 `docs/v2/01-framework.md §Thread Runner`：

| 脑区 | 合法 `next` 值 | 非法值（→ `interrupted`） |
|------|---------------|---------------------------|
| limbic | `'cortex'`, `'brainstem'`, `'self'`, `null` | `'limbic'` |
| cortex | `'limbic'`, `'brainstem'`, `null` | `'cortex'`, `'self'` |
| brainstem | `'limbic'`, `'cortex'`, `null` | `'brainstem'`, `'self'` |

### Thread Runner 新路由逻辑

```typescript
// 伪代码：新路由核心
const output = slot.output as BrainOutput | null

// 1. 处理 reply（发送给用户）
if (output?.reply) {
  await sendReply(output.reply)  // 通过 eventBus 或 workspace 触发
}

// 2. 处理 next（路由）
const next = output?.next ?? null
if (next === null || next === undefined) {
  await completeThread()
  return
}
if (next === 'self') {
  // DEFER 处理
  await handleDefer(output)
  return
}

// 3. 验证合法转换
if (!isLegalTransition(currentBrain, next)) {
  await interruptThread()
  return
}

// 4. 传递 handoff
if (output?.handoff) {
  // 写入下一脑区的 input slot 或通过 Block 4 注入
}

nextBrain = next
```

**`reply` 的实现细节**：Thread Runner 通过 `eventBus.emit({ event_type: 'thread.reply', payload: { reply, threadId } })` 发出，上层应用监听此事件并通过具体通道发送给用户。AIMA 框架只负责发出事件，不直接发送。

### Slot Schema 变更

删除 `slots.intent`（Cortex only）和 `slots.complexity_hint`（Cortex only）列。
- `intent` 信息已包含在 `output.next` 中（无需单独列）
- `complexityHint` 已在 `output` JSONB 中（Brainstem 读 Cortex output，不需要独立列）
- `WriteSlotParams` 同步删除 `intent`/`complexityHint` 字段

### DMN Reactive 变更

4 处 `mode`/`intent` 引用更新：

1. **`handleEvent` 中的 DEFER 检测**（第 108-110 行）：
   ```typescript
   // 旧
   payload.output?.mode === 'DEFER'
   // 新
   payload.output?.next === 'self'
   ```

2. **`shouldStartNewSegment` 中**（第 195-200 行）：
   ```typescript
   // 旧：output?.mode === 'ROUTE' && output.needs_analysis
   // 新：output?.next === 'cortex' && output.needs_analysis
   // 旧：output?.mode === 'RESPOND'
   // 新：output?.reply != null && !output?.next
   ```

3. **`evaluateOutcome` 中**（第 261-263 行）：
   ```typescript
   // 旧：output?.mode === 'RESPOND' → 'positive'
   //     output?.mode === 'EXECUTE' → 'positive'
   // 新：output?.reply != null → 'positive'
   //     output?.next === 'brainstem' → 'positive'
   ```

4. **`buildEpisodicContent` 中**（第 237-238 行）：
   ```typescript
   // 旧：mode: output?.mode, intent: output?.intent
   // 新：next: output?.next, reply: output?.reply != null ? '[present]' : undefined
   ```

---

## Phase 0: Research

无需额外研究。所有设计决策均基于现有代码库分析和 v2 文档。无外部依赖变更，无新技术引入。

---

## Phase 1: Design Artifacts

### data-model.md

见 [data-model.md](./data-model.md)。

### quickstart.md

见 [quickstart.md](./quickstart.md)。

---

## Work Package Split

### WP01 — 类型系统 + Thread Runner 核心迁移

**依赖**: 无（可立即开始）
**优先级**: P1
**预计规模**: 5-6 个子任务，~350 行 prompt

**范围**：
- `src/types/index.ts`：新增 `BrainOutput`，删除 `Intent`、`ComplexityHint`，更新 `WriteSlotParams`
- `src/runner/index.ts`：完整重写路由逻辑，实现新 BrainOutput 读取 + reply 事件发出 + 合法转换校验 + handoff 传递
- `src/workspace/index.ts`：移除 `WriteSlotParams.intent`/`complexityHint` 读写逻辑
- `src/schema/slots.ts`：删除 `intent`/`complexityHint` 列
- Drizzle migration：`0002_remove_slot_intent_columns.sql`
- 运行 `bun test`，确保现有测试通过（可能需要修正测试中的 `mock output` 格式）

### WP02 — 脑区 LLM Output Schema 迁移

**依赖**: WP01
**优先级**: P1
**预计规模**: 4-5 个子任务，~300 行 prompt

**范围**：
- 更新 pi-agent adapter 中 Limbic 的结构化输出工具定义（`mode` 枚举 → `{next?, reply?, handoff?}`）
- 更新 pi-agent adapter 中 Cortex 的结构化输出工具定义（`intent` 枚举 → `{next?, reply?, handoff?}`）
- 更新 pi-agent adapter 中 Brainstem 的结构化输出工具定义（新增 `next`/`handoff` 字段）
- 对 claude-sdk adapter 做相同更新
- 对 pi-coding-agent adapter 做相同更新（如有脑区 schema 定义）
- 运行 `bun test`，407 项测试全部通过

### WP03 — DMN Reactive 更新 + 旧枚举清理

**依赖**: WP01
**优先级**: P1（可与 WP02 并行）
**预计规模**: 4 个子任务，~200 行 prompt

**范围**：
- `src/dmn/reactive/index.ts`：4 处 `mode`/`intent` 引用 → `next`/`reply`
- 全库 `grep` 确认 `mode === 'RESPOND'`、`mode === 'EXECUTE'`、`intent === 'both'` 等残留为零
- 更新 `docs/v2/01-framework.md` 中的 ⚠️ P1-C 警告（标注已修复）
- 运行 `bun test`，全部通过；`grep` 验证 `mode`/`intent` 枚举零残留

---

## Gates

- ✅ 无未解决的澄清标记
- ✅ 无新外部依赖
- ✅ 变更范围清晰（5 个源文件 + 1 个 schema 文件 + 1 个 migration）
- ✅ 现有 407 项测试是定量验证基准
- ✅ DEFER 处理方式兼容（`next: 'self'` 替代旧 `mode: 'DEFER'`，Feature 012 修复继续有效）
