# Token-Rich 自主 Agent 架构：让 Agent 像人一样思考和工作

> **研究日期**: 2026-03-06
> **研究范围**: Token-Rich 深度推理、类人工作模式、从错误中学习、最小控制架构、经济学分析
> **适用于**: Agentic 虚拟员工平台 — 颠覆性 Agent 自主性设计
> **状态**: **当前有效**
> **与 15 号报告的关系**: 15 号报告定义了"治理而非约束"的框架。本报告更进一步 — 研究如何**最大化 Agent 自主性**，将控制基础设施降到真正的最小集。

---

## 摘要

本报告提出一个根本性的范式转变：**从"如何控制 Agent"转向"如何让 Agent 真正自主"**。

核心论点：
1. **用 Token 换智慧** — 一个 Claude Opus 级别模型的深度推理，胜过十个 Haiku 的流水线协作
2. **Agent 应该犯错** — 错误是学习机会，系统应支持而非阻止犯错
3. **最少的控制** — 只保留真正不可妥协的底线（PII/金额/记录），其余全部信任 Agent
4. **事后审计** — 像经理看报告，不是审批每一个操作
5. **情境判断** — Agent 具备专业判断力，根据当下情况即兴调整

**一句话总结**：给 Agent 足够的 Token 去"思考"，给它目标和价值观，然后让它自己 figure out。

> **重要修正（基于 OpenClaw 实践经验）**：本报告第 2 节关于"单强模型 > 多 Agent"的结论**需要限定**。用户在 OpenClaw 的实际开发经验表明：**专职多 Agent 在实践中优于 all-in-one 单 Agent**，因为专职 Agent 可以更专注本职问题，并积累专项经验。但这不是传统的 MoE/编排模式 — 而是类似真人团队：每个成员有专长和专项记忆，同时共享团队级 context（团队经验、错误记录）。
>
> **LLM 成本模型**：预算 ~$2-3K/月，300-500M tokens/月（10-15M/天），Smart Router 按任务复杂度分配模型，工作日/时高负荷、非工作时低功耗待命。

---

## 目录

1. [Token-Rich 深度推理架构](#1-token-rich-深度推理架构)
2. [一个强模型 vs 一群弱模型：定量分析](#2-一个强模型-vs-一群弱模型定量分析)
3. [类人工作模式：认知科学视角](#3-类人工作模式认知科学视角)
4. [从错误中学习：Blameless 文化](#4-从错误中学习blameless-文化)
5. [最小控制架构](#5-最小控制架构)
6. [实际案例分析](#6-实际案例分析)
7. [经济学分析](#7-经济学分析)
8. [架构设计方案](#8-架构设计方案)
9. [与现有架构的关系](#9-与现有架构的关系)
10. [参考文献](#10-参考文献)

---

## 1. Token-Rich 深度推理架构

### 1.1 核心范式：Let the Model Think

2025-2026 年最重要的架构转变不是更好的编排，而是**更深的推理**。

Claude Opus 4.6 引入了 **Adaptive Thinking**：模型自行决定一个任务需要多少推理深度，而非二元的"开/关" extended thinking。这意味着：

- **4 级推理深度控制**：low / medium / high / max
- **1M Token 上下文窗口**：约 3000 页文本的工作记忆
- **Context Compaction**：自动摘要旧对话，保持"工作记忆"清晰
- **MRCR v2 评测 76%**：在 1M Token、8-needle 最难变体上的表现

**关键洞察**：不再需要把任务拆分给多个小模型 — 一个足够强的模型可以在内部进行"多角色辩论"。

### 1.2 Inner Monologue 架构

**MIRROR 认知架构**（2025）展示了如何在 LLM 中实现类人内心独白：

```
┌─────────────────────────────────────────┐
│           MIRROR Architecture           │
│                                         │
│  ┌─────────┐  ┌──────────┐  ┌────────┐ │
│  │  Goals   │  │Reasoning │  │ Memory │ │
│  │  Thread  │  │  Thread  │  │ Thread │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │             │            │       │
│       └──────┬──────┘────────────┘       │
│              ▼                           │
│     ┌─────────────────┐                  │
│     │   Cognitive      │                  │
│     │   Controller     │                  │
│     │ (Synthesizer)    │                  │
│     └────────┬─────────┘                  │
│              ▼                           │
│     ┌─────────────────┐                  │
│     │  Unified Inner   │                  │
│     │  Narrative       │                  │
│     │ (First-Person)   │                  │
│     └─────────────────┘                  │
│                                         │
│  Thinker Layer ────────────────────────  │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│  Talker Layer (Context-Aware Response)   │
└─────────────────────────────────────────┘
```

MIRROR 的核心设计：
- **三条并行认知线程**：目标追踪、推理、记忆 — 同时运行，不阻塞
- **认知控制器**：将三条线程合成为统一的第一人称叙事
- **对话间隙处理**：利用自然对话暂停期进行内部推理
- **性能**：在 CuRaTe 基准上相对提升 21%（69% → 84%），额外成本仅 $0.003-$0.017/轮

### 1.3 Scratch Pad / 工作草稿

ReAct 框架中的 trace/scratchpad 是 Agent 的"工作纸"：

```
┌─────────────────────────────────────┐
│          Agent Scratch Pad          │
│                                     │
│  Thought: 这个审批请求金额异常大，  │
│  但申请人是部门主管，历史记录显示   │
│  他之前有过类似的大额采购...        │
│                                     │
│  Observation: 预算系统显示该部门    │
│  本季度剩余预算充足                 │
│                                     │
│  Reflection: 虽然金额超出常规，     │
│  但有合理业务理由，风险可接受       │
│                                     │
│  Action: 批准，并在周报中标注       │
│  此项供经理知悉                     │
└─────────────────────────────────────┘
```

这不是预定义流程，而是 Agent 真正在"想"。

### 1.4 Context Window 管理：工作记忆

MemGPT/Letta 的操作系统类比是目前最先进的上下文管理方案：

```
┌─────────────────────────────────────┐
│     Agent Memory Hierarchy          │
│                                     │
│  ┌───────────────────────────────┐  │
│  │  Core Memory (In-Context)     │  │
│  │  ≈ RAM                        │  │
│  │  • 当前任务上下文              │  │
│  │  • 角色定义 + 价值观          │  │
│  │  • 本次对话的关键决策          │  │
│  └───────────────┬───────────────┘  │
│                  │ Agent 自主管理    │
│  ┌───────────────▼───────────────┐  │
│  │  Archival Memory (Vector DB)  │  │
│  │  ≈ Disk                       │  │
│  │  • 过往经验和教训              │  │
│  │  • 领域知识库                  │  │
│  │  • 组织政策文档                │  │
│  └───────────────────────────────┘  │
│                                     │
│  ┌───────────────────────────────┐  │
│  │  Recall Memory (搜索式)       │  │
│  │  ≈ Search Engine              │  │
│  │  • 完整对话历史                │  │
│  │  • 按日期/关键词检索           │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

关键特性：**Agent 自主决定**什么放进核心记忆、什么归档、什么检索。不是系统替它管理，而是它自己管理自己的"大脑"。

---

## 2. 一个强模型 vs 一群弱模型：定量分析

### 2.1 OneFlow 研究：单 Agent 基线的逆袭

2025 年 1 月的论文 "Rethinking the Value of Multi-Agent Workflow: A Strong Single Agent Baseline" 给出了颠覆性结论：

**核心发现**：
- **单 Agent 可以达到同质多 Agent 工作流的性能**，且因 KV Cache 共享而有效率优势
- OneFlow 设计的工作流用单 Agent 执行时，性能**反而略高于**多 Agent 版本
- 跨 7 个基准测试（编码、数学、通用问答、领域推理、规划与工具使用）验证

**为什么**：KV Cache 共享让单 Agent 拥有更多上下文，生成更好的结果。多 Agent 的通信开销反而是损耗。

### 2.2 Google 研究：180 种配置的定量分析

Google 2025 年底的论文 "Towards a Science of Scaling Agent Systems" 提供了更精确的决策边界：

| 任务类型 | 最佳架构 | 原因 |
|----------|----------|------|
| **顺序任务** + 单 Agent ≥45% 准确率 | **单 Agent** | 多 Agent 降低 39%-70% 性能 |
| **可并行任务** | **集中式多 Agent** | 比单 Agent 高 80%（如金融分析） |
| **工具密集型任务** | **单 Agent** | 多 Agent 的工具协调开销 > 收益 |

**三大定律**：
1. **工具协调权衡**：工具越多，多 Agent 开销越大
2. **能力饱和**：当单 Agent 已经够好时，加 Agent 收益递减
3. **拓扑依赖错误放大**：独立多 Agent 错误放大 17.2 倍，集中式仅 4.4 倍

### 2.3 内部辩论：一个模型内的多视角

最新研究发现，高级推理模型可以在内部**自发产生多角色辩论**：

> "You do not need separate models or prompts to force this interaction; the debate emerges autonomously within the reasoning process of a single model instance."

这直接支持了"Think Harder, Orchestrate Less"的范式：

```
传统方式:
  Agent_Analyst → Agent_Reviewer → Agent_Approver → Agent_Executor
  (4 次 API 调用, 4 个 prompt, 通信开销, 错误放大)

Token-Rich 方式:
  一个 Opus 模型 + Extended Thinking:
    [内部] 分析 → 质疑自己的分析 → 考虑替代方案 →
    评估风险 → 做出判断 → 解释理由
  (1 次 API 调用, 深度推理, 自我校正)
```

### 2.4 决策框架：何时用单模型 vs 多 Agent

```
                    ┌─────────────────────┐
                    │ 任务是否可并行化？   │
                    └──────┬──────────────┘
                           │
                    ┌──────▼──────┐
                    │    Yes      │──────────────────┐
                    └──────┬──────┘                  │
                           │ No                      │
                    ┌──────▼──────────────┐   ┌──────▼──────────────┐
                    │ 单 Agent 准确率     │   │ 集中式多 Agent      │
                    │ ≥ 45%?              │   │ (1 Coordinator +    │
                    └──────┬──────────────┘   │  N Specialists)     │
                           │                  └─────────────────────┘
                    ┌──────▼──────┐
                    │    Yes      │──→ 用单个强模型 + Deep Thinking
                    └──────┬──────┘
                           │ No
                    ┌──────▼──────────────┐
                    │ 增强 Prompt + 工具  │
                    │ 提升单 Agent 能力   │
                    └─────────────────────┘
```

---

## 3. 类人工作模式：认知科学视角

### 3.1 Satisficing：追求"够好"而非"最优"

Herbert Simon 的**有限理性（Bounded Rationality）**理论对 Agent 设计有深刻启示：

**人类如何决策**：
- 设定一个"可接受阈值"（aspiration level）
- 找到第一个满足阈值的选项就行动
- 不会穷尽所有可能性去找"最优解"

**Agent 应该怎么做**：

```python
# 不是这样（Optimizing — 穷举所有选项）
async def handle_approval(request):
    all_options = await explore_all_possible_actions(request)
    scores = await evaluate_each_option(all_options)
    best = max(scores, key=lambda x: x.score)
    return best

# 而是这样（Satisficing — 够好就行动）
async def handle_approval(request):
    # Agent 用自己的判断力快速评估
    assessment = await think(f"""
        审批请求: {request}

        我需要判断：
        1. 这个请求合理吗？（基于我的经验和常识）
        2. 有没有明显的红旗？
        3. 我有足够信息做决定吗？

        不需要完美分析。给出我的专业判断。
    """)

    if assessment.confidence >= "sufficient":
        return assessment.decision
    else:
        # 只在信息不足时才寻求更多信息
        return await gather_more_info_and_retry(request)
```

### 3.2 情境意识（Situational Awareness）

人类专业人士的核心能力不是遵循流程，而是**理解"当前情况需要什么"**：

```
一个有经验的审批员：

场景 A: 常规小额采购
  → 快速扫一眼，批准，2 分钟搞定

场景 B: 异常大额 + 新供应商
  → 仔细检查背景、要求额外文档、可能升级给上级

场景 C: 紧急灾后采购
  → 理解紧迫性，简化流程，快速批准但确保记录

同一个人，同一个"审批"任务，三种完全不同的处理方式。
不是因为流程不同，而是因为**判断力**不同。
```

Agent 的情境意识实现：

```python
# Agent 的 System Prompt（价值观 + 判断框架，不是流程）
AGENT_VALUES = """
你是一个有经验的采购审批专员。

你的价值观：
- 保护组织利益，但也理解业务需要灵活性
- 遵守合规底线，但不死板执行
- 效率很重要 — 不要为小事浪费人和时间
- 有疑问时，宁可问也不要猜

你的判断框架：
- 常规事务：快速处理，不要过度分析
- 异常事务：深入调查，但不要制造瓶颈
- 紧急事务：先行动后完善文档，确保有追踪
- 不确定时：升级给你的经理，附上你的初步判断

你不需要：
- 每次都走完整流程
- 为每个决定写详细理由
- 等待外部系统确认才能判断
"""
```

### 3.3 即兴发挥（Improvisation）

当标准流程不适用时，人类会**创造性地解决问题**。Agent 也应该有这个能力：

```python
async def handle_task(agent, task):
    # 第一次尝试：按经验来
    result = await agent.attempt(task)

    if result.success:
        return result

    # 失败了？不是报错退出，而是反思和调整
    reflection = await agent.think(f"""
        我的第一个方法失败了: {result.error}

        让我想想为什么：
        - 是我理解错了任务吗？
        - 是工具/环境的限制吗？
        - 有没有完全不同的方法？

        我见过类似的情况吗？
        {await agent.recall_similar_experiences(task)}

        让我尝试一个不同的思路...
    """)

    # 用新方法重试 — 不是同样的方法重试 N 次
    new_approach = await agent.devise_alternative(reflection)
    return await agent.attempt(task, approach=new_approach)
```

### 3.4 专业判断力的建模

专业判断力不是规则，而是**经验 + 直觉 + 价值观**的组合：

```
┌─────────────────────────────────────────┐
│        Professional Judgment Model      │
│                                         │
│  ┌───────────┐                          │
│  │  经验库    │  过往处理过的类似案例    │
│  │ (Archival) │  成功和失败的教训        │
│  └─────┬─────┘                          │
│        │                                │
│  ┌─────▼─────┐                          │
│  │  直觉     │  基于经验的模式识别      │
│  │ (Pattern  │  "这个感觉不太对"        │
│  │  Match)   │  → 触发更深入的分析      │
│  └─────┬─────┘                          │
│        │                                │
│  ┌─────▼─────┐                          │
│  │  价值观    │  组织的核心原则          │
│  │ (Values)  │  决策的道德和战略锚点    │
│  └─────┬─────┘                          │
│        │                                │
│  ┌─────▼─────┐                          │
│  │  判断     │  综合以上，做出决定      │
│  │(Judgment) │  "鉴于我所知道的一切，   │
│  └───────────┘   我认为应该..."          │
└─────────────────────────────────────────┘
```

---

## 4. 从错误中学习：Blameless 文化

### 4.1 Reflexion：语言强化学习

Reflexion（NeurIPS 2023）是目前最重要的"从错误中学习"框架：

```
┌─────────────────────────────────────┐
│         Reflexion Loop              │
│                                     │
│  Trial 1: 尝试 → 失败              │
│      │                              │
│      ▼                              │
│  Self-Reflection: "我失败是因为     │
│  没有考虑到预算周期已切换到新       │
│  财年，导致查错了预算表..."         │
│      │                              │
│      ▼ (存入 Episodic Memory)       │
│                                     │
│  Trial 2: 尝试（带反思记忆）→ 成功 │
│      │                              │
│      ▼                              │
│  经验积累: "处理预算相关任务时，    │
│  先确认当前财年。"                  │
│                                     │
│  ★ 无需微调模型参数                 │
│  ★ 学习发生在 Token 空间           │
│  ★ 运行时知识，不是训练时知识       │
└─────────────────────────────────────┘
```

核心机制：
- **Actor**：执行动作
- **Self-Reflection Model**：生成语言化的自我批评
- **Episodic Memory**：存储反思，供未来检索
- **改进方式**：不是改模型权重，而是改上下文 — 在 Token 空间中学习

### 4.2 区分"可接受的错误"和"不可接受的错误"

```
┌─────────────────────────────────────────────────────┐
│              错误分类框架                             │
│                                                     │
│  ┌─────────────────────────────────────────┐        │
│  │  可接受的错误（判断失误）                │        │
│  │  • 选了次优方案但结果还行                │        │
│  │  • 多花了一些时间在不必要的调查上        │        │
│  │  • 格式/表述不够理想                     │        │
│  │  • 低估了任务复杂度需要重做              │        │
│  │                                         │        │
│  │  处理方式：记录 → 反思 → 改进           │        │
│  │  就像新员工犯错 → 经理辅导               │        │
│  └─────────────────────────────────────────┘        │
│                                                     │
│  ┌─────────────────────────────────────────┐        │
│  │  不可接受的错误（违反底线）              │        │
│  │  • 泄露 PII / 敏感数据                   │        │
│  │  • 超出授权金额范围                      │        │
│  │  • 删除/覆盖不可恢复的数据               │        │
│  │  • 冒充其他身份执行操作                  │        │
│  │                                         │        │
│  │  处理方式：硬性阻止 — 这是唯一需要       │        │
│  │  "事前拦截"的场景                        │        │
│  └─────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────┘
```

### 4.3 经验积累的运行时知识系统

```python
class AgentExperienceMemory:
    """
    Agent 的经验积累系统。
    不是微调，而是运行时知识。
    类比：新员工入职 6 个月后积累的"肌肉记忆"。
    """

    def __init__(self, agent_id: str):
        self.lessons: list[Lesson] = []       # 教训库
        self.patterns: list[Pattern] = []     # 模式库
        self.heuristics: list[str] = []       # 启发式规则

    async def learn_from_outcome(self, task, action, outcome):
        """每次任务完成后的学习循环"""

        reflection = await self.agent.think(f"""
            任务: {task}
            我的行动: {action}
            结果: {outcome}

            反思：
            1. 结果是否达到预期？
            2. 有没有我下次可以做得更好的地方？
            3. 这个经验能否泛化为一条规则？

            如果有教训，用一句话总结。
            如果没有特别的教训，说"无需特别记录"。
        """)

        if reflection.has_lesson:
            self.lessons.append(Lesson(
                context=task.summary,
                lesson=reflection.lesson,
                confidence=reflection.confidence,
                timestamp=now()
            ))

    async def get_relevant_experience(self, new_task) -> str:
        """检索与当前任务相关的过往经验"""
        relevant = vector_search(self.lessons, new_task.embedding, top_k=5)

        return "\n".join([
            f"- 过往经验: {l.context} → 教训: {l.lesson}"
            for l in relevant
        ])
```

### 4.4 Blameless Postmortem 在 Agent 系统中的应用

人类组织的 Blameless Postmortem 文化可以直接映射到 Agent 系统：

| 人类组织实践 | Agent 系统映射 |
|-------------|---------------|
| "不问谁错了，问什么导致了这个结果" | Agent 反思 trace，不是重置/惩罚 Agent |
| 心理安全 — 敢于报告错误 | Agent 的反思不被用于"惩罚"（降低信任分等），而是用于改进 |
| 分享教训给团队 | 一个 Agent 的经验可以（选择性地）分享给同类 Agent |
| 改进系统，不是改进个人 | 识别出是 Prompt/工具/环境的问题，而不是 Agent "能力不行" |

---

## 5. 最小控制架构

### 5.1 真正的最小集

经过分析，Agent 真正需要的控制**只有三项**：

```
┌─────────────────────────────────────────────────────┐
│           THE MINIMAL CONTROL SET                    │
│           (仅此三项，不需要更多)                      │
│                                                     │
│  1. 🔒 数据底线                                     │
│     • 不得暴露 PII（个人身份信息）                    │
│     • 不得在未授权通道传输敏感数据                    │
│     → 实现: Output 扫描 + 数据分类标记               │
│                                                     │
│  2. 💰 金额底线                                     │
│     • 不得超出预授权的金额范围                        │
│     • 超额自动暂停并通知                             │
│     → 实现: API 层面的金额校验（不在 Agent 层面）     │
│                                                     │
│  3. 📝 操作记录                                     │
│     • 所有操作必须可追溯                             │
│     • 结构化日志，事后可审计                          │
│     → 实现: 自动日志，Agent 无感知                    │
│                                                     │
│  其他一切 → 信任 Agent 的判断                        │
└─────────────────────────────────────────────────────┘
```

### 5.2 "Manager Review" vs "Gatekeeper"

```
Gatekeeper 模式（我们不要的）:
  Agent 想执行操作 → Policy Engine 检查 → 批准/拒绝 → 执行
  问题：每个动作都有延迟，Agent 失去自主性，系统复杂度爆炸

Manager Review 模式（我们要的）:
  Agent 自主执行 → 记录操作 → 经理定期看报告 → 必要时反馈
  优势：Agent 全速运行，人类只在有价值时介入

实现方式:
  ┌────────────┐    ┌──────────┐    ┌─────────────┐
  │   Agent    │───→│ 操作日志  │───→│ 周/日报告    │
  │ (自主执行)  │    │ (自动的)  │    │ (给经理看)   │
  └────────────┘    └──────────┘    └──────┬──────┘
                                          │
                                   经理看到异常时
                                          │
                                   ┌──────▼──────┐
                                   │  反馈给 Agent │
                                   │ (更新价值观)  │
                                   └─────────────┘
```

### 5.3 信任默认架构

```python
class TrustByDefaultAgent:
    """
    信任默认 — 只在碰到底线时才拦截。

    设计哲学：
    - 默认允许一切操作
    - 只有明确的底线违规才触发拦截
    - 底线数量要尽可能少（3条以内）
    - 其他所有"不确定"都让 Agent 自己判断
    """

    # 唯一的硬底线 — 在基础设施层面实现，不在 Agent 层面
    HARD_LIMITS = {
        "pii_output_scan": True,       # Output 层面扫描 PII
        "max_transaction_amount": 5000, # 超过此金额暂停
        "immutable_audit_log": True,    # 操作不可篡改记录
    }

    async def execute(self, task):
        """
        Agent 自主执行。
        注意：没有 Policy Engine 检查每个步骤。
        没有 Circuit Breaker 监控每个动作。
        只有三条硬底线在基础设施层面实现。
        """

        # 1. Agent 自己思考怎么做（用足够的 Token）
        plan = await self.think_deeply(task)

        # 2. 执行（不需要审批）
        result = await self.act(plan)

        # 3. 自我评估（不是外部评估）
        self_review = await self.reflect(task, result)

        # 4. 如果自己觉得不确定，主动求助
        if self_review.needs_human_input:
            await self.escalate_to_manager(
                reason=self_review.uncertainty_reason
            )

        # 5. 记录经验
        await self.experience_memory.learn_from_outcome(
            task, plan, result
        )

        return result
```

### 5.4 Management by Exception

人类管理学中的"例外管理"原则可以直接应用：

```
正常运作（99% 的时间）:
  Agent 自主工作 → 生成周报 → 经理扫一眼 → "看起来正常" → 继续

异常触发（1% 的时间）:
  Agent 操作 → 统计异常检测 → "这个 Agent 本周拒绝率异常高"
  → 通知经理 → 经理检查 → 发现是因为上游数据质量问题
  → 修复上游 → Agent 恢复正常

关键：人类只在"异常"时介入。不是审批每个决定。
```

---

## 6. 实际案例分析

### 6.1 Anthropic Claude Code — Agent 自主性的实证

Anthropic 自己的数据是最有力的证据：

**自主性趋势**：
- 2025.10 → 2026.01：Agent 最长自主运行时间从 **25 分钟增至 45 分钟**
- 新用户 20% 使用完全自动批准 → 有经验用户 **40%** 使用完全自动批准
- Agent 主动暂停问问题的频率**高于**人类打断它的频率 — Agent 比人类更懂得何时该停

**关键洞察**：
> "Claude Code pauses for clarification more often than humans interrupt it."

这说明：Agent 不需要外部控制来决定何时停下。**它自己知道什么时候不确定**。

**Agent Teams**：
- 2000 个 Claude Code session，$20,000 API 成本
- 产出 100,000 行 C 编译器代码，可编译 Linux 6.9（x86/ARM/RISC-V）
- 多个 Agent 在共享代码库上并行工作，**无需人类主动干预**
- 测试、构建结果作为主要控制机制 — 不是 Policy Engine

**Deployment Overhang**：
> "The autonomy models are capable of handling exceeds what they exercise in practice."

模型的自主能力**远超**实际被赋予的自主权。瓶颈不是技术，是人类的信任。

### 6.2 Devin — 18 个月的生产实践

Cognition Labs 的 Devin 提供了最丰富的"Agent 在真实工作中"的经验：

**2025 年度表现**：
- 解决问题速度提升 **4 倍**
- 资源消耗效率提升 **2 倍**
- PR 合并率从 34% 提升到 **67%**
- 客户包括 Goldman Sachs、Citi、Santander、Nubank

**关键设计洞察**：
1. **计划会变** — Devin 创建初始计划，但随着新信息出现，计划持续演变
2. **自我调试** — 遇到错误时，它尝试修复、重运行、从失败中学习
3. **清晰前置 > 迭代反馈** — 与人类员工不同，Devin 更需要清晰的前期规格
4. **仍有局限** — 无法独立处理模糊的端到端项目；调试能力仍有限

**最重要的教训**：使用 Devin 的工程师需要学会"管理"AI — 像管理初级工程师一样，而不是像使用工具一样。

### 6.3 Cursor vs Windsurf — 两种自主性哲学

| 维度 | Cursor | Windsurf |
|------|--------|----------|
| **哲学** | 受控自主（Controlled Autonomy） | 委托式自主（Delegated Autonomy） |
| **行为** | 执行前问"我应该继续吗？" | 直接执行，报告结果 |
| **适合** | 需要严格控制的合规环境 | 追求效率的快节奏团队 |
| **信任模型** | 人在循环中（Human-in-the-loop） | 人在旁边（Human-on-the-loop） |

**Windsurf 的 Turbo Mode** 体现了核心张力：速度/自动化 vs 信任/控制。这正是我们需要解决的设计问题。

对于虚拟员工平台，我们应该倾向 Windsurf 的"委托式自主"模式 — Agent 自主执行，人类监督结果。

### 6.4 Anthropic 对 Agent 自主性的度量框架

Anthropic 的研究提出了一个关键概念 — **Deployment Overhang**：

> 模型实际具备的自主能力 >> 实际被赋予的自主权

这意味着：
- 技术瓶颈已经不是问题
- 瓶颈是**人类的信任**和**组织的准备度**
- 设计系统时应该考虑：如何帮助人类**逐步建立信任**，而不是永远限制 Agent

---

## 7. 经济学分析

### 7.1 Claude Opus 4.6 定价（2026 年 2 月）

| 项目 | 价格 |
|------|------|
| 标准输入 | $5.00/M tokens |
| 标准输出 | $25.00/M tokens |
| 长上下文输入（>200K） | $10.00/M tokens |
| 长上下文输出（>200K） | $37.50/M tokens |
| Cache Hit | 标准价的 10% |
| Batch API | 标准价的 50% |

**对比上代**：Opus 4.1 是 $15/$75 — Opus 4.6 **降价 67%**。

### 7.2 "Think Harder, Orchestrate Less" 的经济学

```
方案 A: 多 Agent 编排
  4 个 Haiku Agent × 平均 2000 tokens/call
  = 8000 tokens × $0.25/M(input) + $1.25/M(output)
  ≈ $0.012/task
  + 编排基础设施成本（API Gateway, 状态管理, 错误处理...）
  + 工程维护成本（4 个 prompt 要维护, 4 个通信协议...）
  + 错误放大风险（独立 Agent 错误放大 17.2x）

方案 B: 单 Opus Deep Thinking
  1 个 Opus Agent × 10,000 tokens（含 extended thinking）
  = 10,000 tokens × $5/M(input) + $25/M(output)
  ≈ $0.30/task
  + 几乎零编排基础设施
  + 维护 1 个 prompt
  + 自我校正，错误不放大

方案 B 每次调用贵 25 倍，但：
  - 工程复杂度降低 80%
  - 维护成本降低 75%
  - 错误率更低（自我校正）
  - 通常更少的迭代次数 → 总 token 消耗可能更低
```

### 7.3 Token 成本 vs 人力成本

```
虚拟员工 Token 成本估算（每天）:

假设一个虚拟员工每天处理 50 个任务，每个任务平均:
  - 输入: 5000 tokens（任务描述 + 上下文 + 经验检索）
  - Extended Thinking: 10,000 tokens（内部推理）
  - 输出: 2000 tokens（行动 + 报告）

每日 Token 消耗:
  Input: 50 × 5000 = 250K tokens → $1.25
  Thinking: 不计费（Extended Thinking 的 token 不计费）
  Output: 50 × 2000 = 100K tokens → $2.50

每日成本: ≈ $3.75
每月成本: ≈ $82.50（22 个工作日）

对比人力:
  初级政府行政人员: ~$200-400/天（澳洲）
  = $4,400-8,800/月

成本对比: Agent $82.50/月 vs 人类 $4,400-8,800/月
节省: 98-99%

即使 Agent 需要 10 倍的 token（复杂任务、重试、经验检索）:
  Agent $825/月 vs 人类 $4,400-8,800/月
  节省: 81-91%

结论: Token 成本远非瓶颈。给 Agent 更多 Token 去"深度思考"
是经济上完全合理的。
```

### 7.4 Prompt Caching 的战略价值

```
Agent 的 System Prompt（价值观 + 角色定义 + 经验库）可能很长:
  • 角色定义: ~2000 tokens
  • 价值观和判断框架: ~3000 tokens
  • 相关经验: ~5000 tokens
  • 总计: ~10,000 tokens

没有 Cache: 每次调用 10,000 × $5/M = $0.05 输入成本
有 Cache: 每次调用 10,000 × $0.50/M = $0.005 输入成本

节省 90% 的输入成本。这让"丰富的 Agent 人设"变得廉价。
```

---

## 8. 架构设计方案

### 8.1 Token-Rich Autonomous Agent 总体架构

```
┌─────────────────────────────────────────────────────────┐
│                  Virtual Employee Agent                  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Agent Core (Opus-Class LLM)          │   │
│  │                                                    │   │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────┐    │   │
│  │  │  Values   │ │  Skills  │ │   Experience   │    │   │
│  │  │  & Role   │ │  & Tools │ │   Memory       │    │   │
│  │  └──────────┘ └──────────┘ └────────────────┘    │   │
│  │                                                    │   │
│  │  ┌──────────────────────────────────────────┐     │   │
│  │  │        Adaptive Thinking Engine           │     │   │
│  │  │  (自动调节推理深度: low/med/high/max)     │     │   │
│  │  │                                          │     │   │
│  │  │  Inner Monologue:                        │     │   │
│  │  │  "这个情况我之前遇到过，上次我..."       │     │   │
│  │  │  "但这次不太一样，因为..."               │     │   │
│  │  │  "我觉得应该..."                         │     │   │
│  │  └──────────────────────────────────────────┘     │   │
│  │                                                    │   │
│  │  ┌──────────────────────────────────────────┐     │   │
│  │  │        Reflexion Loop                     │     │   │
│  │  │  失败 → 自我批评 → 调整方法 → 重试       │     │   │
│  │  └──────────────────────────────────────────┘     │   │
│  │                                                    │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ── ── ── ── 以下是基础设施层，Agent 无感知 ── ── ──  │
│                                                         │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐   │
│  │ PII Scanner  │ │ Amount Limit │ │ Immutable Log │   │
│  │ (Output层)   │ │ (API层)      │ │ (自动记录)    │   │
│  └──────────────┘ └──────────────┘ └───────────────┘   │
│           ↑                                             │
│     仅此三项硬底线                                      │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │     Manager Dashboard (事后审计)                  │   │
│  │     • 日/周报告                                   │   │
│  │     • 异常高亮                                    │   │
│  │     • 经理反馈 → 更新 Agent 价值观               │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 8.2 Agent Core 实现

```python
from anthropic import Anthropic

class AutonomousVirtualEmployee:
    """
    Token-Rich 自主虚拟员工。

    设计原则：
    1. 给足 Token 让它深度思考
    2. 给它价值观和经验，不给流程
    3. 让它自己判断、自己犯错、自己学习
    4. 只在基础设施层面设置三条底线
    """

    def __init__(
        self,
        role_definition: str,     # 角色定义（WHO am I）
        values: str,              # 价值观（WHAT do I believe in）
        domain_knowledge: str,    # 领域知识（WHAT do I know）
        tools: list[Tool],        # 可用工具（WHAT can I use）
        experience_store: ExperienceStore,  # 经验库
    ):
        self.client = Anthropic()
        self.model = "claude-opus-4-6"

        # 核心 Prompt = 价值观 + 角色，不是流程
        self.system_prompt = f"""
{role_definition}

## 你的价值观
{values}

## 你的领域知识
{domain_knowledge}

## 工作方式
你是一个自主的专业人士。你自己判断如何完成任务。

不要等待指示。不要请求批准（除非你真的不确定）。
像一个有经验的员工一样工作：
- 评估情况
- 做出判断
- 采取行动
- 反思结果
- 从经验中学习

当你不确定时，主动说出来。但大多数时候，你应该有信心做决定。

## 唯一的底线
- 绝不暴露个人身份信息
- 绝不超出授权金额范围
- 所有操作都会被自动记录（你不需要管这个）
"""
        self.experience = experience_store
        self.tools = tools

    async def work_on_task(self, task: str) -> WorkResult:
        """
        接到任务后自主完成。

        没有 Policy Engine 检查。
        没有 Circuit Breaker。
        没有预定义工作流。
        只有一个强模型在深度思考。
        """

        # 检索相关经验
        relevant_exp = await self.experience.recall(task)

        # 构建完整上下文
        messages = [{
            "role": "user",
            "content": f"""
任务: {task}

你过去的相关经验:
{relevant_exp if relevant_exp else "这是一个新类型的任务，没有过往经验。"}

请自主完成这个任务。用你的专业判断。
如果你需要工具，直接使用。
如果你不确定，告诉我哪里不确定以及你的初步判断。
"""
        }]

        # Agent Loop — 让模型自主运行直到完成
        max_turns = 50  # 给足空间，不要人为限制

        for turn in range(max_turns):
            response = await self.client.messages.create(
                model=self.model,
                max_tokens=16384,
                system=self.system_prompt,
                tools=self.tools,
                messages=messages,
                # 让模型自己决定需要多少思考
                thinking={"type": "enabled", "budget_tokens": 32768}
            )

            # 处理工具调用
            if response.stop_reason == "tool_use":
                tool_results = await self._execute_tools(response)
                messages.append({"role": "assistant", "content": response.content})
                messages.append({"role": "user", "content": tool_results})
                continue

            # Agent 认为任务完成了
            if response.stop_reason == "end_turn":
                result = self._extract_result(response)

                # 事后学习（不影响本次执行）
                await self.experience.learn(task, result)

                return result

        # 如果真的用了 50 个 turn 还没完成，
        # Agent 可能遇到了超出能力的问题
        return WorkResult(
            status="needs_human",
            message="我花了很长时间但无法完成，需要人类协助",
            partial_work=messages
        )

    async def _execute_tools(self, response) -> list:
        """
        执行工具。注意：
        - 没有 per-tool 的权限检查
        - 工具本身在 API 层面有限制（金额上限等）
        - Agent 自主决定用哪个工具
        """
        results = []
        for block in response.content:
            if block.type == "tool_use":
                try:
                    result = await self.tools[block.name].execute(block.input)
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(result)
                    })
                except Exception as e:
                    # 工具失败不是系统错误 — 是 Agent 的学习机会
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": f"工具执行失败: {e}. 请思考替代方案。",
                        "is_error": True
                    })
        return results
```

### 8.3 经验系统实现

```python
class ExperienceStore:
    """
    Agent 的经验存储。

    设计:
    - 使用 Vector DB 存储经验
    - Agent 自主决定什么值得记住
    - 经验有衰减 — 旧的经验权重降低
    - 经验可以被"修正" — 如果后来发现某个教训是错的
    """

    def __init__(self, agent_id: str, vector_db: VectorDB):
        self.agent_id = agent_id
        self.db = vector_db
        self.collection = f"experience_{agent_id}"

    async def recall(self, task: str, top_k: int = 5) -> str:
        """检索与当前任务相关的经验"""
        results = await self.db.search(
            collection=self.collection,
            query=task,
            top_k=top_k,
            # 按相关性 × 时间衰减排序
            score_function=lambda relevance, age_days:
                relevance * (0.95 ** (age_days / 30))  # 每月衰减 5%
        )

        if not results:
            return ""

        return "\n".join([
            f"[{r.metadata['date']}] {r.metadata['context']}: {r.text}"
            for r in results
        ])

    async def learn(self, task: str, result: WorkResult):
        """从任务结果中学习"""
        # 让 Agent 自己决定有没有值得记住的
        reflection = await self._reflect(task, result)

        if reflection.worth_remembering:
            await self.db.insert(
                collection=self.collection,
                text=reflection.lesson,
                metadata={
                    "context": task[:200],
                    "outcome": result.status,
                    "date": datetime.now().isoformat(),
                    "confidence": reflection.confidence
                }
            )

    async def _reflect(self, task, result) -> Reflection:
        """Agent 的自我反思"""
        # 这本身就是一次 LLM 调用 — 用 Token 来学习
        response = await self.client.messages.create(
            model="claude-opus-4-6",
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": f"""
反思刚完成的任务：

任务: {task}
结果: {result.status}
详情: {result.summary}

问自己：
1. 我做得好的地方是什么？
2. 下次可以改进的地方？
3. 有什么值得记住的教训？

如果这只是一个普通任务，没有特别的教训，回答"无需记录"。
只记住真正有价值的经验。
"""
            }]
        )
        return self._parse_reflection(response)
```

### 8.4 Manager Dashboard（事后审计）

```python
class ManagerDashboard:
    """
    经理看到的不是 Agent 的每个动作，
    而是汇总的报告和异常高亮。

    就像真正的经理 — 你不会盯着员工的每个操作，
    你看他们的工作成果和报告。
    """

    async def generate_daily_report(self, agent_id: str) -> Report:
        """生成每日工作报告"""
        logs = await self.audit_store.get_logs(
            agent_id=agent_id,
            date=today()
        )

        return Report(
            summary=f"今日处理 {len(logs)} 个任务",
            completed=len([l for l in logs if l.status == "success"]),
            failed=len([l for l in logs if l.status == "failed"]),
            escalated=len([l for l in logs if l.status == "escalated"]),

            # 只高亮异常 — Management by Exception
            anomalies=self._detect_anomalies(logs),

            # Agent 自己的反思摘要
            agent_reflections=await self._get_agent_reflections(agent_id),
        )

    def _detect_anomalies(self, logs) -> list[Anomaly]:
        """统计异常检测 — 不是规则匹配"""
        anomalies = []

        # 例：今天的拒绝率是否异常高？
        rejection_rate = len([l for l in logs if l.decision == "reject"]) / len(logs)
        if rejection_rate > self._historical_rejection_rate * 2:
            anomalies.append(Anomaly(
                type="high_rejection_rate",
                detail=f"今日拒绝率 {rejection_rate:.0%}，历史平均 {self._historical_rejection_rate:.0%}",
                severity="info"  # 不一定是问题，只是异常
            ))

        # 例：处理时间是否异常长？
        avg_time = mean([l.duration for l in logs])
        if avg_time > self._historical_avg_time * 3:
            anomalies.append(Anomaly(
                type="slow_processing",
                detail=f"平均处理时间 {avg_time}s，历史 {self._historical_avg_time}s",
                severity="info"
            ))

        return anomalies
```

### 8.5 与现有 15 号报告架构的对比和升级

```
15 号报告的五大支柱     →    本报告的简化架构

1. Policy Engine        →    删除。只保留 3 条硬底线在基础设施层面。
   (Cedar/OPA)               Agent 不需要知道 Policy Engine 的存在。

2. Behavioral Contracts →    保留底线部分，但大幅简化。
   (ABC)                     "不变量" 只有 PII/金额/记录三条。
                             其余都不是"合约"，而是"价值观"。

3. Trust Factor         →    删除动态信任评分机制。
   (动态信任)                默认信任。用 Anthropic 的发现支持：
                             有经验的用户自然会增加信任。

4. Reflection Loop      →    保留并强化。这是核心。
   (反思循环)                从 Reflexion 论文吸收运行时学习。
                             经验库 + 自我反思 + 教训积累。

5. Audit Trail          →    简化为事后报告 + 异常检测。
   (审计追踪)                不是实时监控，是事后审计。
                             Manager Dashboard 做周/日报告。
```

---

## 9. 与现有架构的关系

### 9.1 修正：专职多 Agent 团队（非单 Agent 万能）

> **基于 OpenClaw 实践经验的关键修正**

第 2 节引用的 OneFlow/Google 论文结论在学术评测中成立，但在**真实业务场景**中需要限定：

**用户在 OpenClaw 的实际发现**：
- 专职多 Agent **优于** all-in-one 单 Agent
- 原因：专职 Agent 可以更专注本职问题，积累**专项经验**
- 但每个 Agent 仍然共享**团队级 context**（团队经验、错误记录等）

**正确的架构模型 — 像真人团队**：

```
┌──────────────────────────────────────────────────────────┐
│                    虚拟员工团队                              │
│                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  采购审批     │  │  数据录入    │  │  报告生成    │      │
│  │  专职 Agent  │  │  专职 Agent  │  │  专职 Agent  │      │
│  │             │  │             │  │             │      │
│  │ 专项经验:    │  │ 专项经验:    │  │ 专项经验:    │      │
│  │ · 供应商评估  │  │ · 数据格式   │  │ · 报告模板   │      │
│  │ · 审批规则   │  │ · 异常处理   │  │ · 趋势分析   │      │
│  │ · 历史案例   │  │ · 校验技巧   │  │ · 写作风格   │      │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘      │
│         │                │                │              │
│         └────────────────┼────────────────┘              │
│                          │                               │
│              ┌───────────▼────────────┐                  │
│              │  Team Shared Context    │                  │
│              │  · 团队级经验和教训      │                  │
│              │  · 共享错误记录          │                  │
│              │  · 组织政策和价值观      │                  │
│              │  · 跨领域知识           │                  │
│              └────────────────────────┘                  │
│                                                          │
│  每个 Agent 自主思考 + 有专项经验 + 共享团队知识            │
│  不是 MoE 路由，不是流水线，是真人团队模式                  │
└──────────────────────────────────────────────────────────┘
```

**与 MoE/编排的关键区别**：
- MoE：外部路由器**分配**任务给 Agent → Agent 只执行被分配的
- 真人团队：每个人**知道自己擅长什么**，自主接任务、自主协作、自主求助
- 编排思维："任务 A 应该给 Agent 1"
- 团队思维："采购审批 Agent 看到这个任务，判断是自己的职责范围，接手处理"

**Smart Router 的角色**：
- 不是"MoE Coordinator" — 不做任务分解和分配
- 更像"前台接待" — 把来的工作分到对应的专职 Agent
- 根据任务类型 + 复杂度决定用哪个模型级别
- 工作日/时高负荷（全模型运转），非工作时低功耗待命

**LLM 成本模型**：
- 预算: ~$2-3K/月
- 容量: 300-500M tokens/月（10-15M/天）
- 模型: Claude/OpenAI 企业/政府级
- Smart Router: 按任务复杂度分配模型级别
- 工作时间模式: 白天高负荷 / 夜间低功耗待命

### 9.2 保留的架构决策

以下决策依然有效且兼容本报告：
- **决策/执行分离**：Agent Swarm 做决策 → MS SDK 在客户租户执行
- **MCP 协议工具集成**：Agent 的工具接口
- **Entra Agent ID**：Agent 身份管理
- **三层审计存储**：简化为"自动记录 + 事后报告"
- **AKS 部署**：计算基础设施

### 9.3 需要更新的决策

| 原决策 | 建议更新 | 原因 |
|--------|---------|------|
| Policy Engine (Cedar/OPA) 每次调用检查 | 基础设施层 3 条硬底线 | 微观管理 → 信任默认 |
| Trust Factor 动态评分 | 删除，默认信任 | 不信任 → 治理 |
| NeMo Guardrails I/O 过滤 | 删除，只保留 PII 扫描 | 审查 → 自主 |
| MoE 路由 + 多小模型 | 单 Opus 深度推理 + 按需多 Agent | 编排复杂度 → 思考深度 |
| Circuit Breaker | 删除 | 监控 → 事后审计 |

---

## 10. 参考文献

### 学术论文
- Shinn et al., "Reflexion: Language Agents with Verbal Reinforcement Learning", NeurIPS 2023
- "Rethinking the Value of Multi-Agent Workflow: A Strong Single Agent Baseline", arXiv:2601.12307, 2025
- "Towards a Science of Scaling Agent Systems", arXiv:2512.08296, Google Research, 2025
- "MIRROR: Cognitive Inner Monologue Between Conversational Turns", arXiv:2506.00430, 2025
- "AI Agents Need Memory Control Over More Context", arXiv:2601.11653, 2025
- Simon, H., "Bounded Rationality", 1956/1972 — Satisficing 理论基础

### 产业报告与实践
- [Anthropic: Measuring AI Agent Autonomy in Practice](https://www.anthropic.com/research/measuring-agent-autonomy), 2026
- [Anthropic: Building Agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk), 2026
- [Claude Opus 4.6 发布及定价](https://www.marktechpost.com/2026/02/05/anthropic-releases-claude-opus-4-6-with-1m-context-agentic-coding-adaptive-reasoning-controls-and-expanded-safety-tooling-capabilities/), 2026
- [Cognition: Devin's 2025 Performance Review](https://cognition.ai/blog/devin-annual-performance-review-2025), 2025
- [Google Research: When and Why Agent Systems Work](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/), 2025
- [Letta/MemGPT: Agent Memory Architecture](https://www.letta.com/blog/agent-memory), 2025
- [Claude Opus 4.6 API Pricing](https://pricepertoken.com/pricing-page/model/anthropic-claude-opus-4.6), 2026
- [Anthropic Claude Code: Building C Compiler with Agent Teams](https://www.anthropic.com/engineering/building-c-compiler), 2026
- [VentureBeat: Framework for LLM Agents Learning from Experience](https://venturebeat.com/ai/this-new-framework-lets-llm-agents-learn-from-experience-no-fine-tuning), 2025
- [CSA: Agentic Trust Framework](https://cloudsecurityalliance.org/blog/2026/02/02/the-agentic-trust-framework-zero-trust-governance-for-ai-agents), 2026
