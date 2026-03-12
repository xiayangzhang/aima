# Data Model: P1 Safety & State Persistence Fixes

## 变更概览

本 Feature 涉及三处数据模型变更，全部向后兼容。

---

## 1. Thread 状态机（无 schema 变更，行为变更）

### 状态转换规则更新

```
active → waiting    （新增：DEFER 时正确转换）
waiting → active    （已有：routePending 触发）
active → complete   （已有）
active → interrupted （已有）
```

### getActiveThreads() 过滤逻辑变更

```
当前：state NOT IN ('complete', 'interrupted')
修复后：state NOT IN ('complete', 'interrupted', 'waiting')
```

`waiting` 状态的 Thread 不参与崩溃恢复扫描，由 `routePending()` 独立管理其重新激活。

---

## 2. BrainSignal 类型（types 变更）

### 当前

```typescript
interface BrainSignal {
  type: 'amygdala_interrupt' | 'dmn_correction'
  message: string
  causationId?: string
}
```

### 修复后

```typescript
interface BrainSignal {
  type: 'amygdala_interrupt' | 'dmn_correction'
  threadId: string          // 新增：必填，信号所属 Thread
  message: string
  causationId?: string
}
```

### Workspace Signal 存储

```typescript
// 当前（内存）
private signals: Map<BrainSignalType, BrainSignal[]>

// 修复后（内存）
private signals: Map<string, BrainSignal[]>
// key 格式：`${threadId}:${type}`
// 例："thread-abc123:amygdala_interrupt"
```

### API 接口变更

```typescript
// 当前
pushSignal(signal: BrainSignal): void
popSignal(type: BrainSignalType): BrainSignal | undefined
hasSignal(type: BrainSignalType): boolean

// 修复后
pushSignal(signal: BrainSignal): void           // signal 已含 threadId，接口不变
popSignal(type: BrainSignalType, threadId: string): BrainSignal | undefined   // 新增 threadId 参数
hasSignal(type: BrainSignalType, threadId: string): boolean                    // 新增 threadId 参数
```

`pushSignal` 接口不变（`BrainSignal` 已含 `threadId`），`popSignal` / `hasSignal` 增加 `threadId` 参数。

---

## 3. threads 表（schema 变更）

### 新增字段

```sql
ALTER TABLE threads ADD COLUMN segment_state jsonb;
-- nullable，无 default（历史行为 null = 无追踪状态）
```

### Drizzle Schema 变更（`src/schema/threads.ts`）

```typescript
// 新增列
segmentState: jsonb('segment_state')
  .$type<{ segmentId: string; nextSeq: number } | null>()
  .default(null)
```

### Thread 类型变更（`src/types/index.ts`）

```typescript
interface Thread {
  // ... 已有字段 ...
  segmentState: { segmentId: string; nextSeq: number } | null  // 新增
}
```

### Workspace 新增方法

```typescript
// ICognitiveWorkspace 接口同步更新
updateThreadSegmentState(
  threadId: string,
  state: { segmentId: string; nextSeq: number }
): Promise<void>

getThreadSegmentState(
  threadId: string
): Promise<{ segmentId: string; nextSeq: number } | null>
```

---

## Migration

```sql
-- 文件：migrations/0012_add_thread_segment_state.sql
ALTER TABLE threads ADD COLUMN IF NOT EXISTS segment_state jsonb;
```

无 NOT NULL 约束，无 default——历史数据自然为 null，DMN 按 null 处理（初始化新分段）。
