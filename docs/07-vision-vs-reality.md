# AIMA — 设想 vs 现实（深度评估）

> 本文评估当前实现（Features 001-011，399 测试，2026-03-12）是否真正实现了
> `01-agent-architecture.md` 和 `02-memory-architecture.md` 所描述的认知目标。
>
> 这不是技术规范对照，而是一个更根本的问题：**这套架构，能否在高层面上支撑我们的构想？**
> 哪些结构性选择是正确的？哪些需要重新思考？我们不回避大规模重写。

---

## 先说结论

**骨架是对的。三条关键闭环有一条已接上，两条存在结构性问题。**

代码比上一轮评估更完整——`injectedMemoryIds` 已追踪，DMN 已调用 `markMemoryUsed`，Block 4 已有脑区专属检索路径。但深度阅读代码之后，出现了新的、更根本的问题：**闭环在代码层面接上了，但在认知层面没有接上。**

---

## 一、什么是真正对的

### 1.1 Thread Runner 的路由架构

每个脑区激活是独立的 LLM call，通过 Slot 状态协调，不共享 session history。这是正确的设计——脑区间不直接对话，路由全在 Thread Runner。这套机制干净、可测试、可恢复。

### 1.2 Context Assembly 的四块结构

Block 1+2 构成稳定的 prompt cache 前缀，Block 3/4 每次激活时动态注入当前状态和记忆。这个结构正确。

### 1.3 DMN Reactive 的七项职责

DMN 作为事件驱动的异步观察者，在 `brain.complete` 之后并行处理七项职责：段分配、episodic 写入、记忆使用反馈、错误恢复、DEFER 调度、回溯纠错、信号捕获。架构上这是对的——DMN 是观察者，不是执行者。

### 1.4 Hippocampus Consolidation 已在运行

每日批量运行四步：段精修 → 序列回放（LLM 提取 semantic/procedural/implicit） → usage_outcomes 收敛 → 过期清理。这是目前系统里唯一真正在"学习"的部分。

---

## 二、三条闭环的真实状态

### 闭环 1：记忆 → 决策（接上了，但有结构性缺陷）

**实际状态**：Block 4 已有脑区专属检索路径：
- Limbic：有 `entityId` hint 时调用 `getEntityContext()`
- Cortex：有 `situation` hint 时调用 `findSimilarSituations()`
- Brainstem：有 `taskType` hint 时调用 `getProcedure()`

**问题：hint 依赖**

这些专属检索方法只在有 hint 时才激活。hint 来自 `thread.trigger` 和 `cortex.output.task_type`。没有 hint 时，退回通用 `search()`。

这意味着：系统需要在检索记忆之前，就已经知道要检索什么实体、什么情境、什么任务类型——但这个判断本身可能需要记忆的帮助。这是一个先有鸡还是先有蛋的问题：正确的记忆检索依赖于正确的 hint，而正确的 hint 依赖于上下文理解。

**更根本的问题：ILIKE 是一道天花板**

所有检索路径最终走 ILIKE 文本匹配。`findSimilarSituations("用户问了关于发票 X 的问题")` 只能找到含有这些字符串的记忆，找不到语义相近但用词不同的历史情境。

这不是实现细节，而是架构天花板。Cortex"见过类似情况"的能力，在语义搜索上线前，基本是虚设的。

---

### 闭环 2：使用结果 → 重要度调整（接上了，但信号噪声太高）

**实际状态**：

DMN Reactive 的 Responsibility 5 中：
```
brain.complete → 读 injectedMemoryIds → markMemoryUsed(ids, outcome)
  outcome = 'positive' if output.mode in [RESPOND, EXECUTE]
  outcome = 'negative' if slot.status == 'error'
  outcome = 'neutral'  otherwise
```

Hippocampus 每日收敛：
```
if positive_ratio > 0.6 → base_importance += 0.05
if negative_ratio > 0.6 → base_importance -= 0.05
```

**问题 1：信号太粗**

`mode = RESPOND` 不等于"这次决策是好的"。Limbic 可以 RESPOND 一个错误答案。`slot.status = error` 可能只是网络超时。用完成模式作为质量信号，会把大量噪音写入反馈系统。

**问题 2：调整幅度太小**

`±0.05` 的单次调整意味着：一条 `base_importance = 0.3` 的 episodic 记忆，需要连续 10 天被一致性正向使用，才能涨到 0.8。在这个时间尺度上，系统几乎感觉不到自己在变好。

**问题 3：反馈对象混淆**

被注入 Block 4 的记忆，只能确认"这条记忆被注入了"，不能确认"这条记忆对这次决策有用"。记忆被注入 ≠ 记忆被使用 ≠ 记忆有帮助。调用 `markMemoryUsed` 标记注入的所有记忆，会均摊信号到不相关的记忆上。

---

### 闭环 3：Amygdala 风险学习（Stage 2/3 仍是存根）

Stage 2（implicit 记忆检索）= `const memoryResult = null`，显式存根。
Stage 3（Haiku 评估）= `haiku_enabled: false`，占位符。

Amygdala 目前只是静态规则黑名单。它不会从历史风险事件中学习，不会随时间改善判断。

---

## 三、更深的结构性问题

### 3.1 DMN 的回溯纠错开销

DMN Reactive 的 Responsibility 2：在**每次** `brain.complete` 之后调用 LLM 检查"刚才的输出是否需要纠错"。

这意味着：一次请求走 Limbic → Cortex → Brainstem = 3 次脑区激活 = 3 次 LLM call 用于认知 + 3 次 LLM call 用于纠错检查，总计 **6 次 LLM call**。

大多数情况下纠错检查结果是"不需要纠错"，这些 LLM call 是纯开销。这不是实现问题，而是架构选择问题：**被动防御（每次都检查）vs. 主动感知（只在有信号时检查）**。

docs/01 §七 描述 DMN 回溯纠错的触发条件是"读取最新 Action Log，判断刚刚发生的行为是否有误"——这意味着 DMN 应该有一个判断"是否值得深入检查"的预过滤，而不是无条件对每次 brain.complete 调用 LLM。

### 3.2 Episodic 记录太薄，无法支撑有意义的学习

Hippocampus Consolidation 每天回放 episodic 序列，调用 LLM 提取 semantic/procedural/implicit 知识——这是系统里最有价值的学习机制。但它的质量依赖于 episodic 记录的质量。

当前 episodic 记录由 DMN 写入，内容大约是：
- "Limbic 激活，输出 mode=RESPOND"
- "Cortex 激活，intent=execute"
- "Brainstem 完成，slot.status=done"

这些是**执行事实**，不是**认知事实**。Hippocampus 拿着这些记录，很难提取"在 X 类情境下，Y 策略效果好"这样的可泛化知识。

episodic 记录应该包含：决策的理由、关键的上下文条件、对比了哪些选项——即脑区决策过程的摘要，而不仅仅是完成状态。

### 3.3 信号模型的隐患

Amygdala 中断信号和 DMN 纠错信号存在**内存中，per-brain**（不是 per-thread）。

这意味着：如果 Thread-A 的 Brainstem 被 Amygdala 拦截，写入的 signal 会影响同一 AIMA 实例里所有其他正在运行的 Brainstem 激活（Thread-B, Thread-C...）。在多 Thread 并行的场景下，这会导致信号污染。

信号应该是 per-thread 的，而不是 per-brain 的。

### 3.4 DEFER 模式的 Bug（已知）

Limbic 输出 DEFER 时，Thread Runner 写入 pending_observations 但不设置 `thread.state = 'waiting'`，导致 `waitForComplete()` 永远不会在 `waiting` 状态下解析。Teams 多轮对话场景死锁。这个 bug 阻断了 Limbic 的一个核心输出模式。

---

## 四、五脑架构的价值主张

现在可以问一个更根本的问题：**当前的 AIMA，比单个智能 Agent 好在哪里？**

| 维度 | 当前 AIMA 实际提供 | 单 Agent 可以提供 |
|---|---|---|
| 跨 session 持久记忆 | ✅ 真实 | ❌ 无 |
| 结构化可观测性 | ✅ 真实 | 🟡 有限 |
| 工具调用风险拦截 | ✅ 真实（Stage 1） | ❌ 无 |
| 线程级并行处理 | ✅ 真实 | ❌ 无 |
| 深度推理分离（Cortex） | 🟡 架构上对，尚未证明优势 | 🟡 提示工程可近似 |
| 从经验中学习 | ❌ 机制有，闭环噪声高 | ❌ 无 |
| 预测性行为 | ❌ 机制有，尚未证明有效 | ❌ 无 |

当前 AIMA 的核心价值在三点：**记忆持久化 + 可观测性 + 安全拦截**。认知专业化和学习能力是真实的架构设计，但行为上的价值尚未兑现。

这不是说架构错了——而是说我们还没有到达"能体现认知超集价值"的那个阶段。

---

## 五、什么样的实现，能更好地支撑构想

### 方向 1：语义搜索是先决条件，不是优化项

`findSimilarSituations()` 在 ILIKE 下几乎等于关键词搜索。Cortex 的"见过类似情况"能力，以及 Hippocampus 的段回放质量，都依赖语义相似度。

**建议**：pgvector + 写入时嵌入（embedding on write）应该作为 memory 层的基础设施，而不是"后续升级"。在此之前，`findSimilarSituations()` 返回的结果质量无法支撑真正的情境匹配。

### 方向 2：episodic 记录应该捕获决策，而不是执行状态

当前：DMN 写入"脑区完成了，mode=X"。
应该：DMN 从 brain.complete 的 output 中提取"做了什么决策，基于什么理由，在什么条件下"。

这是 Hippocampus 有意义学习的前提。Consolidation 的 LLM 调用质量完全取决于喂进去的 episodic 内容质量。

### 方向 3：反馈信号需要明确的质量评估，而不是完成模式的推断

当前：`mode=RESPOND` → positive。太粗。

更好的方向：在 Thread 创建时，定义可评估的目标（goal）。Thread 完成后，DMN 对比实际输出和目标，给出质量评估。这个评估结果才是有意义的反馈信号。

对于有人类参与的 Thread（Teams DM），"用户是否继续对话"或"用户是否表达满意"也是可采集的信号。

### 方向 4：DMN 回溯纠错应该是事件触发，而不是无条件执行

每次 brain.complete 都做 LLM 纠错检查，是防御性开销。

更好的方向：DMN 先做廉价的规则检查（输出格式是否符合预期、是否有明显 slot 错误），只有触发异常时才启动 LLM 评估。这把纠错的触发从"无条件"改为"有信号"。

### 方向 5：信号模型需要改为 per-thread

Amygdala 中断信号应该是 per-thread，不是 per-brain。在多 Thread 并行的场景下，per-brain 信号会导致跨 Thread 干扰。

### 方向 6：Amygdala Stage 3 应该成为高风险工具的默认路径

Haiku 评估不是 fallback，应该是 `risk_level: 'high'` 工具的默认行为。Static rules 处理已知风险，Haiku 处理未知风险。这才是 Amygdala 真正的价值——不只是黑名单，而是能判断新情况。

---

## 六、哪些问题，值得大规模重写

**值得重写的地方**（结构性问题，小改不解决根本）：

1. **信号模型**：从 per-brain in-memory 改为 per-thread，持久化到 DB，支持多 Thread 并行的信号隔离。

2. **DMN 回溯纠错触发逻辑**：从"每次 brain.complete 都检查"改为"规则预过滤，异常才 LLM 评估"。重写 Responsibility 2 的触发条件。

3. **episodic 写入内容**：从记录执行状态改为记录认知摘要——决策是什么、基于什么、结果怎样。这需要重写 DMN 的 episodic 写入逻辑。

4. **反馈信号**：从 `mode=RESPOND` 推断质量，改为基于 Thread goal 的明确评估。需要在 Thread 数据结构中加 goal 字段，在 Completion 时加评估步骤。

**不需要重写，只需要接通**（机制已有，只差最后一步）：

5. **Amygdala Stage 3**：实现 Haiku 评估逻辑，设为 `risk_level: 'high'` 的默认行为。

6. **DEFER bug**：`ThreadRunner` 在写 pending_observations 后设置 `thread.state = 'waiting'`。

**基础设施决策**（需要先决定，再实施其他）：

7. **pgvector + embedding on write**：这是 `findSimilarSituations()` 和 Hippocampus 段回放真正发挥作用的前提。

---

## 七、优先级判断

```
立即修复（影响基础正确性）：
  DEFER bug → thread.state = 'waiting'
  信号模型 per-thread 化

结构性重写（影响认知能力的基础）：
  episodic 记录内容重写
  DMN 纠错触发条件重写
  反馈信号重设计

基础设施决策（影响学习能力的天花板）：
  pgvector 选型 + embedding 策略

完成存根（机制已有）：
  Amygdala Stage 3（Haiku 评估）
  Amygdala Stage 2（implicit 记忆检索，需 pgvector 先行）
```

最终目标：让系统真正随时间变好——今天处理过的情境，明天处理类似情境时应该更好。这是 AIMA 区别于 single-agent 的核心承诺，也是目前最需要投入的方向。
