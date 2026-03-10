# Data Model: AIMA Core — Workspace & Schema

**Feature**: 001-aima-core-workspace-schema
**Date**: 2026-03-10

---

## 表结构

### `threads`

认知工作单元。一次外部输入触发一个 Thread，Thread 包含其生命周期内所有脑区的 Slot。

```sql
CREATE TABLE threads (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  state           thread_state NOT NULL DEFAULT 'active',
  source_channel  TEXT,                          -- 来源渠道，null = DMN 主动创建
  initiated_by    TEXT        NOT NULL,           -- 'dmn' | 'external:teams' | 'external:webhook' 等
  trigger         TEXT,                          -- 人类可读的触发描述
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE thread_state AS ENUM ('active', 'waiting', 'complete', 'interrupted');
```

**索引**:
- `idx_threads_state` ON `state`（崩溃恢复时查询 `state != 'complete'`）

---

### `slots`

单脑工作记录。每个 Thread 最多有 5 个 Slot（每脑区一个）。

```sql
CREATE TABLE slots (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id             UUID         NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  brain                 brain_type   NOT NULL,
  status                slot_status  NOT NULL DEFAULT 'pending',
  input                 JSONB,
  output                JSONB,
  intent                TEXT,                   -- Cortex 专用: 'communicate' | 'execute' | 'both'
  complexity_hint       TEXT,                   -- Cortex 专用: 'simple' | 'complex'（可选注解）
  execution_session_id  TEXT,                   -- Brainstem 专用: 子执行 session ID
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (thread_id, brain)                     -- 每个 Thread 每个脑区最多一个 Slot
);

CREATE TYPE brain_type AS ENUM ('limbic', 'cortex', 'brainstem', 'amygdala', 'dmn');
CREATE TYPE slot_status AS ENUM ('pending', 'running', 'done', 'error');
```

**索引**:
- `idx_slots_thread_id` ON `thread_id`（按 Thread 查所有 Slot）
- 唯一约束已覆盖 `(thread_id, brain)` 查询

---

### `memories`

统一记忆存储。五类记忆（semantic / episodic / procedural / working / implicit）共用同一张表，通过 `type` 字段区分。

```sql
CREATE TABLE memories (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  type             memory_type  NOT NULL,
  content          TEXT         NOT NULL,          -- 脑区行为描述（不是原始输入文本）
  entity_id        TEXT,                           -- 实体关联（Limbic 实体中心检索用）
  segment_id       TEXT,                           -- episodic 专用：所属事件段
  segment_seq      INTEGER,                        -- episodic 专用：段内序号
  tags             TEXT[]       NOT NULL DEFAULT '{}',
  base_importance  FLOAT        NOT NULL DEFAULT 0.5,
  usage_outcomes   JSONB        NOT NULL DEFAULT '{"positive":0,"negative":0,"neutral":0}',
  source_brain     TEXT,                           -- 写入方脑区
  thread_id        TEXT,                           -- working 类型关联 Thread
  session_id       TEXT,                           -- 写入时的 session ID（调试用）
  supersedes_id    UUID         REFERENCES memories(id),  -- 被取代的旧记录
  t_invalid        TIMESTAMPTZ,                    -- 软删除时间（非空 = 已失效）
  last_accessed_at TIMESTAMPTZ,
  pinned           BOOLEAN      NOT NULL DEFAULT false,
  forgotten        BOOLEAN      NOT NULL DEFAULT false,
  expires_at       TIMESTAMPTZ,                    -- working 类型过期时间
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TYPE memory_type AS ENUM ('semantic', 'episodic', 'procedural', 'working', 'implicit');
```

**索引**:
- `idx_memories_type` ON `type`
- `idx_memories_tags` ON `tags` 使用 GIN 索引（`@>` 操作符）
- `idx_memories_entity_id` ON `entity_id`（实体检索）
- `idx_memories_segment_id` ON `segment_id`（段序列检索）
- `idx_memories_t_invalid` ON `t_invalid` WHERE `t_invalid IS NULL`（过滤有效记忆）
- `idx_memories_thread_id` ON `thread_id`（working 类型清理）

**重要约束**:
- `content` 描述脑区的决策和动作，**不存原始输入文本**（原始输入如需参考可在 `tags` 或应用层处理）
- `usage_outcomes` 默认 `{positive:0, negative:0, neutral:0}`，不允许 null
- `t_invalid` 非空 = 软删除，查询时应过滤 `WHERE t_invalid IS NULL`

---

### `pending_observations`

DMN 写入的待调度前瞻预测。独立表，标准行级并发控制。

```sql
CREATE TABLE pending_observations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_brain    brain_type  NOT NULL,
  note            TEXT        NOT NULL,     -- LLM 生成的自然语言描述，供目标脑区理解上下文
  trigger_at      TIMESTAMPTZ,             -- null = 立即路由；non-null = 不早于此时刻
  expires_at      TIMESTAMPTZ NOT NULL,    -- TTL，Thread Runner routePending 自动清理过期条目
  base_importance FLOAT       NOT NULL DEFAULT 0.5,  -- 容量淘汰优先级（低优先淘汰）
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**索引**:
- `idx_pending_expires_at` ON `expires_at`（过期清理）
- `idx_pending_trigger_at` ON `trigger_at`（路由判断）
- `idx_pending_base_importance` ON `base_importance`（容量淘汰）

**容量保护**:
- 上限由应用层配置（默认建议 100 条）
- 超限时：按 `base_importance ASC, added_at ASC` 淘汰（最低重要度，最早写入优先淘汰）
- 写入使用 advisory lock 序列化（见 research.md D-001）

---

## 枚举类型汇总

| TypeScript 类型 | PostgreSQL 枚举 | 值 |
|---|---|---|
| `BrainType` | `brain_type` | limbic, cortex, brainstem, amygdala, dmn |
| `ThreadState` | `thread_state` | active, waiting, complete, interrupted |
| `SlotStatus` | `slot_status` | pending, running, done, error |
| `MemoryType` | `memory_type` | semantic, episodic, procedural, working, implicit |

---

## 实体关系

```
threads (1) ──── (N) slots          [ON DELETE CASCADE]
memories (1) ──── (0..1) memories   [supersedes_id 自引用，软删除链]
pending_observations                [独立，无 FK 到 threads]
```

`pending_observations` 故意不关联 `threads`——它们是 DMN 的前瞻预测，可能在触发时创建新 Thread，不是绑定到已有 Thread 的。
