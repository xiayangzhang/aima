# Implementation Plan: AIMA Brain Runtime (Feature 002)

**Feature**: 002-aima-brain-runtime
**Version**: 1.0
**Created**: 2026-03-10
**Depends on**: Feature 001 (@aima/core workspace schema, merged to main)

---

## 一、技术栈

| 层 | 选型 |
|---|---|
| 语言 | TypeScript strict, ESM-only, moduleResolution: Bundler |
| 运行时 | Bun v1.x |
| 格式 | Biome |
| 构建 | tsup（共用 Feature 001 配置） |
| 适配器 A | @mariozechner/pi-agent-core + @mariozechner/pi-ai（过渡期） |
| 适配器 B | @anthropic-ai/claude-agent-sdk |
| MCP | @modelcontextprotocol/sdk |
| 数据层 | Feature 001 CognitiveWorkspace（Drizzle + PostgreSQL） |
| 测试 | Bun test（单元）+ Vitest（集成，需 DB） |

---

## 二、模块结构

```
src/
├── adapters/
│   ├── index.ts            # BrainAdapter 接口 + BrainRunParams/Result/Signal 类型
│   ├── pi-agent/index.ts   # PiCodingAgentAdapter
│   └── claude-sdk/index.ts # ClaudeAgentSDKAdapter
├── eventbus/index.ts        # BrainEventBus + BrainEvent 类型 + getEventBus()
├── amygdala/index.ts        # Amygdala 守卫（三段决策）
├── context/index.ts         # ContextAssembler（Block 1-4）
├── runner/index.ts          # ThreadRunner（路由 + 崩溃恢复 + pending）
├── mcp/index.ts             # McpServer（AIMA 工具集）
├── instance.ts              # AIMAInstance（顶层入口）
├── schema/                  # Feature 001（不改动）
├── types/                   # Feature 001（不改动已有内容）
├── workspace/               # Feature 001（不改动）
└── index.ts                 # 公共 API（扩展 Feature 001 导出）
```

---

## 三、关键设计决策

### BrainAdapter 接口对齐策略

- run() 签名与 pi-coding-agent Agent.run() 兼容
- inject() / abort() 是 AIMA 额外接口
- PiCodingAgentAdapter 是原生实现（天然对齐），ClaudeAgentSDKAdapter 是包装实现

### Session 管理

Session key = `${brain}:${threadId}`，存在 ThreadRunner 的 brainSessions Map 中。
- pi-agent-core：通过 agent.resume(sessionId) 或等效参数续接
- Claude Agent SDK：options.resume: sessionId

### Amygdala 拦截时序差异

| 适配器 | 时序 | 实现 |
|---|---|---|
| ClaudeAgentSDKAdapter | 执行前同步（真正拦截） | PreToolUse hook → permissionDecision: 'deny' |
| PiCodingAgentAdapter | 工具调用之间 | getSteeringMessages + 工具注册白名单 |

### Context Assembly 缓存策略

- Block 1/2：AIMAInstance 构造时生成一次，后续不变（保证 prompt cache 命中）
- Block 3/4：每次 run() 前重新生成
- Block 1/2 内绝对不包含时间戳或动态内容

### Thread Runner 并发安全

- Thread 内顺序（单脑写权限），Thread 间并行
- 每个 Thread 维护 processing flag 防止重入
- intent=both 序列：Limbic done → Brainstem 激活 → Brainstem done → 再次激活 Limbic

---

## 四、数据模型变更

Feature 002 不改动 Feature 001 的数据库 schema。新状态全在内存管理：

| 状态 | 位置 |
|---|---|
| brainSessions（brain:threadId → sessionId） | ThreadRunner 内存 Map |
| Signals（amygdala_interrupt / dmn_correction） | CognitiveWorkspace 内存扩展 |
| pending_observations | Feature 001 PostgreSQL（已有） |

---

## 五、测试策略

| 层 | 工具 | 范围 | DB |
|---|---|---|---|
| 单元 | Bun test | ThreadRunner 路由、ContextAssembler 输出、EventBus 分发 | 无 |
| 集成 | Vitest | Thread 完整生命周期（真实 DB + mock LLM） | 需要 |
| E2E | Bun test | AIMAInstance.receive() 实际 LLM 调用（需 ANTHROPIC_API_KEY，CI 跳过） | 需要 |

---

## 六、工作包规划

| WP | 内容 | 依赖 |
|---|---|---|
| WP01 | BrainAdapter 接口 + BrainEventBus + 类型扩展 | — |
| WP02 | ContextAssembler（Block 1-4） | WP01 |
| WP03 | Amygdala 守卫 | WP01 |
| WP04 | ThreadRunner（路由 + 崩溃恢复 + pending） | WP01, WP02 |
| WP05 | PiCodingAgentAdapter | WP01, WP02, WP03 |
| WP06 | ClaudeAgentSDKAdapter + MCP Server | WP01, WP02, WP03 |
| WP07 | AIMAInstance + 公共 API 导出 | WP04, WP05, WP06 |
| WP08 | 单元测试（ThreadRunner / EventBus / ContextAssembler） | WP01~WP04 |
| WP09 | 集成测试（Thread 生命周期 + mock adapter）+ E2E smoke | WP07 |

---

## 七、风险

| 风险 | 缓解 |
|---|---|
| pi-agent-core API 与预期不符 | 先写 spike test 验证 hook 接口 |
| intent=both 路由逻辑复杂 | ThreadRunner 单元测试覆盖全部 intent 组合 |
| Claude SDK query() 接口变化 | 固定版本号，集成测试覆盖关键 hook |
