# Feature Specification: Brain Identity & Role Loading

**Feature**: 007-brain-identity-role-loading
**Status**: Draft
**Created**: 2026-03-11
**Depends on**: Feature 001 (Workspace), Feature 002 (Brain Runtime), Feature 006 (pi-coding-agent Adapter)

---

## Overview

AIMA 当前通过 `AIMAInstanceConfig.identities` 传入硬编码字符串作为各脑区身份。这导致虚拟员工没有真实人格、角色定义和技能索引，无法在部署时按需配置，也无法实现 Feature 006 中 Amygdala 工具权限的动态解锁（role.md 解锁 bash/edit 等）。

本 Feature 实现从文件系统目录（`identityDir`）加载脑区身份内容，替换 Context Assembly Block 1/2 的静态字符串来源，并将 role.md 中声明的工具权限映射为 Amygdala 策略覆盖。

---

## Actors

- **部署者**（配置方）：配置 `identityDir` 路径，编写 soul.md / brain role 文件 / skill-index.md
- **AIMA 框架**（系统）：在启动时加载并缓存文件内容；注入 Context Assembly；向 Amygdala 注册工具权限
- **Amygdala**：读取从 role 文件派生的工具权限策略，覆盖内置默认值
- **运维人员**：调用 `reloadIdentity()` 在不重启进程的情况下刷新缓存

---

## Problem Statement

### P1：虚拟员工缺乏可配置身份

当前 Block 1（核心人格）和 Block 2（角色职责）内容通过代码硬编码传入，无法按部署场景调整。一个 "Alex 财务助理" 和 "Sam 技术顾问" 需要不同的 soul.md 和 role.md，但当前架构无法支持文件化配置。

### P2：Amygdala 工具策略无法动态解锁

Feature 006 的 Amygdala 内置了 bash/edit/write 的默认封锁策略。若某脑区角色需要执行代码（如 Brainstem 执行技术任务），无法通过配置解锁——只能修改代码。

### P3：技能索引无法注入

当前 Block 2 没有技能索引来源。LLM 不知道自己拥有哪些 Skill（Markdown 技能文件），无法调用。

---

## Functional Requirements

### FR-01：identityDir 目录结构

支持以下 flat 目录结构（所有文件可选；缺失文件使用空字符串或系统默认值）：

```
identityDir/
├── soul.md           ← Block 1：核心人格（所有脑区共享）
├── skill-index.md    ← Block 2 前缀：技能索引（所有脑区共享）
├── limbic.md         ← limbic 专属 Block 2 角色
├── cortex.md         ← cortex 专属 Block 2 角色
└── brainstem.md      ← brainstem 专属 Block 2 角色
```

每个脑区 role 文件（`{brain}.md`）支持 YAML frontmatter：

```yaml
---
allowed_tools:
  - bash
  - edit
---
（正文：角色职责描述）
```

`allowed_tools` 列表中声明的工具名称从 Amygdala 的 `DEFAULT_BLOCKED_TOOLS` 中移除（解锁）。

**验收条件**：
- `soul.md` 缺失时，Block 1 回退到空字符串（不报错）
- `{brain}.md` 缺失时，该脑区 Block 2 回退到空字符串
- `skill-index.md` 缺失时，技能索引部分为空
- 不在 `DEFAULT_BLOCKED_TOOLS` 中的工具名称在 `allowed_tools` 中被忽略（无副作用）

### FR-02：启动时加载并缓存

`AIMAInstance` 初始化时（收到 `identityDir` 配置后）一次性加载所有文件并缓存为内存对象。后续 `run()` 调用直接读取缓存，不重复访问文件系统。

**验收条件**：
- 实例创建后修改文件内容，不影响运行中的缓存（直到显式 reload）
- `identityDir` 路径不存在时，初始化失败并抛出有意义的错误（路径 + 原因）
- 目录存在但文件缺失时，正常初始化（缺失文件视为空内容）

### FR-03：注入 Context Assembly Block 1/2

将加载的文件内容整合到 Context Assembly 输出中：

- **Block 1**（`assembleBlock12` 中）：`soul.md` 内容替换现有 identity 字符串来源
- **Block 2**（`assembleBlock12` 中）：
  - 共享部分：`skill-index.md` 内容
  - 脑区专属部分：`{brain}.md` 正文（frontmatter 已剥离）

`identityDir` 未配置时，`assembleBlock12` 行为与现在完全一致（向后兼容）。

**验收条件**：
- Block 1 输出包含 `soul.md` 正文
- Block 2 输出包含 `skill-index.md` + 对应脑区 `.md` 正文
- frontmatter（`---` 块）不出现在 Context Assembly 输出中
- 无 `identityDir` 配置时，现有测试不受影响

### FR-04：Amygdala 工具权限覆盖

加载完成后，将每个脑区 role 文件的 `allowed_tools` 列表传入 Amygdala，使其在该脑区的 `tool_call` 判断中将对应工具从 `DEFAULT_BLOCKED_TOOLS` 中解锁。

覆盖规则：
- 覆盖是**脑区级别**的——limbic 的 `allowed_tools: [bash]` 只解锁 limbic 的 bash，不影响 cortex
- Amygdala 提供 `setRolePolicy(brain, allowedTools)` 方法接收覆盖（或通过扩展 Extension Factory 参数）
- `allowed_tools` 中不在 `DEFAULT_BLOCKED_TOOLS` 的工具名称静默忽略

**验收条件**：
- brainstem.md 声明 `allowed_tools: [bash]` → brainstem 的 bash 工具调用不被默认策略拦截
- limbic.md 未声明 `allowed_tools` → limbic bash 仍被拦截
- 覆盖在启动时生效，不需要等到第一次 `run()`

### FR-05：`reloadIdentity()` 显式刷新

`AIMAInstance` 暴露 `reloadIdentity(): Promise<void>` 方法：
- 重新读取 `identityDir` 下所有文件
- 更新内存缓存
- 重新注册 Amygdala 工具权限覆盖
- 下一次 `run()` 时使用新内容

`reloadIdentity()` 在未配置 `identityDir` 时静默返回（无操作）。

**验收条件**：
- `reloadIdentity()` 后新增的 `allowed_tools` 声明在下一次 `run()` 生效
- `reloadIdentity()` 不中断正在进行的 `run()` 调用

### FR-06：`AIMAInstanceConfig` 扩展

```typescript
interface AIMAInstanceConfig {
  // 新增
  identityDir?: string  // 可选；未设置时行为与现在完全一致
  reloadOnRun?: boolean // 默认 false；true 时每次 run() 前自动 reload（高级用法）
  // ...现有字段不变
}
```

`identityDir` 为可选字段，缺失时完全向后兼容。

**验收条件**：
- 不传 `identityDir` 的现有代码零修改可运行
- `reloadOnRun: true` 时每次 `run()` 前自动调用 `reloadIdentity()`

---

## User Scenarios & Testing

### 场景 A：配置 identityDir 后脑区获得角色身份

1. 部署者在 `./identity/` 目录放置 `soul.md`（"你是 Alex，一个尽职的财务助理"）和 `limbic.md`（角色描述）
2. 创建 `AIMAInstance({ identityDir: './identity', adapter: 'pi-coding-agent', ... })`
3. 触发 limbic 脑区激活
4. limbic 收到的 Block 1 包含 soul.md 内容，Block 2 包含 limbic.md 正文

**测试验证**：不启动真实 LLM，拦截 Context Assembly 输出，验证 soul.md / limbic.md 内容存在于 Block 1/2 中。

### 场景 B：role.md 解锁 bash 工具

1. `brainstem.md` frontmatter 声明 `allowed_tools: [bash]`
2. brainstem 脑区激活，LLM 调用 bash 工具
3. Amygdala tool_call 检查：bash 在 brainstem 的解锁列表中 → 放行
4. limbic 同场景下 bash 仍被拦截

**测试验证**：mock Amygdala check，验证 brainstem 的 bash 不被 DEFAULT_BLOCKED_TOOLS 拦截；limbic 仍被拦截。

### 场景 C：文件缺失时优雅降级

1. `identityDir` 配置存在，但 `cortex.md` 缺失
2. cortex 脑区激活
3. Block 2 cortex 部分为空字符串（不报错，其余脑区正常）

**测试验证**：验证缺失文件场景下 `assembleContext()` 不抛异常，输出符合预期。

### 场景 D：`reloadIdentity()` 刷新后新策略生效

1. 启动时 `brainstem.md` 无 `allowed_tools`，bash 被拦截
2. 运维人员修改 `brainstem.md`，添加 `allowed_tools: [bash]`
3. 调用 `instance.reloadIdentity()`
4. 下一次 brainstem run() 时，bash 工具放行

**测试验证**：验证 `reloadIdentity()` 后 Amygdala 策略更新；下一次 tool_call 检查使用新策略。

---

## Key Entities

- **IdentityLoader**：负责读取、解析、缓存 identityDir 文件内容的内部组件
- **IdentityCache**：内存缓存结构，包含 `soul: string`、`skillIndex: string`、`roles: Record<CognitiveBrainType, { body: string; allowedTools: string[] }>`
- **RolePolicy**：Amygdala 的脑区级别工具权限覆盖；由 IdentityLoader 传入

---

## Assumptions

- `identityDir` 中的文件编码为 UTF-8
- YAML frontmatter 格式遵循标准（`---` 包裹，`allowed_tools` 为字符串数组）；解析错误时记录警告并忽略 frontmatter（正文仍加载）
- `allowed_tools` 只声明解锁（白名单扩展），不支持额外封锁（封锁靠 Amygdala 策略规则）
- Amygdala 当前的 `check()` 方法接受脑区级别的策略注入（或通过 Extension Factory 参数实现）
- `reloadOnRun: true` 是高级用法，默认关闭，文档中标注"会增加文件 I/O 延迟"

---

## Success Criteria

1. **身份注入完整性**：Block 1/2 在配置 `identityDir` 后 100% 包含对应文件内容（soul.md / brain.md 正文）；frontmatter 不出现在输出中
2. **工具权限解锁准确性**：`allowed_tools` 声明的工具在对应脑区 100% 解锁；未声明脑区不受影响
3. **向后兼容**：不传 `identityDir` 的所有现有测试零失败
4. **启动加载性能**：文件加载（含解析）在 100ms 内完成（10 个 < 50KB 的文件）
5. **优雅降级**：缺失文件场景无异常抛出，降级为空内容
6. **测试密度**：单元测试 ≥ 20 个，覆盖所有 FR 核心路径和边界条件
7. **`bun run typecheck` 零错误，`biome check` 通过**

---

## Out of Scope

- 从数据库或远程 URL 加载身份内容（仅本地文件系统）
- 多租户 / 多 agent 实例共享同一 identityDir（每个 AIMAInstance 独立缓存）
- role.md 中声明额外封锁规则（仅支持解锁，封锁靠 Amygdala 规则系统）
- identity 文件的版本控制或 diff 检测
- Block 3/4 内容（这是 Session 状态和记忆，不是身份）
