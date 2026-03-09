> **[部分过时]** MoE 编排/Coordinator 路由模式已不适用。Swarm 概念和共识机制仍有参考价值，但需以"大脑认知分区"模型重新理解，而非任务编排。

# 深度研究报告：动态 Agent Swarm 架构 -- 虚拟员工平台设计

> 研究日期：2026-03-06
> 研究员：AI 系统架构师
> 参考代码：openai-agents-python, swarms

---

## 摘要

本报告针对"虚拟员工平台"的核心架构问题进行深度研究。核心命题是：**一个通用的 Agent Swarm = 一个虚拟员工**。报告从五个维度展开：Agent Swarm 架构模式对比、动态模块加载机制、两个主流框架（OpenAI Agents SDK / Swarms）的源码分析、推荐架构设计方案，以及前沿研究参考。最终提出一个基于 **Dynamic Hierarchical MoE（动态层级式混合专家）** 的架构方案，兼顾灵活性、确定性和可扩展性。

---

## 目录

1. [Agent Swarm 架构模式对比](#1-agent-swarm-架构模式对比)
2. [动态模块加载机制](#2-动态模块加载机制)
3. [OpenAI Agents SDK 源码分析](#3-openai-agents-sdk-源码分析)
4. [Swarms 框架源码分析](#4-swarms-框架源码分析)
5. [推荐架构设计](#5-推荐架构设计)
6. [前沿参考与趋势](#6-前沿参考与趋势)
7. [总结与行动建议](#7-总结与行动建议)

---

## 1. Agent Swarm 架构模式对比

### 1.1 Hierarchical（层级式）

**核心思想**：一个 Director/Boss Agent 负责分解任务和分派工作，多个 Worker Agent 负责执行。类似企业中的管理者-执行者结构。

**代表实现**：
- Swarms 框架的 `HierarchicalSwarm`：Director Agent 创建计划 -> 分发订单给 Worker Agent -> 评估结果 -> 视需要再迭代
- OpenAI Agents SDK 的 `Handoff` 机制：Triage Agent 判断后将控制权交给专业 Agent

**优势**：
- 控制流清晰，便于审计和调试
- 天然适合企业场景中的审批链、工作流
- Director 可以做全局优化，避免 Agent 间冲突
- 容易实现成本控制（Director 控制迭代次数）

**劣势**：
- Director 是单点瓶颈和单点故障
- Director 的能力上限决定了整个系统的上限
- 对于需要 Agent 间高频交互的场景效率不高

**适用场景**：流程审批、项目管理、客服分流、任务分解与执行

### 1.2 Collaborative（协作式）

**核心思想**：多个 Agent 处于平等地位，通过消息传递和共享上下文进行协作。没有明确的主从关系。

**代表实现**：
- Swarms 的 `GroupChat`：多个 Agent 在对话中轮流发言
- Swarms 的 `DebateWithJudge`：Agent 之间辩论，由 Judge 裁决

**优势**：
- 去中心化，没有单点瓶颈
- 适合需要多视角分析的场景（如代码审查、方案评估）
- Agent 间可以互相补充和纠错

**劣势**：
- 协调成本高，容易出现"对话死循环"
- 缺乏全局视角，可能无法收敛到一致结论
- Token 消耗大（每个 Agent 都要理解完整上下文）
- 难以追踪责任和审计

**适用场景**：头脑风暴、多角度分析、代码审查、方案评估

### 1.3 Dynamic Routing（动态路由）

**核心思想**：根据任务的特征（内容、复杂度、紧急度等）动态选择最合适的 Agent 来处理。核心是一个 Router 组件。

**代表实现**：
- Swarms 的 `MultiAgentRouter`：Boss Agent 分析任务后选择一个或多个 Agent 执行
- Swarms 的 `SwarmRouter`：支持 `auto` 模式自动选择 Swarm 类型
- NeurIPS 2025 论文提出的 "Puppeteer-style" 动态编排：将多 Agent 协调视为序贯决策问题

**优势**：
- 灵活性高，同一平台可处理多种任务类型
- 可以根据负载、成本、延迟等因素动态调整
- 新增 Agent 只需注册，不需修改路由逻辑（若路由本身是 LLM 驱动的）

**劣势**：
- 路由决策本身可能出错（错误的 Agent 选择导致任务失败）
- 路由层增加了一次 LLM 调用的延迟和成本
- 需要维护每个 Agent 精准的能力描述

**适用场景**：通用任务入口、多岗位虚拟员工、客服系统

### 1.4 Mixture of Experts (MoE) 式

**核心思想**：借鉴 Mixture-of-Experts 模型架构的理念，用一个 Gate（门控）机制来选择激活哪些"专家 Agent"。与 Dynamic Routing 的区别在于：MoE 式可以同时激活多个专家，并加权融合结果。

**代表实现**：
- Swarms 的 `MixtureOfAgents`：多层处理，每层多个 Agent 并行，再由 Aggregator Agent 汇总
- 论文 "Mixture-of-Agents Enhances Large Language Model Capabilities"（2024）

**优势**：
- 可以利用多个 Agent 的互补优势
- 分层架构允许逐步精炼结果
- Aggregator 可以做质量控制和结果融合

**劣势**：
- 成本高（多个 Agent 同时运行）
- Aggregator 的能力决定了融合质量
- 对于有明确正确答案的任务（如数据录入），多专家融合可能是过度设计

**适用场景**：复杂分析报告、多维度决策、需要"第二意见"的场景

### 1.5 Swarm Intelligence（群体智能）

**核心思想**：去中心化，Agent 之间通过简单规则进行局部交互，宏观上涌现出复杂的协作行为。类似蚁群、鸟群。

**代表实现**：
- Swarms 的 `TreeSwarm`：基于 embedding 相似度将任务路由到最相关的 Agent 树节点
- 学术论文："Multi-agent systems powered by large language models: applications in swarm intelligence"（2025）

**优势**：
- 极高的可扩展性（无中心节点瓶颈）
- 自适应能力强
- 单个 Agent 故障不影响整体

**劣势**：
- 行为难以预测和审计
- 收敛速度慢
- 不适合需要精确控制的企业流程
- LLM-based 群体智能目前仍偏学术，距离生产尚远

**适用场景**：大规模数据处理、探索性任务、不需要精确控制的场景

### 1.6 架构模式对比总结

| 维度 | Hierarchical | Collaborative | Dynamic Routing | MoE 式 | Swarm Intelligence |
|------|-------------|---------------|-----------------|--------|-------------------|
| **控制性** | 高 | 低 | 中 | 中 | 低 |
| **灵活性** | 中 | 高 | 高 | 中 | 极高 |
| **可审计性** | 高 | 中 | 高 | 中 | 低 |
| **成本效率** | 高 | 低 | 高 | 低 | 中 |
| **可扩展性** | 中 | 中 | 高 | 中 | 极高 |
| **确定性** | 高 | 低 | 中 | 中 | 低 |
| **企业适配度** | 高 | 中 | 高 | 中 | 低 |

**结论**：对于虚拟员工平台，推荐采用 **Hierarchical + Dynamic Routing 的混合模式**，以 Hierarchical 确保控制性和可审计性，以 Dynamic Routing 实现灵活性和可扩展性。

---

## 2. 动态模块加载机制

### 2.1 运行时子 Agent 发现和加载

动态加载子 Agent 有三种主流策略：

#### 策略一：注册表模式（Registry Pattern）

每个 Agent 注册到中央注册表，包含名称、能力描述、接口定义等元数据。Coordinator 查询注册表来发现可用 Agent。

Swarms 框架中的 `AgentRegistry` 实现了这种模式：

```python
# swarms/structs/agent_registry.py
class AgentRegistry:
    """线程安全的 Agent 注册表"""
    def __init__(self, name, description, agents=None):
        self.agents: Dict[str, Agent] = {}
        self.lock = Lock()  # 线程安全

    def add(self, agent: Agent) -> None: ...
    def find_agent_by_name(self, name: str) -> Agent: ...
    def list_agents(self) -> List[str]: ...
```

**优势**：显式、可控、便于管理
**不足**：需要预先注册，非完全动态

#### 策略二：基于相似度的自动发现（Similarity-based Discovery）

Swarms 框架的 `DynamicSkillsLoader` 实现了基于文本相似度的技能自动发现：

```python
# swarms/structs/dynamic_skills_loader.py
class DynamicSkillsLoader:
    def __init__(self, skills_dir, similarity_threshold=0.3):
        self.skills_metadata = self._load_all_skills_metadata()

    def load_relevant_skills(self, task: str) -> List[Dict]:
        """基于余弦相似度自动匹配技能"""
        for skill in self.skills_metadata:
            similarity = self._calculate_task_similarity(task, skill["description"])
            if similarity >= self.similarity_threshold:
                relevant_skills.append(skill)
```

每个 Skill 通过 `SKILL.md` 文件（含 YAML frontmatter）描述自身能力，系统在运行时通过 TF 向量余弦相似度匹配最相关的 Skill。

**优势**：真正的动态发现，新增 Skill 只需添加文件
**不足**：当前实现使用简单的词频向量，可替换为 embedding 模型提升精度

#### 策略三：LLM 驱动的动态选择

Swarms 的 `AutoSwarmBuilder` 和 `MultiAgentRouter` 用 LLM 来动态决策：

```python
# swarms/structs/multi_agent_router.py
class MultiAgentRouter:
    """Boss Agent 分析任务后动态选择执行 Agent"""
    # Boss Agent 通过 structured output 返回:
    class HandOffsResponse(BaseModel):
        reasoning: str      # 选择理由
        agent_name: str     # 选中的 Agent
        task: Optional[str] # 可选的任务改写
```

**优势**：最灵活，可处理模糊意图
**不足**：增加 LLM 调用成本，决策可能不稳定

### 2.2 工具/Skill 的注册、发现和动态绑定

#### OpenAI Agents SDK 的工具系统

OpenAI Agents SDK 提供了三层工具绑定机制：

1. **静态工具绑定**：在 Agent 定义时通过 `tools` 列表直接指定
2. **MCP 动态工具**：通过 `mcp_servers` 在运行时从 MCP Server 动态获取工具列表
3. **条件启用/禁用**：通过 `is_enabled` 回调在运行时动态控制工具可见性

```python
# openai-agents-python: Agent.get_all_tools()
async def get_all_tools(self, run_context):
    mcp_tools = await self.get_mcp_tools(run_context)  # 动态 MCP 工具
    # 检查每个静态工具的 is_enabled 状态
    results = await asyncio.gather(*(_check_tool_enabled(t) for t in self.tools))
    enabled = [t for t, ok in zip(self.tools, results) if ok]
    return [*mcp_tools, *enabled]
```

#### Swarms 的工具系统

Swarms 提供了 `ToolStorage` 注册表：

```python
# swarms/tools/tool_registry.py
class ToolStorage:
    def add_tool(self, func: Callable) -> None: ...
    def get_tool(self, name: str) -> Callable: ...
    def list_tools(self) -> List[str]: ...
```

以及 MCP 客户端集成，支持运行时从 MCP Server 发现和调用工具。

### 2.3 MCP 在工具发现中的作用

Model Context Protocol (MCP) 是 Anthropic 于 2024 年推出的开放协议，已成为 AI Agent 工具集成的事实标准。2025 年 12 月，Anthropic 将 MCP 捐赠给 Linux Foundation 下的 Agentic AI Foundation (AAIF)。

**MCP 对我们场景的核心价值**：

1. **标准化接口**：不同企业系统（ERP、CRM、OA）可以通过 MCP Server 暴露操作接口，Agent 无需针对每个系统写集成代码
2. **动态工具发现**：MCP Client 可以在运行时发现 Server 上可用的工具，无需编译期绑定
3. **运行时工具更新**：当企业系统新增功能时，MCP Server 更新即可，Agent 端无需修改
4. **安全治理**：MCP 2025-11 规范引入了安全卡片、OAuth 2.0 等企业级安全机制

**November 2025 规范的关键升级**：
- 从同步工具调用扩展到支持安全的长时间运行工作流
- 引入 StreamableHTTP 传输，取代了旧的 SSE 传输
- 支持企业级的认证和授权机制

### 2.4 配置驱动 vs 自动发现的权衡

| 维度 | 配置驱动 | 自动发现 | 推荐策略 |
|------|---------|---------|---------|
| 确定性 | 高 -- 精确控制哪些模块可用 | 低 -- 可能发现不相关模块 | 核心业务逻辑用配置驱动 |
| 灵活性 | 低 -- 新模块需要改配置 | 高 -- 自动适应新模块 | 辅助能力用自动发现 |
| 安全性 | 高 -- 白名单机制 | 低 -- 需要额外的权限检查 | 敏感操作必须配置驱动 |
| 运维成本 | 高 -- 每个岗位要维护配置 | 低 -- 一次部署到处可用 | 两者结合 |

**推荐策略：分层混合**

```
Layer 1 (配置驱动): 岗位定义 -> 允许的 Agent 类型白名单
Layer 2 (半自动发现): 在白名单范围内，根据任务自动选择具体 Agent
Layer 3 (MCP 动态发现): 工具层面完全动态，Agent 运行时发现可用工具
```

---

## 3. OpenAI Agents SDK 源码分析

### 3.1 核心架构

OpenAI Agents SDK（位于 `/Volumes/leoyun/agentic/ref-repos/openai-agents-python/src/agents/`）是一个精简但设计精良的 Agent 框架，核心文件不超过 20 个。

**核心概念**：
- `Agent`：核心实体，包含 instructions、tools、handoffs、guardrails
- `Runner`：执行引擎，管理 Agent 运行循环
- `Handoff`：Agent 间的任务委派机制
- `Tool` / `FunctionTool`：工具抽象
- `Guardrail`：输入/输出安全检查
- `MCPServer` / `MCPServerManager`：MCP 协议集成

### 3.2 Agent 定义

```python
# src/agents/agent.py
@dataclass
class Agent(AgentBase, Generic[TContext]):
    instructions: str | Callable | None  # 支持动态 instructions
    handoffs: list[Agent | Handoff]      # 可委派的子 Agent
    tools: list[Tool]                    # 静态工具
    mcp_servers: list[MCPServer]         # MCP 动态工具源
    input_guardrails: list[InputGuardrail]   # 输入防护
    output_guardrails: list[OutputGuardrail] # 输出防护
    model: str | Model | None           # 可指定不同模型
    model_settings: ModelSettings        # 模型参数配置
    tool_use_behavior: ...               # 工具使用策略
    reset_tool_choice: bool = True       # 防止工具调用死循环
```

**关键设计亮点**：

1. **动态 Instructions**：`instructions` 可以是字符串，也可以是一个 `Callable[[RunContextWrapper, Agent], str]`，运行时动态生成。这对虚拟员工平台非常有价值 -- 同一个 Agent 可以根据不同的岗位上下文生成不同的指令。

2. **Agent as Tool**：`agent.as_tool()` 方法可以将一个 Agent 包装成工具给其他 Agent 调用。与 Handoff 的区别在于：Handoff 是"移交控制权"（新 Agent 接管对话），as_tool 是"委托执行"（原 Agent 获取结果后继续）。

3. **`clone()` 方法**：支持快速基于现有 Agent 创建变体，改变部分配置。适合"岗位模板"场景。

### 3.3 Handoff 机制

```python
# src/agents/handoffs/__init__.py
@dataclass
class Handoff(Generic[TContext, TAgent]):
    tool_name: str                # 作为工具呈现给 LLM
    tool_description: str         # LLM 看到的描述
    input_json_schema: dict       # 结构化输入
    on_invoke_handoff: Callable   # 执行回调
    input_filter: HandoffInputFilter | None  # 输入过滤
    is_enabled: bool | Callable   # 动态启用/禁用
```

Handoff 本质上是一个"特殊的工具"：LLM 决定要调用某个 Handoff 时，框架会：
1. 验证 Handoff 输入
2. 执行 `on_invoke_handoff` 回调
3. 将控制权交给目标 Agent
4. 目标 Agent 获得（可过滤的）对话历史

**关键特性**：
- `input_filter` 允许在 Handoff 时过滤/变换传递给下一个 Agent 的历史信息
- `is_enabled` 支持运行时动态启用/禁用（`Callable[[RunContextWrapper, Agent], bool]`）
- `nest_handoff_history` 控制是否嵌套历史，避免上下文窗口爆炸

### 3.4 Guardrails 设计

```python
# src/agents/guardrail.py
@dataclass
class InputGuardrail(Generic[TContext]):
    guardrail_function: Callable  # (context, agent, input) -> GuardrailFunctionOutput
    run_in_parallel: bool = True  # 可与 Agent 并行运行

@dataclass
class OutputGuardrail(Generic[TContext]):
    guardrail_function: Callable  # (context, agent, output) -> GuardrailFunctionOutput
```

Guardrails 分为输入和输出两种：
- **InputGuardrail**：检查用户输入是否合规，可与 Agent 并行执行（不阻塞响应速度）或串行执行（必须通过才执行）
- **OutputGuardrail**：检查 Agent 输出是否合规

`tripwire_triggered = True` 会立即中止 Agent 执行。这对企业场景至关重要 -- 确保 Agent 不会执行不合规的操作。

### 3.5 运行引擎

```python
# src/agents/run_config.py
DEFAULT_MAX_TURNS = 10  # 默认最大执行轮次
```

Runner 的核心循环：
1. 获取 Agent 的系统提示（支持动态生成）
2. 收集所有工具（静态 + MCP 动态）
3. 运行输入 Guardrails
4. 调用 LLM
5. 处理工具调用或 Handoff
6. 检查是否需要继续循环
7. 运行输出 Guardrails
8. `max_turns` 硬性限制防止无限循环

### 3.6 MCP 集成

```python
# src/agents/mcp/server.py - 支持多种传输方式
class MCPServerStdio(MCPServer): ...       # 标准 I/O
class MCPServerSse(MCPServer): ...          # SSE (旧版)
class MCPServerStreamableHttp(MCPServer): ... # StreamableHTTP (新版)

# src/agents/mcp/manager.py
class MCPServerManager:
    """管理多个 MCP Server 的生命周期"""
    async def connect_all(self) -> list[MCPServer]: ...
    async def reconnect(self, failed_only=True): ...
    # 支持并行连接、失败容错、自动重连
```

`MCPServerManager` 是生产级的 MCP 管理器，支持：
- 并行连接多个 Server
- 失败容错（`drop_failed_servers`）
- 自动重连
- 超时控制

### 3.7 与我们需求的适配度

| 需求 | 适配度 | 说明 |
|------|-------|------|
| Coordinator + 子 Agent | **高** | Handoff + as_tool 两种模式 |
| 动态加载子 Agent | **中** | `is_enabled` 支持动态启用，但 Handoff 列表是静态定义的 |
| 动态工具发现 | **高** | MCP 原生支持 |
| Guardrails | **高** | Input + Output 双层防护 |
| 成本控制 | **高** | `max_turns` + `reset_tool_choice` |
| 配置驱动部署 | **中** | Agent 是代码定义的，非配置驱动 |
| 共享上下文 | **高** | `TContext` 泛型上下文贯穿整个运行 |
| 审计日志 | **中** | 有 tracing 支持，但不是企业级审计 |

**核心优势**：设计精良、类型安全、MCP 原生支持、Guardrails 完善
**核心不足**：Agent 的定义和组装是代码级的，不支持纯配置驱动；Handoff 列表是静态的，不支持运行时发现新 Agent

---

## 4. Swarms 框架源码分析

### 4.1 核心架构

Swarms 框架（位于 `/Volumes/leoyun/agentic/ref-repos/swarms/swarms/`）是一个"大而全"的多 Agent 框架，提供了 **16+ 种** 不同的 Swarm 编排模式。

**核心目录结构**：
- `structs/`：所有 Swarm 编排结构（SwarmRouter, HierarchicalSwarm, MixtureOfAgents 等）
- `agents/`：特殊 Agent 类型（JudgeAgent, ReActAgent 等）
- `tools/`：工具系统（ToolRegistry, MCP 客户端等）
- `prompts/`：提示词模板

### 4.2 多 Agent 编排方式

Swarms 通过 `SwarmRouter` 统一入口路由到不同的编排策略：

```python
# swarms/structs/swarm_router.py
SwarmType = Literal[
    "AgentRearrange",       # 动态重排
    "MixtureOfAgents",      # 混合专家
    "SequentialWorkflow",   # 顺序流
    "ConcurrentWorkflow",   # 并发流
    "GroupChat",            # 群聊
    "MultiAgentRouter",     # 多 Agent 路由
    "AutoSwarmBuilder",     # 自动构建
    "HierarchicalSwarm",   # 层级式
    "MajorityVoting",      # 多数投票
    "CouncilAsAJudge",     # 委员会评审
    "HeavySwarm",          # 重型 Swarm
    "RoundRobin",          # 轮询
    ...
]
```

**`SwarmRouter` 的 `auto` 模式**是最接近我们需求的功能：由 LLM 根据任务自动选择最优的 Swarm 类型。

**`AgentRearrange`** 提供了灵活的流程定义语法：

```python
# 顺序执行
flow = "researcher -> writer -> reviewer"
# 并发执行
flow = "analyst1, analyst2, analyst3 -> aggregator"
# 混合
flow = "researcher -> writer, reviewer -> editor"
# 人在回路
flow = "agent1 -> H -> agent2"
```

这个 flow DSL 非常适合虚拟员工平台的流程定义。

### 4.3 动态工具加载

**DynamicSkillsLoader**：基于文件系统的技能发现

```python
# swarms/structs/dynamic_skills_loader.py
# 技能以 SKILL.md 文件形式存储，包含 YAML 前置数据
# 运行时通过文本相似度匹配最相关的技能
loader = DynamicSkillsLoader(skills_dir="/path/to/skills")
relevant = loader.load_relevant_skills("审批报销单")
```

**AutoSwarmBuilder**：LLM 驱动的自动 Agent 构建

```python
# swarms/structs/auto_swarm_builder.py
# Boss Agent 自动设计 Agent 团队的角色、提示词和编排方式
class AutoSwarmBuilder:
    """LLM 分析任务 -> 设计 Agent 规格 -> 创建 Agent 实例 -> 执行"""
```

`AutoSwarmBuilder` 的 `BOSS_SYSTEM_PROMPT` 是一个精心设计的元提示词，引导 LLM 进行多 Agent 系统设计，包括：
- 任务分解
- Agent 角色设计（含人格、专长、限制）
- 通信协议
- 质量保证机制

### 4.4 MCP 集成

```python
# swarms/tools/mcp_client_tools.py
async def load_mcp_tools(session, format="openai"):
    """从 MCP Server 加载工具并转换为 OpenAI 格式"""

def transform_mcp_tool_to_openai_tool(mcp_tool):
    """MCP Tool -> OpenAI ChatCompletionToolParam"""
```

Swarms 的 MCP 集成更偏向"工具调用"层面，将 MCP 工具转换为 OpenAI function calling 格式。

### 4.5 与我们需求的适配度

| 需求 | 适配度 | 说明 |
|------|-------|------|
| Coordinator + 子 Agent | **高** | HierarchicalSwarm 原生支持 |
| 动态加载子 Agent | **高** | AutoSwarmBuilder + DynamicSkillsLoader |
| 动态工具发现 | **中** | MCP 支持但不如 OpenAI SDK 成熟 |
| Guardrails | **低** | 没有原生 Guardrails 机制 |
| 成本控制 | **中** | `max_loops` 参数但缺乏精细控制 |
| 配置驱动部署 | **高** | YAML 配置创建 Agent（`create_agents_from_yaml`） |
| 共享上下文 | **高** | `Conversation` 类贯穿全流程 |
| 审计日志 | **中** | 有基础日志但非企业级 |

**核心优势**：编排模式丰富、动态构建能力强、配置驱动、flow DSL 灵活
**核心不足**：代码质量参差不齐、缺乏 Guardrails、类型安全性弱、部分实现偏粗糙

---

## 5. 推荐架构设计

### 5.1 整体架构：Dynamic Hierarchical MoE

基于前述分析，推荐一个**三层架构**：

```
┌────────────────────────────────────────────────────────────┐
│                    Virtual Employee Platform                 │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │            Layer 1: Employee Gateway                  │   │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│  │  │ Task     │  │ Employee     │  │ Session &    │   │   │
│  │  │ Intake   │->│ Registry     │->│ Context Mgr  │   │   │
│  │  │ API      │  │ (Config-     │  │              │   │   │
│  │  │          │  │  Driven)     │  │              │   │   │
│  │  └──────────┘  └──────────────┘  └──────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Layer 2: Coordinator Agent (per Employee)     │   │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│  │  │ Intent   │  │ Dynamic      │  │ Execution    │   │   │
│  │  │ Parser & │->│ Agent        │->│ Orchestrator │   │   │
│  │  │ Planner  │  │ Selector     │  │              │   │   │
│  │  │          │  │ (MoE Gate)   │  │              │   │   │
│  │  └──────────┘  └──────────────┘  └──────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │          Layer 3: Sub-Agent Pool (Shared)             │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────┐   │   │
│  │  │Approval│ │Data    │ │Report  │ │Communication│   │   │
│  │  │Agent   │ │Entry   │ │Gen     │ │Agent        │   │   │
│  │  │        │ │Agent   │ │Agent   │ │(Email/IM)   │   │   │
│  │  └────┬───┘ └────┬───┘ └────┬───┘ └─────┬──────┘   │   │
│  │       │          │          │            │           │   │
│  │  ┌────┴──────────┴──────────┴────────────┴──────┐   │   │
│  │  │        MCP Tool Layer (Dynamic Discovery)     │   │   │
│  │  │  [ERP] [OA] [CRM] [Email] [Calendar] [DB]   │   │   │
│  │  └──────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Cross-Cutting Concerns                    │   │
│  │  [Guardrails] [Audit Log] [Cost Monitor] [Rules DB] │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

### 5.2 Coordinator 的路由决策机制

Coordinator 采用**两阶段决策**：

**阶段一：确定性规则匹配（零 LLM 调用）**

```python
class CoordinatorRouter:
    def __init__(self, rules_engine: RulesEngine, agent_pool: AgentPool):
        self.rules_engine = rules_engine
        self.agent_pool = agent_pool

    async def route(self, task: TaskRequest, context: EmployeeContext) -> RoutingDecision:
        # 阶段一：规则匹配
        rule_match = self.rules_engine.match(task, context)
        if rule_match.is_deterministic:
            return RoutingDecision(
                agents=rule_match.agents,
                flow=rule_match.flow,
                confidence=1.0,
                source="rules"
            )

        # 阶段二：LLM 动态路由
        return await self._llm_route(task, context, rule_match.hints)
```

**规则引擎示例**：
```yaml
# employee_config/approval_clerk.yaml
rules:
  - trigger:
      intent: "expense_approval"
      keywords: ["报销", "费用审批", "expense"]
    action:
      agents: ["approval_agent"]
      flow: "approval_agent"
      deterministic: true
  - trigger:
      intent: "data_entry"
      keywords: ["录入", "填写", "表单"]
    action:
      agents: ["data_entry_agent"]
      flow: "data_entry_agent"
      deterministic: true
```

**阶段二：LLM 动态路由（仅当规则无法匹配时）**

```python
async def _llm_route(self, task, context, hints):
    available_agents = self.agent_pool.get_enabled_agents(context.role)
    agent_descriptions = [
        {"name": a.name, "capabilities": a.description, "cost_tier": a.cost_tier}
        for a in available_agents
    ]

    # LLM 决策，使用 structured output 确保输出格式
    decision = await self.llm.create(
        model="gpt-4.1-mini",  # 用小模型做路由以控制成本
        response_format=RoutingDecision,
        messages=[
            {"role": "system", "content": ROUTING_SYSTEM_PROMPT},
            {"role": "user", "content": f"Task: {task}\nAgents: {agent_descriptions}\nHints: {hints}"}
        ]
    )
    return decision
```

**核心设计原则**：确定性业务规则优先，LLM 仅处理模糊情况。这确保了关键业务流程不会被 LLM 的"创造力"覆盖。

### 5.3 子 Agent 上下文共享机制

采用 **Scoped Context（作用域上下文）** 设计：

```python
@dataclass
class SharedContext:
    """所有 Agent 共享的只读上下文"""
    task_id: str
    employee_role: str
    business_rules: dict          # 当前岗位的业务规则
    session_metadata: dict        # 会话元数据
    audit_trail: list[AuditEntry] # 审计日志（append-only）

@dataclass
class AgentLocalContext:
    """每个 Agent 独有的可变状态"""
    agent_name: str
    local_state: dict            # Agent 私有状态
    tool_results: list           # 工具调用结果
    iteration_count: int         # 当前迭代次数

@dataclass
class TaskContext:
    """组合上下文 -- 传给每个 Agent"""
    shared: SharedContext        # 共享只读
    local: AgentLocalContext     # 私有可变
    inbox: MessageQueue          # 从其他 Agent 接收的消息
    outbox: MessageQueue         # 发送给其他 Agent 的消息
```

**隔离机制**：
- `SharedContext` 是不可变的（frozen dataclass 或只读属性），Agent 无法互相污染
- `AgentLocalContext` 是每个 Agent 独有的，即使并发执行也不会冲突
- `audit_trail` 是 append-only 的，提供完整的执行追踪
- Agent 间通信通过 `inbox/outbox` 消息队列，而非直接修改对方状态

### 5.4 确定性业务规则保障

这是企业场景中最关键的问题之一：**如何确保 LLM 不会"创新"地绕过业务规则**。

推荐**三层防护**：

```
Layer 1: Pre-Execution Guardrails（执行前）
  ├── InputGuardrail: 检查输入是否在允许范围内
  ├── Rules Validator: 验证 LLM 的决策是否符合业务规则
  └── Permission Check: 验证 Agent 是否有权执行此操作

Layer 2: In-Execution Constraints（执行中）
  ├── Tool-Level Validation: 工具参数校验（不依赖 LLM）
  ├── Max Turns: 强制最大迭代次数
  └── Cost Budget: Token/API 调用预算限制

Layer 3: Post-Execution Guardrails（执行后）
  ├── OutputGuardrail: 检查输出是否合规
  ├── Business Rule Assertion: 硬编码的业务断言
  └── Human Review Flag: 超出置信度阈值时标记人工审核
```

**关键实现原则**：

```python
# 确定性规则绝不通过 LLM 执行
class ApprovalAgent:
    async def approve(self, request: ApprovalRequest) -> ApprovalResult:
        # Step 1: 硬编码的业务规则检查（不经过 LLM）
        if request.amount > self.config.auto_approve_limit:
            return ApprovalResult(
                status="pending_human_review",
                reason=f"金额 {request.amount} 超过自动审批限额 {self.config.auto_approve_limit}"
            )

        # Step 2: LLM 仅用于理解发票内容、分类等"软"判断
        classification = await self.llm_classify(request.invoice_content)

        # Step 3: 分类结果再次通过硬编码规则验证
        if classification.category not in self.config.allowed_categories:
            return ApprovalResult(status="rejected", reason="不在允许的费用类别中")

        return ApprovalResult(status="approved")
```

### 5.5 配置驱动的新岗位部署

设计一个**岗位配置规范**：

```yaml
# employee_definitions/expense_clerk.yaml
apiVersion: v1
kind: VirtualEmployee
metadata:
  name: "expense-clerk"
  display_name: "报销审批员"
  department: "财务部"
  version: "1.2.0"

spec:
  coordinator:
    model: "gpt-4.1-mini"              # Coordinator 用小模型
    instructions_template: "expense_coordinator"
    max_turns: 5
    cost_budget_per_task: 0.50          # 每任务最大花费（美元）

  agent_pool:
    allowed_agents:                     # 白名单
      - name: "approval_agent"
        config:
          auto_approve_limit: 5000
          allowed_categories: ["差旅", "办公用品", "餐饮"]
      - name: "data_entry_agent"
        config:
          target_system: "SAP"
          validation_rules: "expense_validation_v2"
      - name: "notification_agent"
        config:
          channels: ["email", "teams"]

  tools:
    mcp_servers:
      - url: "https://mcp.internal/sap-erp"
        auth: "oauth2"
      - url: "https://mcp.internal/email"
        auth: "api_key"
    static_tools: []

  guardrails:
    input:
      - name: "pii_filter"
        action: "redact"
      - name: "scope_check"
        action: "reject_if_out_of_scope"
    output:
      - name: "amount_limit_check"
        action: "flag_for_review"
    rules:
      - "金额超过 10000 元必须二级审批"
      - "差旅费用必须附带出差申请单号"

  routing_rules:
    - trigger: { keywords: ["报销", "expense"] }
      action: { agents: ["approval_agent"], deterministic: true }
    - trigger: { keywords: ["录入", "entry"] }
      action: { agents: ["data_entry_agent"], deterministic: true }
    - trigger: { default: true }
      action: { llm_route: true }
```

**部署新岗位的流程**：
1. 编写 YAML 配置文件
2. 引用已有的 Agent 模板和工具
3. 定义岗位特有的业务规则和 Guardrails
4. 通过 API 或 CLI 部署：`vep deploy expense_clerk.yaml`
5. 系统自动创建 Coordinator、绑定 Agent Pool、连接 MCP Servers

### 5.6 成本控制：防止 Agent Loop 无限迭代

**多层成本控制策略**：

```python
@dataclass
class CostPolicy:
    max_turns_per_task: int = 10            # 单任务最大轮次
    max_llm_calls_per_turn: int = 3         # 单轮最大 LLM 调用
    max_tokens_per_task: int = 50000        # 单任务最大 Token
    max_cost_per_task_usd: float = 1.0      # 单任务最大花费
    max_tool_calls_per_task: int = 20       # 单任务最大工具调用
    cooldown_between_turns_ms: int = 100    # 轮次间冷却时间

class CostMonitor:
    def __init__(self, policy: CostPolicy):
        self.policy = policy
        self.current_turns = 0
        self.current_tokens = 0
        self.current_cost = 0.0
        self.current_tool_calls = 0

    def check_budget(self) -> BudgetStatus:
        if self.current_turns >= self.policy.max_turns_per_task:
            return BudgetStatus.EXCEEDED_TURNS
        if self.current_cost >= self.policy.max_cost_per_task_usd:
            return BudgetStatus.EXCEEDED_COST
        if self.current_tokens >= self.policy.max_tokens_per_task:
            return BudgetStatus.EXCEEDED_TOKENS
        return BudgetStatus.OK

    def on_llm_call(self, tokens_used: int, cost: float):
        self.current_tokens += tokens_used
        self.current_cost += cost
        status = self.check_budget()
        if status != BudgetStatus.OK:
            raise BudgetExceededException(status)
```

**附加策略**：
- **循环检测**：如果 Agent 连续 3 次输出相似内容（cosine similarity > 0.95），强制终止
- **工具调用去重**：同一工具同样参数不重复调用
- **分级模型**：Coordinator 用 gpt-4.1-mini，仅在复杂任务时升级到 gpt-4.1
- **缓存层**：对确定性查询（如"查询审批状态"）缓存结果
- **异步限流**：使用 token bucket 算法限制并发 LLM 调用

### 5.7 技术选型建议

**推荐方案：以 OpenAI Agents SDK 为核心，借鉴 Swarms 的编排理念，自建上层框架**

```
自建框架层（Virtual Employee Platform）
  ├── 岗位配置系统（YAML -> Employee 实例化）
  ├── 规则引擎（确定性路由 + 业务规则校验）
  ├── 成本控制器（预算 + 限流 + 循环检测）
  ├── 审计日志（结构化的完整执行追踪）
  └── Agent 模板库（可复用的子 Agent 定义）

OpenAI Agents SDK（核心运行时）
  ├── Agent 定义和执行
  ├── Handoff / as_tool 机制
  ├── Guardrails
  ├── MCP 集成
  └── Tracing

MCP Layer（工具集成）
  ├── ERP MCP Server
  ├── OA MCP Server
  ├── Email MCP Server
  └── ... 按需扩展
```

**不推荐直接使用 Swarms 的原因**：
1. 代码质量不够稳定（部分实现有大量 TODO）
2. 缺乏 Guardrails 机制（企业场景必需）
3. 类型安全性弱（大量 Any 类型）
4. 过于庞大，很多编排模式我们不需要

**但应该借鉴 Swarms 的**：
1. `AgentRearrange` 的 flow DSL 语法（`->` 和 `,` 的组合）
2. `DynamicSkillsLoader` 的技能发现模式
3. `AutoSwarmBuilder` 的 LLM 驱动 Agent 设计理念
4. YAML 配置驱动的 Agent 创建

### 5.8 多 Agent 协作机制深度设计

> 本节针对多 Agent 协作中的三个核心问题——**共识共享**、**动态任务管理**、**通信与委派**——进行深度设计。所有设计均基于 Dynamic Hierarchical MoE 架构，并参考 OpenAI Agents SDK（RunContextWrapper、Handoff 机制）、Swarms（Conversation、MultiAgentRouter、GroupChat）以及 pi-agent-core（steering/followUp 消息注入机制）的源码实现。

---

#### 5.8.1 共识分层模型

##### 5.8.1.1 设计原理

在分布式系统中，共享状态管理有两个极端：**shared-everything**（所有节点看到完全一致的全局状态）和 **shared-nothing**（每个节点完全独立）。对于 Agent Swarm 场景，两者都不适合：

- **shared-everything** 的问题：所有 Agent 共享全部上下文会导致 token 浪费、上下文污染（一个 Agent 的中间推理过程干扰另一个 Agent 的判断）、以及隐私泄露（某些 Agent 不应看到其他 Agent 处理的敏感数据）。
- **shared-nothing** 的问题：Agent 之间完全隔离会导致信息不协调——Agent A 已经确认了客户信息，Agent B 又重新去问一遍，浪费时间且体验差。

我们采用 **分层共识模型（Layered Consensus Model）**，将共享信息分为四个层次，每个层次有不同的可见性、可变性和同步策略。

核心原则是：**最小知情原则**（Need-to-Know Basis）—— 每个 Agent 只看到完成其任务所需的最少信息。

##### 5.8.1.2 四层共识架构

```
┌──────────────────────────────────────────────────────────┐
│  Layer 0: Global Immutable Context（全局不可变上下文）      │
│  ── 所有 Agent 只读，Swarm 生命周期内不变                    │
│  ── 员工身份、岗位配置、基础业务规则、合规约束                │
├──────────────────────────────────────────────────────────┤
│  Layer 1: Task-Level Shared State（任务级共享状态）          │
│  ── 参与同一任务的 Agent 可读，Coordinator 可写              │
│  ── 当前任务目标、客户上下文、审批状态、阶段性成果              │
├──────────────────────────────────────────────────────────┤
│  Layer 2: Agent-Scoped Context（Agent 作用域上下文）         │
│  ── 仅当前 Agent 可读写                                     │
│  ── 中间推理过程、工具调用详情、临时缓存、私有工作记忆          │
├──────────────────────────────────────────────────────────┤
│  Layer 3: Message Bus（消息总线）                            │
│  ── 定向传递，发送方和接收方可见                              │
│  ── Agent 间委派请求、结果反馈、事件通知                      │
└──────────────────────────────────────────────────────────┘
```

##### 5.8.1.3 每个层次的具体内容清单

**Layer 0: 全局不可变上下文**

| 内容 | 说明 | 示例 |
|------|------|------|
| `employeeId` | 虚拟员工唯一标识 | `"expense-clerk-001"` |
| `role` | 岗位角色 | `"报销审批员"` |
| `department` | 所属部门 | `"财务部"` |
| `businessRules` | 业务规则（只读快照） | `{ autoApproveLimit: 5000, ... }` |
| `complianceConstraints` | 合规约束 | `["金额>10000需二级审批"]` |
| `allowedAgents` | 可用 Agent 白名单 | `["approval_agent", "data_entry_agent"]` |
| `allowedTools` | 可用工具白名单 | `["erp_query", "email_send"]` |
| `costBudget` | 成本预算 | `{ maxTokens: 50000, maxCost: 1.0 }` |

**Layer 1: 任务级共享状态**

| 内容 | 说明 | 可变性 | 写入者 |
|------|------|--------|--------|
| `taskId` | 任务唯一标识 | 不可变 | System |
| `taskGoal` | 任务目标自然语言描述 | 不可变 | User/System |
| `taskStatus` | 任务当前状态 | 可变 | Coordinator |
| `priority` | 任务优先级 | 可变 | Coordinator |
| `customerContext` | 客户相关信息 | 可追加 | Any Agent |
| `approvalState` | 审批状态机 | 可变 | Approval Agent |
| `stageResults` | 各阶段产出 | 可追加 | Sub-Agents |
| `humanEscalation` | 人工升级状态 | 可变 | System |
| `auditTrail` | 审计日志 | 只追加 | All (自动) |

**Layer 2: Agent 作用域上下文**

| 内容 | 说明 | 是否传递给后续 Agent |
|------|------|---------------------|
| 中间推理链 (chain-of-thought) | Agent 的内部推理过程 | 否 |
| 工具调用原始请求/响应 | API 调用的完整 I/O | 否（仅结果摘要传递） |
| 临时变量和缓存 | 计算中间值 | 否 |
| 迭代计数和重试状态 | 内部循环控制 | 否 |
| LLM 对话历史 | 与 LLM 的完整交互 | 否（仅最终输出传递） |

**Layer 3: 消息总线**

| 消息类型 | 方向 | 内容 |
|----------|------|------|
| `TaskDelegation` | Coordinator → Sub-Agent | 任务描述 + 所需上下文切片 |
| `TaskResult` | Sub-Agent → Coordinator | 结构化结果 + 置信度 + 摘要 |
| `ContextUpdate` | Any → Coordinator → All | 共享状态更新事件 |
| `PriorityChange` | System → Coordinator | 优先级调整通知 |
| `SteeringMessage` | User/System → Active Agent | 运行中注入的指导信息 |

##### 5.8.1.4 TypeScript 伪代码实现

```typescript
// ========== Layer 0: 全局不可变上下文 ==========
interface GlobalImmutableContext {
  readonly employeeId: string;
  readonly role: string;
  readonly department: string;
  readonly businessRules: Readonly<BusinessRules>;
  readonly complianceConstraints: readonly string[];
  readonly allowedAgents: readonly string[];
  readonly allowedTools: readonly string[];
  readonly costBudget: Readonly<CostBudget>;
}

// ========== Layer 1: 任务级共享状态 ==========
interface TaskSharedState {
  readonly taskId: string;
  readonly taskGoal: string;
  taskStatus: TaskStatus;  // Coordinator 可修改
  priority: Priority;
  customerContext: CustomerContext;       // 可追加
  approvalState: ApprovalStateMachine;   // 状态机
  stageResults: StageResult[];           // append-only
  humanEscalation: EscalationState | null;
  auditTrail: AuditEntry[];             // append-only
}

// 通过 Proxy 实现写入控制
function createTaskSharedState(
  initial: TaskSharedState,
  writerId: string,  // 写入者标识
  writePolicy: WritePolicy
): TaskSharedState {
  return new Proxy(initial, {
    set(target, prop, value) {
      // 检查写入权限
      if (!writePolicy.canWrite(writerId, prop as string)) {
        throw new PermissionError(
          `Agent ${writerId} cannot write to ${String(prop)}`
        );
      }
      // append-only 字段只允许追加
      if (writePolicy.isAppendOnly(prop as string)) {
        if (!Array.isArray(target[prop as keyof TaskSharedState])) {
          throw new TypeError(`${String(prop)} is not an array`);
        }
        (target[prop as keyof TaskSharedState] as any[]).push(value);
        return true;
      }
      // 记录审计日志
      target.auditTrail.push({
        timestamp: Date.now(),
        agent: writerId,
        field: prop as string,
        oldValue: target[prop as keyof TaskSharedState],
        newValue: value,
      });
      (target as any)[prop] = value;
      return true;
    }
  });
}

// ========== Layer 2: Agent 私有上下文 ==========
interface AgentLocalContext {
  agentName: string;
  agentType: string;
  localState: Map<string, any>;     // 私有键值存储
  toolCallHistory: ToolCallRecord[]; // 工具调用记录
  iterationCount: number;
  retryCount: number;
  startedAt: number;
}

// ========== 组合上下文：传递给每个 Agent 的视图 ==========
interface AgentContextView {
  // Layer 0 - 完整只读
  readonly global: GlobalImmutableContext;
  // Layer 1 - 按需投影（只看到需要的字段）
  readonly task: Readonly<Partial<TaskSharedState>>;
  // Layer 2 - 完全可写
  local: AgentLocalContext;
  // Layer 3 - 消息收发
  inbox: AsyncIterable<AgentMessage>;
  send: (target: string, message: AgentMessage) => Promise<void>;
}

// ========== 上下文工厂：为不同 Agent 创建不同的上下文视图 ==========
class ContextFactory {
  constructor(
    private globalCtx: GlobalImmutableContext,
    private taskState: TaskSharedState,
  ) {}

  createViewForAgent(
    agentName: string,
    agentType: string,
    /** 该 Agent 需要看到的 task 字段列表 */
    taskFieldsNeeded: (keyof TaskSharedState)[],
    messageBus: MessageBus,
  ): AgentContextView {
    // 投影 task state：只暴露所需字段
    const taskProjection = {} as Partial<TaskSharedState>;
    for (const field of taskFieldsNeeded) {
      (taskProjection as any)[field] = this.taskState[field];
    }

    return {
      global: Object.freeze({ ...this.globalCtx }),
      task: Object.freeze(taskProjection),
      local: {
        agentName,
        agentType,
        localState: new Map(),
        toolCallHistory: [],
        iterationCount: 0,
        retryCount: 0,
        startedAt: Date.now(),
      },
      inbox: messageBus.subscribe(agentName),
      send: (target, msg) => messageBus.publish(agentName, target, msg),
    };
  }
}
```

##### 5.8.1.5 共享信息的一致性保证

在 Agent Swarm 中，我们采用 **最终一致性 + 事件通知** 的模型，而非强一致性。原因是：

1. Agent 是异步执行的，强一致性锁会导致性能瓶颈
2. LLM 推理本身具有不确定性，强一致性的投入产出比不高
3. 大多数场景下，最终一致性加上事件通知已经足够

**一致性策略**：

```typescript
// 状态更新通过 Coordinator 中转，保证序列化
class TaskStateManager {
  private state: TaskSharedState;
  private subscribers: Map<string, (update: StateUpdate) => void> = new Map();
  private updateQueue: StateUpdate[] = [];
  private processing = false;

  /** 提交状态更新（入队串行处理） */
  async submitUpdate(update: StateUpdate): Promise<void> {
    this.updateQueue.push(update);
    if (!this.processing) {
      await this.processQueue();
    }
  }

  /** 串行处理更新队列，保证顺序一致性 */
  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.updateQueue.length > 0) {
      const update = this.updateQueue.shift()!;
      // 验证更新合法性
      if (!this.validateUpdate(update)) {
        update.onReject?.(new ValidationError(update));
        continue;
      }
      // 应用更新
      this.applyUpdate(update);
      // 通知所有订阅者
      for (const [agentName, callback] of this.subscribers) {
        if (this.shouldNotify(agentName, update)) {
          callback(update);
        }
      }
      update.onApply?.();
    }
    this.processing = false;
  }

  /** 判断某个 Agent 是否需要收到此更新通知 */
  private shouldNotify(agentName: string, update: StateUpdate): boolean {
    // 只通知关注此字段的 Agent
    const agentConfig = this.getAgentConfig(agentName);
    return agentConfig.watchedFields.includes(update.field);
  }
}
```

**什么时候 Agent B 能看到 Agent A 的更新？**

- **同步场景**（Agent A 完成后 Agent B 才开始）：Agent B 获取上下文时，已经包含最新状态。
- **并发场景**（Agent A 和 Agent B 同时执行）：Agent A 提交更新后，Coordinator 通过 `steeringMessage` 机制向 Agent B 注入更新通知。Agent B 在下一个 tool execution 检查点处看到更新。
- **关键状态变更**（如审批被拒绝）：通过 `AbortSignal` 直接中断正在执行的 Agent，重新调度。

##### 5.8.1.6 场景示例：采购审批流程

```
场景：员工提交了一笔 8000 元的差旅报销

Step 1: 用户提交 → Coordinator 接收
  Layer 0 (已有): { autoApproveLimit: 5000, allowedCategories: ["差旅","办公"] }
  Layer 1 (创建): { taskId: "t-001", taskGoal: "审批差旅报销8000元", priority: NORMAL }

Step 2: Coordinator 路由 → Approval Agent
  Coordinator 为 Approval Agent 创建上下文视图:
    - global: 完整（含 autoApproveLimit=5000）
    - task: { taskId, taskGoal, customerContext, approvalState }  // 只投影需要的字段
    - local: 空（新创建）

Step 3: Approval Agent 执行
  - 调用工具查询发票详情 → 结果存入 local.toolCallHistory（私有）
  - 判断金额 8000 > 5000 → 需要主管审批
  - 更新 Layer 1: approvalState = PENDING_MANAGER_REVIEW
  - 写入 stageResults: { agent: "approval", result: "需主管审批", confidence: 1.0 }

Step 4: Coordinator 收到更新 → 委派 Notification Agent
  Notification Agent 的上下文视图:
    - task: { taskId, taskGoal, approvalState }  // 不需要看到发票详情
    - 不需要看到 Approval Agent 的工具调用历史（Layer 2 隔离）

Step 5: 主管审批通过 → 系统注入 SteeringMessage
  Layer 1 更新: approvalState = MANAGER_APPROVED
  Coordinator 调度 Data Entry Agent 将审批结果录入 ERP
```

##### 5.8.1.7 与现有框架的对比

| 特性 | OpenAI Agents SDK | Swarms | 我们的设计 |
|------|-------------------|--------|-----------|
| 共享机制 | `TContext` 泛型对象，所有 Agent 共享同一个引用 | `Conversation` 全局对话历史 | 四层分级，按需投影 |
| 隔离性 | 弱 — 所有 Agent 看到相同的 Context | 弱 — 全局 Conversation | 强 — Layer 2 完全隔离 |
| 写入控制 | 无 — 任何 Agent 可修改 Context | 无 — 任何 Agent 可 add 到 Conversation | 有 — Proxy + WritePolicy |
| 一致性 | 无保证（共享引用，并发不安全） | 无保证 | 事件驱动 + 串行更新队列 |
| 上下文过滤 | `HandoffInputFilter` 可过滤历史 | 无 | `ContextFactory.createViewForAgent` 按需投影 |
| 审计 | Tracing（可选） | 基础日志 | `auditTrail` append-only + 每次写入记录 |

---

#### 5.8.2 动态任务管理与优先级调度

##### 5.8.2.1 设计原理

虚拟员工与人类员工一样，需要处理多任务并发、紧急插入和优先级调整。关键挑战在于：

1. **LLM 调用是"黑盒"长时操作**：一次 LLM 推理可能需要 2-30 秒，无法像操作系统线程一样毫秒级抢占。
2. **Agent 执行有"检查点"**：tool execution 之间是天然的检查点（参考 pi-agent-core 的 `getSteeringMessages` 实现）。
3. **状态恢复比进程恢复更复杂**：Agent 的"工作记忆"包含 LLM 对话历史，恢复时需要重建上下文。

因此，我们不追求操作系统式的抢占式调度，而是采用 **协作式调度 + 检查点注入** 的模型。

##### 5.8.2.2 任务优先级模型

```typescript
/** 优先级维度 */
interface PriorityDimensions {
  /** 时间紧迫度：截止时间距现在的时间差 */
  urgency: number;         // 0-100, 越高越紧急
  /** 业务影响：金额大小、涉及客户等级 */
  impact: number;          // 0-100
  /** 来源权重：直接上级 > 系统触发 > 常规请求 */
  sourceWeight: number;    // 0-100
  /** 等待时间：任务已等待多久（防止饥饿） */
  waitingPenalty: number;  // 随时间增长
}

/** 综合优先级计算 */
function calculatePriority(dims: PriorityDimensions): number {
  // 加权公式，可通过配置调整权重
  return (
    dims.urgency * 0.35 +
    dims.impact * 0.30 +
    dims.sourceWeight * 0.20 +
    dims.waitingPenalty * 0.15
  );
}

/** 预定义优先级等级 */
enum PriorityLevel {
  CRITICAL = 4,   // 系统故障、安全事件 → 立即中断一切
  HIGH = 3,       // 紧急审批、VIP客户 → 暂停当前低优先级任务
  NORMAL = 2,     // 常规业务请求
  LOW = 1,        // 定时任务、报告生成
  BACKGROUND = 0, // 数据清洗、统计汇总
}

/** 任务定义 */
interface Task {
  id: string;
  goal: string;
  priority: PriorityLevel;
  priorityScore: number;     // 精确分数，同级别内排序用
  createdAt: number;
  deadline?: number;          // 截止时间
  status: TaskStatus;
  /** 当前执行到哪一步（用于恢复） */
  checkpoint?: TaskCheckpoint;
  /** 所需资源（Agent 类型） */
  requiredAgents: string[];
  /** 被哪个任务暂停的 */
  preemptedBy?: string;
}

type TaskStatus =
  | 'queued'        // 等待执行
  | 'running'       // 正在执行
  | 'suspended'     // 被暂停（可恢复）
  | 'completed'     // 完成
  | 'failed'        // 失败
  | 'cancelled';    // 取消
```

##### 5.8.2.3 动态任务插入机制

结合 pi-agent-core 的 `getSteeringMessages` 和 `getFollowUpMessages` 机制，设计以下方案：

```typescript
/**
 * 任务调度器 — Coordinator 的核心组件
 *
 * 参考 pi-agent-core 的双层循环设计：
 * - 外层循环：followUp 机制处理新任务到达
 * - 内层循环：steering 机制注入运行时更新
 */
class TaskScheduler {
  private taskQueue: PriorityQueue<Task>;
  private runningTasks: Map<string, RunningTask> = new Map();
  private suspendedTasks: Map<string, SuspendedTask> = new Map();

  /** 新任务到达 */
  async submitTask(task: Task): Promise<void> {
    // 计算优先级分数
    task.priorityScore = calculatePriority({
      urgency: this.calculateUrgency(task),
      impact: this.calculateImpact(task),
      sourceWeight: task.sourceWeight ?? 50,
      waitingPenalty: 0,
    });

    // 检查是否需要抢占
    if (task.priority >= PriorityLevel.HIGH) {
      await this.tryPreempt(task);
    }

    this.taskQueue.enqueue(task);
    await this.scheduleNext();
  }

  /** 尝试抢占低优先级任务 */
  private async tryPreempt(newTask: Task): Promise<void> {
    // 找到优先级最低的正在运行的任务
    const lowestRunning = this.findLowestPriorityRunning();
    if (!lowestRunning) return;

    // 只在优先级差距足够大时才抢占（避免频繁切换）
    if (newTask.priority - lowestRunning.task.priority < 2) return;

    // 向正在运行的 Agent 发送暂停信号
    // 参考 pi-agent-core: 通过 steeringMessages 注入中断指令
    await this.suspendTask(lowestRunning);
  }

  /** 暂停任务：利用 steering 机制 */
  private async suspendTask(running: RunningTask): Promise<void> {
    // 1. 保存当前检查点
    const checkpoint = await running.captureCheckpoint();

    // 2. 通过 steering 注入暂停指令
    //    在 pi-agent-core 中，getSteeringMessages 在每次 tool execution 后被调用
    //    我们利用这个检查点注入暂停信号
    running.steeringQueue.push({
      type: 'system_directive',
      content: 'TASK_SUSPENDED: 当前任务已被更高优先级任务暂停，请保存工作状态。',
      directive: 'suspend',
    });

    // 3. 等待 Agent 到达下一个检查点并暂停
    await running.waitForSuspension();

    // 4. 记录暂停状态
    this.suspendedTasks.set(running.task.id, {
      task: { ...running.task, status: 'suspended', preemptedBy: 'incoming' },
      checkpoint,
      suspendedAt: Date.now(),
    });

    this.runningTasks.delete(running.task.id);
  }

  /** 恢复被暂停的任务 */
  async resumeTask(taskId: string): Promise<void> {
    const suspended = this.suspendedTasks.get(taskId);
    if (!suspended) return;

    // 从检查点恢复
    // 使用 pi-agent-core 的 agentLoopContinue 从保存的上下文继续
    const restoredContext = this.rebuildContextFromCheckpoint(
      suspended.checkpoint
    );

    // 重新提交到任务队列
    suspended.task.status = 'queued';
    this.taskQueue.enqueue(suspended.task);
    this.suspendedTasks.delete(taskId);

    await this.scheduleNext();
  }
}
```

##### 5.8.2.4 任务暂停与恢复的状态管理

```typescript
/** 检查点：捕获 Agent 执行状态的快照 */
interface TaskCheckpoint {
  taskId: string;
  /** 保存时的 Agent 上下文（对话历史 + 中间结果） */
  agentMessages: AgentMessage[];
  /** Layer 1 的任务共享状态快照 */
  taskStateSnapshot: Partial<TaskSharedState>;
  /** Layer 2 的 Agent 私有状态 */
  agentLocalState: Map<string, any>;
  /** 已完成的阶段 */
  completedStages: string[];
  /** 下一步应该执行什么 */
  nextAction: string;
  /** 保存时间 */
  savedAt: number;
}

/**
 * 检查点管理器
 *
 * 设计考虑：
 * 1. LLM 对话历史可能很长，但恢复时不需要全部 —— 可以压缩
 * 2. 阶段性成果（stageResults）是最重要的恢复信息
 * 3. 私有状态可能包含大量工具调用细节，只保留关键数据
 */
class CheckpointManager {
  /** 捕获检查点 */
  async capture(
    task: Task,
    agentView: AgentContextView,
    agentMessages: AgentMessage[],
  ): Promise<TaskCheckpoint> {
    return {
      taskId: task.id,
      agentMessages: this.compressMessages(agentMessages),
      taskStateSnapshot: {
        taskStatus: agentView.task.taskStatus,
        approvalState: agentView.task.approvalState,
        stageResults: [...(agentView.task.stageResults ?? [])],
      },
      agentLocalState: new Map(agentView.local.localState),
      completedStages: this.extractCompletedStages(agentView),
      nextAction: this.inferNextAction(agentView),
      savedAt: Date.now(),
    };
  }

  /** 压缩消息历史：保留关键信息，去除冗余 */
  private compressMessages(messages: AgentMessage[]): AgentMessage[] {
    // 策略：保留最后 N 条 + 所有工具结果摘要
    const MAX_RECENT = 10;
    const recent = messages.slice(-MAX_RECENT);

    // 将更早的消息压缩为摘要
    if (messages.length > MAX_RECENT) {
      const older = messages.slice(0, -MAX_RECENT);
      const summary: AgentMessage = {
        role: 'user',
        content: `[之前的工作摘要] 已完成以下步骤：\n${
          this.summarizeMessages(older)
        }`,
        timestamp: Date.now(),
      };
      return [summary, ...recent];
    }
    return recent;
  }

  /** 从检查点恢复上下文 */
  async restore(checkpoint: TaskCheckpoint): Promise<{
    messages: AgentMessage[];
    taskState: Partial<TaskSharedState>;
    resumePrompt: string;
  }> {
    // 构建恢复提示
    const resumePrompt = [
      `你正在恢复一个之前被暂停的任务。`,
      `任务目标：${checkpoint.taskStateSnapshot.taskStatus}`,
      `已完成阶段：${checkpoint.completedStages.join(', ')}`,
      `下一步应该：${checkpoint.nextAction}`,
      `请从暂停点继续执行，不要重复已完成的工作。`,
    ].join('\n');

    return {
      messages: checkpoint.agentMessages,
      taskState: checkpoint.taskStateSnapshot,
      resumePrompt,
    };
  }
}
```

##### 5.8.2.5 Coordinator 的实时信息注入

```typescript
/**
 * 运行时信息注入器
 *
 * 参考 pi-agent-core 的 getSteeringMessages 机制：
 * 在每次 tool execution 完成后调用，检查是否有新的信息需要注入。
 *
 * 场景举例：
 * - 审批规则刚刚变更（规则更新）
 * - 客户刚刚补充了材料（新信息到达）
 * - 另一个 Agent 完成了相关工作（依赖完成通知）
 */
class RuntimeInjector {
  private pendingInjections: Map<string, Injection[]> = new Map();

  /** 注入新的共识信息 */
  inject(targetAgentId: string, injection: Injection): void {
    const queue = this.pendingInjections.get(targetAgentId) ?? [];
    queue.push(injection);
    this.pendingInjections.set(targetAgentId, queue);
  }

  /**
   * 作为 getSteeringMessages 的实现
   * pi-agent-core 在每次 tool 执行后调用此方法
   */
  getSteeringMessagesFor(agentId: string): () => Promise<AgentMessage[]> {
    return async (): Promise<AgentMessage[]> => {
      const pending = this.pendingInjections.get(agentId) ?? [];
      if (pending.length === 0) return [];

      // 清空队列
      this.pendingInjections.set(agentId, []);

      // 转换为 AgentMessage
      return pending.map(inj => this.toAgentMessage(inj));
    };
  }

  private toAgentMessage(injection: Injection): AgentMessage {
    switch (injection.type) {
      case 'rule_change':
        return {
          role: 'user',
          content: `[系统通知 - 规则变更] ${injection.description}\n` +
            `变更内容：${JSON.stringify(injection.payload)}\n` +
            `请根据新规则重新评估当前任务。`,
          timestamp: Date.now(),
        };
      case 'new_information':
        return {
          role: 'user',
          content: `[新信息到达] ${injection.description}\n` +
            `新信息：${JSON.stringify(injection.payload)}\n` +
            `请将此信息纳入考虑。`,
          timestamp: Date.now(),
        };
      case 'dependency_completed':
        return {
          role: 'user',
          content: `[依赖任务完成] Agent "${injection.sourceAgent}" 已完成其工作。\n` +
            `结果摘要：${injection.payload.summary}\n` +
            `你现在可以继续执行需要此结果的步骤。`,
          timestamp: Date.now(),
        };
      case 'suspend':
        return {
          role: 'user',
          content: `[系统指令 - 任务暂停] 当前任务需要被暂停，因为有更高优先级的任务到达。\n` +
            `请总结你目前的进展和下一步计划，然后停止执行。`,
          timestamp: Date.now(),
        };
      default:
        return {
          role: 'user',
          content: `[系统通知] ${injection.description}`,
          timestamp: Date.now(),
        };
    }
  }
}

type Injection = {
  type: 'rule_change' | 'new_information' | 'dependency_completed' | 'suspend' | 'priority_change';
  description: string;
  payload: any;
  sourceAgent?: string;
  urgency: 'immediate' | 'next_checkpoint';
};
```

##### 5.8.2.6 防止优先级反转

```typescript
/**
 * 优先级反转防护
 *
 * 场景：低优先级任务持有某个 MCP 工具的独占锁（如 ERP 写入），
 * 高优先级任务也需要该工具，导致高优先级被阻塞。
 *
 * 解决方案：优先级继承协议
 */
class PriorityInversionGuard {
  private resourceHolders: Map<string, { taskId: string; originalPriority: PriorityLevel }> = new Map();

  /** 请求资源 */
  async requestResource(
    resource: string,
    requestingTask: Task,
  ): Promise<ResourceGrant> {
    const holder = this.resourceHolders.get(resource);

    if (!holder) {
      // 资源空闲，直接授予
      this.resourceHolders.set(resource, {
        taskId: requestingTask.id,
        originalPriority: requestingTask.priority,
      });
      return { granted: true };
    }

    if (requestingTask.priority > holder.originalPriority) {
      // 高优先级任务被低优先级阻塞 → 优先级继承
      // 临时提升持有者的优先级，使其尽快完成并释放资源
      await this.boostPriority(holder.taskId, requestingTask.priority);

      // 请求者排队等待
      return {
        granted: false,
        waitingFor: holder.taskId,
        estimatedWait: this.estimateCompletion(holder.taskId),
      };
    }

    // 低或同优先级请求，排队
    return { granted: false, waitingFor: holder.taskId };
  }

  /** 释放资源 */
  releaseResource(resource: string, taskId: string): void {
    const holder = this.resourceHolders.get(resource);
    if (holder?.taskId === taskId) {
      // 恢复原始优先级
      this.restorePriority(taskId, holder.originalPriority);
      this.resourceHolders.delete(resource);
    }
  }
}
```

##### 5.8.2.7 时序图：紧急任务打断常规任务

```
时间 ──────────────────────────────────────────────────────────────→

Coordinator          Approval Agent (低优先级)       Notification Agent
    │                       │                              │
    │  ①分派常规审批任务      │                              │
    │──────────────────────>│                              │
    │                       │                              │
    │                       │ ②调用 ERP 查询发票            │
    │                       │ (tool execution #1)          │
    │                       │                              │
    │                       │ ③工具返回 → 检查 steering     │
    │                       │   (无 pending steering)       │
    │                       │                              │
    │                       │ ④调用规则引擎校验              │
    │                       │ (tool execution #2)          │
    │                       │                              │
=== 紧急 VIP 客户审批到达 =============================================
    │                       │                              │
    │ ⑤新任务到达            │                              │
    │ priority=HIGH         │                              │
    │                       │                              │
    │ ⑥判断需要抢占          │                              │
    │ inject steering:      │                              │
    │ "TASK_SUSPENDED"      │                              │
    │─────────(steering)───>│                              │
    │                       │                              │
    │                       │ ⑦工具返回 → 检查 steering     │
    │                       │   发现 SUSPEND 指令           │
    │                       │                              │
    │                       │ ⑧保存检查点                   │
    │                       │ {completedStages:["查询","校验"],│
    │                       │  nextAction:"生成审批意见"}    │
    │<─────(checkpoint)─────│                              │
    │                       │ (暂停)                       │
    │                       │                              │
    │ ⑨创建新的 Approval Agent 实例处理 VIP 任务              │
    │──────────────────────>│' (新实例)                     │
    │                       │'                             │
    │                       │' ⑩处理 VIP 紧急审批           │
    │                       │' ...                         │
    │                       │' ⑪完成                       │
    │<─────(result)─────────│'                             │
    │                       │                              │
    │ ⑫恢复暂停的任务        │                              │
    │ 从检查点恢复上下文      │                              │
    │──────────────────────>│                              │
    │                       │                              │
    │                       │ ⑬从"生成审批意见"继续         │
    │                       │ (不重复查询和校验)             │
    │                       │ ...                          │
    │                       │ ⑭完成                        │
    │<─────(result)─────────│                              │
    │                       │                              │
    │ ⑮委派通知              │                              │
    │──────────────────────────────────────────────────────>│
    │                       │                              │ ⑯发送通知
```

##### 5.8.2.8 与现有框架的对比

| 特性 | OpenAI Agents SDK | Swarms | pi-agent-core | 我们的设计 |
|------|-------------------|--------|---------------|-----------|
| 任务优先级 | 无 | 无 | 无 | 多维度优先级模型 |
| 任务中断 | 无（只有 max_turns 硬停） | 无 | `getSteeringMessages` | 基于 steering 的协作式中断 |
| 任务恢复 | 无 | 无 | `agentLoopContinue` | 检查点 + 上下文重建 |
| 动态注入 | 无 | 无 | `getSteeringMessages` + `getFollowUpMessages` | 扩展 steering 支持多种注入类型 |
| 抢占调度 | 不支持 | 不支持 | 不支持 | 协作式抢占（检查点处暂停） |
| 优先级反转防护 | 不适用 | 不适用 | 不适用 | 优先级继承协议 |

---

#### 5.8.3 Agent 间通信协议与委派机制

##### 5.8.3.1 设计原理

Agent 间通信是多 Agent 系统最容易出问题的地方。核心挑战是：

1. **信息失真**（"电话游戏"问题）：自然语言在 Agent 间传递时，每次经过 LLM 理解和重新表达都会引入偏差。经过 3-4 次传递后，原始意图可能完全变形。
2. **上下文膨胀**：如果每次委派都传递完整上下文，token 消耗呈指数增长。
3. **通信复杂度**：N 个 Agent 两两通信是 O(N²)，大型 Swarm 中不可接受。

解决方案是：**结构化消息 + 星型拓扑 + 分层上下文传递**。

##### 5.8.3.2 通信协议：AgentMessage 标准格式

```typescript
/** Agent 间通信的标准消息格式 */
interface InterAgentMessage {
  /** 消息唯一标识 */
  id: string;
  /** 消息类型 */
  type: MessageType;
  /** 发送方 Agent */
  from: string;
  /** 接收方 Agent（"coordinator" 为默认中转） */
  to: string;
  /** 时间戳 */
  timestamp: number;
  /** 关联的任务 ID */
  taskId: string;
  /** 消息体 — 结构化 JSON，避免自然语言传递导致的信息失真 */
  payload: MessagePayload;
  /** 元数据 */
  metadata: {
    /** 消息的重要性等级 */
    priority: PriorityLevel;
    /** 是否需要确认回执 */
    requiresAck: boolean;
    /** 超时（毫秒） */
    timeout?: number;
    /** 关联消息 ID（用于请求-响应配对） */
    correlationId?: string;
    /** 消息经过的 Agent 路径（用于追踪和防环） */
    hopTrace: string[];
  };
}

type MessageType =
  | 'task_delegation'      // 任务委派
  | 'task_result'          // 任务结果
  | 'context_update'       // 上下文更新
  | 'query'                // 查询请求
  | 'query_response'       // 查询响应
  | 'event_notification'   // 事件通知
  | 'error_report'         // 错误报告
  | 'heartbeat'            // 心跳
  | 'ack';                 // 确认回执

/** 委派任务时的消息体 */
interface TaskDelegationPayload {
  /** 结构化的任务描述（不是自然语言！） */
  task: {
    objective: string;           // 明确的目标
    constraints: string[];       // 约束条件
    expectedOutput: OutputSpec;  // 期望输出格式
    deadline?: number;           // 截止时间
  };
  /** 上下文切片：只传递该 Agent 需要的信息 */
  contextSlice: {
    /** 从 Layer 1 选择性传递的字段 */
    taskFields: Partial<TaskSharedState>;
    /** 前序 Agent 的结果摘要（不是完整输出） */
    predecessorSummaries: AgentResultSummary[];
    /** 相关的业务规则子集 */
    relevantRules: BusinessRule[];
  };
  /** 回调配置 */
  callback: {
    /** 结果发送给谁 */
    reportTo: string;
    /** 是否需要中间进度报告 */
    progressReporting: boolean;
    /** 进度报告间隔 */
    progressIntervalMs?: number;
  };
}

/** 任务结果消息体 */
interface TaskResultPayload {
  /** 结构化结果 */
  result: {
    /** 任务是否成功 */
    status: 'success' | 'partial_success' | 'failure';
    /** 结构化输出数据 */
    data: Record<string, any>;
    /** 自然语言摘要（供其他 Agent 或人类阅读） */
    summary: string;
    /** 置信度（0-1） */
    confidence: number;
  };
  /** 执行统计 */
  stats: {
    duration: number;
    llmCalls: number;
    toolCalls: number;
    tokensUsed: number;
  };
  /** 后续建议 */
  suggestions?: string[];
}

/** 输出规格：告诉 Agent 期望什么格式的输出 */
interface OutputSpec {
  format: 'json' | 'text' | 'table' | 'decision';
  schema?: Record<string, any>;   // JSON Schema
  maxLength?: number;
}
```

##### 5.8.3.3 三种通信模式及适用场景

```typescript
/**
 * 模式一：同步委派（Synchronous Delegation）
 *
 * Coordinator 委派任务给 Sub-Agent，等待结果后继续。
 * 类似 OpenAI Agents SDK 的 agent.as_tool() 模式。
 *
 * 适用场景：
 * - 顺序依赖：Agent B 的输入依赖 Agent A 的输出
 * - 简单任务：预期很快完成（< 30s）
 * - 关键路径：结果直接影响后续决策
 *
 * 示例：Coordinator → Approval Agent 判断是否需要审批 → 根据结果决定下一步
 */
class SyncDelegation {
  async delegate(
    targetAgent: string,
    delegation: TaskDelegationPayload,
    timeout: number = 30_000,
  ): Promise<TaskResultPayload> {
    const message: InterAgentMessage = {
      id: generateId(),
      type: 'task_delegation',
      from: 'coordinator',
      to: targetAgent,
      timestamp: Date.now(),
      taskId: delegation.task.objective,
      payload: delegation,
      metadata: {
        priority: PriorityLevel.NORMAL,
        requiresAck: true,
        timeout,
        correlationId: generateId(),
        hopTrace: ['coordinator'],
      },
    };

    // 发送并等待响应
    const result = await this.messageBus.sendAndWait<TaskResultPayload>(
      message,
      timeout,
    );

    return result;
  }
}

/**
 * 模式二：异步委派（Asynchronous Delegation）
 *
 * Coordinator 委派任务后不等待，继续处理其他工作。
 * 结果通过回调或消息总线异步返回。
 *
 * 适用场景：
 * - 并行独立：多个 Agent 可以同时工作
 * - 长时间任务：如生成报告、大批量数据处理
 * - 非关键路径：结果可以稍后汇总
 *
 * 示例：同时委派 Data Agent 收集数据 + Report Agent 准备模板
 */
class AsyncDelegation {
  async delegateMultiple(
    delegations: Array<{
      targetAgent: string;
      payload: TaskDelegationPayload;
    }>,
  ): Promise<DelegationHandle[]> {
    const handles: DelegationHandle[] = [];

    for (const { targetAgent, payload } of delegations) {
      const correlationId = generateId();
      const message: InterAgentMessage = {
        id: generateId(),
        type: 'task_delegation',
        from: 'coordinator',
        to: targetAgent,
        timestamp: Date.now(),
        taskId: payload.task.objective,
        payload,
        metadata: {
          priority: PriorityLevel.NORMAL,
          requiresAck: true,
          correlationId,
          hopTrace: ['coordinator'],
        },
      };

      await this.messageBus.send(message);

      handles.push({
        correlationId,
        targetAgent,
        status: 'pending',
        /** 等待特定委派的结果 */
        wait: () => this.messageBus.waitForCorrelation<TaskResultPayload>(
          correlationId
        ),
      });
    }

    return handles;
  }

  /** 等待所有或部分结果 */
  async waitForAll(
    handles: DelegationHandle[],
    options: { timeout?: number; minRequired?: number } = {},
  ): Promise<TaskResultPayload[]> {
    const { timeout = 60_000, minRequired = handles.length } = options;

    const results: TaskResultPayload[] = [];
    const promises = handles.map(h => h.wait());

    // Promise.allSettled + 超时
    const settled = await Promise.race([
      Promise.allSettled(promises),
      new Promise<PromiseSettledResult<TaskResultPayload>[]>(resolve =>
        setTimeout(() => resolve(
          handles.map((_, i) =>
            results[i]
              ? { status: 'fulfilled' as const, value: results[i] }
              : { status: 'rejected' as const, reason: new Error('timeout') }
          )
        ), timeout)
      ),
    ]);

    const fulfilled = settled
      .filter((r): r is PromiseFulfilledResult<TaskResultPayload> =>
        r.status === 'fulfilled')
      .map(r => r.value);

    if (fulfilled.length < minRequired) {
      throw new InsufficientResultsError(
        `需要 ${minRequired} 个结果，只收到 ${fulfilled.length} 个`
      );
    }

    return fulfilled;
  }
}

/**
 * 模式三：事件驱动（Event-Driven / Pub-Sub）
 *
 * Agent 发布事件，感兴趣的 Agent 订阅并响应。
 *
 * 适用场景：
 * - 状态变更通知：审批状态变化、新文档到达
 * - 松耦合协作：发布者不需要知道谁会处理
 * - 广播场景：一个事件需要多个 Agent 知晓
 *
 * 示例：Approval Agent 发布"审批通过"事件 →
 *       Notification Agent 订阅并发送通知 +
 *       Data Entry Agent 订阅并录入 ERP
 */
class EventDrivenCommunication {
  private subscriptions: Map<string, Array<{
    agentId: string;
    filter?: (event: AgentEvent) => boolean;
    handler: (event: AgentEvent) => Promise<void>;
  }>> = new Map();

  /** 订阅事件 */
  subscribe(
    eventType: string,
    agentId: string,
    handler: (event: AgentEvent) => Promise<void>,
    filter?: (event: AgentEvent) => boolean,
  ): Unsubscribe {
    const subs = this.subscriptions.get(eventType) ?? [];
    const sub = { agentId, filter, handler };
    subs.push(sub);
    this.subscriptions.set(eventType, subs);

    return () => {
      const idx = subs.indexOf(sub);
      if (idx >= 0) subs.splice(idx, 1);
    };
  }

  /** 发布事件 */
  async publish(event: AgentEvent): Promise<void> {
    const subs = this.subscriptions.get(event.type) ?? [];
    const eligibleSubs = subs.filter(
      s => !s.filter || s.filter(event)
    );

    // 并行通知所有订阅者
    await Promise.allSettled(
      eligibleSubs.map(s => s.handler(event))
    );
  }
}
```

**三种模式的选择指南**：

| 场景 | 推荐模式 | 原因 |
|------|----------|------|
| 审批判断 → 后续处理 | 同步 | 结果直接决定后续流程 |
| 多系统数据收集 | 异步（并行） | 各系统独立，可并行 |
| 报告生成（收集+模板+渲染） | 异步（管线） | 有序依赖但各阶段独立 |
| 审批状态变更通知 | 事件驱动 | 多方需要知晓，松耦合 |
| 紧急任务到达 | 事件驱动 + 同步 | 广播通知 + 直接调度 |
| 人工审核结果回调 | 事件驱动 | 时间不确定，异步等待 |

##### 5.8.3.4 委派工作的完整数据流

```typescript
/**
 * 上下文传递策略：解决"传多少上下文"的问题
 *
 * 核心思想：分三层传递，逐层递减
 */
class ContextTransferStrategy {
  /**
   * 为目标 Agent 准备上下文切片
   *
   * Layer A: 任务指令（必传）
   *   - 明确的任务目标、约束、期望输出格式
   *   - 使用结构化 JSON，不是自然语言描述
   *
   * Layer B: 必要上下文（按需传递）
   *   - 前序 Agent 的结果摘要（不是完整输出）
   *   - 相关业务规则
   *   - 客户关键信息
   *
   * Layer C: 参考信息（可选传递）
   *   - 完整的客户对话历史
   *   - 详细的前序分析
   *   - 仅在目标 Agent 明确需要时传递
   */
  prepareContextSlice(
    targetAgentType: string,
    taskState: TaskSharedState,
    predecessorResults: TaskResultPayload[],
    transferConfig: ContextTransferConfig,
  ): TaskDelegationPayload['contextSlice'] {
    // Layer A: 总是传递
    const taskFields: Partial<TaskSharedState> = {
      taskId: taskState.taskId,
      taskGoal: taskState.taskGoal,
      taskStatus: taskState.taskStatus,
    };

    // Layer B: 根据 Agent 类型决定
    const neededFields = transferConfig.fieldMapping[targetAgentType] ?? [];
    for (const field of neededFields) {
      (taskFields as any)[field] = taskState[field as keyof TaskSharedState];
    }

    // 前序结果：只传摘要，不传完整输出
    const summaries = predecessorResults.map(r => ({
      agentName: r.result.data.agentName ?? 'unknown',
      summary: r.result.summary,
      status: r.result.status,
      keyData: this.extractKeyData(r, targetAgentType),
    }));

    // Layer C: 仅当配置要求时传递额外上下文
    const relevantRules = this.filterRelevantRules(
      taskState,
      targetAgentType,
    );

    return {
      taskFields,
      predecessorSummaries: summaries,
      relevantRules,
    };
  }

  /** 从前序结果中提取目标 Agent 需要的关键数据 */
  private extractKeyData(
    result: TaskResultPayload,
    targetAgentType: string,
  ): Record<string, any> {
    // 每种 Agent 类型有不同的关注点
    // 例如：Notification Agent 只需要审批结果和收件人
    //       Data Entry Agent 需要完整的表单数据
    const extractors: Record<string, (r: TaskResultPayload) => Record<string, any>> = {
      notification_agent: (r) => ({
        decision: r.result.data.decision,
        recipient: r.result.data.recipient,
        amount: r.result.data.amount,
      }),
      data_entry_agent: (r) => ({
        formData: r.result.data.formData,
        targetSystem: r.result.data.targetSystem,
        validationResults: r.result.data.validationResults,
      }),
    };

    return (extractors[targetAgentType] ?? (() => ({ summary: result.result.summary })))(result);
  }
}

/** 上下文传递配置 — 在岗位 YAML 中定义 */
interface ContextTransferConfig {
  /** Agent 类型 → 需要从 TaskSharedState 获取的字段列表 */
  fieldMapping: Record<string, (keyof TaskSharedState)[]>;
  /** 是否传递前序结果的完整数据（默认只传摘要） */
  includeFullPredecessorData: boolean;
  /** 上下文最大 token 数（超出则压缩） */
  maxContextTokens: number;
}
```

##### 5.8.3.5 防止信息失真（"电话游戏"问题）

```typescript
/**
 * 信息保真策略
 *
 * 核心原则：关键信息用结构化数据传递，不经过 LLM 重新表达
 */
class InformationFidelityGuard {
  /**
   * 策略 1: 结构化传递
   * 关键数据（金额、日期、ID、状态）始终以 JSON 传递
   * LLM 只处理理解和决策，不负责"转述"数据
   */
  validateDelegationPayload(payload: TaskDelegationPayload): ValidationResult {
    const issues: string[] = [];

    // 检查关键字段是否是结构化的（不是嵌入在自然语言中）
    if (typeof payload.task.objective !== 'string') {
      issues.push('objective 应该是明确的字符串');
    }
    if (!payload.task.expectedOutput?.format) {
      issues.push('缺少 expectedOutput 格式定义');
    }
    if (!payload.contextSlice.taskFields.taskId) {
      issues.push('缺少结构化的 taskId');
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * 策略 2: 源头标注
   * 每条信息标注来源，如果需要验证可以回溯
   */
  annotateSource(data: any, source: string): AnnotatedData {
    return {
      data,
      source,
      timestamp: Date.now(),
      hash: this.computeHash(data),  // 用于验证数据完整性
    };
  }

  /**
   * 策略 3: 跳跃限制
   * 消息最多经过 2 次转发，超过则直接回到 Coordinator 重新路由
   */
  checkHopLimit(message: InterAgentMessage, maxHops: number = 2): boolean {
    if (message.metadata.hopTrace.length > maxHops) {
      // 超过跳跃限制，拒绝转发
      return false;
    }
    return true;
  }

  /**
   * 策略 4: 结果校验
   * 对关键数值结果进行回路验证
   */
  async verifyResult(
    original: TaskDelegationPayload,
    result: TaskResultPayload,
  ): Promise<VerificationResult> {
    // 检查结果是否回答了原始问题
    if (result.result.status === 'success' && original.task.expectedOutput.schema) {
      const isValid = this.validateAgainstSchema(
        result.result.data,
        original.task.expectedOutput.schema,
      );
      if (!isValid) {
        return { verified: false, reason: '结果不符合期望的输出格式' };
      }
    }
    return { verified: true };
  }
}
```

##### 5.8.3.6 通信拓扑：星型 + 直连混合

```
大型 Swarm 的通信拓扑设计：

默认模式：星型拓扑（所有通信经过 Coordinator）
  优点：O(N) 通信复杂度，便于审计和控制
  缺点：Coordinator 是瓶颈

    Sub-Agent A ──→ Coordinator ──→ Sub-Agent B
                        ↕
                   Sub-Agent C

优化模式：直连快速通道（Coordinator 授权的点对点通信）
  条件：两个 Agent 需要高频交互且 Coordinator 已批准
  优点：减少延迟，降低 Coordinator 负担
  缺点：需要额外的审计机制

    Sub-Agent A ─── 直连(已授权) ──→ Sub-Agent B
         ↕                              ↕
    Coordinator ←── 审计日志回报 ──────┘
```

```typescript
/** 消息总线：支持星型 + 直连混合拓扑 */
class MessageBus {
  private directChannels: Map<string, Set<string>> = new Map();

  /** Coordinator 授权直连通道 */
  authorizeDirectChannel(agent1: string, agent2: string): void {
    this.getOrCreate(agent1).add(agent2);
    this.getOrCreate(agent2).add(agent1);
  }

  /** 发送消息 */
  async send(message: InterAgentMessage): Promise<void> {
    // 记录审计日志（所有消息都记录）
    await this.auditLog.record(message);

    // 检查是否有直连通道
    if (this.hasDirectChannel(message.from, message.to)) {
      // 直连发送
      await this.directSend(message);
    } else {
      // 通过 Coordinator 中转
      await this.routeThroughCoordinator(message);
    }
  }

  /** 发送并等待响应 */
  async sendAndWait<T>(
    message: InterAgentMessage,
    timeout: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new TimeoutError(`等待 ${message.to} 响应超时`)),
        timeout,
      );

      this.responseHandlers.set(message.metadata.correlationId!, (response) => {
        clearTimeout(timer);
        resolve(response.payload as T);
      });

      this.send(message);
    });
  }
}
```

##### 5.8.3.7 错误处理与降级策略

```typescript
/**
 * 多层错误处理策略
 *
 * Level 1: Agent 内部重试（工具调用失败等瞬时错误）
 * Level 2: 换一个 Agent 执行（Agent 能力不匹配或持续失败）
 * Level 3: 降级执行（用更简单的策略完成部分工作）
 * Level 4: 升级到人工（所有自动策略失败）
 */
class ErrorHandler {
  async handleAgentFailure(
    failedAgent: string,
    task: Task,
    error: AgentError,
    context: AgentContextView,
  ): Promise<ErrorRecoveryAction> {

    // Level 1: 瞬时错误 → Agent 内部重试
    if (error.isTransient && error.retryCount < 3) {
      return {
        action: 'retry',
        delay: Math.pow(2, error.retryCount) * 1000,  // 指数退避
        modifications: undefined,
      };
    }

    // Level 2: Agent 能力不匹配 → 换一个 Agent
    if (error.type === 'capability_mismatch' || error.retryCount >= 3) {
      const alternativeAgent = await this.findAlternativeAgent(
        task,
        failedAgent,
        context.global.allowedAgents,
      );
      if (alternativeAgent) {
        return {
          action: 'reassign',
          targetAgent: alternativeAgent,
          // 传递失败信息，避免新 Agent 重复相同错误
          additionalContext: {
            previousAttempt: {
              agent: failedAgent,
              error: error.message,
              partialResults: error.partialResults,
            },
          },
        };
      }
    }

    // Level 3: 降级执行
    if (this.canDegrade(task)) {
      return {
        action: 'degrade',
        degradedPlan: this.createDegradedPlan(task, error),
        notification: `任务 ${task.id} 降级执行：${error.message}`,
      };
    }

    // Level 4: 升级到人工
    return {
      action: 'escalate_to_human',
      escalation: {
        reason: `Agent ${failedAgent} 处理任务 ${task.id} 失败`,
        error: error.message,
        context: this.prepareHumanContext(task, error, context),
        suggestedActions: this.suggestHumanActions(error),
        urgency: task.priority >= PriorityLevel.HIGH ? 'immediate' : 'normal',
      },
    };
  }

  /** 准备人工接管所需的上下文 */
  private prepareHumanContext(
    task: Task,
    error: AgentError,
    context: AgentContextView,
  ): HumanEscalationContext {
    return {
      taskGoal: context.task.taskGoal!,
      completedSteps: context.task.stageResults ?? [],
      failedStep: error.failedStep,
      errorDetail: error.message,
      relevantData: error.partialResults,
      auditTrail: context.task.auditTrail ?? [],
      // 人工可以直接在 UI 上操作的选项
      availableActions: ['approve', 'reject', 'modify_and_retry', 'cancel'],
    };
  }
}
```

##### 5.8.3.8 场景示例：项目进度汇报

```
场景：每周五自动生成项目进度汇报
需要从 Jira（任务进度）、GitLab（代码提交）、Confluence（文档更新）
三个系统收集信息，汇总后生成报告并发送给项目经理。

════════════════════════════════════════════════════

Step 1: Coordinator 接收定时任务触发
  ┌─────────────────────────────────────────┐
  │ Task: 生成本周项目进度汇报               │
  │ Priority: LOW (定时任务)                 │
  │ Deadline: 周五 18:00                    │
  └─────────────────────────────────────────┘

Step 2: Coordinator 决策 — 使用异步并行模式
  目标：从三个系统并行收集数据

  ┌─────────────────────────────────────────────────────┐
  │  Coordinator                                          │
  │  ├── AsyncDelegation.delegateMultiple([               │
  │  │    { target: "jira_agent",                         │
  │  │      contextSlice: { projectId, sprintId } },      │
  │  │    { target: "gitlab_agent",                       │
  │  │      contextSlice: { repoUrl, sinceDatei } },      │
  │  │    { target: "confluence_agent",                   │
  │  │      contextSlice: { spaceKey, sinceDate } },      │
  │  │  ])                                                │
  │  └── waitForAll(handles, { timeout: 60s })            │
  └─────────────────────────────────────────────────────┘

Step 3: 三个 Data Agent 并行执行（各自独立，不需要互相通信）

  Jira Agent                  GitLab Agent              Confluence Agent
  ┌──────────────┐           ┌──────────────┐          ┌──────────────┐
  │ MCP Tool:     │           │ MCP Tool:     │          │ MCP Tool:     │
  │ jira.search() │           │ gitlab.commits│          │ confluence.   │
  │               │           │ gitlab.mrs()  │          │  search()     │
  │ 结果:         │           │ 结果:         │          │ 结果:          │
  │ {             │           │ {             │          │ {              │
  │  completed: 12│           │  commits: 47  │          │  pagesUpdated │
  │  inProgress: 5│           │  mergedMRs: 8 │          │    : 6        │
  │  blocked: 2   │           │  openMRs: 3   │          │  newPages: 2  │
  │  summary: "..." │         │  summary: "..."│         │  summary: "..."│
  │ }             │           │ }             │          │ }              │
  └──────┬───────┘           └──────┬───────┘          └──────┬───────┘
         │                          │                          │
         └──────── 结构化 JSON ─────┴──────────────────────────┘
                            │
                            ▼

Step 4: Coordinator 收到三个结果 → 同步委派 Report Agent

  ┌──────────────────────────────────────────────────┐
  │  Report Agent 收到的 contextSlice:                 │
  │  {                                                 │
  │    predecessorSummaries: [                          │
  │      { agent: "jira",   keyData: { completed: 12, │
  │        inProgress: 5, blocked: 2 } },              │
  │      { agent: "gitlab", keyData: { commits: 47,   │
  │        mergedMRs: 8 } },                           │
  │      { agent: "confluence", keyData: {             │
  │        pagesUpdated: 6, newPages: 2 } },           │
  │    ],                                              │
  │    task: {                                         │
  │      objective: "生成项目进度周报",                   │
  │      expectedOutput: {                             │
  │        format: "text",                             │
  │        template: "weekly_report_v2"                │
  │      }                                             │
  │    }                                               │
  │  }                                                 │
  │                                                    │
  │  注意：Report Agent 不需要知道：                     │
  │  - 各 Agent 调用了哪些 API（Layer 2 隔离）          │
  │  - 具体的认证凭据                                   │
  │  - 数据收集过程中的重试细节                          │
  └──────────────────────────────────────────────────┘

Step 5: Report Agent 生成报告 → 同步返回 Coordinator

Step 6: Coordinator → 事件驱动模式发布 "report_ready" 事件

  EventBus.publish({
    type: "report_ready",
    payload: { reportId, format: "html", recipients: ["pm@corp.com"] }
  })

  订阅者自动响应：
  - Notification Agent 订阅了 "report_ready" → 发送邮件给项目经理
  - Archive Agent 订阅了 "report_ready" → 存档到 SharePoint

错误处理：如果 GitLab Agent 超时

  Coordinator 的 waitForAll 配置:
  { timeout: 60s, minRequired: 2 }  // 至少需要 2 个结果

  → GitLab 超时，但 Jira + Confluence 成功
  → Report Agent 生成降级版本报告（缺少代码统计部分）
  → 报告中注明："GitLab 数据暂时不可用，代码提交统计将在下次更新。"
  → Notification Agent 同时通知 DevOps 团队检查 GitLab 连接
```

##### 5.8.3.9 与现有框架的对比

| 特性 | OpenAI Agents SDK | Swarms | pi-agent-core | 我们的设计 |
|------|-------------------|--------|---------------|-----------|
| 通信模型 | Handoff（同步移交） | GroupChat（轮询广播） | 单 Agent（无 Agent 间通信） | 三模式混合（同步/异步/事件） |
| 消息格式 | 自然语言（对话历史） | 自然语言（Conversation） | AgentMessage | 结构化 JSON + 自然语言摘要 |
| 上下文传递 | 完整历史 + HandoffInputFilter | 完整 Conversation | transformContext | 分层切片（最小知情原则） |
| 拓扑结构 | 链式（A→B→C） | 全连接/轮询 | N/A | 星型 + 授权直连 |
| 错误处理 | Guardrail tripwire | 基础 try-catch | AbortSignal | 四级降级策略 |
| 信息保真 | HandoffInputFilter | 无 | convertToLlm | 结构化传递 + 源头标注 + 跳跃限制 |
| 委派方式 | Handoff (移交) / as_tool (委托) | boss → worker | 无 | 同步委派 / 异步并行 / 事件驱动 |
| 可扩展性 | 中（链式，N 个 Agent = N 次 handoff） | 低（GroupChat O(N²) token） | N/A | 高（星型 O(N) + 直连优化） |

---

#### 5.8.4 综合架构总结

将三个核心问题的设计整合到 Dynamic Hierarchical MoE 架构中：

```
┌──────────────────────────────────────────────────────────────────┐
│                    Virtual Employee (Agent Swarm)                  │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Layer 0: Global Immutable Context                          │   │
│  │  [岗位配置] [业务规则] [合规约束] [成本预算]                   │   │
│  └────────────────────────────────────────────────────────────┘   │
│                              │                                     │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Coordinator Agent                                          │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐     │   │
│  │  │ Task         │ │ Task         │ │ Message        │     │   │
│  │  │ Scheduler    │ │ State        │ │ Bus            │     │   │
│  │  │ (优先级调度)  │ │ Manager      │ │ (星型+直连)    │     │   │
│  │  │              │ │ (一致性保证)  │ │                │     │   │
│  │  └──────────────┘ └──────────────┘ └────────────────┘     │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐     │   │
│  │  │ Context      │ │ Runtime      │ │ Error          │     │   │
│  │  │ Factory      │ │ Injector     │ │ Handler        │     │   │
│  │  │ (按需投影)   │ │ (steering)   │ │ (四级降级)     │     │   │
│  │  └──────────────┘ └──────────────┘ └────────────────┘     │   │
│  └────────────────────────────────────────────────────────────┘   │
│                              │                                     │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Layer 1: Task-Level Shared State                           │   │
│  │  [任务目标] [客户上下文] [审批状态] [阶段成果] [审计日志]      │   │
│  └────────────────────────────────────────────────────────────┘   │
│           │               │               │                        │
│     ┌─────┴─────┐   ┌────┴────┐    ┌────┴────┐                   │
│     │ Agent A   │   │ Agent B │    │ Agent C │                   │
│     │ Layer 2:  │   │ Layer 2:│    │ Layer 2:│                   │
│     │ [私有状态]│   │ [私有]  │    │ [私有]  │                   │
│     └─────┬─────┘   └────┬────┘    └────┬────┘                   │
│           │               │               │                        │
│     ┌─────┴───────────────┴───────────────┴────┐                  │
│     │  Layer 3: Message Bus (InterAgentMessage)  │                  │
│     │  [委派请求] [结果反馈] [事件通知] [心跳]     │                  │
│     └────────────────────────────────────────────┘                  │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Cross-Cutting: Guardrails + Audit + Cost + Fidelity Guard  │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**关键设计决策总结**：

| 问题 | 决策 | 理由 |
|------|------|------|
| 共享 vs 隔离 | 四层分级，Layer 0/1 共享，Layer 2 隔离 | 最小知情原则，减少 token 浪费和上下文污染 |
| 一致性模型 | 最终一致性 + 事件通知 | LLM 推理本身是非确定性的，强一致性投入产出比低 |
| 调度模型 | 协作式抢占（检查点暂停） | LLM 是黑盒长操作，无法毫秒级抢占 |
| 通信拓扑 | 星型（默认）+ 授权直连 | O(N) 复杂度，Coordinator 保持全局视野 |
| 消息格式 | 结构化 JSON + 自然语言摘要 | 关键数据不经过 LLM 重表达，防止信息失真 |
| 上下文传递 | 三层递减（指令/必要上下文/参考） | 按需传递，避免上下文膨胀 |
| 错误恢复 | 四级降级（重试→换Agent→降级→人工） | 渐进式处理，最大化自动恢复率 |
| 任务恢复 | 检查点 + 上下文压缩 + 恢复提示 | 参考 pi-agent-core 的 agentLoopContinue |

---

## 6. 前沿参考与趋势

### 6.1 关键论文和项目

**Agent 架构综述**：
- [A Survey on Large Language Model based Autonomous Agents](https://arxiv.org/abs/2308.11432) -- 最全面的 LLM Agent 综述（CoLing 2025 发表）
- [Agentic AI: Architectures, Taxonomies, and Evaluation](https://arxiv.org/html/2601.12560v1) -- 2026 年 Agent 架构分类法
- [LLM-Based Multi-Agent Systems for Software Engineering](https://dl.acm.org/doi/10.1145/3712003) -- ACM TOSEM 多 Agent 系统综述

**Swarm Intelligence**：
- [Multi-agent systems powered by LLMs: applications in swarm intelligence](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1593017/full) -- LLM 驱动的群体智能，展示了蚁群和鸟群仿真（Frontiers in AI, 2025）
- [LLM-Powered Swarms: A New Frontier or a Conceptual Stretch?](https://arxiv.org/html/2506.14496v1) -- 对 LLM Swarm 的批判性分析

**动态编排**：
- [NeurIPS 2025: Puppeteer-style Dynamic Orchestration](https://blog.promptlayer.com/multi-agent-evolving-orchestration/) -- 将多 Agent 协调视为序贯决策问题，而非预定义 pipeline
- [Mixture-of-Agents Enhances LLM Capabilities](https://arxiv.org/html/2406.04692v1) -- MoA 分层架构

**协议标准**：
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) -- 最新 MCP 规范
- [Google Agent2Agent (A2A) Protocol](https://a2a-protocol.org/latest/specification/) -- Agent 间互操作协议（v0.3, 2025-07）

### 6.2 行业趋势分析

**趋势一：从固定 DAG 到动态编排**

2025-2026 年的核心范式转变是从预定义的有向无环图（DAG）工作流转向动态编排。NeurIPS 2025 论文提出的 "puppeteer" 模式将多 Agent 协调视为序贯决策问题：在每一步，编排器观察到目前为止发生的所有事情，然后决定下一个应该贡献的 Agent，创建一个由问题本身而非开发者预设的隐式推理图。

**趋势二：MCP + A2A 双协议标准化**

- **MCP（Agent-to-Tool）**：Agent 与工具之间的标准接口，类似于 "USB for AI"
- **A2A（Agent-to-Agent）**：Agent 与 Agent 之间的标准接口，类似于 "HTTP for Agents"

两个协议互补：MCP 解决 Agent 如何使用工具，A2A 解决 Agent 如何互相协作。两者均已捐赠给 Linux Foundation，正在成为行业标准。

**趋势三：Agent-as-a-Service 架构**

Gartner 报告 2024 Q1 到 2025 Q2 期间，多 Agent 系统咨询量激增 1,445%。企业正在从"部署单个 AI 助手"转向"部署专业化 Agent 团队"。Amazon 报告称 2025 年以来已在内部组织中构建了数千个 Agent。

Deloitte 预测 2026 年将是"人在回路上方"（human-on-the-loop）编排的元年 -- Agent 自主执行，人类负责监督而非逐步操作。

**趋势四：从通用大模型到专业化 Agent**

2026 年的趋势是专业化：每个 Agent 针对特定任务优化，而非使用一个通用大模型处理所有事情。这与我们"虚拟员工 = Agent Swarm"的理念高度一致。

### 6.3 我们的定位

```
行业趋势                    我们的对应
─────────────              ─────────────
动态编排 (Non-DAG)     ->   Coordinator + MoE Gate 动态路由
MCP 标准化             ->   MCP 作为工具集成唯一通道
A2A 协议               ->   Agent 间通信标准化（预留接口）
Agent-as-a-Service     ->   虚拟员工即服务（VEaaS）
专业化 Agent           ->   子 Agent 池 + 动态加载
Human-on-the-loop      ->   Guardrails + 审计日志 + 人工审核标记
```

---

## 7. 总结与行动建议

### 7.1 核心架构决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 编排模式 | Hierarchical + Dynamic Routing 混合 | 兼顾控制性和灵活性 |
| 路由机制 | 规则优先 + LLM 兜底 | 确定性业务不依赖 LLM |
| 核心运行时 | OpenAI Agents SDK | 设计精良、MCP 原生、Guardrails 完善 |
| 工具集成 | MCP 协议 | 行业标准、动态发现 |
| 配置格式 | YAML + JSON Schema | 人类可读、可验证 |
| 上下文管理 | Scoped Context（共享只读 + 私有可变） | 隔离性好、可审计 |
| 成本控制 | 多层预算（turns/tokens/cost/time） | 全方位防护 |

### 7.2 分阶段实施路线

**Phase 1（4 周）：核心框架搭建**
- 基于 OpenAI Agents SDK 搭建 Coordinator + Sub-Agent 基础框架
- 实现 YAML 配置解析和 Employee 实例化
- 实现基础 Guardrails（输入/输出检查）
- 实现成本控制器（max_turns + token budget）

**Phase 2（3 周）：动态能力**
- 实现规则引擎（确定性路由）
- 实现 MCP Server Manager（工具动态发现）
- 实现 Agent 注册表和动态加载
- 实现 Scoped Context 和审计日志

**Phase 3（3 周）：岗位落地**
- 实现 2-3 个标杆岗位（如报销审批、数据录入、项目协调）
- 编写岗位配置模板
- 性能测试和成本优化
- 构建监控仪表盘

**Phase 4（2 周）：生产化**
- A2A 协议接口预留
- 企业级安全（OAuth 2.0, 审计合规）
- 故障恢复和重试机制
- 文档和运维手册

### 7.3 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| LLM 路由决策不稳定 | 任务分配到错误的 Agent | 规则优先策略 + OutputGuardrail 兜底检查 |
| Agent 循环/发散 | 成本失控、任务超时 | 多层预算限制 + 循环检测 + 强制终止 |
| MCP Server 不可用 | 工具调用失败 | MCPServerManager 失败容错 + 重连 + 降级策略 |
| 上下文窗口爆炸 | 性能下降、信息丢失 | Handoff input_filter + 对话压缩 + 分段处理 |
| 业务规则被 LLM 绕过 | 合规风险 | 硬编码规则层 + Guardrails + 人工审核标记 |

---

## 参考来源

### 学术论文
- [A Survey on Large Language Model based Autonomous Agents (CoLing 2025)](https://arxiv.org/abs/2308.11432)
- [Agentic AI: Architectures, Taxonomies, and Evaluation (2026)](https://arxiv.org/html/2601.12560v1)
- [LLM-Based Multi-Agent Systems for Software Engineering (ACM TOSEM)](https://dl.acm.org/doi/10.1145/3712003)
- [Multi-agent systems powered by LLMs: applications in swarm intelligence (Frontiers in AI, 2025)](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1593017/full)
- [LLM-Powered Swarms: A New Frontier or a Conceptual Stretch?](https://arxiv.org/html/2506.14496v1)
- [Mixture-of-Agents Enhances Large Language Model Capabilities](https://arxiv.org/html/2406.04692v1)
- [MCP Tool Descriptions Are Smelly (2026)](https://arxiv.org/html/2602.14878v1)

### 协议规范
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Google Agent2Agent (A2A) Protocol v0.3](https://a2a-protocol.org/latest/specification/)
- [A2A GitHub Repository](https://github.com/a2aproject/A2A)

### 行业分析
- [Developer's Guide to Multi-Agent Patterns in ADK (Google)](https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/)
- [Multi-Agent System Architecture Guide 2026 (ClickIT)](https://www.clickittech.com/ai/multi-agent-system-architecture/)
- [Deloitte: AI Agent Orchestration 2026](https://www.deloitte.com/us/en/insights/industry/technology/technology-media-and-telecom-predictions/2026/ai-agent-orchestration.html)
- [7 Agentic AI Trends to Watch in 2026 (ML Mastery)](https://machinelearningmastery.com/7-agentic-ai-trends-to-watch-in-2026/)
- [Top 5 Open-Source Agentic AI Frameworks 2026 (AIM)](https://aimultiple.com/agentic-frameworks)
- [Dynamic Multi-Agent Orchestration Learns Task Routing (PromptLayer)](https://blog.promptlayer.com/multi-agent-evolving-orchestration/)
- [A Year of MCP: From Internal Experiment to Industry Standard (Pento)](https://www.pento.ai/blog/a-year-of-mcp-2025-review)
- [MCP Tool Discovery: How It Works (Obot AI)](https://obot.ai/resources/learning-center/mcp-tool-discovery/)
- [AWS: Evaluating AI Agents at Amazon](https://aws.amazon.com/blogs/machine-learning/evaluating-ai-agents-real-world-lessons-from-building-agentic-systems-at-amazon/)
- [Top 9 AI Agent Frameworks March 2026 (Shakudo)](https://www.shakudo.io/blog/top-9-ai-agent-frameworks)

### 源码参考
- OpenAI Agents SDK: `/Volumes/leoyun/agentic/ref-repos/openai-agents-python/src/agents/`
- Swarms Framework: `/Volumes/leoyun/agentic/ref-repos/swarms/swarms/`
