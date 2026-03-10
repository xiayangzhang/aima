# AIMA — 实现状态与路线图

> 本文记录当前实现进度、已决定但未实现的方向、以及待讨论的设计决策。
> 随开发进展持续更新。概念性内容见 `00-overview.md` 和 `01-agent-architecture.md`。

---

## 一、当前实现状态

`@aima/core` v0.1.1（`main` 分支，18/18 测试通过）

| 模块 | 状态 | 备注 |
|---|---|---|
| Thread/Slot 持久化（PostgreSQL） | ✅ | |
| ThreadRunner + 五脑路由 | ✅ | |
| PiAgentAdapter（pi-agent-core） | ✅ | 暂时使用 pi-agent-core，见下方迁移说明 |
| Event Bus（五级订阅） | ✅ | COMPLIANCE/ALERT/INFO/DEBUG/TRACE |
| 崩溃恢复 | ✅ | at-most-once 语义，含非幂等工具保护 |
| 测试覆盖 | ✅ | 39 个 unit + integration smoke test |
| `continue()`（多轮对话续接） | ⏳ | |
| `memory.search()`（只读接口） | ⏳ | |
| `identityDir` 身份文件加载 | ⏳ | soul.md / identity.md / role.md |
| ClaudeSDKAdapter | ⏳ | 用于多云部署（Azure / Bedrock） |
| `@aima/crew`（OpenClaw fork） | ⏳ | 待 @aima/core 稳定后实现 |

---

## 二、已决定但未实现

### 统一迁移到 pi-coding-agent adapter

**决定**：放弃 pi-agent-core，统一使用 `pi-coding-agent` 作为单一 adapter。

**原因**：
- pi-coding-agent 的内置工具（bash、文件 I/O）与外部工具走同一 `AgentTool` 注册路径
- Extension API 的 `tool_call` 事件（pre-execution，可 block）让 Amygdala 覆盖所有工具，无例外
- 无需维护两套 adapter，工具权限由 Amygdala 策略（`role.md` 中的 `permissions`）统一控制

**默认工具权限**（Amygdala 内置，`role.md` 可解锁）：

```
bash          → BLOCK
file_write    → BLOCK
file_delete   → BLOCK
file_read     → BLOCK
memory_search → ALLOW
workspace_read/write → ALLOW
```

**当前阻碍**：无，可以在 `continue()` 实现完成后进行。

---

## 三、路线图

### 近期（@aima/core 功能补全）

1. `continue()` — 多轮对话 Thread 续接
2. `memory.search()` — 只读记忆接口（ILIKE 全文搜索；向量检索留后）
3. `identityDir` — soul/identity/role 文件加载，注入 Block 1/2
4. 迁移到 `pi-coding-agent` adapter + Amygdala 工具权限策略

### 中期（认知能力核心）

5. DMN 事件响应 — 事件监听、错误恢复、回溯纠错、信号捕获（写 pending）、Session Anchor 触发
6. **DMN 心跳整合（含 Predictive Activation）** — 深度前瞻预测、pending_observations 维护（写/更新/清除）、implicit 聚类合并；基于历史模式主动发起 Thread、取消失效预测
   > Predictive Activation 是 AIMA 区别于其他框架的核心能力之一，不可作为"以后再加"处理
7. Hippocampus — 每日记忆整理（清理/权重/semantic 提炼）+ 预测反馈评估 + 定期 Skill Review（固化候选暴露、失效检测）
8. Skill 系统 — reference / adapted / first-party 三层，Hippocampus 固化机制

### 后期

9. `@aima/crew` — OpenClaw fork，换芯实现
10. ClaudeSDKAdapter — 多云部署支持（Azure / Bedrock）
11. 向量检索 — MemoryService 后端升级（pgvector 或 Qdrant）
12. `subscribeInstance(instanceId, fn)` — 多租户 EventBus 便利方法

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
