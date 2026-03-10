# Tasks: DMN Reactive & Consolidation (Feature 003)

## 工作包总览

| WP | 标题 | 子任务 | 依赖 | 优先级 |
|---|---|---|---|---|
| WP01 | DmnService 骨架 + Haiku 封装 | T001-T004 | — | P0 |
| WP02 | DmnReactive — 错误恢复 + DEFER + 信号捕获 | T005-T009 | WP01 | P0 |
| WP03 | DmnReactive — brain.complete 四联职责 | T010-T014 | WP01 | P0 |
| WP04 | DmnConsolidation — 前瞻预测 + Pending 维护 | T015-T019 | WP01 | P1 |
| WP05 | DmnConsolidation — Implicit 聚类 + 集成 | T020-T024 | WP01, WP04 | P1 |
| WP06 | 单元测试 | T025-T030 | WP01~WP05 | P1 |
| WP07 | 集成测试 + smoke test | T025, WP05 | WP06 | P2 |

WP02 和 WP03 可并行（都依赖 WP01，互不依赖）。
WP04 和 WP03 可并行（都依赖 WP01）。

---

## WP01 — DmnService 骨架 + Haiku 封装

**目标**：建立 DMN 模块的基础结构：类型定义、一次性 Haiku 调用封装、DmnService 顶层生命周期类。

子任务：
- [x] T001: DmnConfig 类型（consolidationInterval, maxRetries, llmModel, apiKey）
- [x] T002: callHaiku(prompt, config) 一次性 LLM 调用封装（@anthropic-ai/sdk 直调，无对话历史）
- [x] T003: DmnService 类骨架（start/stop/runConsolidationNow，组合 Reactive + Consolidation）
- [x] T004: AIMAInstance 集成（config.enableDmn，start() 时条件启动 DmnService）

**Prompt**: WP01-dmn-service-skeleton.md

---

## WP02 — DmnReactive — 错误恢复 + DEFER + 信号捕获

**目标**：实现 DmnReactive 的事件订阅框架及三项确定性职责（职责1/6/7）。

子任务：
- [x] T005: DmnReactive 类结构 + Event Bus 订阅（start/stop）+ 异步 handler 隔离
- [x] T006: 错误恢复 handler（职责1）— ALERT 事件 → retry Slot 或 Thread interrupted
- [x] T007: DEFER 调度 handler（职责6）— Limbic Slot DEFER → pending 写入
- [x] T008: 信号捕获 handler（职责7）— 规则匹配 + Haiku fallback → pending 写入
- [x] T009: 重试计数追踪（working 记忆存 retryCount，超限降级）

**Prompt**: WP02-dmn-reactive-error-defer.md

---

## WP03 — DmnReactive — brain.complete 四联职责

**目标**：实现 brain.complete 事件触发的四项并发职责：段分配、显著性处理、记忆反馈、回溯纠错。

子任务：
- [x] T010: brain.complete 事件 handler 入口（Promise.all 并发执行四项职责）
- [x] T011: 段分配（职责3）— threadSegments 内存 Map + segment_id/segment_seq 分配逻辑 + episodic 写入
- [x] T012: 显著性处理（职责4）— significance_boost 读取 + base_importance 叠加到 episodic 写入
- [x] T013: 记忆使用反馈（职责5）— injectedMemoryIds + 确定性 outcome 评估 + markUsed 调用
- [x] T014: 回溯纠错（职责2）— 读最近 N 条事件 + Haiku 判断 + dmn_correction Signal 写入

**Prompt**: WP03-dmn-reactive-brain-complete.md

---

## WP04 — DmnConsolidation — 前瞻预测 + Pending 维护

**目标**：实现 DmnConsolidation 的心跳框架及前两项批处理职责。

子任务：
- [x] T015: DmnConsolidation 类结构 + setInterval 心跳 + lastRunAt 增量追踪
- [x] T016: 读 episodic 增量（created_at > lastRunAt，分页读取）
- [x] T017: 前瞻预测（职责1）— 读 episodic+procedural+semantic 模式 + Haiku 判断 → pending 写入
- [x] T018: Pending 维护（职责2）— 读当前 pending + 增量 + Haiku 重评估 → 移除/保留/更新
- [x] T019: Consolidation 单次运行入口（runOnce）+ 三项职责并发执行框架

**Prompt**: WP04-dmn-consolidation-prediction-pending.md

---

## WP05 — DmnConsolidation — Implicit 聚类 + 集成

**目标**：实现 implicit 记忆聚类合并职责，完成 DmnService 集成，更新公共导出。

子任务：
- [x] T020: 读近期 provisional implicit 记忆（tag 过滤，时间窗口）
- [x] T021: Haiku 语义相似度判断 + 聚类分组
- [x] T022: canonical 写入 + supersedes_ids 软删除旧记录（幂等性检查）
- [x] T023: DmnService 注入 AIMAInstance + 完整 start/stop 流程测试（手动验证）
- [x] T024: src/index.ts 追加 DMN 公共导出（DmnService, DmnConfig 类型）

**Prompt**: WP05-dmn-consolidation-implicit-integration.md

---

## WP06 — 单元测试

**目标**：无 DB 无真实 LLM 的纯单元测试，覆盖 Reactive 和 Consolidation 核心路径。

子任务：
- [x] T025: DmnService 生命周期单元测试（start/stop/runConsolidationNow）
- [x] T026: DmnReactive 错误恢复单元测试（可重试 vs 不可重试，重试计数）
- [x] T027: DmnReactive DEFER 调度单元测试（pending 写入参数验证）
- [x] T028: DmnReactive brain.complete 单元测试（段分配、significance、markUsed）
- [x] T029: DmnReactive 回溯纠错单元测试（Haiku mock → dmn_correction Signal）
- [ ] T030: DmnConsolidation 前瞻预测 + Pending 维护单元测试（Haiku mock）

**Prompt**: WP06-unit-tests.md

---

## WP07 — 集成测试 + smoke test

**目标**：真实 DB 环境验证 DMN 完整流程；选跑 smoke test（需 ANTHROPIC_API_KEY）。

子任务：
- [ ] T031: 集成测试 helper（mock LLM + 真实 DB + MockBrainAdapter 复用 Feature 002）
- [ ] T032: 集成测试 — 错误恢复完整周期（ALERT → retry → Thread 完成）
- [ ] T033: 集成测试 — DEFER → pending → Limbic 重激活
- [ ] T034: 集成测试 — brain.complete → episodic 写入 + segment_id + markUsed 计数
- [ ] T035: Consolidation smoke test（需 ANTHROPIC_API_KEY，条件跳过）

**Prompt**: WP07-integration-tests.md

