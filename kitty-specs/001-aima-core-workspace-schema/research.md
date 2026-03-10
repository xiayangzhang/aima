# Research: AIMA Core — Workspace & Schema

**Feature**: 001-aima-core-workspace-schema
**Date**: 2026-03-10
**Status**: Complete — 无未解决的 NEEDS CLARIFICATION

---

## 决策记录

### D-001: pending_observations 存储方式

**Decision**: 独立 `pending_observations` 表（Option A）

**Rationale**:
- 独立表使用标准行级锁，无热点写问题
- SQL 原生 INSERT / DELETE，无需 JSONB 操作
- `COUNT(*)` 容量检查、`ORDER BY base_importance ASC` 淘汰，均为标准查询
- 并发写通过 `pg_advisory_xact_lock` 序列化，不需要锁整个 workspace 行

**Alternatives Considered**:
- JSONB 字段（文档原始描述）：热点写、需要应用层解析、SELECT FOR UPDATE 会锁整行，对读操作不友好。在单实例低并发下可接受，但独立表无额外成本且更干净。

---

### D-002: PostgreSQL Driver 选择

**Decision**: `postgres`（porsager/postgres）

**Rationale**:
- TypeScript-first 设计，async iterable 原生支持
- Drizzle 官方推荐，与 drizzle-orm 集成最好
- 连接池内置（`postgres({ max: 10 })`），无需额外依赖
- 比 `pg`（node-postgres）更现代的 API 设计

**Alternatives Considered**:
- `pg`：老牌稳定，但 callback 风格，TypeScript 类型需要 `@types/pg`，不推荐新项目使用
- `@neondatabase/serverless`：针对 serverless 优化，AIMA 是长驻进程，不适用

---

### D-003: 测试分层策略

**Decision**: bun test（unit）+ vitest（integration）双 runner

**Rationale**:
- 单元测试（无 DB）用 bun test：零配置，启动快，与 Bun runtime 天然集成
- 集成测试（真实 PostgreSQL）用 vitest：更好的 coverage report、并发 worker 控制、snapshot 支持
- 两个 runner 共存在 TypeScript 项目中是成熟模式

**Alternatives Considered**:
- 全用 bun test：integration test 的覆盖率统计工具不够成熟
- 全用 vitest：单元测试失去 bun test 的速度优势

---

### D-004: updated_at 维护

**Decision**: 应用层显式设置，不用数据库触发器

**Rationale**:
- 触发器增加 schema 复杂度，且 drizzle-kit generate 对触发器支持不完整
- CognitiveWorkspace 是唯一写入路径，应用层控制完全可靠
- 测试时更容易注入固定时间（不依赖 `now()` 函数）

---

### D-005: Advisory Lock Key

**Decision**: `hashtext('aima_pending_write')` 作为 advisory lock key

**Rationale**:
- `hashtext()` 是 PostgreSQL 内置函数，将字符串 hash 为 int4，避免 magic number
- `aima_pending_write` 字符串有语义，代码可读
- 事务级 advisory lock（`pg_advisory_xact_lock`，非 session 级），事务结束自动释放，无泄漏风险
