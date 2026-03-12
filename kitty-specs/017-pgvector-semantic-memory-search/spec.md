# Feature Specification: pgvector Semantic Memory Search

**Feature Branch**: `017-pgvector-semantic-memory-search`
**Created**: 2026-03-12
**Status**: Draft

## Background

AIMA 记忆系统目前通过 ILIKE 字符串匹配检索记忆（`findSimilarSituations`、`getProcedure`）。这种方法依赖精确的关键词重叠，当查询措辞与记忆内容措辞不同但语义相同时，会漏检相关记忆。

例如，一条记忆描述"拒绝了删除 customer 数据的请求"，若查询为"阻止破坏性操作"，ILIKE 无法匹配，但语义搜索可以。

向量语义搜索通过将文本转换为高维向量（embedding），比较向量间的余弦相似度来衡量语义接近度，显著提升记忆召回率与精度。

---

## User Scenarios & Testing

### User Story 1 — 脑区检索到语义相关但措辞不同的记忆 (Priority: P1)

当 Cortex 调用 `findSimilarSituations("block destructive operation")` 时，应该能召回内容为"曾拒绝删除文件请求"的 episodic 记忆，即使词汇不重叠。

**Why this priority**: 这是整个 Feature 的核心价值——用向量相似度替代关键词匹配，提升记忆召回的语义覆盖率。

**Independent Test**: 在 `findSimilarSituations` 中 mock embedding 函数，断言语义相似的查询可以召回语义相似的记忆。

**Acceptance Scenarios**:

1. **Given** 一条 episodic 记忆内容为"rejected request to delete customer records"，**When** 调用 `findSimilarSituations("prevent destructive action")`，**Then** 该记忆出现在返回结果中。
2. **Given** 该记忆没有 embedding（旧记忆），**When** 执行同样的查询，**Then** 系统回退到 ILIKE 匹配，不报错。
3. **Given** 嵌入服务不可用，**When** `findSimilarSituations` 被调用，**Then** 系统使用 ILIKE 继续工作，不中断记忆检索。

---

### User Story 2 — 新写入的记忆自动获得嵌入向量 (Priority: P1)

每次新记忆写入系统后，系统应自动生成该记忆的嵌入向量并存储，无需调用方额外操作，也不阻断写入流程。

**Why this priority**: 嵌入向量是向量检索的前提。写入时自动生成，确保新记忆在下次检索时可以被语义召回。

**Independent Test**: 调用 `writeMemory()`，断言 embedding 生成函数被异步调用，写入不因 embedding 失败而阻断。

**Acceptance Scenarios**:

1. **Given** 一条新记忆通过 `writeMemory()` 写入，**When** 写入成功，**Then** 系统异步为该记忆生成并存储 embedding 向量。
2. **Given** embedding 生成失败（API 超时、限流），**When** 写入操作完成，**Then** 记忆正常写入，embedding 列为 null，`writeMemory()` 不抛出异常。
3. **Given** 一条记忆已有 embedding，**When** 该记忆内容被更新，**Then** 系统重新生成 embedding 并更新存储。

---

### User Story 3 — Brainstem 通过语义检索找到相关操作过程 (Priority: P1)

Brainstem 调用 `getProcedure("deploy to kubernetes")` 时，应能召回描述"在 AKS 集群上发布服务"的 procedural 记忆。

**Independent Test**: 同 Story 1，mock embedding，断言语义相关的 procedure 记忆被召回。

**Acceptance Scenarios**:

1. **Given** procedural 记忆描述"AKS cluster deployment steps"，**When** 查询 `getProcedure("deploy to kubernetes")`，**Then** 该记忆出现在结果中。
2. **Given** 无相关 procedural 记忆，**When** 查询任意 taskType，**Then** 返回空数组，不报错。

---

### Edge Cases

- `embedding` 列为 null（旧记忆或 embedding 生成失败）→ 自动回退到 ILIKE，不影响功能
- 查询文本为空字符串 → 不调用 embedding API，直接返回空结果
- embedding 向量维度不匹配 → 系统记录错误，跳过向量搜索，使用 ILIKE 回退
- pgvector 扩展未安装 → 系统启动时检测，日志警告，降级到全 ILIKE 模式

---

## Requirements

### Functional Requirements

- **FR-001**: `findSimilarSituations()` 在有 embedding 的记忆上使用向量余弦相似度排序，不再仅依赖关键词匹配。
- **FR-002**: `getProcedure()` 同样升级为向量检索，有 embedding 的记忆优先按相似度排序。
- **FR-003**: 当记忆缺少 embedding 时，检索自动回退到 ILIKE，不中断服务。
- **FR-004**: `writeMemory()` 在成功写入 DB 后，异步生成并存储 embedding；生成失败不影响写入结果。
- **FR-005**: embedding 生成服务封装为独立模块，接受文本输入，返回数值向量；对调用方透明（不需要了解具体 embedding 模型）。
- **FR-006**: 数据库 schema 新增 `embedding` 向量列（nullable），新增支持近似最近邻（ANN）检索的索引。
- **FR-007**: 全部现有测试继续通过，不引入回归。
- **FR-008**: `searchMemory()` 的 `query` 字段在有 embedding 时优先使用向量检索，无 embedding 时回退 ILIKE（此项为次要，不影响核心功能验收）。

### Key Entities

- **Embedding**：记忆内容的高维数值向量表示，用于计算语义相似度；随记忆写入异步生成，存储于记忆条目的 `embedding` 字段。
- **Semantic Similarity Score**：两个 embedding 向量间的余弦相似度（0–1），用于替代关键词匹配对检索结果排序。

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: `findSimilarSituations` 召回率提升——语义相似但词汇不重叠的查询可召回相关记忆（可通过单元测试 mock embedding 验证）。
- **SC-002**: 写入记忆时 embedding 生成异步进行，`writeMemory()` 延迟增量 < 5ms（测量：调用 `writeMemory()` 到返回的时间不含 embedding 生成时间）。
- **SC-003**: 嵌入服务不可用时，全部检索功能降级到 ILIKE，系统不中断——可通过注入错误验证。
- **SC-004**: 全部现有测试继续通过，零回归。
- **SC-005**: 新增记忆成功生成 embedding 的比例 ≥ 95%（稳态，排除 API 不可用期间）。

---

## Assumptions

- 嵌入向量维度固定为 1536（与 OpenAI text-embedding-3-small 对齐）；不在本 feature 内支持多维度或可配置维度。
- 现有历史记忆（embedding=null）在本 feature 内**不做批量补填（backfill）**；backfill 可在后续独立任务中处理。
- 嵌入 API key 通过环境变量注入，与 LLM API key 配置风格一致；本 feature 不引入新的密钥管理机制。
- `searchMemory()` 的向量检索升级为**次要目标**；若实现复杂度过高可延后。
- pgvector 扩展已在目标 PostgreSQL 实例（本地开发 + AKS）上可安装；本 feature 负责在 migration 中 `CREATE EXTENSION IF NOT EXISTS vector`。
