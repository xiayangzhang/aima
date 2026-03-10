# Work Packages: AIMA Core — Workspace & Schema

**Inputs**: `kitty-specs/001-aima-core-workspace-schema/`
**Spec**: spec.md | **Plan**: plan.md | **Data Model**: data-model.md | **Contracts**: contracts/workspace.ts

---

## Work Package WP01: 包初始化 + 工具链 (Priority: P0)

**Goal**: 建立可运行的 `@aima/core` 包骨架：依赖、编译配置、lint、测试 runner 全部就位。
**Independent Test**: `bun install` 成功，`bun run typecheck` 零错误，`biome check .` 通过。
**Prompt**: `tasks/WP01-package-init-toolchain.md`

### Included Subtasks
- [x] T001 创建 package.json（@aima/core，Bun 配置，全部依赖声明）
- [x] T002 创建 tsconfig.json（strict，ESM，NodeNext）
- [x] T003 [P] 创建 biome.json（lint + format 规则）
- [x] T004 [P] 创建 drizzle.config.ts
- [x] T005 [P] 创建 vitest.integration.config.ts
- [x] T006 [P] 建立目录骨架（src/types/ src/schema/ src/workspace/ tests/unit/ tests/integration/ drizzle/migrations/）

### Implementation Notes
- 所有工具版本锁定在 package.json；不用 `*` 或 `latest`
- tsconfig `moduleResolution: "NodeNext"` + `module: "NodeNext"` 是 Bun + ESM 的正确组合
- drizzle.config.ts 读取 `DATABASE_URL` 环境变量

### Parallel Opportunities
- T003 / T004 / T005 / T006 互相独立，可并行

### Dependencies
- 无（起点）

### Risks & Mitigations
- Bun 与某些 Node.js 原生模块不兼容 → 只用纯 TypeScript 包

---

## Work Package WP02: 核心类型定义 (Priority: P0)

**Goal**: 在 `src/types/index.ts` 建立所有核心枚举和接口的单一权威来源。
**Independent Test**: `import type { BrainType, ThreadState, ICognitiveWorkspace } from '@aima/core'` 编译无误。
**Prompt**: `tasks/WP02-core-types.md`

### Included Subtasks
- [x] T007 定义全部核心枚举（BrainType、CognitiveBrainType、ThreadState、SlotStatus、MemoryType、Intent、ComplexityHint、UsageOutcome、EventLevel、RiskLevel、SkillType）
- [x] T008 定义实体接口（Thread、Slot、MemoryEntry、PendingObservation、UsageOutcomes）
- [ ] T009 定义输入/参数类型（CreateThreadParams、WriteSlotParams、CreateMemoryParams、MemorySearchFilters、CreatePendingParams）
- [ ] T010 定义 ICognitiveWorkspace 接口（与 contracts/workspace.ts 完全对齐）
- [ ] T011 [P] 验证类型：tsc --noEmit 零错误，无 `any`

### Implementation Notes
- `src/types/index.ts` 是唯一文件，不分拆
- 所有字段名用 camelCase（TypeScript 惯例），DB 列名用 snake_case（Drizzle 映射）
- `ICognitiveWorkspace` 接口放在 types 而非 workspace 模块，因为它是公共 API 的一部分

### Parallel Opportunities
- T011 在 T007-T010 完成后即可运行

### Dependencies
- 依赖 WP01（tsconfig 就位）

### Risks & Mitigations
- 类型与 DB schema 枚举不同步 → WP03 的 pgEnum 定义必须引用这里的类型而非重复定义

---

## Work Package WP03: Drizzle Schema + Migration (Priority: P0)

**Goal**: 4 张表的 Drizzle schema 定义完成，`drizzle-kit generate` 成功生成迁移文件，`drizzle-kit migrate` 在空库上执行成功。
**Independent Test**: 运行迁移后，`\dt` 列出 4 张表，所有列和约束与 data-model.md 一致。
**Prompt**: `tasks/WP03-drizzle-schema-migration.md`

### Included Subtasks
- [ ] T012 `src/schema/threads.ts`：threads 表 + threadState pgEnum
- [ ] T013 `src/schema/slots.ts`：slots 表 + brainType pgEnum + slotStatus pgEnum + UNIQUE(thread_id, brain)
- [ ] T014 `src/schema/memories.ts`：memories 表 + memoryType pgEnum + GIN index on tags
- [ ] T015 `src/schema/pending.ts`：pending_observations 表 + 3 个索引
- [ ] T016 `src/schema/index.ts`：re-export 所有表和 enum，供 workspace 模块使用
- [ ] T017 执行 `bun run db:generate` 验证迁移生成，`bun run db:migrate` 验证在测试库上执行成功

### Implementation Notes
- pgEnum 定义与 `src/types/index.ts` 中的 TypeScript 类型值保持完全一致
- tags 列：`text('tags').array().notNull().default(sql`'{}'::text[]`)`
- usage_outcomes 列：`jsonb('usage_outcomes').notNull().default(sql`'{"positive":0,"negative":0,"neutral":0}'::jsonb`)`
- 自引用 FK（supersedes_id）需用 `() =>` 延迟引用

### Parallel Opportunities
- T012-T015 可以并行（各自独立文件），但 T016 和 T017 必须在全部完成后

### Dependencies
- 依赖 WP02（需要 MemoryType 等枚举）

### Risks & Mitigations
- pgEnum 变更在迁移中是 destructive 操作 → 初期设计时把所有枚举值一次定义完整

---

## Work Package WP04: CognitiveWorkspace — Thread & Slot (Priority: P1)

**Goal**: Thread 和 Slot 的完整 CRUD 实现，含 upsert 逻辑（writeSlot），单元测试覆盖所有路径。
**Independent Test**: `bun test tests/unit/workspace/thread-slot.test.ts` 全部通过。
**Prompt**: `tasks/WP04-workspace-thread-slot.md`

### Included Subtasks
- [ ] T018 `src/workspace/index.ts`：CognitiveWorkspace class 骨架，constructor(db: DrizzleDB)
- [ ] T019 实现 Thread 操作：createThread、getThread、updateThreadState、getActiveThreads
- [ ] T020 实现 Slot 操作：writeSlot（upsert by thread_id+brain）、readSlot、getSlotsByThread
- [ ] T021 `tests/unit/workspace/thread-slot.test.ts`：mock DB，覆盖正常路径和边界情况

### Implementation Notes
- writeSlot 使用 Drizzle 的 `onConflictDoUpdate`（UNIQUE(thread_id, brain) 触发 upsert）
- updateThreadState 同时更新 updated_at
- getActiveThreads：`WHERE state NOT IN ('complete')`
- mock DB：用 vitest mock 或简单的 in-memory map 实现，不用真实 PG

### Parallel Opportunities
- T019 和 T020 可以并行（互不依赖）
- T021 可在 T019/T020 完成后并行写（不依赖真实 DB）

### Dependencies
- 依赖 WP03（schema 就位）
- 可与 WP05、WP06 并行开发

### Risks & Mitigations
- upsert 冲突语义：writeSlot 应完整覆盖旧 slot 还是 merge？→ 完整覆盖（由调用方传入完整 WriteSlotParams）

---

## Work Package WP05: CognitiveWorkspace — Pending Observations (Priority: P1)

**Goal**: Pending observations 完整 DAO 实现，包含 advisory lock 并发保护和容量淘汰逻辑。
**Independent Test**: `bun test tests/unit/workspace/pending.test.ts` 全部通过，包含容量淘汰路径。
**Prompt**: `tasks/WP05-workspace-pending.md`

### Included Subtasks
- [ ] T022 `src/workspace/pending.ts`：writePending 实现（advisory lock + 容量检查 + 淘汰 + insert，全在一个事务内）
- [ ] T023 实现 getPendingObservations、removeExpiredPending、removePending
- [ ] T024 容量淘汰逻辑：配置上限（默认 100），超限时按 base_importance ASC, added_at ASC 删除
- [ ] T025 `tests/unit/workspace/pending.test.ts`：mock DB，测试正常写入、超限淘汰、过期清理

### Implementation Notes
- advisory lock key：`hashtext('aima_pending_write')`，用 `pg_advisory_xact_lock` 事务级锁
- 淘汰计算：先 SELECT COUNT(*)，超限则 DELETE WHERE id IN (SELECT id ORDER BY base_importance ASC, added_at ASC LIMIT n)
- capacity 上限通过 CognitiveWorkspace constructor 的 options 参数传入（`pendingCapacity?: number`）
- removeExpiredPending：`DELETE WHERE expires_at <= $now`

### Parallel Opportunities
- T023 和 T022 可并行（不同方法）
- T024 是 T022 的一部分，不单独并行

### Dependencies
- 依赖 WP03
- 可与 WP04、WP06 并行

### Risks & Mitigations
- advisory lock 在单元测试（mock DB）中无法真正测试 → 并发正确性在 WP07 集成测试中验证

---

## Work Package WP06: CognitiveWorkspace — Memory (Priority: P1)

**Goal**: Memory 的完整 CRUD 实现，含 supersedes_id 原子失效、searchMemory 过滤、markMemoryUsed 和 clearWorkingMemory。
**Independent Test**: `bun test tests/unit/workspace/memory.test.ts` 全部通过。
**Prompt**: `tasks/WP06-workspace-memory.md`

### Included Subtasks
- [ ] T026 `src/workspace/memory.ts`：writeMemory（含 supersedes_id 事务原子失效）
- [ ] T027 实现 searchMemory（type + tags GIN 过滤 + entityId + segmentId + excludeInvalid + limit，按 base_importance DESC 排序）
- [ ] T028 实现 markMemoryUsed（UPDATE usage_outcomes 的对应计数器 +1，用 jsonb_set 或应用层 merge）
- [ ] T029 实现 clearWorkingMemory（DELETE WHERE type='working' AND thread_id=$threadId）
- [ ] T030 `tests/unit/workspace/memory.test.ts`：覆盖 write、supersedes 失效、search 过滤、markUsed、clearWorking

### Implementation Notes
- writeMemory supersedes 路径：db.transaction(tx => { insert; update t_invalid })
- searchMemory tags 过滤：Drizzle `arrayContains(memories.tags, tags)` 或 sql`tags @> ${sql.array(tags)}::text[]`
- excludeInvalid 默认 true：`.where(isNull(memories.tInvalid))`
- markMemoryUsed：在应用层先 SELECT 再 UPDATE（避免复杂 jsonb 操作），ids 可能是批量数组

### Parallel Opportunities
- T027、T028、T029 互相独立，可并行
- T030 可在 T026-T029 完成后并行写

### Dependencies
- 依赖 WP03
- 可与 WP04、WP05 并行

### Risks & Mitigations
- jsonb 字段的 usage_outcomes 更新：SELECT + UPDATE 有 race condition → 在 WP07 集成测试中验证（实际场景中 markUsed 调用频率不高，可接受最终一致性）

---

## Work Package WP07: 集成测试套件 (Priority: P1)

**Goal**: 在真实 PostgreSQL 上验证全部 DAO 方法，含并发写锁和事务原子性测试。
**Independent Test**: `bun run test:integration` 全部通过（需 AIMA_TEST_DATABASE_URL 就位）。
**Prompt**: `tasks/WP07-integration-tests.md`

### Included Subtasks
- [ ] T031 集成测试基础设施：vitest config、DB 连接 helper、beforeEach BEGIN / afterEach ROLLBACK fixture
- [ ] T032 Thread & Slot 集成测试：完整生命周期（create → writeSlot → updateState → getActive → Slot upsert）
- [ ] T033 Pending 集成测试：正常写入、容量淘汰（写入超限验证淘汰）、并发写（Promise.all 多个 writePending）、过期清理
- [ ] T034 Memory 集成测试：write + searchMemory 过滤正确性、supersedes_id 原子失效、markMemoryUsed 计数、clearWorkingMemory

### Implementation Notes
- DB helper：`createTestDb()` 返回 Drizzle 实例 + SQL 连接，从 `process.env.AIMA_TEST_DATABASE_URL` 读取
- 并发测试 T033：`await Promise.all(Array.from({length: 10}, () => ws.writePending({...})))` 后验证行数等于 capacity
- 迁移：集成测试运行前执行 `drizzle-kit migrate` 确保 schema 最新

### Parallel Opportunities
- T032 / T033 / T034 互相独立，可在 T031 完成后并行

### Dependencies
- 依赖 WP04、WP05、WP06（所有 DAO 实现完成）

### Risks & Mitigations
- 测试 DB 连接失败 → 集成测试 gracefully skip 并打印 `AIMA_TEST_DATABASE_URL not set` 提示

---

## Work Package WP08: 公共 API 导出 + 构建验证 (Priority: P0)

**Goal**: `src/index.ts` 导出所有公共 API，tsup 构建成功，包可作为库被外部 import。
**Independent Test**: `bun run build` 成功，`import { CognitiveWorkspace } from './dist/index.js'` 在外部项目中编译无误。
**Prompt**: `tasks/WP08-public-api-build.md`

### Included Subtasks
- [ ] T035 `src/index.ts`：导出 CognitiveWorkspace class、ICognitiveWorkspace、所有公共类型（从 types/index.ts re-export）
- [ ] T036 验证无内部实现细节泄漏：schema 表对象、drizzle DB 类型不在公共导出中
- [ ] T037 `tsup.config.ts`：配置 ESM + CJS 双输出，dts: true，sourcemap: true
- [ ] T038 运行 `bun run build` + `bun run typecheck`，验证零错误，dist/ 包含 index.js / index.cjs / index.d.ts

### Implementation Notes
- tsup entry: `{ index: 'src/index.ts' }`，format: `['esm', 'cjs']`
- 不导出：`src/schema/` 的 Drizzle 表对象（内部细节）、`src/workspace/pending.ts` 等子模块
- package.json exports 字段：`{ ".": { "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" } }`

### Parallel Opportunities
- T036 和 T035 可并行（T036 是 review 性质的验证）
- T037 和 T035 可并行

### Dependencies
- 依赖 WP04、WP05、WP06（所有实现完成）

### Risks & Mitigations
- CJS/ESM 双输出时某些 postgres driver 的 dynamic import 问题 → 测试验证；必要时使用 `--bundle false`

---

## Dependency & Execution Summary

```
WP01 (基础) → WP02 (类型) → WP03 (Schema)
                                    ↓
               ┌───────────────────┼───────────────────┐
            WP04                WP05                WP06
         (Thread/Slot)        (Pending)           (Memory)
               └───────────────────┼───────────────────┘
                                   ↓
                    ┌──────────────┴──────────────┐
                  WP07                           WP08
             (集成测试)                      (构建验证)
```

- **MVP Scope**: WP01 + WP02 + WP03 + WP04 = 最小可运行的 Thread/Slot DAO
- **完整 Feature**: 全部 8 个 WP
- **可并行阶段**: WP04 / WP05 / WP06 三个 WP 完全独立，可同时开发

---

## Subtask Index

| ID | Summary | WP | Priority | Parallel? |
|---|---|---|---|---|
| T001 | package.json | WP01 | P0 | No |
| T002 | tsconfig.json | WP01 | P0 | No |
| T003 | biome.json | WP01 | P0 | Yes |
| T004 | drizzle.config.ts | WP01 | P0 | Yes |
| T005 | vitest integration config | WP01 | P0 | Yes |
| T006 | 目录骨架 | WP01 | P0 | Yes |
| T007 | 核心枚举 | WP02 | P0 | No |
| T008 | 实体接口 | WP02 | P0 | No |
| T009 | 输入类型 | WP02 | P0 | No |
| T010 | ICognitiveWorkspace 接口 | WP02 | P0 | No |
| T011 | tsc 验证 | WP02 | P0 | Yes |
| T012 | threads schema | WP03 | P0 | Yes |
| T013 | slots schema | WP03 | P0 | Yes |
| T014 | memories schema | WP03 | P0 | Yes |
| T015 | pending schema | WP03 | P0 | Yes |
| T016 | schema/index.ts | WP03 | P0 | No |
| T017 | migration 生成+执行 | WP03 | P0 | No |
| T018 | CognitiveWorkspace 骨架 | WP04 | P1 | No |
| T019 | Thread 操作 | WP04 | P1 | Yes |
| T020 | Slot 操作 | WP04 | P1 | Yes |
| T021 | Thread/Slot 单元测试 | WP04 | P1 | Yes |
| T022 | writePending + advisory lock | WP05 | P1 | No |
| T023 | pending 查询/删除操作 | WP05 | P1 | Yes |
| T024 | 容量淘汰逻辑 | WP05 | P1 | No |
| T025 | pending 单元测试 | WP05 | P1 | Yes |
| T026 | writeMemory + supersedes 事务 | WP06 | P1 | No |
| T027 | searchMemory | WP06 | P1 | Yes |
| T028 | markMemoryUsed | WP06 | P1 | Yes |
| T029 | clearWorkingMemory | WP06 | P1 | Yes |
| T030 | memory 单元测试 | WP06 | P1 | Yes |
| T031 | 集成测试基础设施 | WP07 | P1 | No |
| T032 | Thread/Slot 集成测试 | WP07 | P1 | Yes |
| T033 | Pending 集成测试（含并发） | WP07 | P1 | Yes |
| T034 | Memory 集成测试 | WP07 | P1 | Yes |
| T035 | src/index.ts 公共导出 | WP08 | P0 | No |
| T036 | 泄漏验证 | WP08 | P0 | Yes |
| T037 | tsup.config.ts | WP08 | P0 | Yes |
| T038 | 构建 + typecheck 验证 | WP08 | P0 | No |
