# AIMA 概览

> **版本**: v2.0
> **状态**: 草稿

---

## AIMA 是什么

**AIMA**（Artificial Intelligence: A Minded Architecture）是一个**中间层行为框架**，位于 LLM 基础设施和上层应用之间。它回答的问题是：一个认知个体应该如何思考、如何分工、如何记忆、如何感知风险——这是行为框架层的问题，既不是"怎么调用模型"，也不是"要做什么业务"。

---

## 三层架构

```
┌────────────────────────────────────────────────────────────────┐
│  上层应用                                                       │
│                                                                │
│  secondfirst/employee — 虚拟员工产品，直接基于 AIMA 构建        │
│  决定：解决什么问题、装载哪些 Skill、集成哪些外部系统            │
├────────────────────────────────────────────────────────────────┤
│  AIMA                                                          │
│  行为框架：认知如何运作                                         │
│  五脑架构 / 认知工作区 / Hippocampus / Skill 体系 / Event Bus  │
├────────────────────────────────────────────────────────────────┤
│  pi-agent-core / pi-ai（pi-mono）                              │
│  LLM 基础设施：Agent Loop、工具执行、Session 管理、流式输出     │
└────────────────────────────────────────────────────────────────┘
```

三层的分工是严格的：
- **pi-ai / pi-agent** 解决机器问题——如何调用模型、管理 Session、执行工具
- **AIMA** 解决行为问题——认知个体如何运作
- **上层应用** 解决领域问题——用这套认知框架做什么

---

## AIMA 提供什么

| 能力 | 说明 |
|---|---|
| **生命周期机制** | Thread 创建/状态管理、Slot 写入/读取、崩溃恢复 |
| **记忆基底** | 五类记忆的写入/检索/巩固基础设施（Hippocampus） |
| **通信基础设施** | Brain Event Bus（内部通道）、工具注册、脑区间路由 |
| **安全层** | Amygdala 工具执行前拦截、审计事件链 |

AIMA 是认知个体的物理基础——提供"肉体"，不提供"心智"。

---

## AIMA 不提供什么

| 不提供 | 由谁提供 |
|---|---|
| 认知内容（什么值得记忆、应该学习什么） | soul.md / role 文件 |
| "正确"的定义 | soul.md + 上层注入的价值观 |
| 业务逻辑 | Skill（Markdown）+ 上层应用 |
| 领域知识 | Skill 文件 |

AIMA 不对心智的内容做判断，只保证心智的生长有土壤。

---

## 五个组成部分

| 组件 | 功能角色 | 一句话说明 |
|---|---|---|
| **Limbic** | Communicator + Router | 人类通道的入口和出口；处理社交输入、语气调节、沟通路由 |
| **Cortex** | Planner + Reasoner | 纯内部推理引擎；负责复杂任务分解、规划、判断 |
| **Brainstem** | Executor + System Interface | 系统通道的入口；将指令翻译为工具调用并执行 |
| **Amygdala** | GuardRail | 工具执行前同步拦截；规则优先，Haiku 兜底 |
| **DMN** | Reflector + Consolidator | 异步回顾与前瞻预测；唯一能在无外部触发时主动分析的脑区 |
| **Hippocampus** | Memory System | 五类记忆的统一入口；包含 Encoding / Recall / Consolidation 三个子模块 |

---

## 两个外部接口

AIMA 有两种不同类型的外部界面：

- **Limbic** = 人类 ↔ AIMA：处理来自 Teams、Email、社交输入等需要关系/语气判断的输入
- **Brainstem** = 系统 ↔ AIMA：处理 Webhook、定时触发、Dataverse 事件等技术事件

两者平行，各有明确的适用场景，不存在"唯一对外通道"。

---

## 上层应用：secondfirst/employee

secondfirst/employee 是 AIMA 框架的第一个上层应用，也是目前唯一的产品实现。它基于 AIMA 构建虚拟员工（如 Alex），决定装载哪些 Skill、集成哪些微软生态系统（Teams、Dataverse、Entra），以及如何向客户组织呈现 AI 同事这一角色。AIMA 框架本身不依赖 secondfirst，两者在独立 repo 中维护。
