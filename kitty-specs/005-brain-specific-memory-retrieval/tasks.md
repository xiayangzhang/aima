# Task Breakdown: Brain-Specific Memory Retrieval

**Feature**: 005-brain-specific-memory-retrieval
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Total WPs**: 3 | **Total Subtasks**: 19
**Generated**: 2026-03-11

---

## Subtask Master List

| ID | Description | WP | Status |
|----|-------------|-----|--------|
| T001 | `getEntityContext` 实现（entity_id + types + 双重排序 + limit） | WP01 | planned |
| T002 | `findSimilarSituations` 实现（三并发 ILIKE + 分组返回） | WP01 | planned |
| T003 | `getProcedure` 实现（type=procedural + ILIKE + 双重排序 + limit） | WP01 | planned |
| T004 | `ilike` 导入 + `ICognitiveWorkspace` 接口同步（三个方法签名） | WP01 | planned |
| T005 | `src/index.ts` 导出三个新方法类型 | WP01 | planned |
| T006 | 单元测试：`getEntityContext`（mock DB，覆盖所有边界） | WP01 | planned |
| T007 | 单元测试：`findSimilarSituations`（mock DB，三组分类正确） | WP01 | planned |
| T008 | 单元测试：`getProcedure`（mock DB，类型纯净度） | WP01 | planned |
| T009 | `AssembleBlock4Opts` 接口定义（entityId? / taskType? / situation?） | WP02 | planned |
| T010 | `assembleBlock4` 签名扩展 + limbic 分支升级（getEntityContext + fallback） | WP02 | planned |
| T011 | cortex 分支升级（findSimilarSituations + 合并三组 + fallback） | WP02 | planned |
| T012 | brainstem 分支升级（getProcedure + fallback） | WP02 | planned |
| T013 | `assembleContext` 新增 opts 参数并透传到 `assembleBlock4` | WP02 | planned |
| T014 | `src/index.ts` 导出 `AssembleBlock4Opts` 类型 | WP02 | planned |
| T015 | 单元测试：`assembleBlock4` spy 路由（opts 有值 + 无值两种情况） | WP02 | planned |
| T016 | 集成测试：`getEntityContext`（真实 DB，实体过滤/排序/types/forgotten） | WP03 | planned |
| T017 | 集成测试：`findSimilarSituations`（真实 DB，三组分类/ILIKE/limit） | WP03 | planned |
| T018 | 集成测试：`getProcedure`（真实 DB，类型纯净/ILIKE/limit） | WP03 | planned |
| T019 | 集成测试：`assembleBlock4` 路由正确性（真实 workspace） | WP03 | planned |

---

## WP01 — CognitiveWorkspace 专属检索方法实现

**目标**：在 `CognitiveWorkspace` 中实现三个脑区专属检索方法，同步更新接口和导出。
**优先级**：P0（基础，WP02/03 依赖）
**估算**：~420 行 prompt | 8 subtasks
**依赖**：无
**提示文件**：[WP01-workspace-brain-retrieval-methods.md](./tasks/WP01-workspace-brain-retrieval-methods.md)

### 子任务清单

- [x] T001: `getEntityContext` 实现
- [x] T002: `findSimilarSituations` 实现
- [x] T003: `getProcedure` 实现
- [x] T004: `ilike` 导入 + `ICognitiveWorkspace` 接口同步
- [ ] T005: `src/index.ts` 导出
- [ ] T006: 单元测试 - getEntityContext
- [ ] T007: 单元测试 - findSimilarSituations
- [ ] T008: 单元测试 - getProcedure

### 并行机会

T001/T002/T003 均为独立新方法，逻辑互不影响，可同时起草但提交需先完成 T004 接口更新。T006/T007/T008 可并行编写。

### 风险

- `ilike` 未在 drizzle-orm 当前 import 列表中，需要添加
- `lastAccessedAt` 排序需要 `NULLS LAST`，Drizzle 无内建支持，需用 `sql\`\`` 模板
- `findSimilarSituations` 的 mock DB 需要处理三次并发 `select()` 调用，mock 需要按顺序返回不同结果

---

## WP02 — assembleBlock4 升级为脑区专属路由

**目标**：升级 `src/context/index.ts` 中的 `assembleBlock4` 和 `assembleContext`，接受 `AssembleBlock4Opts`，按 brainType 路由到专属方法；fallback 保留旧行为。
**优先级**：P1（依赖 WP01）
**估算**：~380 行 prompt | 7 subtasks
**依赖**：WP01
**提示文件**：[WP02-assemble-block4-brain-routing.md](./tasks/WP02-assemble-block4-brain-routing.md)

### 子任务清单

- [ ] T009: `AssembleBlock4Opts` 接口
- [ ] T010: `assembleBlock4` 签名 + limbic 升级
- [ ] T011: cortex 分支升级
- [ ] T012: brainstem 分支升级
- [ ] T013: `assembleContext` 透传 opts
- [ ] T014: `src/index.ts` 导出 `AssembleBlock4Opts`
- [ ] T015: 单元测试

### 并行机会

T010/T011/T012 是同一函数的三个 if/else 分支，逻辑上必须顺序完成（不可拆分到不同文件），但概念上可独立起草。

### 风险

- 现有调用方（runner、adapters）不传 opts，必须保证 opts 为 undefined 时行为与改前完全一致
- `CognitiveWorkspace` 在 `context/index.ts` 中只是类型引用，需要确认新方法在接口上可见（WP01 先完成）
- 单元测试需要 spy workspace 方法而非 mock DB——用 jest/bun:test 的 `mock.fn()` 替换 workspace 实例上的方法

---

## WP03 — 集成测试（真实 PostgreSQL）

**目标**：用真实 DB 验证三个方法和路由的 SQL 语义正确性（ILIKE 匹配、排序、limit、类型过滤）。
**优先级**：P2（依赖 WP01 + WP02）
**估算**：~300 行 prompt | 4 subtasks
**依赖**：WP01、WP02
**提示文件**：[WP03-integration-tests.md](./tasks/WP03-integration-tests.md)

### 子任务清单

- [ ] T016: 集成测试 - getEntityContext
- [ ] T017: 集成测试 - findSimilarSituations
- [ ] T018: 集成测试 - getProcedure
- [ ] T019: 集成测试 - assembleBlock4 路由

### 并行机会

T016/T017/T018 均为独立测试，可并行编写。T019 依赖前三者同逻辑，可独立。

### 风险

- `withTransaction` 模式自动回滚，所有写入不持久化，无需手动清理
- 确保 `AIMA_TEST_DATABASE_URL` 环境变量在 CI 中设置
- `findSimilarSituations` 的 ILIKE 匹配在中文内容上需要验证（PostgreSQL 默认 ILIKE 对 ASCII 大小写折叠，不影响汉字）
