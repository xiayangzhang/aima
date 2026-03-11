# AIMA — 实现状态与路线图

> 本文记录当前实现进度、已决定但未实现的方向、以及待讨论的设计决策。
> 随开发进展持续更新。概念性内容见 `00-overview.md` 和 `01-agent-architecture.md`。

---

## 一、当前实现状态

`@aima/core` v0.1.x（`main` 分支，388 测试通过）

| Feature | 模块 | 状态 | 备注 |
|---|---|---|---|
| 001 | Thread/Slot 持久化（PostgreSQL）+ pi-agent 连接层 | ✅ | |
| 002 | ThreadRunner + 五脑路由 + EventBus + 崩溃恢复 | ✅ | |
| 003 | PiCodingAgentAdapter + Amygdala 工具策略 | ✅ | 含 Extension API tool_call 事件 |
| 004 | Hippocampus 记忆整理（每日 batch）| ✅ | |
| 005 | DMN（Default Mode Network）事件响应 + 整合 | ✅ | |
| 006 | 记忆架构（MemoryService，五类记忆）| ✅ | |
| 007 | Brain Identity & Role Loading（identityDir）| ✅ | soul.md / skill-index.md / brain.md；Amygdala 工具解锁 |
| 008 | Per-brain 模型路由 + Block 4 上下文提示 | ✅ | buildBlock4Opts()；limbic=haiku，cortex/brainstem=sonnet |
| 009 | Brainstem 子执行 Session（spawn_execution_session）| ✅ | SpawnExecutionSessionFn 回调注入；FR-04 偏差见注 |
| 010 | Thread Continue 多轮对话续接（continue()）| ⏳ | spec/plan/tasks 已完成，待实现 |

**注（Feature 009 FR-04 偏差）**：`spawnSubExecution` 使用原生 `@anthropic-ai/sdk messages.create()`，而非 pi-coding-agent adapter。当前子执行 session 无 Amygdala 检查、无工具注册。若需要工具访问或合规审计覆盖子执行，需另立 Feature（建议 Feature 011）修复。

---

## 二、ClaudeSDKAdapter 状态

ClaudeSDKAdapter 已实现（Feature 002），但有已知能力差距（相比 pi-coding-agent adapter）：

| 差距 | 影响 |
|---|---|
| `inject()` 实时性降级 | 下次 `run()` 才生效（pi-agent 立即注入） |
| `tool.pre_use/post_use` 事件缺失 | Amygdala 无法逐工具检查；DMN 看不到工具执行 |
| EventBus 工具事件不完整 | 审计链不完整 |

对于 secondfirst/employee 生产路径，优先使用 `pi-coding-agent` adapter。ClaudeSDKAdapter 适用于无工具需求的轻量场景（如 DMN LLM 调用）。

---

## 三、路线图

### 近期（@aima/core 功能补全）

1. **Feature 010** — `continue()` 多轮对话 Thread 续接（`reopenThread()` + `AIMAInstance.continue()`）
2. **Feature 011**（待规划）— 子执行 Session 增强：pi-coding-agent adapter 替换原生 SDK；Amygdala 覆盖子执行；工具注册

### 中期（认知能力核心）

3. **Skill 系统** — reference / adapted / first-party 三层，Hippocampus 固化机制，Skill Review
4. **DMN Predictive Activation** — 前瞻预测、pending_observations 维护、历史模式触发主动 Thread
5. **记忆检索升级** — 脑区专属检索视图（见 docs/02-memory-architecture.md 生物化重设计计划）

### 后期

6. **`@aima/crew`（AIMA-CLAW）** — OpenClaw fork 换芯，替换 pi-coding-agent
7. **向量检索** — MemoryService 后端升级（pgvector 或 Qdrant）
8. **`subscribeInstance(instanceId, fn)`** — 多租户 EventBus 便利方法
9. **多云部署** — ClaudeSDKAdapter 差距补全（Azure Bedrock 场景）

---

## 四、暂缓的设计决策

> 这些问题已识别，有意推迟，不影响当前实现。

| 问题 | 暂缓原因 | 最晚决策时间 |
|---|---|---|
| DEFER 超时默认值与通道配置存储方式 | 需要 Limbic 实现后验证合理范围 | Limbic 上线前 |
| Block 3/4 的 snapshot 隔离策略 | 需要 assembleContext() 实现时决定 | ThreadRunner 扩展前 |
| intent=both 时 Limbic 失败后的回退流程 | 需要完整 Thread Runner 序列图 | intent=both 实现前 |
| Skill adapted 版本更新机制 | 需要 Hippocampus Skill Review 实现时设计 | Hippocampus 实现前 |
| 多租户 EventBus instance 级过滤 | 当前单 instance 开发不需要 | 多租户上线前 |
| 子执行 Session Amygdala 覆盖 | Feature 009 FR-04 偏差，待 Feature 011 | Feature 011 规划前 |
