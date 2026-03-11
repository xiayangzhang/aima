# Feature Specification: Brain-Specific Memory Retrieval

**Feature**: 005-brain-specific-memory-retrieval
**Status**: Draft
**Created**: 2026-03-11
**Depends on**: Feature 001 (Workspace Schema), Feature 002 (Brain Runtime), Feature 003 (DMN), Feature 004 (Hippocampus)

---

## Overview

AIMA 的五个脑区目前共享一个通用的 `searchMemory(query)` ILIKE 检索——所有脑区用同一个方法、同一套排序、同一个语义层做记忆召回。这不符合生物学原理：海马体索引情节、前额叶匹配经验、纹状体调取程序，各脑区有不同的检索模式。

本 Feature 为三个核心脑区实现专属检索方法，并将 Context Assembly Block 4 升级为按脑区调用专属方法：

- **Limbic**：实体中心检索 `getEntityContext(entityId, opts)` — "关于这个实体我知道什么？"
- **Cortex**：情境匹配检索 `findSimilarSituations(situation, opts)` — "类似情况我处理过吗？"
- **Brainstem**：过程检索 `getProcedure(taskType, opts)` — "这类任务怎么执行？"

同时将 `markAccessed(ids)` 升级为调用 `markMemoryUsed(ids, 'neutral')`，以及升级 Context Assembly Block 4 逻辑使各脑区使用其专属方法。

---

## Actors

- **AIMA 脑区**（系统）：各脑区调用专属检索方法获取上下文
- **Context Assembly 层**（系统）：Block 4 按脑区类型路由到对应的专属方法
- **上层应用**：通过 CognitiveWorkspace 直接调用专属方法（集成、测试等）

---

## Problem Statement

当前所有脑区使用 `searchMemory(query, filters)` ILIKE 检索，存在以下问题：

1. **语义不对齐**：ILIKE 全文匹配不区分检索意图——Limbic 想要"这个人的所有相关记忆"，Cortex 想要"类似场景的历史处理方式"，二者对"相关"的定义完全不同
2. **无实体聚焦**：Limbic 脑区的核心能力是建立实体关联网络，但 `searchMemory` 没有 `entity_id` 优先聚焦能力，导致实体检索精度低
3. **无类型过滤语义**：Brainstem 应该只读 procedural 记忆，但通用检索需要调用方手动传 `type: 'procedural'` filter，语义分散在调用侧
4. **Context Assembly Block 4 单一化**：所有脑区走同一检索路径，无法体现不同脑区的认知特化，检索质量低于专属方法

---

## Functional Requirements

### FR-01：getEntityContext — Limbic 实体中心检索

在 `CognitiveWorkspace` 中实现：

```typescript
getEntityContext(
  entityId: string,
  opts?: {
    types?: MemoryType[]    // 过滤记忆类型，默认全部
    limit?: number          // 结果上限，默认 10
  }
): Promise<MemoryEntry[]>
```

检索所有 `entity_id = entityId` 且 `forgotten = false` 的记忆，按 `base_importance DESC, last_accessed_at DESC` 排序，可按 `types` 过滤，结果最多 `limit` 条。

**验收条件**：
- 只返回指定 `entity_id` 的记忆，不包含 entity_id 为其他值或 null 的记忆
- 已 forgotten 的记忆不出现在结果中
- 结果按 importance 降序排列，importance 相同时按 last_accessed_at 降序
- `types` 参数为空时返回所有类型；指定类型时只返回该类型的记忆
- `limit` 默认 10

### FR-02：findSimilarSituations — Cortex 情境匹配检索

在 `CognitiveWorkspace` 中实现：

```typescript
findSimilarSituations(
  situation: string,
  opts?: {
    limit?: number    // 每组类型的上限，默认 5
  }
): Promise<{
  episodes: MemoryEntry[]
  procedures: MemoryEntry[]
  facts: MemoryEntry[]
}>
```

对 `situation` 字符串做 ILIKE 匹配，分别查询：
- `episodes`：type = 'episodic'，`forgotten = false`，content ILIKE `%situation%`
- `procedures`：type = 'procedural'，同上
- `facts`：type = 'semantic'，同上

三组各取 top-`limit` 条（按 `base_importance DESC`），返回分组结果。

**验收条件**：
- 返回对象包含 `episodes`、`procedures`、`facts` 三个数组
- 各数组只包含对应 type 的记忆
- 已 forgotten 的记忆不出现
- 各数组长度不超过 `limit`（默认 5）
- 内容不包含 situation 关键词的记忆不返回

### FR-03：getProcedure — Brainstem 任务过程检索

在 `CognitiveWorkspace` 中实现：

```typescript
getProcedure(
  taskType: string,
  opts?: {
    limit?: number    // 默认 3
  }
): Promise<MemoryEntry[]>
```

只查询 `type = 'procedural'`、`forgotten = false`、content ILIKE `%taskType%` 的记忆，按 `base_importance DESC, last_accessed_at DESC` 排序，返回前 `limit` 条。

**验收条件**：
- 只返回 type = 'procedural' 的记忆
- 已 forgotten 的记忆不出现
- content 不包含 taskType 关键词的记忆不返回
- 结果按 importance 降序排列
- `limit` 默认 3

### FR-04：Context Assembly Block 4 升级

将 `CognitiveWorkspace.assembleContext()` 的 Block 4（记忆检索段）升级为按 `brainType` 路由专属方法：

| brainType | 检索方法 | 参数来源 |
|-----------|----------|----------|
| `'limbic'` | `getEntityContext(entityId)` | 从参数取 `entityId` |
| `'cortex'` | `findSimilarSituations(situation)` | 从 query 取 situation 字符串 |
| `'brainstem'` | `getProcedure(taskType)` | 从参数取 `taskType` |
| 未识别 / 未传 | `searchMemory(query)` | 通用兜底 |

`assembleContext` 新增可选参数 `brainType?: string`、`entityId?: string`、`taskType?: string`，默认 undefined（走通用 `searchMemory`）。

**验收条件**：
- `brainType = 'limbic'` 时调用 `getEntityContext`（entityId 从参数传入）
- `brainType = 'cortex'` 时调用 `findSimilarSituations`（situation 从 query 传入）
- `brainType = 'brainstem'` 时调用 `getProcedure`（taskType 从参数传入）
- `brainType` 未传或不识别时 fallback 到通用 `searchMemory`
- 不破坏已有 Block 1-3 逻辑

### FR-05：markAccessed 别名更新

将 `CognitiveWorkspace.markAccessed(ids)` 内部实现改为调用 `markMemoryUsed(ids, 'neutral')`，使其与 Feature 004 引入的 `markMemoryUsed` 语义一致。对外接口不变（仍接受 `ids: string[]`）。

**验收条件**：
- 调用 `markAccessed(ids)` 等价于调用 `markMemoryUsed(ids, 'neutral')`
- `last_accessed_at` 仍被更新（通过 `markMemoryUsed` 内部逻辑）
- 外部调用方无需修改（接口签名不变）

---

## User Scenarios & Testing

### 场景 A：Limbic 查询某客户的全部相关记忆

1. 系统收到关于实体 `entity:client-123` 的消息
2. Limbic 脑区调用 `getEntityContext('client-123')`
3. 返回该客户关联的所有记忆（合同条款 semantic、历史对话 episodic、服务流程 procedural）
4. Limbic 选取高重要度记录注入 Block 4

**测试验证**：写入 3 条 entity_id = 'client-123' 的不同类型记忆，调用 `getEntityContext('client-123')` 返回这 3 条按 importance 排序，不返回其他 entity 的记忆。

### 场景 B：Cortex 匹配类似客户投诉场景

1. 当前任务涉及"客户投诉延误交付"
2. Cortex 调用 `findSimilarSituations('客户投诉')`
3. 返回 `{ episodes: [...历史处理案例], procedures: [...投诉处理流程], facts: [...相关政策] }`
4. Cortex 综合三类信息生成处理建议

**测试验证**：预置含"投诉"关键词的 episodic/procedural/semantic 各一条，调用后各组正确返回，不含该关键词的记忆不出现。

### 场景 C：Brainstem 获取报销审批流程

1. Brainstem 收到执行"报销审批"任务的指令
2. 调用 `getProcedure('报销审批')`
3. 返回含步骤描述的 procedural 记忆列表
4. Brainstem 按步骤执行

**测试验证**：预置 type=procedural 含"报销"的记忆，调用返回；预置 type=semantic 含"报销"的记忆，调用不返回。

### 场景 D：Context Assembly Block 4 按脑区路由

1. `assembleContext({ brainType: 'limbic', entityId: 'client-123', query: '...' })` 内部调用 `getEntityContext`
2. `assembleContext({ brainType: 'cortex', query: '投诉处理' })` 内部调用 `findSimilarSituations`
3. `assembleContext({ brainType: 'brainstem', taskType: '报销审批', query: '...' })` 内部调用 `getProcedure`
4. `assembleContext({ query: '...' })` 走通用 `searchMemory` 兜底

---

## Key Entities

- **MemoryEntry**：已有数据模型，`entity_id`、`type`、`base_importance`、`last_accessed_at`、`forgotten` 字段全部已实现，本 Feature 不新增字段
- **CognitiveWorkspace**：新增 3 个方法（getEntityContext / findSimilarSituations / getProcedure）+ 修改 `assembleContext` Block 4 路由 + 修改 `markAccessed` 内部实现
- **AssembleContextOptions**：已有接口，新增 `brainType?`、`entityId?`、`taskType?` 可选字段

---

## Assumptions

- Feature 001 的 `entity_id` 字段已存在于 memories 表，可直接用于等值过滤
- Feature 003 的 `markMemoryUsed(ids, outcome)` 已实现（`markAccessed` 可委托给它）
- `assembleContext` 当前已有 Block 4 逻辑，本 Feature 只升级 Block 4 内部路由，不重写整个方法
- ILIKE 匹配对多语言内容有效（PostgreSQL ILIKE 支持 Unicode）
- Amygdala 和 DMN 已有专属方法（`searchMemoryByTags` / `getSessionContext`），本 Feature 不修改

---

## Success Criteria

1. `getEntityContext` 召回率：给定 entity_id，100% 返回该实体相关的未过期记忆（单元 + 集成测试）
2. `findSimilarSituations` 分类精度：三组 episodes/procedures/facts 类型正确率 100%，无混入
3. `getProcedure` 类型纯净度：只返回 procedural 类型，其他类型不出现
4. Context Assembly Block 4：limbic/cortex/brainstem 各路由到正确方法，未识别类型走 fallback
5. `markAccessed` 等价性：调用后行为与 `markMemoryUsed(ids, 'neutral')` 一致
6. `bun run typecheck` 零错误，`biome check` 通过
7. 所有新方法有对应单元测试，覆盖边界条件（空结果、limit、forgotten 过滤、types 过滤）

---

## Out of Scope

- 向量检索 / embedding 相似度匹配（ILIKE 已满足当前需求）
- `depth > 1` 的实体关联展开（`getEntityContext` 只做单层 entity_id 等值过滤）
- MCP tool 层的新增暴露（专属方法不另建 MCP tool，已有 `memory_search` 兜底）
- Amygdala 和 DMN 的专属方法变更（已有实现，不需要修改）
