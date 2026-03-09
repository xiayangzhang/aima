# Rust AI Agent 框架调研报告

> 研究日期：2026-03-07
> 研究目标：评估 Rust 生态中的 AI Agent 框架，作为 pi-mono（TypeScript）的替代或补充方案
> 前置报告：`research/architecture/17-pi-mono-ecosystem-update.md`、`research/architecture/06-pi-mono-deep-dive.md`

---

## 目录

1. [当前主流 Rust AI Agent 框架](#1-当前主流-rust-ai-agent-框架)
2. [Rust vs TypeScript 在 Agent 场景的实际权衡](#2-rust-vs-typescript-在-agent-场景的实际权衡)
3. [Rig 深度评估](#3-rig-深度评估)
4. [混合架构可能性](#4-混合架构可能性)
5. [框架对比总表](#5-框架对比总表)
6. [结论与建议](#6-结论与建议)

---

## 1. 当前主流 Rust AI Agent 框架

### 1.1 Rig（0xPlaygrounds/rig）— 主要候选

**定位**：Rust 生态目前最成熟、社区最活跃的 LLM 应用开发框架，覆盖从 RAG 管道到 Agent 系统的完整需求。

**关键指标**（截至 2026-02）：
- GitHub Stars：**~6,200**，Forks：671
- 最新版本：v0.31.0（活跃迭代中，重大版本号每月推进）
- 维护状态：0xPlaygrounds 团队全职维护，2025-2026 年内发布了大量破坏性更新

**核心功能**：
- 统一 LLM 接口（Provider-agnostic，Builder Pattern + async/await via Tokio）
- Agent loop + Tool calling（含 ToolSet、动态工具基于向量检索）
- RAG 管道构建
- MCP 支持：v0.11 加入 MCP Agent Builder 支持，通过 `rmcp` crate 集成（官方 Rust MCP SDK）
- 多 Agent：支持 agent-as-tool 模式（agent 作为另一个 agent 的工具调用），`agent_with_agent_tool.rs` 示例可用
- 流式响应、结构化提取

**Provider 支持**：OpenAI、Anthropic、Azure OpenAI、Cohere、DeepSeek、Google Gemini、Groq、HuggingFace、Hyperbolic、VertexAI 等 15+ 供应商

**社区与生态**：
- Coral Protocol 深度使用 Rig 构建其协议层
- `rigs`（M4n5ter/rigs）是基于 Rig 的 Agent 编排框架，社区衍生
- 知名用户：St Jude 基因组可视化 chatbot、VT Code（Rust 终端编程 Agent）
- 有围绕它构建的 MCP 集成库：`mcp-rig`（tim-schultz/mcp-rig）

**弱点**：
- 原生 Hook/Middleware 系统相对薄弱——框架本身不提供 Governance 层，需要自行在 Tool 或 Agent wrapper 层实现
- 版本迭代快，breaking changes 频繁（如 v0.31 要求 schemars v1.0）
- 多 Agent 协调更多是 "agent-as-tool" 模式，不是显式的 Swarm/Multi-Agent 编排原语

---

### 1.2 AutoAgents（liquidos-ai/AutoAgents）

**定位**：原生多 Agent 框架，基于 Ractor（Erlang/Akka 风格 Actor 模型）构建，专注于 production 部署，含边缘端支持。

**关键指标**：
- GitHub：`liquidos-ai/AutoAgents`，活跃维护
- 背后公司：LiquidOS（LiquidOS Platform 产品即将推出，面向嵌入式/机器人/本地 Agent 场景）
- 在 Hacker News 上有独立讨论帖，获得一定关注

**核心功能**：
- 基于 Actor 模型（Ractor）的原生多 Agent 架构
- ReAct 推理循环（Thought → Action → Observation）
- SlidingWindowMemory 内存管理，路线图含 RAG
- 部署目标：云原生 Agent、边缘 Agent、WASM 浏览器端
- 类型安全工具调用（Rust struct + serde 验证）
- 可插拔 LLM 后端（autoagents-llm crate）

**性能基准**（2026 年公开 benchmark vs Python 框架）：
- 内存峰值：1,046 MB vs Python 平均 5,146 MB（节省约 5x）
- 吞吐量：4.97 rps vs Python 平均 3.66 rps（高 36%），vs LangGraph 高 84%
- 冷启动：4 ms vs 60,140 ms（Serverless 场景关键指标）

**弱点**：
- Actor 模型（Ractor）的心智模型与认知分区 Swarm 架构存在一定阻抗——Ractor 偏向显式消息传递式分布式系统，而非自主 Agent 推理
- MCP 支持情况未公开文档化（需进一步验证）
- 生态成熟度不及 Rig，第三方集成较少
- 社区规模相对较小

---

### 1.3 Swiftide（bosun-ai/swiftide）

**定位**：流式 LLM 应用框架，原本聚焦 RAG/Indexing 管道，v0.26 后加入 Agent 能力。

**关键指标**：
- GitHub Stars：**~628**，Forks：51（明显小于 Rig）
- 维护状态：bosun-ai 团队维护，活跃但规模较小

**核心功能**：
- 流式索引管道（Loader → Transformer → Store）
- v0.26 起支持 Agent + Tool calling
- **原生 Hook 系统**：在 Agent 生命周期关键节点（新消息后、工具调用后、所有操作前）注入自定义逻辑
- MCP 支持：通过 `rmcp` crate 集成，所有 transport 均支持
- 集成：OpenAI、Groq、Gemini、Anthropic、Redis、Qdrant、Ollama、FastEmbed-rs、LanceDB 等

**亮点**：Swiftide 是上述三个框架中**唯一**原生提供 Hook/Lifecycle 回调的，这直接对应我们的 Governance 层需求。

**弱点**：
- 社区规模显著偏小（628 stars），生产案例稀少
- Agent 能力是相对较新的加入（v0.26），不如 Rig 成熟
- 没有原生多 Agent 支持
- 仍处于 "heavy development"，文档可能滞后

---

### 1.4 其他值得关注的项目

| 项目 | 定位 | 说明 |
|------|------|------|
| `genai`（jeremychone/rust-genai） | 多 Provider LLM 客户端 | 不是 Agent 框架，但提供干净的多 Provider 统一 API，可作为底层 LLM 客户端 |
| `pi_agent_rust` | pi-mono 的 Rust 移植 | 保持 pi 的 UX，Arc/Cow 消息流，零 GC，已含 extension policy profile（safe/balanced/permissive），但社区极小 |
| `rigs` | 基于 Rig 的编排层 | Rig 的社区衍生 orchestration 框架 |
| `agentai` | 简单 Agent 库 | AdamStrojek/rust-agentai，小型项目，不成熟 |

---

## 2. Rust vs TypeScript 在 Agent 场景的实际权衡

### 2.1 性能优势的量化

| 指标 | Rust 框架 | Python/TS 框架 | 说明 |
|------|-----------|----------------|------|
| 内存峰值 | ~1 GB | ~5 GB | 约 5x 优势，AutoAgents benchmark |
| CPU 占用 | ~24% | ~80%+ | Rig benchmark |
| 冷启动 | 4 ms | 60,000+ ms | Serverless/K8s 场景 |
| GC 停顿 | 无 | 有（V8/JVM） | 影响 P99 延迟 |
| MCP 实现 | 16x 更快，50x 内存 | 基准 | pmcp 对 TypeScript 实现的对比 |

### 2.2 这些优势在我们场景（政府/企业 workflow）中的实质意义

**有实质意义的情况**：
- **高并发 Agent 运行**：如果一个虚拟员工平台同时服务数百个用户会话，Rust 的内存效率在 AKS 节点成本上有直接收益
- **长会话（100k-5M token）**：大 context 下 Rust 的无 GC 特性避免了 V8 在 GC 时产生的不可预测停顿
- **MCP 服务端**：作为 MCP Server 处理大量工具调用请求时，Rust 吞吐量优势明显

**优势有限的情况**：
- **等待 LLM 响应期间**：Agent 大部分时间在等 LLM，这一阶段 Rust/TS 差异几乎不可见
- **政府云 workflow**：Teams 消息、Power Automate 调用、审批流 —— 大量时间花在 I/O 等待上，语言性能不是瓶颈
- **低并发初期**：POC 阶段并发量低，性能差异无感知

### 2.3 TypeScript 的实际劣势评估

| 劣势 | 严重程度 | 说明 |
|------|----------|------|
| V8 GC 停顿 | 中等 | 长会话可能出现几十到几百 ms 停顿，但 LLM 延迟本身是秒级，相对影响小 |
| 内存占用 | 中等 | 对 AKS 节点密度有影响，但可通过垂直扩展解决 |
| 类型安全 | 低 | TypeScript 有足够的类型系统，与 Rust 的编译时保证有差距但实践中可管理 |
| 依赖安全 | 低-中 | npm 生态供应链风险，政府场景需要 SBOM，但这是流程问题非语言问题 |
| 生态碎片化 | 正面 | npm 生态**更丰富**，尤其是 Microsoft SDK、Teams SDK、Power Platform 集成 |

**结论**：TypeScript 在 Agent workflow 场景（I/O 密集型、LLM 延迟主导）中的劣势**被夸大了**。Rust 的性能优势在 CPU 密集型计算（向量处理、数据编码、MCP Server）中才真正显现。

---

## 3. Rig 深度评估

### 3.1 Agent Loop 设计

Rig 的 Agent 核心采用**标准 ReAct/Tool-Use 循环**：
1. 发送 prompt + 工具定义到 LLM
2. 解析 LLM 响应（文本 or 工具调用）
3. 执行工具调用，获取结果
4. 将工具结果追加到 context，重复循环直到 LLM 返回最终文本

**与 pi-mono 4-hook 模型对比**：
- pi-mono 的 `before_tool`、`after_tool`、`before_llm`、`after_llm` 四钩子在 Rig 中**没有对应原语**
- Rig 的扩展点主要是：自定义 Tool 实现、自定义 LLM Provider、ToolSet 的 RAG 检索策略
- Governance/Audit Hook 需要在 Tool wrapper 层自行实现，或包装 Agent 本身

### 3.2 多 Provider 支持

| Provider | 状态 |
|----------|------|
| OpenAI | 完整支持 |
| Anthropic | 完整支持 |
| Azure OpenAI | 完整支持（`rig-azure` crate） |
| Google Gemini / VertexAI | 支持 |
| DeepSeek | 支持 |
| Groq | 支持 |
| Ollama（本地） | 支持 |
| Cohere | 支持 |
| Azure Government | **未显式支持**——Azure OpenAI 集成理论上可指向 Azure Government endpoint，但需自行配置，文档未覆盖 |

### 3.3 MCP 支持

- v0.11 正式加入 MCP Agent Builder 支持
- 通过 `rmcp`（官方 Rust MCP SDK）桥接，所有 transport（stdio、SSE、HTTP Streamable）支持
- ToolServer 可同时持有 static tools、dynamic tools 和 MCP tools，多 Agent 共享 ToolServer
- 社区有独立 `mcp-rig` crate 进一步简化集成

### 3.4 子 Agent / 多 Agent 支持

**当前状态**：支持但原语级别有限
- `agent_with_agent_tool.rs` 示例：将 Agent 作为 Tool 暴露给另一个 Agent
- 这实现了**层级式委托**（Router → Worker），但不是显式的 Swarm/Cognitive Partition 原语
- 没有内置的 Swarm 协调机制，"统一意识"需要在应用层自行实现
- `rigs`（社区 fork）提供了更高层的编排原语，但成熟度不明

### 3.5 社区与生态

| 维度 | 评价 |
|------|------|
| GitHub Stars | ~6,200（Rust AI 框架中最高） |
| Issue/PR 活跃度 | 高，v0.31 发布讨论 #1406 有活跃讨论 |
| 衍生项目 | `mcp-rig`、`rigs`、Coral Protocol 集成 |
| 文档质量 | 中等，docs.rig.rs 有完整 API 文档，但高级模式文档薄弱 |
| 类比 OpenClaw | **无**——Rig 生态没有类似 OpenClaw 这样的大型社区应用项目作为参考实现 |

### 3.6 Azure Government 兼容性

- Rig 的 Azure OpenAI 集成使用标准 REST API，理论上可指向 Azure Government endpoint（`*.openai.azure.us`）
- 实际操作中需要手动配置 base URL，Rig 未提供专门的 Azure Government 配置选项
- 没有公开的 Azure Government 部署案例或测试
- **风险**：政府云的认证方式（CAC、PIV、Entra Government）是否完全兼容需要验证

---

## 4. 混合架构可能性

### 4.1 MCP 协议作为解耦层

MCP 协议的核心价值：**定义了 Agent Runtime 与 Tool/Skill 之间的标准接口**，天然解耦了语言选择。

```
[Rust Agent Runtime]  ←—MCP协议—→  [TypeScript/Python Tool Server]
        ↓
   负责：Agent loop、推理、并发、低延迟调度
                                        ↓
                               负责：Teams SDK、Power Automate、
                                    MS Graph、Python 数据处理工具
```

这一架构**在实践中已有先例**：
- Rust Analyzer Tools MCP Server 是 Rust/TypeScript 混合 MCP 架构的真实案例
- MCP 协议本身无语言要求，transport 层（stdio/SSE/HTTP）完全语言无关

### 4.2 混合架构的权衡

**优势**：
- Rust 处理高并发 Agent loop、MCP Server 端点，获得性能收益
- TypeScript 处理 MS 生态集成（Teams Bot SDK、MSAL、Power Platform），利用现有生态
- MCP 边界清晰，两侧可独立演进

**代价**：
- 运维复杂度提升：两套运行时、两套构建工具链、两套部署镜像
- 跨语言调试困难：追踪一个请求需要横跨 Rust trace 和 Node.js trace
- 招聘/团队：需要同时维护 Rust 和 TypeScript 能力，对早期团队是额外负担
- MCP 协议本身有序列化开销（JSON），高频工具调用时 IPC 成本累积

### 4.3 实用性判断

对于我们的场景（政府/企业 workflow automation），混合架构在**以下阶段**才有意义：

| 阶段 | 推荐方案 | 理由 |
|------|----------|------|
| POC 阶段 | 纯 TypeScript | 速度优先，验证业务逻辑，避免额外复杂度 |
| 早期 Production | 纯 TypeScript | 团队熟悉度，MS 生态集成，问题排查方便 |
| 规模化阶段（100+ 并发用户） | 可考虑混合 | 内存/CPU 成本成为实际痛点时引入 Rust runtime |
| MCP Server 高负载 | 引入 Rust | 将 MCP Server 实现切换到 Rust，其余保持 TypeScript |

---

## 5. 框架对比总表

| 维度 | pi-mono (TypeScript) | Rig (Rust) | AutoAgents (Rust) | Swiftide (Rust) |
|------|---------------------|------------|-------------------|-----------------|
| **Stars** | ~1,200 | ~6,200 | 较少（<500 估计） | ~628 |
| **成熟度** | 中（生产可用） | 中高（生产可用） | 低中（早期） | 低中（早期） |
| **Agent Loop** | 完整 4-hook | ReAct/Tool-Use | ReAct（Ractor Actor）| 流式 Tool-Use |
| **Hook/Middleware** | 原生 4 hook | 无原生，需自实现 | 有 hook 示例 | 原生 Lifecycle Hook |
| **多 Agent** | 无内置 | Agent-as-Tool | 原生 Actor 多 Agent | 无原生 |
| **MCP 支持** | 无 | 有（v0.11+）| 未明确 | 有（rmcp） |
| **Provider 数量** | 20+ | 15+ | 较少 | 8+ |
| **Azure OpenAI** | 有 | 有 | 未知 | 未知 |
| **Azure Gov** | 未测试 | 未测试 | 未测试 | 未测试 |
| **MS SDK 集成** | 丰富（npm 生态）| 无原生 | 无原生 | 无原生 |
| **内存占用** | 中（V8 GC） | 低（Rust 所有权）| 低 | 低 |
| **GC 停顿** | 有 | 无 | 无 | 无 |
| **Governance 层** | 需自建 | 需自建 | 需自建 | Hook 系统可支撑 |
| **社区** | 中（OpenClaw 生态） | 中高（Coral 等）| 小 | 小 |
| **招聘难度** | 低（TS 普及） | 中高（Rust 稀缺） | 中高 | 中高 |
| **适合场景** | 快速迭代/MS 集成 | 高并发 Agent Runtime | 边缘/嵌入式 Agent | RAG + Agent 管道 |

---

## 6. 结论与建议

### 6.1 核心判断

**Rust 框架目前尚未达到可以替代 pi-mono（TypeScript）的成熟度**，主要原因：

1. **Governance/Hook 层缺失**：我们架构最关键的需求之一是 audit hook、governance middleware。Rig（最成熟的选项）没有原生 Hook 系统，需要大量自建工作。
2. **MS 生态集成的不对称性**：Teams Bot SDK、MSAL、Power Platform Connector 等核心集成全在 npm 生态，Rust 侧几乎无现成方案，自建成本高。
3. **多 Agent / 认知分区支持薄弱**：Rig 的 agent-as-tool 模式和 AutoAgents 的 Ractor Actor 模式，都不直接对应"统一意识 + 认知分区"这一 Swarm 模型，需要大量上层封装。
4. **性能优势在我们场景中被稀释**：workflow automation 主要是 I/O 等待（LLM 延迟、Teams API 调用），Rust 的 CPU/内存优势在这一场景的实际权重较低。
5. **Azure Government 兼容性未经验证**：任何 Rust 框架都没有公开的 Azure Government 部署案例。

### 6.2 有价值的部分

Rust 生态中**有价值的不是替代整个框架，而是特定场景的局部替代**：

- **MCP Server 实现**：如果我们自建 MCP Server（工具执行端点），用 Rust 实现可获得 16x 性能提升和 50x 内存节省，成本仅是实现一个 MCP Server 而非整个 Agent Runtime
- **`rmcp` SDK**：官方 Rust MCP SDK 成熟度高，可在混合架构中单独使用
- **`rig-core` 作为学习参考**：Rig 的多 Provider 抽象设计值得借鉴，指导我们在 TypeScript 层的接口设计

### 6.3 Rig 是 Rust 生态的最优选

如果将来决定引入 Rust 组件，**Rig 是当前最合适的出发点**，理由：
- 社区规模最大（6,200 stars），生态衍生最丰富
- MCP 支持最完整
- Provider 覆盖最广，Azure OpenAI 已有官方集成
- 但需接受：缺乏原生 Hook 系统、多 Agent 支持有限、Azure Government 需自行验证

### 6.4 推荐行动路径

```
短期（POC - 早期Production）：
  → 坚持 TypeScript（pi-mono 或 Claude Agent SDK），全力聚焦业务逻辑验证
  → 不引入 Rust，避免额外复杂度

中期（规模化阶段）：
  → 如果 MCP Server 成为性能瓶颈，用 Rig 或 rmcp 重写 MCP Server 端点
  → Agent Runtime 层继续保持 TypeScript，通过 MCP 协议与 Rust MCP Server 通信
  → Governance/Audit 层继续在 TypeScript 中实现（Hook 更成熟）

长期（如有战略理由）：
  → 届时再评估 Rig 的 Hook/Governance 生态成熟度
  → 或基于 Swiftide 的 Lifecycle Hook 构建 Rust Agent Runtime，覆盖 Governance 层
  → 混合架构：Rust Runtime ←MCP→ TypeScript Tools/Skills
```

### 6.5 需要进一步验证的问题

- [ ] Rig 的 Azure OpenAI 集成是否可以无修改对接 Azure Government endpoint
- [ ] AutoAgents 的 MCP 支持路线图（是否在开发中）
- [ ] `mcp-rig` crate 的生产稳定性（`tim-schultz/mcp-rig` 的维护状态）
- [ ] Swiftide 的 Lifecycle Hook 是否足够覆盖我们的 Audit 需求（before/after tool 调用、before/after LLM 调用的 4 类 hook）

---

*本报告为一次性参考材料。如架构选型确定，相关结论应提炼入 `docs/02-technical-architecture.md`。*
