# Quickstart / Definition of Done: Brain Output Model Migration

## 验证命令

```bash
# 从 AIMA repo 根目录运行
cd /Volumes/leoyun/aima

# 1. 主验证：407 项测试全部通过
bun test

# 2. 旧枚举零残留
grep -r "mode === 'RESPOND'" src/     # 应返回 0 条
grep -r "mode === 'EXECUTE'" src/     # 应返回 0 条
grep -r "mode === 'ROUTE'" src/       # 应返回 0 条
grep -r "mode === 'DEFER'" src/       # 应返回 0 条
grep -r "mode === 'NO_REPLY'" src/    # 应返回 0 条
grep -r "intent === 'both'" src/      # 应返回 0 条
grep -r "intent === 'communicate'" src/  # 应返回 0 条
grep -r "intent === 'execute'" src/   # 应返回 0 条
grep -r "type Intent" src/            # 应返回 0 条
grep -r "type ComplexityHint" src/    # 应返回 0 条

# 3. Migration 已存在
ls drizzle/migrations/ | grep 0002    # 应看到 0002_*.sql
```

---

## 验证场景

### 场景 A：Limbic 同时回复 + 路由 Brainstem（User Story 1）

**构造 Limbic 输出**：
```json
{
  "next": "brainstem",
  "reply": "好的，我来处理发邮件给 Alice 的请求。",
  "handoff": "发送邮件给 Alice，主题：项目更新"
}
```

**预期行为**：
1. Thread Runner 读取 `reply` → emit `thread.reply` 事件（含回复内容）
2. Thread Runner 读取 `next: 'brainstem'` → 激活 Brainstem
3. 两者均发生，没有一个被跳过
4. Brainstem 的 input slot 包含 `handoff` 内容

---

### 场景 B：Brainstem 自主路由回 Limbic（User Story 2）

**构造 Brainstem 输出**：
```json
{
  "next": "limbic",
  "handoff": "邮件已成功发送给 Alice。时间：2026-03-12 14:30。"
}
```

**预期行为**：
1. Thread Runner 激活 Limbic
2. Limbic 接收到 `handoff` 内容作为输入上下文
3. Limbic 据此组织告知用户的回复消息

---

### 场景 C：Brainstem 完成后静默结束（User Story 2）

**构造 Brainstem 输出**：
```json
{
  "next": null
}
```

**预期行为**：Thread 进入 `complete` 状态，Limbic 不被激活，用户不收到消息。

---

### 场景 D：DEFER（Limbic 延迟等待）

**构造 Limbic 输出**：
```json
{
  "next": "self",
  "timeout_ms": 300000
}
```

**预期行为**：
1. Thread 进入 `waiting` 状态
2. pending observation 写入，`triggerAt = now + 300000ms`
3. 5 分钟后，routePending 恢复原 Thread 并激活 Limbic

---

### 场景 E：非法路由（Cortex → self）

**构造 Cortex 输出**：
```json
{
  "next": "self"
}
```

**预期行为**：Thread Runner 检测到非法转换 → Thread 进入 `interrupted` 状态。

---

### 场景 F：空输出（等同 next: null）

**构造任意脑区输出**：
```json
{}
```

**预期行为**：Thread Runner 读取 `next = undefined` → Thread 进入 `complete` 状态。

---

### 场景 G：routePending 按 target_brain 路由（User Story 4）

**构造 pending observation**：
```json
{
  "targetBrain": "cortex",
  "note": "定期分析用户行为模式",
  "threadId": null
}
```

**预期行为**：routePending 创建新 Thread → 激活 Cortex（不激活 Limbic）。

---

## Definition of Done

- [ ] `bun test` 输出 407 通过，0 失败，0 跳过
- [ ] `grep -r "type Intent" src/` 返回 0 条
- [ ] `grep -r "type ComplexityHint" src/` 返回 0 条
- [ ] `grep -r "mode ===" src/` 返回 0 条（针对旧 mode 枚举的字符串比较）
- [ ] `grep -r "intent === 'both'" src/` 返回 0 条
- [ ] `drizzle/migrations/0002_*.sql` 存在，包含 DROP COLUMN 语句
- [ ] `src/runner/index.ts` 中不含 `intent === 'both'` 三步路由逻辑
- [ ] `src/schema/slots.ts` 中不含 `intent`/`complexityHint` 列定义
- [ ] 场景 A-G 通过手动或自动化验证
