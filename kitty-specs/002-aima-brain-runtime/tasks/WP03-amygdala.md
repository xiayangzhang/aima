---
work_package_id: WP03
title: Amygdala 守卫
lane: planned
dependencies: []
subtasks: [T012, T013, T014, T015, T016]
history:
- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
---

# WP03 — Amygdala 守卫

## 目标

实现工具调用守卫（Amygdala），三段决策骨架（静态规则 → implicit 记忆 → Haiku 降级），违规时向工作空间写入 amygdala_interrupt Signal。

## 上下文

- 依赖 WP01：使用 BrainSignal、BrainEventBus、CognitiveWorkspace（含 pushSignal）
- 新建文件：`src/amygdala/index.ts`
- Amygdala 不持有 LLM session，不走 BrainAdapter，偶发一次性 LLM 调用（Haiku）
- 架构参考：01-agent-architecture.md §六

## Amygdala 在两种 Adapter 下的行为差异

| Adapter | 拦截时序 | Amygdala 的角色 |
|---|---|---|
| ClaudeAgentSDKAdapter | PreToolUse hook（执行前同步） | check() 被 hook 调用，返回 block=true 时由 adapter 执行 deny |
| PiCodingAgentAdapter | 工具调用之间（非执行前） | 订阅 EventBus tool.pre_use，写 Signal，适配器下次 steer() 携带中断消息 |

Amygdala 类本身只负责 check() 和 pushSignal()，不感知底层 adapter 类型。

## 实现指导

### T012 — ToolRiskLevel 类型 + 默认工具权限表

**文件**：`src/amygdala/index.ts`（新建）

```typescript
import { randomUUID } from 'crypto'
import type { BrainEventBus } from '../eventbus/index'
import type { CognitiveWorkspace } from '../workspace/index'
import type { BrainType } from '../types/index'

export type ToolRiskLevel = 'low' | 'medium' | 'high'
export type AmygdalaDecision = 'allow' | 'block' | 'escalate'

// 默认工具权限（静态规则，过渡期直到 pi-coding-agent 迁移完成）
const DEFAULT_BLOCK_TOOLS = new Set([
  'bash', 'file_write', 'file_delete', 'file_read',
])
const DEFAULT_ALLOW_TOOLS_PREFIX = ['memory_', 'workspace_']

// 工具风险分级（注册时声明，未注册的工具默认 medium）
const DEFAULT_RISK_LEVELS: Record<string, ToolRiskLevel> = {
  'bash': 'high',
  'file_write': 'high',
  'file_delete': 'high',
  'file_read': 'medium',
  'memory_search': 'low',
  'memory_entity_context': 'low',
  'memory_similar_situations': 'low',
  'memory_procedure': 'low',
  'workspace_read_slot': 'low',
  'workspace_write_slot': 'low',
  'spawn_execution_session': 'medium',
}
```

### T013 — AmygdalaConfig 类型

```typescript
export interface AmygdalaRule {
  toolName: string | RegExp    // 精确匹配或正则
  decision: AmygdalaDecision   // 匹配时的决策
  reason: string
}

export interface AmygdalaConfig {
  rules?: AmygdalaRule[]        // 应用层自定义规则（叠加在 DEFAULT 规则之上）
  riskLevels?: Record<string, ToolRiskLevel>  // 工具风险级别覆盖
  haiku_enabled?: boolean       // 是否启用 Haiku 降级（默认 false，Feature 002 过渡期）
}

export class Amygdala {
  private config: AmygdalaConfig
  private workspace: CognitiveWorkspace
  private eventBus: BrainEventBus
  private riskLevels: Record<string, ToolRiskLevel>

  constructor(config: AmygdalaConfig, workspace: CognitiveWorkspace, eventBus: BrainEventBus) {
    this.config = config
    this.workspace = workspace
    this.eventBus = eventBus
    this.riskLevels = { ...DEFAULT_RISK_LEVELS, ...config.riskLevels }
  }
  // ... 方法见 T014-T016
}
```

### T014 — Amygdala.check()：三段决策

```typescript
async check(toolName: string, args: Record<string, unknown>): Promise<{
  decision: AmygdalaDecision
  reason: string
}> {
  // 第 1 段：静态规则（含默认 BLOCK/ALLOW 规则）
  const staticResult = this.checkStaticRules(toolName)
  if (staticResult) return staticResult

  const risk = this.riskLevels[toolName] ?? 'medium'

  // 第 2 段：implicit 记忆匹配（medium/high 工具）
  // Feature 002 过渡期：记忆检索逻辑留 stub，返回 null（无命中）
  // 完整实现在 DMN Reactive feature 后补充
  const memoryResult = null  // TODO: await this.checkImplicitMemory(toolName, args)

  if (memoryResult) return memoryResult

  // 第 3 段：Haiku 降级（仅 high 风险，且 haiku_enabled=true）
  if (risk === 'high' && this.config.haiku_enabled) {
    // Feature 002 过渡期：Haiku 降级留 stub，默认 escalate
    return { decision: 'escalate', reason: `High-risk tool ${toolName} requires human review (Haiku eval not yet implemented)` }
  }

  // 默认：medium 工具无明确规则时放行
  return { decision: 'allow', reason: `No rule matched for ${toolName} (risk: ${risk})` }
}

private checkStaticRules(toolName: string): { decision: AmygdalaDecision; reason: string } | null {
  // 应用层自定义规则（优先级最高）
  for (const rule of this.config.rules ?? []) {
    const matches = typeof rule.toolName === 'string'
      ? rule.toolName === toolName
      : rule.toolName.test(toolName)
    if (matches) return { decision: rule.decision, reason: rule.reason }
  }

  // 默认 BLOCK 规则
  if (DEFAULT_BLOCK_TOOLS.has(toolName)) {
    return { decision: 'block', reason: `Tool ${toolName} is blocked by default policy (high-risk, pre-pi-coding-agent migration)` }
  }

  // 默认 ALLOW 规则（前缀匹配）
  if (DEFAULT_ALLOW_TOOLS_PREFIX.some(prefix => toolName.startsWith(prefix))) {
    return { decision: 'allow', reason: `Tool ${toolName} is allowed by default (read-only workspace/memory tool)` }
  }

  return null
}
```

### T015 — Amygdala 订阅 EventBus tool.pre_use

```typescript
// 在构造函数中调用，或提供 start() 方法
startListening(): () => void {
  return this.eventBus.subscribe(async (event) => {
    if (event.event_type !== 'tool.pre_use') return

    const toolName = event.payload['tool'] as string
    const args = (event.payload['args'] as Record<string, unknown>) ?? {}

    const { decision, reason } = await this.check(toolName, args)

    if (decision === 'block' || decision === 'escalate') {
      this.workspace.pushSignal({
        type: 'amygdala_interrupt',
        message: `Amygdala ${decision}: ${reason}`,
        causationId: event.event_id,
      })

      // 发射 ALERT 事件（供外部审计系统订阅）
      this.eventBus.emit({
        event_type: 'amygdala.interrupt',
        level: 'ALERT',
        brain: 'amygdala',
        thread_id: event.thread_id,
        session_id: event.session_id,
        causation_id: event.event_id,
        payload: { tool: toolName, decision, reason },
      })
    }
  })
}
```

**注意**：PiCodingAgentAdapter 下，适配器在每轮工具调用后通过 `agent.steer()` 检查 Signal 并注入中断消息（非执行前同步）。ClaudeAgentSDKAdapter 的 `PreToolUse` hook 直接调用 `amygdala.check()`，不走 EventBus（同步执行前拦截）。

### T016 — 内部辅助：getAmygdalaDecision

（已内联在 T014 中，T016 作为逻辑验证：确保三段顺序正确，第 1 段命中后不进入第 2/3 段）

## Definition of Done

- [ ] T012: ToolRiskLevel、AmygdalaDecision、默认工具权限表
- [ ] T013: AmygdalaConfig、AmygdalaRule 类型，Amygdala 类构造函数
- [ ] T014: check() 方法，三段决策顺序正确（静态规则 → 记忆 stub → Haiku stub）
- [ ] T015: startListening() 订阅 EventBus，tool.pre_use 违规时写 Signal + 发射 ALERT
- [ ] T016: 静态规则函数逻辑清晰，默认 BLOCK/ALLOW 均被覆盖
- [ ] bun run typecheck 零错误，biome check 通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
spec-kitty agent tasks move-task WP03 --to for_review --note "Ready: <summary>"
```
