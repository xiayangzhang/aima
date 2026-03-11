# AIMA Project Constitution

**项目**：AIMA — Artificial Intelligence: A Minded Architecture
**维护者**：secondfirst
**版本**：1.0.0 | 2026-03-11

---

## 一、实现标准

### 1.1 不敷衍

每个功能需求必须按 spec 完整实现，不得以"近似实现"或"简化版"替代。

- 方法签名必须与 spec/plan 一致，包括可选参数、返回类型、默认值
- SQL 查询条件必须完整（forgotten、t_invalid、类型过滤、排序字段）
- 每个 Definition of Done 项必须逐条可验证，不得留空或存疑

### 1.2 不降级

当有 opts 或参数时，必须走专属逻辑；fallback 仅用于参数缺失的情况，不得作为默认路径。

- 有 `entityId` 时必须调用 `getEntityContext`，不得 fallback 到 `searchMemory`
- 有 `situation` 时必须调用 `findSimilarSituations`，不得退化为单类型查询
- 有 `taskType` 时必须调用 `getProcedure`，不得返回混合类型结果
- Fallback 路径存在是为了向后兼容，不是为了省事

### 1.3 不过度工程

不实现 spec 中没有的功能，不为假设的未来需求预留接口，不提前抽象。

---

## 二、测试标准

### 2.1 真实测试

凡涉及 SQL 语义的逻辑（排序、ILIKE 匹配、类型过滤、NULLS LAST 等），必须有**集成测试**连接真实 PostgreSQL 验证，不得只用 mock 测试。

- Mock 单元测试验证**调用路径**（哪个方法被调用、参数是什么）
- 集成测试验证**SQL 语义**（实际数据是否按预期返回、排序是否正确）
- 两者缺一不可，不得用 mock 替代集成测试

### 2.2 边界覆盖

每个新方法的测试必须覆盖：
- 空结果（no matching rows）
- `limit` 截断（写入 N 条，验证最多返回 limit 条）
- `forgotten = true` 的记录不出现
- `t_invalid IS NOT NULL` 的记录不出现（superseded）
- 排序正确（高 importance 在前，同 importance 时 lastAccessedAt 在前）

### 2.3 测试隔离

集成测试必须做到：
- 每个 `describeWithDb` 块有独立的 `{ db, client }`，不共享连接
- `afterEach` 清理测试写入的数据（用 TEST_TAG 标记 + `arrayContains` 过滤删除）
- `beforeEach` 中需要隔离环境时（如检索类测试），先 wipe 相关类型数据

---

## 三、代码质量

### 3.1 类型安全

- 禁止 `as any`；需要访问私有方法时用 `as never as { method: () => Promise<void> }`
- 禁止 `!` non-null assertion；用 `?? defaultValue` 或显式检查
- 所有新方法签名必须同步更新 `ICognitiveWorkspace` 接口

### 3.2 Biome 合规

- `bun run typecheck` 零错误
- `biome check` 通过（import 排序、行长度、禁用规则）
- 每个 WP 完成后必须运行两者验证，不得提交带警告的代码

### 3.3 一致性

- SQL 查询风格与已有 `searchMemory` 一致（Drizzle ORM，条件数组 + `and(...conditions)`）
- 测试结构与已有 `tests/unit/workspace/memory.test.ts` 一致（`makeMockDb` 工厂 + `makeMemoryRow` fixtures）
- 日志前缀格式与已有脑区一致（`[BrainName] message`）

---

## 四、工作流规则

### 4.1 Spec-Kitty 流程

- 所有功能开发走 `specify → plan → tasks → implement → review → merge` 全流程
- 不得跳过 review 阶段直接 merge
- WP 完成后必须移动到 `for_review` lane，不得停留在 `doing`

### 4.2 实现前必须读代码

- 实现新功能前必须读取相关现有文件，理解上下文后再动笔
- 不得在没有读取代码的情况下修改现有函数
- 发现 spec 与现有代码不一致时，先在 plan/WP 文件中记录，不擅自调整 spec

### 4.3 提交规范

- commit message 用英文，格式 `type(scope): description`
- 每个 WP 对应一个或多个 commit，不得将多个 WP 混入同一 commit
- 不跳过 hooks，不使用 `--no-verify`
