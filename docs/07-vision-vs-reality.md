# AIMA — 设想 vs 现实

> 本文评估当前实现（Features 001-011，399 测试，2026-03-12）是否达到 `01-agent-architecture.md` 和 `02-memory-architecture.md` 所描述的认知目标。
>
> 这不是技术规范对照，而是对"这个系统是否按照我们设想的方式运作"的诚实评估。

---

## 一句话结论

**我们有骨架，但没有神经系统。**

结构是对的：五脑存在，通过正确的渠道通信，工作空间持久化，Context Assembly 运行。但使系统"有思维"而不仅仅是"有结构"的部分——学习、适应、预测——目前还是存根或断路。

---

## 什么是对的

单次请求的处理路径符合设想：

- Limbic 路由、Cortex 规划、Brainstem 执行 ✅
- Thread/Slot 模型，PostgreSQL 持久化 ✅
- Event Bus 发射结构化事件，Amygdala 订阅 ✅
- Context Assembly 四个 Block，身份/Skill/状态/记忆 ✅
- DMN 事件响应运行，心跳整合运行 ✅
- Hippocampus Consolidation 每日批处理运行 ✅
- identityDir 加载 soul.md / skill-index.md / {brain}.md ✅

---

## 什么还不工作：三条断路的反馈闭环

### 闭环 1：记忆 → 决策（基本没接上）

**设想**（docs/02 §六）：各脑区有专属检索方法——Limbic 用 `getEntityContext()`，Cortex 用 `findSimilarSituations()`，Brainstem 用 `getProcedure()`。记忆真正影响当次判断。

**现实**：Context Assembly Block 4 只调用通用 `search()`。脑区专属检索方法已实现，但没有接入任何脑区的激活路径。**记忆系统目前基本是只写不读**——内容写进去，但没有以有意义的方式影响决策。

---

### 闭环 2：使用结果 → 重要度调整（链条断了）

**设想**（docs/01 §七，docs/02 §八）：`brain.complete` 事件 → DMN 评估执行质量 → `markUsed(injected_memory_ids, outcome)` → Consolidation 批量调整 `base_importance`。记忆系统学会"什么更有价值"。

**现实**：
- `BrainRunResult` 没有 `injected_memory_ids` 字段
- DMN Reactive 没有调用 `markUsed`
- Consolidation 的 `usage_outcomes` 收敛步骤永远收到空输入

Hippocampus 记录着每条记忆的使用反馈计数器，但这些计数器永远是零。系统无法从经验中调整什么值得记住。

---

### 闭环 3：Amygdala 的风险学习（显式存根）

**设想**（docs/01 §六）：三阶段 Amygdala——静态规则 → implicit 记忆匹配 → Haiku 评估。Amygdala 知道"什么是危险"并随时间改善判断。

**现实**：
- Stage 2 = `const memoryResult: ... | null = null`（显式存根）
- Stage 3 = `haiku_enabled: false`（占位符）

Amygdala 目前只是静态黑名单。它不会从历史风险事件中学习，不会动态更新判断。`implicit` 记忆类型存在，但没有被读取用于拦截决策。

---

## 另一个阻断性问题：DEFER 模式不工作

**设想**（docs/01 §二）：`DEFER` 是 Limbic 的核心输出模式，用于"确认收到，等待更多输入"。Teams 多轮对话的基础。

**现实**：DEFER 路径写入 pending 但从不调用 `updateThreadState('waiting')`，导致 `waitForComplete()` 永远不会在 `waiting` 状态下解析。多轮对话场景在 Teams 中会死锁。

---

## 总结

| 层次 | 状态 | 说明 |
|---|---|---|
| 架构结构（五脑、Thread/Slot、Event Bus） | ✅ 符合设想 | |
| 单次请求处理（路由 → 规划 → 执行） | ✅ 基本符合 | |
| 可观测性（事件发射、Slot 状态） | ✅ 基本符合 | |
| 记忆读取影响决策 | ❌ 闭环未接上 | 脑区专属检索未接入激活路径 |
| 使用反馈 → 重要度调整 | ❌ 链条断了 | injected_memory_ids 未传递，markUsed 未调用 |
| Amygdala 风险学习 | ❌ 显式存根 | Stage 2/3 均为占位符 |
| DEFER 多轮协作 | ❌ Bug，会死锁 | Thread.state 未设为 waiting |
| 系统随时间自主变好 | ❌ 未实现 | 上述三条闭环全断 |

---

## 诚实的定位

我们现在有的是一个**结构正确但静态**的系统。它比 single-agent 更有组织、更可观测。但"认知超集"的行为承诺——系统会学习、会适应、会预测——目前还没有兑现。

上述三条反馈闭环是让 AIMA 从"结构上正确"变为"行为上有思维"的关键路径。
