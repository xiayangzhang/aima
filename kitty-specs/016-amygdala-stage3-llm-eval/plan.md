# Implementation Plan: Amygdala Stage 3 LLM Eval
*Path: kitty-specs/016-amygdala-stage3-llm-eval/plan.md*

**Branch**: `016-amygdala-stage3-llm-eval` | **Date**: 2026-03-12 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/kitty-specs/016-amygdala-stage3-llm-eval/spec.md`

## Summary

替换 `src/amygdala/index.ts` 中 Stage 3 的存根实现，改为真实的 Haiku LLM 评估。新增 `AmygdalaConfig.llm` 字段，`check()` 方法在高风险工具调用时调用 LLM 做出 allow/block/escalate 决策，并将评估结果写入 `implicit` 记忆供未来 Stage 2 使用。

## Technical Context

**Language/Version**: TypeScript (Bun runtime)
**Primary Dependencies**: `callLlm` / `parseLlmJson`（`src/llm.ts`，已有）
**Storage**: `memories` 表（implicit 类型写入，无 schema 变更）
**Testing**: Bun test
**Target Platform**: Linux server (AKS)
**Project Type**: Single project
**Performance Goals**: Stage 3 LLM call < 2s（Haiku 模型，prompt 短）
**Constraints**: 不改 `check()` 方法签名；不改 Stage 1 逻辑；`haiku_enabled=false` 时行为不变
**Scale/Scope**: 改动 ~50 行代码，新增 ~4 个测试

## Constitution Check

*无 constitution 文件，跳过。*

## Project Structure

### Documentation (this feature)

```
kitty-specs/016-amygdala-stage3-llm-eval/
├── plan.md
├── quickstart.md
└── tasks/
```

### Source Code (repository root)

```
src/
└── amygdala/index.ts          # 主改动：AmygdalaConfig + check() Stage 3

tests/unit/amygdala/
└── amygdala.test.ts           # 新增 Stage 3 测试场景
```

**Structure Decision**: Single project，改动集中在 1 个源文件 + 测试更新。

## Phase 0: Research

**代码审查结论**：

| 决策 | 结论 | 依据 |
|---|---|---|
| LLM 调用函数 | `callLlm` + `parseLlmJson`（`src/llm.ts`） | DMN Reactive 同一模式 |
| LLM config 来源 | `AmygdalaConfig.llm?: LlmConfig` 新增字段 | 与 DMN/Hippocampus 的 `config.llm` 一致 |
| args 传递方式 | `JSON.stringify(args).slice(0, 300)` 截断摘要 | 防止超长 prompt |
| 失败回退 | try/catch → `escalate` | FR-004 |
| 记忆写入失败 | 内层 try/catch，静默捕获 | FR-006 |
| implicit 写入时机 | LLM 评估完成后（含失败回退后）| FR-005 |
| implicit baseImportance | block/escalate=0.8，allow=0.4 | 危险决策更重要 |
| implicit tags | `['amygdala_eval', toolName, decision]` | 便于 Stage 2 按 tag 检索 |

### 当前存根（待替换）

```typescript
// Stage 3: Haiku fallback (high-risk only, when haiku_enabled=true)
if (risk === 'high' && this.config.haiku_enabled) {
  return {
    decision: 'escalate',
    reason: `High-risk tool ${toolName} requires human review (Haiku eval not yet implemented)`,
  }
}
```

### 目标实现

```typescript
// Stage 3: Haiku LLM evaluation (high-risk only, when haiku_enabled=true)
if (risk === 'high' && this.config.haiku_enabled) {
  return await this.evaluateWithLlm(toolName, args, risk)
}
```

新增私有方法 `evaluateWithLlm`：

```typescript
private async evaluateWithLlm(
  toolName: string,
  args: Record<string, unknown>,
  risk: ToolRiskLevel,
): Promise<{ decision: AmygdalaDecision; reason: string }> {
  const argsSummary = JSON.stringify(args).slice(0, 300)
  const prompt = `You are a security gate evaluating a tool call.
Tool: ${toolName}
Risk level: ${risk}
Arguments: ${argsSummary}

Decide if this tool call should be allowed, blocked, or escalated for human review.
Respond with JSON: {"decision": "allow" | "block" | "escalate", "reason": string}
Be conservative: when in doubt, escalate.`

  let decision: AmygdalaDecision = 'escalate'
  let reason = 'LLM evaluation failed — defaulting to escalate'

  try {
    const response = await callLlm(prompt, this.config.llm ?? {})
    const result = parseLlmJson<{ decision: string; reason: string }>(response, {
      decision: 'escalate',
      reason: 'parse failed',
    })
    const validDecisions: AmygdalaDecision[] = ['allow', 'block', 'escalate']
    decision = validDecisions.includes(result.decision as AmygdalaDecision)
      ? (result.decision as AmygdalaDecision)
      : 'escalate'
    reason = result.reason ?? reason
  } catch {
    // LLM call failed — keep escalate default
  }

  // Write to implicit memory (fire-and-forget, errors do not block decision)
  this.writeEvalMemory(toolName, decision, reason).catch(() => {})

  return { decision, reason }
}

private async writeEvalMemory(
  toolName: string,
  decision: AmygdalaDecision,
  reason: string,
): Promise<void> {
  await this.workspace.writeMemory({
    type: 'implicit',
    content: JSON.stringify({ tool: toolName, decision, reason }),
    tags: ['amygdala_eval', toolName, decision],
    baseImportance: decision === 'allow' ? 0.4 : 0.8,
  })
}
```

### AmygdalaConfig 变更

```typescript
export interface AmygdalaConfig {
  rules?: AmygdalaRule[]
  riskLevels?: Record<string, ToolRiskLevel>
  haiku_enabled?: boolean
  llm?: LlmConfig  // ← 新增：Haiku LLM config for Stage 3
}
```

### check() 参数变更

`_args` → `args`（去掉下划线，Stage 3 实际使用）：

```typescript
async check(
  toolName: string,
  args: Record<string, unknown>,  // was _args
): Promise<{ decision: AmygdalaDecision; reason: string }>
```

## Phase 1: Design & Contracts

### Data Model

无 schema 变更。写入 `memories` 表的 implicit 类型记录：

| 字段 | 值 |
|---|---|
| `type` | `'implicit'` |
| `content` | `JSON.stringify({ tool, decision, reason })` |
| `tags` | `['amygdala_eval', toolName, decision]` |
| `baseImportance` | `allow=0.4 / block|escalate=0.8` |
| `sourceBrain` | `'amygdala'` |

### Quickstart Validation

**V1 — LLM allow 决策**
```typescript
// mock callLlm → '{"decision":"allow","reason":"safe context"}'
// check('bash', {cmd: 'ls'})
// 断言：返回 { decision: 'allow', reason: 'safe context' }
// 断言：writeMemory 被调用，type='implicit', tags 含 'allow'
```

**V2 — LLM block 决策**
```typescript
// mock callLlm → '{"decision":"block","reason":"dangerous command"}'
// 断言：返回 { decision: 'block' }
```

**V3 — LLM 调用失败**
```typescript
// mock callLlm → throw new Error('timeout')
// 断言：返回 { decision: 'escalate' }，不抛异常
// 断言：writeMemory 仍被调用（失败也写记忆）
```

**V4 — haiku_enabled=false 不触发 Stage 3**
```typescript
// haiku_enabled=false（默认）
// check('bash', {})
// 断言：callLlm 未被调用
// 断言：返回 { decision: 'allow' }（static rules 无匹配则 allow）
```

**V5 — 零回归**
```bash
bun test tests/unit/amygdala/
bun test
```

## Complexity Tracking

*无 Constitution 违规，跳过。*


**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/kitty-specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/spec-kitty.plan` command. See `.kittify/templates/commands/plan.md` for the execution workflow.

The planner will not begin until all planning questions have been answered—capture those answers in this document before progressing to later phases.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]  
**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]  
**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]  
**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]  
**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]
**Project Type**: [single/web/mobile - determines source structure]  
**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]  
**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]  
**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

[Gates determined based on constitution file]

## Project Structure

### Documentation (this feature)

```
kitty-specs/[###-feature]/
├── plan.md              # This file (/spec-kitty.plan command output)
├── research.md          # Phase 0 output (/spec-kitty.plan command)
├── data-model.md        # Phase 1 output (/spec-kitty.plan command)
├── quickstart.md        # Phase 1 output (/spec-kitty.plan command)
├── contracts/           # Phase 1 output (/spec-kitty.plan command)
└── tasks.md             # Phase 2 output (/spec-kitty.tasks command - NOT created by /spec-kitty.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

*Fill ONLY if Constitution Check has violations that must be justified*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |