> **[待定]** 核心底层选型仍在评估中。AutoGen/Semantic Kernel 是候选之一，MS SDK 同时作为执行层（见 13 号报告）。

# Microsoft Agent 框架全面评估：能否作为虚拟员工平台核心？

> 研究日期：2026-03-06
> 研究员：技术研究员
> 关联文档：`08-dynamic-agent-swarm-architecture.md`, `11-integration-blueprint.md`

---

## 摘要

本报告对 Microsoft Agent Framework 生态（AutoGen 0.4 + Semantic Kernel 合并后的统一框架）进行全面深度评估，回答一个核心问题：**微软的 Agent 框架能否作为我们虚拟员工平台的核心底层，而非仅仅是执行层？**

结论前置：**Microsoft Agent Framework 已经发展为一个相当成熟的多 Agent 编排框架，具备作为平台核心底层的技术能力，但存在架构灵活性和锁定风险的权衡。推荐采用方案 D（混合方案）作为最优路径。**

---

## 目录

1. [Microsoft Agent Framework 全景](#1-microsoft-agent-framework-全景)
2. [AutoGen 0.4 核心架构深度分析](#2-autogen-04-核心架构深度分析)
3. [Semantic Kernel Agent 能力分析](#3-semantic-kernel-agent-能力分析)
4. [Azure AI Foundry Agent Service](#4-azure-ai-foundry-agent-service)
5. [与 pi-ai + pi-agent-core 方案的正面对比](#5-与-pi-ai--pi-agent-core-方案的正面对比)
6. [混合方案评估](#6-混合方案评估)
7. [代码级验证](#7-代码级验证)
8. [最终结论与建议](#8-最终结论与建议)

---

## 1. Microsoft Agent Framework 全景

### 1.1 框架演进时间线

| 时间 | 事件 | 意义 |
|------|------|------|
| 2023 Q4 | AutoGen 0.2 发布 | 多 Agent 对话范式的先驱，学术导向 |
| 2025 Q1 | AutoGen 0.4 发布 | 完全重写，引入 actor 模型、事件驱动、分层架构 |
| 2025 Q2 | Semantic Kernel Agent 抽象成熟 | 企业级 Agent 框架，Process Framework 预览 |
| 2025 Q4 | **Microsoft Agent Framework 公开预览** | AutoGen + Semantic Kernel 合并为统一框架 |
| 2025 Q4 | Azure AI Foundry Agent Service GA | 托管 Agent 运行时上线 |
| 2026 Q1 | Agent Framework 进入 Release Candidate | API 稳定，所有 1.0 功能就绪 |
| 2026 Q1 (预计) | **Agent Framework 1.0 GA** | 正式生产级发布 |
| 2026 Q2 (预计) | Process Framework GA | 确定性业务流程编排 |

### 1.2 合并后的架构定位

Microsoft Agent Framework 的合并逻辑非常清晰：

- **Semantic Kernel 贡献**：类型安全的技能系统、Session/State 管理、中间件/过滤器、遥测、企业级集成
- **AutoGen 贡献**：简洁的多 Agent 抽象、动态编排模式（Group Chat/Handoff）、Actor 模型运行时
- **新增能力**：统一的工作流引擎、Graph-based 编排、MCP/A2A 协议原生支持

合并后，原有的 AutoGen 和 Semantic Kernel 将进入维护模式——仅接收安全补丁，不再新增功能。所有新的开发精力集中在 Agent Framework 上。

### 1.3 技术栈全貌

```
┌─────────────────────────────────────────────────────────────┐
│                Microsoft Agent Framework                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Agent Types   │  │ Workflows    │  │ Protocols        │  │
│  │ • ChatAgent   │  │ • Sequential │  │ • MCP (tool)     │  │
│  │ • A2A Agent   │  │ • Concurrent │  │ • A2A (agent)    │  │
│  │ • Anthropic   │  │ • Handoff    │  │ • AG-UI (UI)     │  │
│  │ • Custom      │  │ • Group Chat │  │ • OpenAPI        │  │
│  │              │  │ • Custom      │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ LLM Providers│  │ Runtime      │  │ Enterprise       │  │
│  │ • Azure OAI  │  │ • In-process │  │ • State/Threads  │  │
│  │ • OpenAI     │  │ • Distributed│  │ • Telemetry      │  │
│  │ • Anthropic  │  │ • Azure Host │  │ • Middleware      │  │
│  │ • Custom     │  │              │  │ • Auth (Entra)   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         ↓                    ↓                    ↓
┌─────────────────┐  ┌───────────────┐  ┌──────────────────┐
│ Process Framework│  │ Foundry Agent │  │ M365 Copilot     │
│ (确定性工作流)    │  │ Service (托管) │  │ (终端用户体验)    │
└─────────────────┘  └───────────────┘  └──────────────────┘
```

---

## 2. AutoGen 0.4 核心架构深度分析

### 2.1 vs 0.2 的根本性变化

AutoGen 0.4 是一次**彻底的重写**，与 0.2 几乎没有代码级兼容性：

| 维度 | AutoGen 0.2 | AutoGen 0.4 |
|------|-------------|-------------|
| 架构模型 | 函数调用链 | **Actor 模型** |
| 消息传递 | 同步、直接调用 | **异步消息队列** |
| Agent 通信 | 共享对话历史 | **事件驱动 Pub/Sub** |
| 运行时 | 单进程、紧耦合 | **分布式 Runtime（gRPC）** |
| API 分层 | 单层 API | **双层（Core + AgentChat）** |
| 扩展性 | 继承 + Override | **可插拔组件接口** |
| 类型系统 | 弱类型 | **强类型 + 接口强制** |

**关键变化解析：**

#### Actor 模型

AutoGen 0.4 Core 采用了 Actor 模型——每个 Agent 是一个独立的计算单元，管理自己的状态，仅通过消息与其他 Agent 交互。这意味着：

- Agent 之间**完全解耦**，可以独立部署、升级、销毁
- 消息传递可以跨进程、跨机器，天然支持分布式
- 状态隔离，一个 Agent 崩溃不影响其他 Agent

#### 分层 API

- **Core API**：底层 Actor 框架，提供 `AgentRuntime`、消息路由、订阅机制。最大灵活性。
- **AgentChat API**：建立在 Core 之上的高层 API，提供 `AssistantAgent`、`Team`（多 Agent 组）等开箱即用的抽象。

### 2.2 动态 Agent 创建与销毁

**支持程度：中等偏好**

AutoGen 0.4 Core 的 `AgentRuntime` 支持在运行时注册新 Agent：

```python
# Core API: 动态注册 Agent
runtime = SingleThreadedAgentRuntime()
await runtime.register("DynamicWorker", DynamicWorkerAgent, lambda: DynamicWorkerConfig(...))
```

Agent 可以通过消息触发动态创建新 Agent。`DistributedAgentRuntime` 中，Worker Runtime 可以动态加入和离开。但需注意：

- **没有内置的 Agent Pool 管理**——需要自行实现 Agent 池化、负载均衡
- **没有内置的自动扩缩容**——需要结合外部编排（如 Kubernetes）
- **Agent 销毁机制较原始**——主要依赖运行时的生命周期管理

对于我们的 Dynamic Hierarchical MoE 需求，Core API 提供了足够的原语（Agent 注册/注销、消息路由），但 MoE 的动态路由逻辑和专家选择策略需要自行实现。

### 2.3 多 Agent 编排能力

**编排模式（已合并到 Agent Framework）：**

| 模式 | 描述 | 灵活度 |
|------|------|--------|
| Sequential | 管道式，Agent 串行处理 | 低，固定顺序 |
| Concurrent | 并行处理，结果聚合 | 中，固定并行集 |
| Handoff | Agent 间交接控制权，Mesh 拓扑 | **高**，运行时动态路由 |
| Group Chat | 多 Agent 协作对话，编排器管理发言 | **高**，动态选择发言者 |
| Magnetic | 基于能力匹配的动态分配 | **高**，最接近 MoE |

**关键发现**：Handoff 和 Group Chat 模式是**动态的**，不是固定 DAG。特别是 Handoff 模式：

- 没有中心编排器，Agent 之间直接交接
- 基于运行时上下文决定交接目标
- 支持条件路由和内容路由（Content-Based Routing）

**对我们的启示**：Group Chat + Handoff 模式的组合可以实现我们 Dynamic Hierarchical MoE 中 Coordinator 到 Sub-Agent Pool 的动态路由。Coordinator 作为 Group Chat 的编排器，根据任务特征选择最合适的 Sub-Agent 进行 Handoff。

### 2.4 Agent 间通信机制

AutoGen 0.4 的通信基于**异步消息传递**，支持两种模式：

1. **事件驱动（Pub/Sub）**：Agent 发布消息到 Topic，订阅该 Topic 的 Agent 接收。适合广播式通知。
2. **请求/响应（Request/Response）**：Agent 直接向特定 Agent 发送消息并等待回复。适合委派任务。

通信通过 `AgentRuntime` 中介，解耦了 Agent 之间的直接依赖。在分布式模式下，消息通过 gRPC 传输。

**与我们需求的契合度**：
- 共识共享 → Pub/Sub 模式天然支持
- 任务委派 → Request/Response 模式直接映射
- 通信反馈 → 双向消息天然支持

### 2.5 分布式运行时

AutoGen 0.4 提供 `DistributedAgentRuntime`：

- 基于 **gRPC** 的 Worker Runtime
- 多个 Worker Runtime 可以部署在不同机器上
- 每个 Worker Runtime 托管一组 Agent
- 通过中央 Runtime 做消息路由

这为分布式部署提供了基础，但需注意：

- 当前实现相对简单，缺乏生产级的容错和恢复机制
- 没有内置的服务发现机制
- 需要自行处理 Worker Runtime 的故障转移

### 2.6 状态管理与持久化

**当前状态**：

- `save_state()` / `load_state()` 方法支持 Agent 状态序列化为 JSON
- 状态包括消息历史和元数据
- **没有内置的持久化存储后端**——需要自行实现（如 PostgreSQL、Redis）
- Process Framework（预计 2026 Q2 GA）将带来更完整的 checkpoint 和 human-in-the-loop 能力

### 2.7 MCP/A2A 支持

**MCP（Model Context Protocol）：原生支持**

- Agent Framework 支持连接 MCP Server，将外部工具暴露给 Agent
- 支持将 Agent 本身暴露为 MCP Tool
- Azure Foundry MCP Server（云托管）已上线，支持 Entra 认证
- 可以同时使用 MCP 和传统的 Plugin/Function 方式注册工具

**A2A（Agent-to-Agent Protocol）：原生支持**

- `agent-framework-a2a` 包（2026 年 2 月发布）
- 支持与任何实现 A2A 标准的 Agent 通信（包括 Google Vertex AI、LangChain 等）
- 支持 Key-based、OAuth2、Entra Agent Identity 三种认证方式

**AG-UI（Agent-User Interface Protocol）：已兼容**

### 2.8 自定义 LLM Provider

**完全支持**。这是一个关键发现：

- **Anthropic Claude**：有官方 NuGet 包 `Microsoft.Agents.AI.Anthropic`，Python 端通过 Claude Agent SDK 集成
- **OpenAI / Azure OpenAI**：原生支持
- **自定义 Provider**：实现 `BaseAgent` 接口即可，与 Provider 无关
- **多 Provider 混用**：同一个工作流中可以混用不同 LLM Provider 的 Agent

```python
# 不同 Provider 的 Agent 可以在同一工作流中协作
writer = Agent(client=AnthropicClient(), name="Writer", ...)
reviewer = Agent(client=OpenAIChatClient(), name="Reviewer", ...)
workflow = SequentialWorkflow(agents=[writer, reviewer])
```

这意味着我们可以用 Anthropic Claude 作为核心推理引擎，同时在特定场景使用 Azure OpenAI（如与 M365 深度集成时）。

---

## 3. Semantic Kernel Agent 能力分析

### 3.1 Agent 抽象层设计

Semantic Kernel 的 Agent 抽象现已融入 Agent Framework，核心贡献包括：

- **类型安全的技能系统**：通过 `@ai_function` 装饰器或 Plugin 定义工具，强类型接口
- **Session/Thread 管理**：内置会话管理，支持多轮对话的状态维护
- **中间件（Filters）**：请求/响应管道中的拦截器，可用于审计、限流、内容安全
- **遥测**：内置 OpenTelemetry 集成，分布式追踪开箱即用

### 3.2 Process Framework

Process Framework 是 Semantic Kernel 贡献的**确定性工作流引擎**，计划 2026 Q2 GA：

**核心特性：**
- 事件驱动的步骤编排
- 支持 Sequential、Parallel、Fan-in/Fan-out、Map-Reduce 模式
- 与分布式框架集成（Dapr、Orleans）
- 检查点（Checkpoint）和 Human-in-the-loop
- 支持可视化工作流设计

**关键定位差异：**
- **Agent Framework Workflow**：LLM 驱动的动态编排——Agent 根据上下文决定下一步
- **Process Framework**：确定性的业务流程——步骤和条件预定义，可预测、可审计

**对我们的意义**：虚拟员工的很多工作流（如审批流程、定期报表）需要确定性；而复杂问题解决需要 LLM 驱动。两者互补，Process Framework 可以处理我们的结构化工作流需求。

### 3.3 Plugin 系统 vs MCP

| 维度 | SK Plugin | MCP |
|------|-----------|-----|
| 定义方式 | 代码内定义（装饰器/类） | 外部 Server（独立进程） |
| 运行时 | 进程内 | 跨进程/跨网络 |
| 标准化 | 微软私有 | 开放标准 |
| 灵活性 | 高（完全控制） | 高（可连接任意 MCP Server） |
| 性能 | 更快（无网络开销） | 有网络开销 |
| 生态 | 微软生态 | 跨厂商通用 |

**结论**：MCP 是更前瞻的选择，但 Plugin 仍然有性能优势。Agent Framework 两者都支持。

### 3.4 多 LLM Provider 支持

Semantic Kernel 从设计之初就支持多 Provider：

- AI Service Selector 可以根据任务动态选择 Provider
- 支持 Azure OpenAI、OpenAI、Anthropic、Hugging Face、本地模型等
- **AI Connector 抽象**使得新增 Provider 只需实现一个接口

---

## 4. Azure AI Foundry Agent Service

### 4.1 定位

Azure AI Foundry Agent Service 是一个**托管的 Agent 运行时**，不是框架本身：

- **托管运行时**：自动扩缩容、监控、身份集成、安全
- **模型连接**：连接 Foundry 中的模型（Azure OpenAI、Anthropic on Azure 等）
- **工具编排**：管理对话、编排工具调用、内容安全
- **企业集成**：与 Entra（Azure AD）、VNet、Private Endpoint 集成

### 4.2 与 Agent Framework 的关系

```
Agent Framework (SDK)  ←→  Foundry Agent Service (Runtime)
   开发时使用                    部署时托管
   定义 Agent                   运行 Agent
   定义 Workflow               执行 Workflow
```

Foundry Agent Service 是 Agent Framework 的**云端运行时**，类比关系：
- Agent Framework ≈ Spring Framework
- Foundry Agent Service ≈ Azure App Service / AWS Lambda

### 4.3 多租户支持

- 基于 Azure Entra ID 的身份隔离
- 支持 VNet 网络隔离
- 按 Project/Resource Group 级别的资源隔离
- **但不提供应用级多租户**——这需要在应用层实现

### 4.4 政府云可用性

**当前状态：有限**

- Azure AI Foundry 在 Azure Government（GCC High）的部分服务可用
- Copilot 功能正在向 GCC High 扩展（2026 H1 计划）
- Agent Service 特定地，**尚未发现明确的 GCC/GCC High 可用性公告**
- Purview 等合规工具对 Agent 活动的监控已扩展到 GCC High

**风险评估**：如果客户有严格的政府合规需求（如 FedRAMP High、IL4/IL5），Agent Service 的可用性可能存在延迟。但 Agent Framework 作为 SDK 是开源的，可以自行部署在任何环境中。

---

## 5. 与 pi-ai + pi-agent-core 方案的正面对比

### 5.1 对比矩阵

| 维度 | pi-ai + pi-agent-core + 自研 | Microsoft Agent Framework | 评估 |
|------|------------------------------|--------------------------|------|
| **Agent Loop 灵活性** | **极高**。pi-agent-core 的 agentLoop 是请求-响应式，代码透明，可任意修改推理循环的每一步。 | **高**。BaseAgent 接口允许自定义推理循环，但 Workflow 编排层有固定模式（Sequential/Concurrent/Handoff/GroupChat），自定义需实现 Custom Orchestration。 | pi-ai 略胜，但差距不大 |
| **多 Agent 编排** | **需自研**。当前无多 Agent 机制，需要基于 08 号文档的 Dynamic Hierarchical MoE 从零构建。 | **开箱即用**。内置 5 种编排模式 + 自定义编排支持。Graph-based Workflow 支持条件路由、动态分支。 | **微软大幅领先** |
| **动态路由/MoE** | **需自研**。需要自行实现 Router、Agent Pool、能力评分等。参考 08 号文档的设计方案，估计 4-6 人月。 | **部分支持**。Handoff + Conditional Edge + Magnetic 模式可实现基本的动态路由。但 MoE 的专家选择/门控机制需要在 Custom Orchestration 中实现。 | 微软提供基础设施，但核心 MoE 逻辑都需自研 |
| **MCP 支持** | **需集成**。pi-agent-core 没有原生 MCP 支持，需要自行集成 MCP Client/Server SDK。 | **原生支持**。框架内置 MCP Client，支持连接任意 MCP Server。还可以将 Agent 暴露为 MCP Tool。 | **微软明显领先** |
| **A2A 支持** | **无**。需要从零实现或集成第三方。 | **原生支持**。官方 `agent-framework-a2a` 包，支持跨框架 Agent 通信。 | **微软明显领先** |
| **LLM Provider 灵活性** | **极高**。pi-ai 设计为 LLM 抽象层，理论上支持任意 Provider。 | **高**。官方支持 Azure OpenAI、OpenAI、Anthropic、GitHub Models。自定义 Provider 需要实现 AI Connector 接口。 | 基本持平 |
| **M365 集成深度** | **无**。需要通过 Graph API 从零集成。 | **深度集成**。与 Copilot、Teams、SharePoint 等原生集成。Foundry Agent Service 提供企业级连接器。 | **微软大幅领先** |
| **多租户** | **需自研**。需要从零构建租户隔离、数据隔离、配额管理。 | **部分支持**。Azure 基础设施提供资源级隔离（Entra ID + VNet），但应用级多租户仍需自行实现。 | 微软有基础设施优势 |
| **政府云** | **灵活**。自研方案可部署在任何环境，包括 Air-gapped 网络。 | **受限**。Agent Service 在 GCC High 的可用性不确定。但 SDK 是开源的，可自部署。 | 自研方案更灵活 |
| **社区/生态** | **极小**。pi-mono 是小型开源项目（mariozechner 个人项目），社区几乎为零。 | **庞大**。Semantic Kernel 27K+ GitHub Stars，微软官方支持，丰富的文档、示例、教程。 | **微软大幅领先** |
| **学习曲线** | **中等**。代码简洁直观，但文档少，需要阅读源码。 | **中等偏高**。概念多（Agent/Workflow/Edge/Orchestration/Process），但文档完善。 | 基本持平 |
| **锁定风险** | **低**。开源、轻量，随时可替换任何组件。 | **中等**。SDK 开源，但深度使用 Foundry Agent Service 后迁移成本高。A2A/MCP 等开放标准降低了部分锁定风险。 | 自研方案锁定风险更低 |
| **生产就绪度** | **低**。agentLoop 为交互式编码设计，缺乏分布式、容错、审计等生产级特性。需大量改造（参考 11 号文档）。 | **高**。RC 状态，2026 Q1 GA。内置遥测、中间件、认证、状态管理。 | **微软大幅领先** |
| **开发效率** | **慢**。核心基础设施需从零构建，估计 6-12 人月才能达到基本的多 Agent 编排能力。 | **快**。多 Agent 编排开箱即用，20 行代码即可启动基本工作流。估计 2-3 人月可达到同等能力。 | **微软大幅领先** |

### 5.2 深度分析：三个关键维度

#### 维度一：谁更适合做 Dynamic Hierarchical MoE？

我们的核心架构是 Dynamic Hierarchical MoE——Coordinator 动态路由到 Sub-Agent Pool。

**pi-ai + pi-agent-core 方案**：
- 优势：完全自定义 Coordinator 的决策逻辑，可以精确控制门控网络、专家选择策略
- 劣势：所有基础设施（消息传递、Agent 生命周期、状态管理）需从零构建

**Microsoft Agent Framework 方案**：
- 优势：Handoff 模式提供 Agent 间交接原语，Group Chat 提供编排器模式，Conditional Edge 提供路由基础，分布式 Runtime 提供跨进程 Agent 通信
- 劣势：MoE 的"门控网络"概念需要映射为 Custom Orchestration，不是开箱即用

**结论**：Microsoft Agent Framework 提供了 70% 的基础设施，剩余 30% 的 MoE 特定逻辑需要在其上构建。而 pi-ai 方案需要从零构建 100%。从效率角度，**微软方案胜出**。

#### 维度二：决策与执行的分离

我们最初的假设是决策层和执行层分离——pi-ai 做决策，微软 SDK 做执行。

**新的发现**：Agent Framework 的 Workflow + Custom Orchestration 机制实际上允许我们在框架内实现决策逻辑：
- Custom Orchestration 可以注入自定义的路由/决策逻辑
- Agent 的 `instructions`（系统提示）控制 Agent 的决策行为
- Middleware/Filters 可以在决策链路中插入自定义逻辑

因此，如果使用 Agent Framework 作为核心，决策与执行**可以统一在一个框架内**，不必强制分离。但如果需要极端灵活性（如切换不同的决策引擎），分离仍然有价值。

#### 维度三：长期战略风险

**pi-ai + pi-agent-core 风险**：
- 开发团队规模极小（个人项目），可能面临维护者弃坑风险
- 需要大量自研投入，人力成本高
- 缺乏社区验证，潜在 bug 和安全风险

**Microsoft Agent Framework 风险**：
- 框架方向受微软战略影响（如：AutoGen 0.2 → 0.4 的断裂性变更）
- 深度依赖后迁移成本高（特别是使用 Foundry Agent Service 后）
- 微软可能在商业模式上对高级功能收费（Foundry Agent Service 计划 2026.4 开始计费）
- 开放标准（MCP/A2A）一定程度上对冲了锁定风险

---

## 6. 混合方案评估

### 方案 A：pi-ai + pi-agent-core 做核心，微软 SDK 做执行

```
┌──────────────────────────────────┐
│ pi-agent-core (决策核心)          │
│   Agent Loop, MoE Router         │
│   ↓                              │
│ Microsoft SDK (执行层)            │
│   M365 Connectors, Graph API     │
└──────────────────────────────────┘
```

| 维度 | 评估 |
|------|------|
| 技术可行性 | 可行，但集成点多，需要桥接两套 Agent 抽象 |
| 开发效率 | **低**。需要同时维护两套系统，接口适配工作量大 |
| 长期风险 | 中。pi-agent-core 社区小，但可控 |
| 客户生态契合 | 差。客户期望看到微软技术栈，pi-agent-core 缺乏品牌认知 |

**评分：5/10** — 这是我们的原始假设，但在了解 Agent Framework 的能力后，这个方案的性价比明显不足。

### 方案 B：AutoGen/Agent Framework 做核心，pi-ai 做 LLM 抽象

```
┌──────────────────────────────────┐
│ Agent Framework (编排核心)        │
│   Workflow, Orchestration        │
│   ↓                              │
│ pi-ai (LLM 抽象层)               │
│   Model switching, Anthropic     │
└──────────────────────────────────┘
```

| 维度 | 评估 |
|------|------|
| 技术可行性 | **低**。Agent Framework 已有完善的 AI Connector 抽象和多 Provider 支持（包括 Anthropic），pi-ai 的 LLM 抽象层变得冗余 |
| 开发效率 | 中。引入不必要的抽象层增加了复杂度 |
| 长期风险 | 高。维护一个与框架功能重叠的抽象层没有意义 |
| 客户生态契合 | 中。主体用微软，但引入了不必要的组件 |

**评分：3/10** — Agent Framework 自身已经解决了 LLM 抽象问题，不需要 pi-ai。

### 方案 C：完全基于 Microsoft Agent Framework

```
┌──────────────────────────────────┐
│ Agent Framework (全栈)            │
│   Agent 定义                      │
│   Multi-Agent Workflow           │
│   MCP/A2A Protocols              │
│   ↓                              │
│ Foundry Agent Service (运行时)    │
│   托管, 监控, 安全                │
│   ↓                              │
│ M365 Integration                 │
│   Copilot, Teams, SharePoint     │
└──────────────────────────────────┘
```

| 维度 | 评估 |
|------|------|
| 技术可行性 | **高**。框架能力覆盖我们 80% 以上的需求 |
| 开发效率 | **最高**。统一技术栈，文档完善，社区活跃 |
| 长期风险 | **高**。深度绑定微软生态，政府云可用性不确定 |
| 客户生态契合 | **最高**。客户认知度和信任度最高 |

**评分：7/10** — 对于大多数场景是最优选择，但锁定风险和政府云可用性是硬伤。

### 方案 D：Agent Framework 做多 Agent 编排 + 自研 Virtual Employee Runtime（推荐）

```
┌──────────────────────────────────────────────────────┐
│ 自研层 (Virtual Employee Runtime)                     │
│   ┌──────────────┐  ┌──────────────┐                │
│   │ MoE Router   │  │ YAML Config  │                │
│   │ (门控网络)    │  │ (角色定义)    │                │
│   └──────┬───────┘  └──────┬───────┘                │
│          │                 │                         │
│   ┌──────▼─────────────────▼───────────────────┐    │
│   │ Agent Lifecycle Manager                     │    │
│   │ (动态创建/销毁/池化/健康检查)                │    │
│   └──────┬─────────────────────────────────────┘    │
│          │                                           │
│   ┌──────▼─────────────────────────────────────┐    │
│   │ Multi-Tenant State Store                    │    │
│   │ (租户隔离的状态持久化)                       │    │
│   └──────┬─────────────────────────────────────┘    │
│          │                                           │
│   ┌──────▼─────────────────────────────────────┐    │
│   │ Audit & Compliance Engine                   │    │
│   │ (审计日志、合规检查、政府云适配)              │    │
│   └──────────────────────────────────────────────┘    │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│ Microsoft Agent Framework (编排核心)                   │
│   • Agent 定义 (ChatAgent / Custom Agent)             │
│   • Workflow 编排 (Handoff / GroupChat / Custom)      │
│   • MCP/A2A 协议通信                                  │
│   • LLM Provider 管理 (Anthropic + Azure OpenAI)      │
│   • OpenTelemetry 遥测                                │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│ 部署层 (可选)                                         │
│   • Azure Foundry Agent Service (商业客户)            │
│   • 自托管 Kubernetes (政府/合规客户)                   │
└──────────────────────────────────────────────────────┘
```

| 维度 | 评估 |
|------|------|
| 技术可行性 | **高**。利用 Agent Framework 的编排能力，自研补充 MoE/租户/审计 |
| 开发效率 | **高**。框架提供 70% 基础设施，自研 30% 差异化能力 |
| 长期风险 | **可控**。通过自研层解耦，可以替换底层框架；MCP/A2A 标准保障互操作 |
| 客户生态契合 | **高**。对外展示微软技术栈，内部保持架构灵活性 |

**评分：9/10** — 推荐方案。兼顾效率、灵活性和风险控制。

### 方案 E：Agent Framework + Process Framework 双轨制

这是方案 D 的增强版——将 Process Framework 纳入考量：

```
虚拟员工的两类工作：
  ├── 开放式问题解决 → Agent Framework Workflow (LLM 驱动)
  │     例：分析报告撰写、复杂客户咨询
  │
  └── 结构化业务流程 → Process Framework (确定性编排)
        例：审批流、定期报表、合规检查
```

| 维度 | 评估 |
|------|------|
| 技术可行性 | 高，但 Process Framework 要到 2026 Q2 才 GA |
| 开发效率 | 长期更高——结构化流程不需要 LLM 推理，降低成本 |
| 长期风险 | 与方案 D 类似 |
| 客户生态契合 | 最高——结构化流程对企业客户非常有吸引力 |

**评分：9/10（长期）/ 7/10（短期，因 Process Framework 未 GA）**

---

## 7. 代码级验证

### 7.1 Agent 定义方式

```python
# Microsoft Agent Framework - Agent 定义
from agent_framework import Agent, OpenAIChatClient

# 最简定义：20 行以内
agent = Agent(
    client=OpenAIChatClient(),
    name="VirtualEmployee",
    instructions="""
    你是一位虚拟财务分析师。你的职责包括：
    1. 分析财务数据并生成报告
    2. 回答关于预算和支出的问题
    3. 对异常交易发出预警
    """,
)

# 使用 Anthropic Claude
from agent_framework_anthropic import AnthropicChatClient

claude_agent = Agent(
    client=AnthropicChatClient(model="claude-opus-4-6"),
    name="StrategicPlanner",
    instructions="你是一位战略规划专家...",
)
```

### 7.2 多 Agent 协作的代码模式

```python
from agent_framework import Agent, SequentialWorkflow, HandoffWorkflow

# 定义专家 Agent 池
researcher = Agent(client=client, name="Researcher", instructions="...")
analyst = Agent(client=client, name="Analyst", instructions="...")
writer = Agent(client=client, name="Writer", instructions="...")
reviewer = Agent(client=client, name="Reviewer", instructions="...")

# 模式 1: Sequential（管道式）
pipeline = SequentialWorkflow(agents=[researcher, analyst, writer, reviewer])
result = await pipeline.run("分析 Q1 财务数据并生成报告")

# 模式 2: Handoff（交接式 — 最接近我们的动态路由）
# Agent 可以根据上下文将控制权交给最合适的 Agent
coordinator = Agent(
    client=client,
    name="Coordinator",
    instructions="根据用户需求，将任务交给最合适的专家。",
    handoffs=[researcher, analyst, writer, reviewer],  # 可交接的目标
)
workflow = HandoffWorkflow(agents=[coordinator, researcher, analyst, writer, reviewer])
result = await workflow.run("我需要一份市场分析报告")

# 模式 3: Group Chat（协作对话）
from agent_framework import GroupChatWorkflow

group = GroupChatWorkflow(
    agents=[analyst, writer, reviewer],
    max_rounds=10,
    # 自定义选择下一个发言者的策略
    speaker_selection="auto",  # 或 "round_robin" 或自定义函数
)
result = await group.run("讨论 Q1 表现并形成共识")
```

### 7.3 工具注册和调用

```python
from agent_framework import Agent, ai_function

# 方式 1: @ai_function 装饰器（原 Semantic Kernel 的 Plugin 模式）
@ai_function(description="查询数据库中的财务数据")
async def query_financial_data(quarter: str, metric: str) -> str:
    # 实际查询逻辑
    result = await db.query(f"SELECT {metric} FROM financials WHERE quarter = '{quarter}'")
    return json.dumps(result)

agent = Agent(
    client=client,
    name="FinanceBot",
    instructions="...",
    tools=[query_financial_data],
)

# 方式 2: MCP Server 集成
from agent_framework import McpToolProvider

mcp_tools = McpToolProvider(
    server_url="http://localhost:8080/mcp",  # 或远程 MCP Server
    # 或使用 Azure Foundry MCP Server
    # server_url="https://mcp.ai.azure.com",
    # credentials=EntraCredentials(...)
)

agent = Agent(
    client=client,
    name="FinanceBot",
    instructions="...",
    tools=[query_financial_data, mcp_tools],  # 混用本地工具和 MCP
)
```

### 7.4 自定义 LLM Provider

```python
# Anthropic Claude（官方支持）
from agent_framework_anthropic import AnthropicChatClient

claude_client = AnthropicChatClient(
    api_key="sk-ant-...",
    model="claude-opus-4-6",
)

# Azure 上的 Anthropic（通过 Foundry）
from agent_framework import FoundryChatClient

foundry_claude = FoundryChatClient(
    endpoint="https://xxx.api.azureml.ms",
    deployment="claude-opus-4-6",
    credential=DefaultAzureCredential(),
)

# 自定义 Provider（实现接口即可）
from agent_framework import ChatClient, ChatMessage, ChatResponse

class CustomLLMClient(ChatClient):
    async def complete(self, messages: list[ChatMessage], **kwargs) -> ChatResponse:
        # 调用你的自定义 LLM
        response = await self.custom_api.call(messages)
        return ChatResponse(content=response.text)
```

### 7.5 映射到我们的 Dynamic Hierarchical MoE

```python
# 概念验证：用 Agent Framework 实现 MoE 路由
from agent_framework import Agent, GroupChatWorkflow

# 1. 定义 Sub-Agent Pool（专家池）
expert_pool = {
    "finance": Agent(client=claude, name="FinanceExpert", instructions="..."),
    "legal": Agent(client=claude, name="LegalExpert", instructions="..."),
    "hr": Agent(client=claude, name="HRExpert", instructions="..."),
    "tech": Agent(client=claude, name="TechExpert", instructions="..."),
}

# 2. MoE Coordinator（门控网络 — 用 Custom Orchestration 实现）
class MoEOrchestration:
    """自定义编排：实现 MoE 门控逻辑"""

    async def select_experts(self, task: str) -> list[Agent]:
        """根据任务选择最合适的专家组合"""
        # 方式 A: 用 LLM 做路由决策
        routing_result = await self.router_agent.run(
            f"分析以下任务需要哪些专家参与: {task}"
        )
        selected = parse_expert_selection(routing_result)
        return [expert_pool[name] for name in selected]

    async def run(self, task: str) -> str:
        # 动态选择专家
        experts = await self.select_experts(task)

        # 根据专家数量选择编排模式
        if len(experts) == 1:
            return await experts[0].run(task)
        else:
            # 多专家协作
            group = GroupChatWorkflow(agents=experts, max_rounds=5)
            return await group.run(task)
```

---

## 8. 最终结论与建议

### 8.1 核心结论

**Microsoft Agent Framework 具备作为虚拟员工平台核心底层的技术能力**，理由如下：

1. **多 Agent 编排**已经成熟——5 种内置模式 + 自定义编排，覆盖我们的大部分需求
2. **MCP/A2A 原生支持**——不需要自行实现协议层
3. **多 LLM Provider**——官方支持 Anthropic，可在同一工作流混用不同 Provider
4. **企业级特性**——遥测、中间件、认证、状态管理开箱即用
5. **社区和生态**——27K+ Stars，微软官方支持，丰富的文档和示例
6. **即将 GA**——2026 Q1，正好匹配我们的时间线

但**不建议完全依赖微软**，理由如下：

1. **MoE 门控逻辑**需要自研——框架提供原语但不提供 MoE 特定抽象
2. **多租户**需要自研——框架提供基础设施级隔离，不提供应用级多租户
3. **政府云**可用性不确定——Agent Service 托管运行时的 GCC High 支持未明确
4. **锁定风险**——深度使用 Foundry Agent Service 后迁移成本高

### 8.2 推荐方案：方案 D（混合架构）

**Microsoft Agent Framework 做编排核心 + 自研 Virtual Employee Runtime 做差异化**

具体技术路线：

| 阶段 | 时间 | 内容 |
|------|------|------|
| Phase 1 | 2026 Q1-Q2 | 基于 Agent Framework RC/GA 搭建 PoC，验证多 Agent 编排、MCP 集成、Anthropic Claude 作为主 LLM |
| Phase 2 | 2026 Q2-Q3 | 构建 Virtual Employee Runtime 自研层——MoE Router、YAML 配置加载、多租户状态管理 |
| Phase 3 | 2026 Q3-Q4 | 集成 Process Framework（预计 Q2 GA），实现结构化工作流；合规/审计引擎 |
| Phase 4 | 2026 Q4+ | 政府云适配（自托管 K8s 部署方案）、A2A 跨系统集成 |

### 8.3 关键决策点

1. **放弃 pi-ai + pi-agent-core 作为核心**——其价值不足以支撑从零构建的成本。Agent Framework 提供了更完善的基础设施。

2. **保留自研层的战略价值**——MoE Router、多租户、审计引擎是我们的差异化竞争力，不应交给第三方框架。

3. **Anthropic Claude 作为主 LLM**——Agent Framework 官方支持，无需额外适配。在需要 M365 深度集成时可回退到 Azure OpenAI。

4. **MCP 优先于私有 Plugin**——所有新的工具集成优先使用 MCP 协议，保障互操作性和可移植性。

5. **部署灵活性**——商业客户用 Foundry Agent Service，政府/合规客户用自托管 Kubernetes。Agent Framework SDK 是开源的，支持两种模式。

### 8.4 风险缓解

| 风险 | 缓解措施 |
|------|----------|
| Agent Framework 1.0 延期 | RC 已稳定，可基于 RC 开发；关注 GitHub Releases |
| 微软方向大变（如再次重写） | 自研层做解耦隔离；核心业务逻辑不直接依赖框架内部 API |
| Foundry Agent Service 定价过高 | 保持自托管能力，不过度依赖托管服务 |
| 政府云支持延迟 | 自托管 K8s 方案作为 Plan B，SDK 开源可自部署 |
| Anthropic on Azure 服务中断 | 支持直连 Anthropic API 作为后备 |

---

## 附录：参考来源

### 官方文档与博客
- [AutoGen v0.4: Reimagining the foundation of agentic AI](https://www.microsoft.com/en-us/research/blog/autogen-v0-4-reimagining-the-foundation-of-agentic-ai-for-scale-extensibility-and-robustness/)
- [AutoGen reimagined: Launching AutoGen 0.4](https://devblogs.microsoft.com/autogen/autogen-reimagined-launching-autogen-0-4/)
- [Semantic Kernel Agent Framework](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/)
- [Semantic Kernel Multi-Agent Orchestration](https://devblogs.microsoft.com/semantic-kernel/semantic-kernel-multi-agent-orchestration/)
- [Semantic Kernel + AutoGen = Open-Source Microsoft Agent Framework](https://visualstudiomagazine.com/articles/2025/10/01/semantic-kernel-autogen--open-source-microsoft-agent-framework.aspx)
- [Microsoft Agent Framework Overview](https://learn.microsoft.com/en-us/agent-framework/overview/)
- [Microsoft Agent Framework Workflows](https://learn.microsoft.com/en-us/agent-framework/workflows/)
- [Introducing Microsoft Agent Framework](https://azure.microsoft.com/en-us/blog/introducing-microsoft-agent-framework/)
- [Microsoft Agent Framework Reaches Release Candidate](https://devblogs.microsoft.com/foundry/microsoft-agent-framework-reaches-release-candidate/)
- [Workflow Orchestrations in Agent Framework](https://learn.microsoft.com/en-us/agent-framework/user-guide/workflows/orchestrations/overview)

### MCP/A2A 协议
- [Using MCP Tools in Agent Framework](https://learn.microsoft.com/en-us/agent-framework/user-guide/model-context-protocol/using-mcp-tools)
- [A2A Integration](https://learn.microsoft.com/en-us/agent-framework/user-guide/agents/agent-types/a2a-agent)
- [Foundry MCP Server Preview](https://visualstudiomagazine.com/articles/2025/12/04/microsoft-previews-cloud-hosted-foundry-mcp-server-for-ai-agent-development.aspx)

### LLM Provider
- [Anthropic Agents in Agent Framework](https://learn.microsoft.com/en-us/agent-framework/agents/providers/anthropic)
- [Build AI Agents with Claude Agent SDK and Microsoft Agent Framework](https://devblogs.microsoft.com/semantic-kernel/build-ai-agents-with-claude-agent-sdk-and-microsoft-agent-framework/)
- [Claude Opus 4.6 available in Microsoft Foundry](https://azure.microsoft.com/en-us/blog/claude-opus-4-6-anthropics-powerful-model-for-coding-agents-and-enterprise-workflows-is-now-available-in-microsoft-foundry-on-azure/)

### 运行时与分布式
- [Distributed Agent Runtime (AutoGen)](https://microsoft.github.io/autogen/stable//user-guide/core-user-guide/framework/distributed-agent-runtime.html)
- [Hosted Agents in Foundry Agent Service](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents?view=foundry)
- [Foundry Agent Service at Ignite 2025](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/foundry-agent-service-at-ignite-2025-simple-to-build-powerful-to-deploy-trusted-/4469788)

### 社区与分析
- [Microsoft Agent Framework: Production-Ready Convergence](https://cloudsummit.eu/blog/microsoft-agent-framework-production-ready-convergence-autogen-semantic-kernel/)
- [Demystifying Custom Orchestration in Agent Framework](https://tech.hub.ms/2026-03-02-Demystifying-Custom-Orchestration-in-Microsoft-Agent-Framework-Workflows.html)
- [Agent Framework on GitHub](https://github.com/microsoft/agent-framework)
- [Semantic Kernel Agent Orchestration](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/)
- [AutoGen to Microsoft Agent Framework Migration Guide](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/)
- [Migrate Semantic Kernel and AutoGen to Agent Framework RC](https://devblogs.microsoft.com/semantic-kernel/migrate-your-semantic-kernel-and-autogen-projects-to-microsoft-agent-framework-release-candidate/)
