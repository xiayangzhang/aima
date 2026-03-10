---
work_package_id: WP02
title: ContextAssembler（Block 1-4）
lane: "for_review"
dependencies: []
subtasks: [T007, T008, T009, T010, T011]
agent: "claude"
shell_pid: "32355"
history:
- 2026-03-10T00:00:00Z – system – lane=planned – Prompt created
---

# WP02 — ContextAssembler（Block 1-4）

## 目标

组装每次脑区激活的 system prompt（Block 1-4），保证 Block 1/2 走 LLM prompt cache 前缀，Block 3/4 动态刷新。

## 上下文

- 依赖 WP01：使用 CognitiveBrainType、CognitiveWorkspace（含 Signals 扩展）
- 新建文件：`src/context/index.ts`
- 规则：Block 1/2 内禁止任何动态内容（时间戳、session ID 等）——保证 prompt cache 命中
- 记忆检索调用 Feature 001 的 CognitiveWorkspace.searchMemory()

## 关键架构约束

Block 1+2 需要至少 2048 tokens 才触发 Anthropic prompt cache。
实际的身份描述 + Skill Index 内容通常远超此门槛，但若在开发阶段发现 cache miss，需检查 Block 1/2 是否有动态内容。

## 实现指导

### T007 — ContextAssemblerConfig 类型

**文件**：`src/context/index.ts`（新建）

```typescript
import type { CognitiveBrainType } from '../types/index'
import type { CognitiveWorkspace } from '../workspace/index'
import type { MemorySearchFilters } from '../types/index'

export interface BrainIdentity {
  role: string           // 脑区角色一句话描述
  instructions: string   // 详细行为指南（静态，写在配置里或从文件加载）
}

export interface ContextAssemblerConfig {
  identities: Record<CognitiveBrainType, BrainIdentity>
  skillIndex?: string    // Skill 索引文本（静态，可为空字符串）
  timezone?: string      // 时区，如 'Australia/Sydney'，默认 'UTC'
}

export interface AssembledContext {
  systemPrompt: string        // 完整 system prompt（Block 1+2+3+4 拼接）
  injectedMemoryIds: string[] // Block 4 注入的记忆 IDs
}
```

### T008 — assembleBlock12()：静态前缀

构造时生成一次，后续不变：

```typescript
// Block 1：脑区角色定义
// Block 2：Skill Index
// 两者拼接，字节完全相同保证 cache 命中
export function assembleBlock12(brain: CognitiveBrainType, config: ContextAssemblerConfig): string {
  const identity = config.identities[brain]
  const lines: string[] = [
    `## Role`,
    identity.role,
    ``,
    `## Instructions`,
    identity.instructions,
  ]
  if (config.skillIndex) {
    lines.push(``, `## Skill Index`, config.skillIndex)
  }
  return lines.join('\n')
}
```

**重要**：此函数的输出在同一 AIMAInstance 实例生命周期内必须保持完全一致（字节相同）。调用方（AIMAInstance 构造时）缓存此结果，不在每次 run() 时重新调用。

### T009 — assembleBlock3()：工作空间状态 + 当前时间

```typescript
export async function assembleBlock3(
  brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  threadId: string,
  timezone: string,
): Promise<string> {
  const thread = await workspace.getThread(threadId)
  const slots = await workspace.getSlotsByThread(threadId)
  const now = new Date()
  // 时间格式化，带时区偏移
  const localTime = now.toLocaleString('en-AU', { timeZone: timezone, hour12: false })

  const slotsText = slots
    .map(s => `  ${s.brain}: ${s.status}${s.output ? ` (output: ${JSON.stringify(s.output).slice(0, 100)})` : ''}`)
    .join('\n')

  return [
    `## Current Context`,
    `- local_time: ${localTime}`,
    `- timezone: ${timezone}`,
    `- thread_id: ${threadId}`,
    `- thread_state: ${thread?.state ?? 'unknown'}`,
    ``,
    `## Workspace Slots`,
    slotsText || '  (no slots yet)',
  ].join('\n')
}
```

### T010 — assembleBlock4()：脑区专属记忆检索

```typescript
export async function assembleBlock4(
  brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  threadId: string,
): Promise<{ text: string; injectedMemoryIds: string[] }> {
  let results: Array<{ id: string; content: string; type: string }> = []

  // 脑区专属检索策略（按文档 01 §九）
  if (brain === 'limbic') {
    // Limbic：semantic + episodic，按 thread 上下文
    const r = await workspace.searchMemory({ type: 'semantic', limit: 10, excludeInvalid: true })
    const ep = await workspace.searchMemory({ type: 'episodic', threadId, limit: 5, excludeInvalid: true })
    results = [...r, ...ep]
  } else if (brain === 'cortex') {
    // Cortex：procedural + episodic（历史情境）
    const r = await workspace.searchMemory({ type: 'procedural', limit: 10, excludeInvalid: true })
    const ep = await workspace.searchMemory({ type: 'episodic', limit: 5, excludeInvalid: true })
    results = [...r, ...ep]
  } else if (brain === 'brainstem') {
    // Brainstem：procedural（操作流程）
    results = await workspace.searchMemory({ type: 'procedural', limit: 10, excludeInvalid: true })
  }

  // 去重
  const seen = new Set<string>()
  const unique = results.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true })

  if (unique.length === 0) return { text: '', injectedMemoryIds: [] }

  const text = [
    `## Relevant Memory`,
    ...unique.map(m => `[${m.type}] ${m.content}`),
  ].join('\n')

  return { text, injectedMemoryIds: unique.map(m => m.id) }
}
```

### T011 — assembleContext()：合并四块

```typescript
export async function assembleContext(
  brain: CognitiveBrainType,
  workspace: CognitiveWorkspace,
  threadId: string,
  config: ContextAssemblerConfig,
  cachedBlock12: string,  // 由调用方（AIMAInstance）在构造时缓存，传入避免重复计算
): Promise<AssembledContext> {
  const tz = config.timezone ?? 'UTC'
  const block3 = await assembleBlock3(brain, workspace, threadId, tz)
  const { text: block4Text, injectedMemoryIds } = await assembleBlock4(brain, workspace, threadId)

  const parts = [cachedBlock12, block3]
  if (block4Text) parts.push(block4Text)

  return {
    systemPrompt: parts.join('\n\n'),
    injectedMemoryIds,
  }
}
```

## Definition of Done

- [ ] T007: ContextAssemblerConfig、BrainIdentity、AssembledContext 类型定义
- [ ] T008: assembleBlock12() 纯函数，输出不含动态内容
- [ ] T009: assembleBlock3() 包含当前时间和 Thread/Slot 状态
- [ ] T010: assembleBlock4() 按脑区路由检索，返回 injectedMemoryIds
- [ ] T011: assembleContext() 合并四块，接受缓存的 block12 参数
- [ ] bun run typecheck 零错误，biome check 通过

## 实施命令

```bash
cd /Volumes/leoyun/aima
spec-kitty agent workflow implement --agent <name>
# 完成后：
spec-kitty agent tasks move-task WP02 --to for_review --note "Ready: <summary>"
```

## Activity Log

- 2026-03-10T13:03:09Z – claude – shell_pid=32355 – lane=doing – Started implementation via workflow command
- 2026-03-10T13:05:38Z – claude – shell_pid=32355 – lane=for_review – Ready for review: ContextAssembler implemented with 4 blocks (cache-safe prefix, workspace state, brain-routed memory retrieval, merge). 74 unit tests passing, typecheck + biome clean.
