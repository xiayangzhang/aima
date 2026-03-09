# AIMA 记忆架构

> **版本**: 1.0
> **状态**: 当前权威文档
> **关联**: `01-agent-architecture.md` 第九节为概览，本文为详细设计

---

## 一、设计原则

### 记忆不是数据库，是认知基础设施

记忆的目的是让脑区在每次 Loop 开始时拥有足够的上下文，而不是作为通用存储层。每种记忆类型的读取方式、检索策略和生命周期都不同——用同一套接口服务所有场景是错误的。

### 读写场景决定设计

不同脑区在不同时机对记忆有不同需求：

| 场景 | 使用方 | 需要什么 |
|---|---|---|
| Context Assembly | 所有脑区 | 检索与当前任务相关的历史知识 |
| DMN Reactive | DMN | 读取最新 N 条事件，判断错误/预测 |
| DMN Consolidation | DMN | 批量扫描，调整权重，清理过期 |
| Amygdala 检测 | Amygdala | 快速匹配风险模式 |
| Skill 固化 | DMN + Cortex | 读写 procedural 记忆 |

每个场景的最优实现方式不同，不存在统一的"最好"检索策略。

---

## 二、记忆类型

| 类型 | 功能角色 | 内容 | 主要写入方 | 主要读取场景 |
|---|---|---|---|---|
| `semantic` | 长期知识 | 实体、关系、事实（人、组织、系统、项目） | Limbic / Cortex | Context Assembly |
| `episodic` | 事件日志 | 发生过的事件序列，时序有序（= Action Log） | DMN（消费 Event Bus） | DMN Reactive |
| `procedural` | 技能库 | Skill 化的流程模式（reference / adapted / first-party） | Cortex | Context Assembly + Skill 固化 |
| `working` | 会话暂存 | 当前 Session 的临时状态，Session 结束清除 | 所有脑区 | 当前 Session |
| `implicit` | 风险模式 | 危险行为历史、Amygdala 规则的动态补充 | Amygdala / DMN | Amygdala 检测 |

### Importance 初始值

| 类型 | 初始 importance | 理由 |
|---|---|---|
| `episodic` | 0.3 | 高频写入，单条价值低，靠时序而非权重检索 |
| `procedural` | 0.8 | Skill 是核心知识，高优先注入 |
| `semantic` | 0.6 | 中等稳定性 |
| `implicit` | 0.7 | 风险模式应该被优先检索 |
| `working` | — | 不持久化，不参与检索排序 |

---

## 三、检索策略（按场景）

### 场景 A：Context Assembly（Block 4 记忆注入）

**目标**：找到与当前消息/任务语义相关的历史知识，注入系统提示词。

**当前实现（原型阶段）**：
- 全文搜索（ILIKE `%query%`）
- 按 `importance DESC, created_at DESC` 排序
- 返回 top-N 条，渲染为 Markdown 段落
- Query = 原始消息/任务描述（不做实体提取）

**局限**：关键词匹配无法处理语义相近但词汇不同的情况（如"合同审批"和"采购审核"语义相近但词汇不重叠）。

**演进路径**：
1. 为 `semantic` 和 `procedural` 记忆添加向量嵌入列
2. 检索时并行执行全文搜索 + 向量相似度搜索
3. 融合两路结果，按加权分数重排
4. `episodic` 不参与 Context Assembly 的向量搜索（见场景 B）

### 场景 B：DMN Reactive（Action Log 读取）

**目标**：获取最新发生的事件，判断是否有错误或需要预测的行为。

**实现**：**不使用搜索**，直接读取 `episodic` 记忆的最新 N 条，按 `created_at DESC` 取。

这是时序读取，不是语义检索。DMN 需要的是"刚刚发生了什么"，而不是"历史上发生过类似的什么"。全文搜索和向量搜索对这个场景都是错误的工具。

**Cache 效率**：DMN 每次调用只读取 `created_at > last_read_at` 的增量条目，历史部分已缓存在 LLM 上下文中，随 Session 时长增加 cache hit rate 趋近 100%。

### 场景 C：Amygdala 风险模式匹配

**目标**：在工具执行前快速判断是否触发风险规则。

**实现**：两层，按顺序执行：
1. **静态规则**（代码层）：正则、金额阈值、关键词黑名单，零延迟，零 LLM 成本
2. **动态规则**（`implicit` 记忆）：从数据库读取所有 `implicit` 记忆，在内存中做精确匹配（数据量小，不需要搜索索引）

`implicit` 记忆保持小规模——只存储具有泛化价值的风险模式，不存储每次拦截事件（那些进 `episodic`）。

### 场景 D：DMN Consolidation（记忆整理）

**目标**：批量处理历史记忆，调整权重，清理过期，固化 Skill。

**实现**：结构化查询，不走检索接口：
- `expires_at < now()` → 软删除（标记 `forgotten = true`）
- `importance` 调整 → 基于引用计数（Context Assembly 每次命中 +0.1，上限 1.0；长时间未命中 -0.05）
- `procedural` 记忆的使用频率 → 触发 Skill 固化判断

---

## 四、子实例的记忆隔离

### 问题

子实例（临时计算分支）与父实例共享同一记忆池。如果子实例写入错误的 `semantic` 记忆，父实例会被污染，且子实例销毁后这些写入无法撤回。

### 设计决策：子实例不直接写持久记忆

子实例的记忆权限：

| 类型 | 读权限 | 写权限 |
|---|---|---|
| `semantic` | ✅ | ❌ |
| `episodic` | ✅ | ❌ |
| `procedural` | ✅ | ❌ |
| `working` | ✅ | ✅（隔离命名空间，`parent_session_id` 标签） |
| `implicit` | ✅ | ❌ |

**子实例的输出路径**：
1. 结果写入子实例自己的 `working` 记忆（带 `parent_session_id` 标签）
2. 父实例的工作空间 Slot 接收子实例的输出
3. 父实例的 DMN 决定哪些内容值得提升为持久记忆（`semantic` / `procedural` / `implicit`）

这使子实例成为纯粹的计算分支：输入来自父实例的共享记忆（只读），输出通过工作空间 Slot 返回，写持久记忆的权力归父实例。

### 实现方式

子实例在创建时接收一个 `read_only_memory: true` 标志。记忆服务在写入前检查此标志，拒绝非 `working` 类型的写入并返回错误（非异常，由子实例的 DMN 处理）。

---

## 五、记忆写入规范

每条记忆记录：

```
{
  id:           UUID
  type:         semantic | episodic | procedural | working | implicit
  content:      string（Markdown 格式）
  partition_id: string（写入方脑区）
  session_id:   string
  importance:   float（初始值见第二节）
  source:       "brain" | "event_bus" | "dmn_consolidation"
  tags:         string[]（可选，辅助检索）
  expires_at:   timestamp | null
  forgotten:    boolean（软删除标志）
  created_at:   timestamp
}
```

`episodic` 额外字段：
```
{
  event_type:   string（来自 Event Bus 的事件类型）
  brain:        string（发射事件的脑区）
  thread_id:    string | null
}
```

---

## 六、生命周期

```
写入 → 活跃（被检索命中 importance↑）→ 沉默（长时间未命中 importance↓）→ 过期（expires_at）→ 软删除

episodic 特殊路径：
Event Bus → DMN 消费 → 写入 → DMN Consolidation 定期归档（超过 N 天的 episodic 降低 importance，最终软删除）

procedural 特殊路径：
Cortex 生成 → first-party Skill → 重复使用 → DMN Consolidation 固化 → 高 importance
```

---

## 七、当前阶段局限与演进

| 局限 | 影响 | 演进方向 |
|---|---|---|
| `semantic` / `procedural` 只有全文搜索 | 语义相近但词汇不同的内容无法命中 | 向量嵌入 + 混合检索 |
| `episodic` 无结构化事件图 | 无法查询因果关系链 | 事件图谱（可选，高复杂度） |
| importance 调整是简单线性规则 | 不能反映复杂的使用模式 | 基于注意力权重的动态调整 |
| 全文搜索对中文支持弱 | 中文内容检索质量低 | 中文分词 + 向量搜索 |

当前阶段（原型）：接受全文搜索的局限，确保数据结构和接口为向量搜索演进预留空间（不需要改表结构，只需添加 embedding 列）。
