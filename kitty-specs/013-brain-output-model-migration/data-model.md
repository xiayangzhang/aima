# Data Model: Brain Output Model Migration

## 新增类型：BrainOutput

```typescript
// src/types/index.ts

/**
 * 统一的脑区输出结构。三个字段完全独立，任意组合均合法。
 * - next:    路由目标（null/undefined = Thread 结束）
 * - reply:   对外输出，发给人类的内容（undefined = 不产生对外消息）
 * - handoff: 脑间上下文，传递给下一脑区的内部备注（undefined = 无附加上下文）
 */
export interface BrainOutput {
  next?: CognitiveBrainType | 'self' | null
  reply?: string
  handoff?: string
}
```

`'self'` 是特殊路由值，对应 DEFER（Limbic 专用）：Thread 进入 `waiting` 状态，待 pending observation 触发后恢复。

## 删除类型

```typescript
// 从 src/types/index.ts 删除以下内容：

// DELETED: Cortex 专用意图枚举（由 BrainOutput.next 替代）
export type Intent = 'communicate' | 'execute' | 'both'

// DELETED: Cortex 专用复杂度注解（移入 output JSONB，不再需要独立列）
export type ComplexityHint = 'simple' | 'complex'
```

## 更新类型：Slot

```typescript
// src/types/index.ts — Slot 接口变更

// 旧
export interface Slot {
  ...
  intent: Intent | null          // DELETED
  complexityHint: ComplexityHint | null  // DELETED
  executionSessionId: string | null
  ...
}

// 新
export interface Slot {
  id: string
  threadId: string
  brain: BrainType
  status: SlotStatus
  input: unknown | null
  output: unknown | null         // 类型为 BrainOutput（经 LLM 输出，存 JSONB）
  executionSessionId: string | null  // Brainstem only（保留）
  createdAt: Date
  updatedAt: Date
}
```

## 更新类型：WriteSlotParams

```typescript
// src/types/index.ts — WriteSlotParams 变更

// 旧
export interface WriteSlotParams {
  status?: SlotStatus
  input?: unknown
  output?: unknown
  intent?: Intent | null         // DELETED
  complexityHint?: ComplexityHint | null  // DELETED
  executionSessionId?: string | null
}

// 新
export interface WriteSlotParams {
  status?: SlotStatus
  input?: unknown
  output?: unknown
  executionSessionId?: string | null
}
```

## 数据库 Schema 变更

### slots 表（src/schema/slots.ts）

```typescript
// 删除以下两列：
intent: text('intent'),          // DELETED — 'communicate' | 'execute' | 'both'
complexityHint: text('complexity_hint'),  // DELETED — 'simple' | 'complex'
```

### Migration（drizzle/migrations/0002_remove_slot_intent_columns.sql）

```sql
ALTER TABLE slots DROP COLUMN IF EXISTS intent;
ALTER TABLE slots DROP COLUMN IF EXISTS complexity_hint;
```

## 合法路由转换表

Thread Runner 实现的路由校验规则（非法转换 → Thread 状态更新为 `interrupted`）：

| 脑区 (currentBrain) | 合法 next 值 | 特殊处理 |
|---------------------|-------------|---------|
| `limbic` | `'cortex'`, `'brainstem'`, `'self'`, `null` | `'self'` → DEFER（写 pending，Thread 进入 waiting） |
| `cortex` | `'limbic'`, `'brainstem'`, `null` | — |
| `brainstem` | `'limbic'`, `'cortex'`, `null` | — |

## BrainOutput 在 Thread Runner 中的处理顺序

```
读取 slot.output (as BrainOutput)
    │
    ├─ reply 有值？→ emit 'thread.reply' 事件（含 threadId + reply 内容）
    │
    ├─ next === undefined/null？→ updateThreadState('complete')，结束
    │
    ├─ next === 'self'（DEFER）？→ updateThreadState('waiting')，writePending，结束
    │
    ├─ isLegalTransition(currentBrain, next)？
    │   否 → updateThreadState('interrupted')，结束
    │
    ├─ handoff 有值？→ 写入 nextBrain 的 input slot（作为 Block 4 注入上下文）
    │
    └─ activateBrain(next, threadId)
```

## 旧 intent=both 三步路由的废除

```typescript
// 旧 Thread Runner（src/runner/index.ts）— 已删除
} else if (currentBrain === 'brainstem') {
  const cortexOutput = slotMap.cortex?.output
  if (cortexOutput?.intent === 'both') {
    nextBrain = 'limbic'  // ← 硬编码三步路由
  } else {
    await completeThread()
  }
}

// 新逻辑（通用，无特殊判断）
} else if (currentBrain === 'brainstem') {
  // brainstem 输出中 next: 'limbic' = 自主路由回通知
  // brainstem 输出中 next: null = 结束 Thread
  // 完全由 brainstem 自己的 output.next 决定
}
```
