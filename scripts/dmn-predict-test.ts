/**
 * DMN Predictive Activation — 早期验证测试
 *
 * 不依赖任何 AIMA 基础设施，直接用 Claude API 验证核心认知逻辑：
 * 给定充满噪音的 episodic log，DMN 能否准确识别需要主动触发的行为？
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// 加载 .env
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(join(__dirname, ".env"), "utf-8");
  for (const line of env.split("\n")) {
    const [k, ...v] = line.split("=");
    if (k && v.length) process.env[k.trim()] = v.join("=").trim();
  }
} catch {}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── 输出 schema ──────────────────────────────────────────────────────────────

interface Prediction {
  confidence: number; // 0-1
  target_brain: "limbic" | "cortex" | "brainstem";
  action: string; // 具体动作描述
  trigger_condition: string; // 何时/什么条件触发
  entity_ref: string; // 关联的实体（合同号、PO号等）
  reasoning: string; // DMN 的推理说明
  cancellation_condition?: string; // 什么情况下取消这个预测
}

interface DMNOutput {
  predictions: Prediction[];
  ignored_signals: string[]; // DMN 判断为无关噪音的事件摘要
  uncertainty_notes: string[]; // DMN 不确定的地方
}

// ─── 系统提示 ─────────────────────────────────────────────────────────────────

const DMN_SYSTEM_PROMPT = `你是 AIMA 认知框架中的 DMN（默认模式网络）。

你的职责是分析 episodic 事件日志，识别需要主动触发的行为模式——即那些如果不主动介入就可能被遗漏或延误的事项。

你不响应外部触发，你主动预判。

你有三个可以激活的脑区：
- limbic：负责对外沟通（发送消息、跟进确认、提醒）
- cortex：负责内部推理和规划（提前准备分析、加载上下文）
- brainstem：负责工具执行（在指定时间执行操作、触发系统动作）

判断原则：
1. **宁多勿少**：漏报的代价远高于多报。在有合理依据时，倾向于输出预测，即使不确定性较高。上层可以过滤误报，但无法弥补漏报。
2. **自身行为也是信号**：如果 log 中存在 DMN_ACTION 记录，说明该事项上一轮已经预测并处理过。结合处理结果（是否有后续响应）判断是否需要再次触发，避免重复汇报同一件事。
3. 明确区分"有意义的信号"和"无关噪音"——同事闲聊、与业务无关的系统通知等不触发预测
4. 复合场景中可以同时产生多个预测，每个预测独立评估
5. 如果某个预测的前提条件已经被后续事件满足或推翻，明确说明取消条件
6. 置信度低于 0.4 的预测不要输出（阈值从 0.5 降低，配合宁多勿少原则）

以 JSON 格式输出，schema:
{
  "predictions": [
    {
      "confidence": number,          // 0-1
      "target_brain": "limbic" | "cortex" | "brainstem",
      "action": string,              // 具体动作
      "trigger_condition": string,   // 何时/什么条件触发
      "entity_ref": string,          // 关联实体
      "reasoning": string,           // 推理说明
      "cancellation_condition": string  // 可选，什么情况下取消
    }
  ],
  "ignored_signals": string[],       // 被判断为无关噪音的事件摘要
  "uncertainty_notes": string[]      // 不确定的地方
}`;

// ─── 测试场景 ─────────────────────────────────────────────────────────────────

const scenarios: Array<{ name: string; description: string; log: string; expected: string }> = [
  {
    name: "场景 A — 采购流程 + 大量日常噪音",
    description: "正常采购流程夹杂大量无关的办公室日常事件",
    expected: "预测付款跟进；忽略所有噪音",
    log: `
[09:00] SYSTEM   | PO-2847 已创建，申请人：陈工，金额：¥128,000，供应商：联华科技
[09:03] TEAMS    | 王总 → 全体：大家早上好！今天天气不错
[09:07] TEAMS    | 李梅 → IT支持：打印机又卡纸了，谁来帮忙看看
[09:12] TEAMS    | 办公室群 → 全体：今天下午3点会议室B有团建活动，欢迎参加🎉
[09:15] SYSTEM   | 供应商"联华科技"已确认 PO-2847，预计交货期 7 个工作日
[09:18] TEAMS    | 张三 → 全体：有人知道公司wifi密码吗，我换手机了
[09:19] TEAMS    | 小李 → 张三：密码是 office2024，别发群里啊哈哈
[09:22] CALENDAR | 陈工 的日历：下午 2:00 - 季度复盘会议（时长 2h）
[09:28] TEAMS    | 人事部 → 全体：本周五是小王的生日，大家准备一下惊喜
[09:30] SYSTEM   | PO-2847 采购审批通过，审批人：王总
[09:35] TEAMS    | 赵工 → IT支持：我的电脑键盘方向键坏了，怎么报修
[09:40] SYSTEM   | 打印机状态：离线（纸张卡住）
[09:45] TEAMS    | 大群 → 全体：楼道的快递到了，大家去取一下
[09:50] CALENDAR | 系统提醒：明天 10:00 全公司月度例会
[09:55] TEAMS    | 陈工 → 王总：感谢审批，我跟供应商确认一下交货安排
`.trim(),
  },
  {
    name: "场景 B — 复合场景：合同+审批+请假重叠",
    description: "多个业务流程同时进行，加上人员请假影响",
    expected: "合同付款预测、PO跟进预测、请假期间任务转交提醒",
    log: `
[Day 1, 10:00] SYSTEM   | 合同 CONTRACT-C2847 已签署，合同方：启明星科技，金额：¥450,000
[Day 1, 10:30] TEAMS    | 全体 → 大群：新来的实习生小刘今天入职，大家欢迎一下
[Day 2, 09:15] SYSTEM   | PO-5521 已创建，申请人：张姐，金额：¥32,000
[Day 2, 11:00] TEAMS    | 老板 → 全体：本周末公司年会，请大家确认出席
[Day 2, 14:00] SYSTEM   | 张姐提交请假申请：Day 5 至 Day 9（年假5天）
[Day 2, 14:30] TEAMS    | 小李 → 大群：谁有好的火锅推荐，周五团建要订
[Day 3, 09:00] SYSTEM   | 供应商确认 PO-5521，报价有效期 14 天
[Day 3, 16:00] TEAMS    | 技术群 → 全体：下午服务器例行维护，部分系统暂停 2 小时
[Day 4, 09:30] TEAMS    | 采购群 → 张姐：PO-5521 的审批还没动静，催一下？
[Day 4, 10:00] SYSTEM   | 张姐请假审批通过，Day 5 起生效
[Day 4, 17:00] TEAMS    | 小王 → 大群：明天是周五，提前祝大家周末愉快
[Day 5, 09:00] SYSTEM   | 张姐状态：休假中
[Day 5, 09:15] TEAMS    | 采购群 → 全体：年会场地确认，请各部门报人数
[Day 5, 11:00] TEAMS    | 闲聊群 → 全体：楼下新开了一家奶茶店，好喝推荐
[Day 27, 09:00] SYSTEM  | 系统日历提醒：CONTRACT-C2847 已签署 27 天
[Day 27, 10:30] TEAMS   | 老板 → 全体：本月销售数据出来了，大家看一下报告
[Day 27, 14:00] TEAMS   | IT群 → 全体：请大家更新系统密码，安全要求
`.trim(),
  },
  {
    name: "场景 C — 负面测试：流程已完成，不应触发",
    description: "合同付款已确认，预算冻结，验证 DMN 不乱预测",
    expected: "不触发付款预测（已完成）；不触发采购动作（预算冻结）",
    log: `
[Day 1, 10:00]  SYSTEM   | 合同 CONTRACT-C1203 已签署，金额：¥280,000
[Day 1, 15:00]  TEAMS    | 全体：下午茶时间到，咖啡在茶水间
[Day 15, 09:00] SYSTEM   | CONTRACT-C1203 付款确认收据已上传，付款金额：¥280,000
[Day 15, 09:05] COMPLIANCE | CONTRACT-C1203 付款完成，状态变更为：已结清
[Day 15, 11:00] TEAMS    | 财务群 → 全体：本月报销截止明天，大家尽快提交
[Day 20, 09:00] SYSTEM   | 财务部通知：Q2预算冻结，所有新采购申请暂停审批
[Day 20, 10:00] SYSTEM   | PO-6633 已创建，申请人：小陈，金额：¥15,000
[Day 20, 10:30] TEAMS    | 小陈 → 采购群：PO-6633 提交了，麻烦审批一下
[Day 20, 14:00] TEAMS    | 全体 → 大群：今天下雨，停车场比较堵，大家早点走
[Day 28, 09:00] SYSTEM   | 系统日历提醒：CONTRACT-C1203 已签署 28 天
[Day 28, 10:00] TEAMS    | 老板 → 管理层：下周战略规划会，请各部门准备汇报材料
`.trim(),
  },
  {
    name: "场景 D — 模式冲突：审批超时但审批人在休假",
    description: "审批流程超时，但正常升级路径受阻（审批人请假），噪音干扰",
    expected: "识别升级需求，预测转交或提醒，考虑审批人状态",
    log: `
[Day 1, 09:00]  SYSTEM   | 风险评估申请 RISK-0892 提交，申请人：林工，要求审批人：刘总监
[Day 1, 09:30]  TEAMS    | 全体：公司开放日活动下周举行，欢迎邀请家属参观
[Day 1, 14:00]  SYSTEM   | 刘总监 OOO 状态启动，时长：Day 1 - Day 10（出差新加坡）
[Day 2, 10:00]  TEAMS    | 技术群 → 全体：昨晚部署的新版本上线了，大家测一下
[Day 3, 09:00]  SYSTEM   | RISK-0892 审批状态：等待中（已等待 48 小时）
[Day 3, 11:00]  TEAMS    | 林工 → 采购群：RISK-0892 有进展吗？这个项目下周要启动
[Day 3, 15:00]  TEAMS    | 闲聊群 → 全体：楼上装修，下午会有点噪音，大家见谅
[Day 4, 09:00]  SYSTEM   | SLA 提醒：RISK-0892 已超过标准审批时限（72小时），状态：超时
[Day 4, 09:30]  TEAMS    | 小王 → 全体：谁的外卖放在前台了，快去拿
[Day 4, 10:00]  TEAMS    | 人事 → 全体：本月全勤奖名单已公示，请查收
[Day 4, 14:00]  SYSTEM   | 林工 查看了 RISK-0892 状态（只读）
[Day 4, 16:00]  TEAMS    | 大群 → 全体：今晚有流星雨，推荐去楼顶看
`.trim(),
  },
  {
    name: "场景 E — 闭环测试：DMN 上轮预测已写回 log",
    description: "与场景 A 相同的采购流程，但 log 中包含 DMN 上一轮已汇报的记录，验证误报率是否下降",
    expected: "不重复汇报交货跟进（上轮已发出）；若无响应则升级；噪音同样过滤",
    log: `
[Day 1, 09:00] SYSTEM     | PO-2847 已创建，申请人：陈工，金额：¥128,000，供应商：联华科技
[Day 1, 09:03] TEAMS      | 王总 → 全体：大家早上好！
[Day 1, 09:15] SYSTEM     | 供应商"联华科技"已确认 PO-2847，预计交货期 7 个工作日
[Day 1, 09:18] TEAMS      | 张三 → 全体：有人知道公司wifi密码吗
[Day 1, 09:30] SYSTEM     | PO-2847 采购审批通过，审批人：王总
[Day 1, 09:35] TEAMS      | 大群 → 全体：楼道快递到了
[Day 1, 09:45] TEAMS      | 全体：今晚有羽毛球活动，感兴趣的报名
[Day 5, 08:55] DMN_ACTION | 预测触发：向陈工发送"PO-2847 交货期临近，建议确认联华科技发货状态"
[Day 5, 08:55] DMN_ACTION | 目标脑区：limbic，置信度：0.85，实体：PO-2847
[Day 5, 10:30] TEAMS      | 全体：本周五公司聚餐，请大家报名
[Day 5, 14:00] TEAMS      | 小李 → 大群：谁有好的咖啡推荐
[Day 6, 09:00] SYSTEM     | 系统日志：陈工 查看了 PO-2847 状态（只读）
[Day 6, 11:00] TEAMS      | 陈工 → 联华科技联系人（外部）：你好，想确认一下 PO-2847 的发货安排（Teams 外部消息记录）
[Day 6, 14:00] TEAMS      | 全体：停车场B区今天封闭维修
[Day 7, 09:00] SYSTEM     | 当前距离预计交货日还剩 1 个工作日，未收到发货确认
[Day 7, 10:00] TEAMS      | 部门群 → 全体：月度总结报告模板已更新，请大家使用新版
[Day 7, 15:00] TEAMS      | 闲聊群：周末天气不错，有人去爬山吗
`.trim(),
  },

  {
    name: "场景 F — 跨流程依赖链断裂",
    description: "合同A的付款依赖PO-B审批，但PO-B被预算冻结卡住；同时项目启动依赖合同A付款完成；三条流程互锁，夹杂噪音",
    expected: "识别依赖链断裂点（PO-B→合同A→项目启动）；预测向财务或管理层升级解锁预算冻结；不独立触发已被依赖卡住的下游动作",
    log: `
[Day 1, 09:00] SYSTEM     | 合同 CONTRACT-A0031 签署，金额：¥620,000，付款条件：收到服务商发票后7个工作日内付款
[Day 1, 09:30] TEAMS      | 全体 → 大群：茶水间的咖啡机修好了，大家可以去用
[Day 1, 10:00] SYSTEM     | 项目 PROJ-771 创建，状态：待启动，前置条件：CONTRACT-A0031 付款完成
[Day 2, 09:00] SYSTEM     | 服务商"远景咨询"发送发票 INV-2031，金额：¥620,000，关联 CONTRACT-A0031
[Day 2, 09:30] TEAMS      | 小王 → 财务群：INV-2031 已收到，按合同要求需要 PO-B 关联后才能付款
[Day 2, 10:00] SYSTEM     | PO-9901 已创建，申请人：财务小王，金额：¥620,000，备注：关联 CONTRACT-A0031/INV-2031
[Day 2, 11:00] TEAMS      | 部门群 → 全体：下周一新同事入职，大家提前准备好工位
[Day 3, 09:00] SYSTEM     | PO-9901 提交审批，当前审批节点：财务总监
[Day 3, 10:00] SYSTEM     | 财务部公告：Q2预算已冻结，金额超过¥100,000的采购申请暂停审批，解冻时间未知
[Day 3, 10:05] SYSTEM     | PO-9901 审批状态：暂停（预算冻结）
[Day 3, 11:00] TEAMS      | 小王 → 财务群：PO-9901 被冻了，CONTRACT-A0031 的款付不出去
[Day 3, 14:00] TEAMS      | 闲聊群 → 全体：今天午饭楼下新开的餐厅不错，推荐
[Day 4, 09:00] TEAMS      | 项目群 → 全体：PROJ-771 什么时候可以启动？客户那边在催
[Day 4, 09:30] TEAMS      | 小王 → 项目群：合同款没付，供应商没收到款不会开始干活，启动不了
[Day 4, 10:00] TEAMS      | IT群 → 全体：今天下午服务器例行巡检，VPN可能短暂中断
[Day 4, 14:00] SYSTEM     | PROJ-771 状态查询：阻塞中，等待 CONTRACT-A0031 付款
[Day 5, 09:00] TEAMS      | 项目经理李总 → 王总（老板）：PROJ-771 客户催的很急，预算冻结能不能走特批？
[Day 5, 09:30] TEAMS      | 大群 → 全体：本周是节能宣传周，请大家注意随手关灯
[Day 5, 10:00] SYSTEM     | 系统日志：INV-2031 付款截止日：Day 11（合同7日条款）
[Day 5, 11:00] TEAMS      | 闲聊群：周末有人去看演唱会吗
[Day 6, 09:00] TEAMS      | 全体 → 大群：走廊的绿植今天换新了
[Day 6, 10:00] SYSTEM     | 系统日历：距 INV-2031 付款截止还有 5 个工作日
`.trim(),
  },

  {
    name: "场景 G — 关键人员离职级联冲击",
    description: "核心员工突然离职，同时持有5个开放审批任务、2个进行中合同、1个客户关系。下周有3个截止日期。噪音贯穿始终。上轮DMN已汇报过离职信息但未收到处理确认",
    expected: "识别孤儿任务并逐一分析风险优先级；预测紧急任务转交；提醒即将到期项；不重复汇报已汇报过的纯离职通知（上轮DMN已处理）",
    log: `
[Day 1, 08:30] SYSTEM     | 人事系统：张磊（采购经理）提交离职申请，最后工作日：Day 5
[Day 1, 09:00] TEAMS      | 张磊 → 采购群：大家好，我有个消息要跟大家说，今天下午开个小会
[Day 1, 09:30] TEAMS      | 全体 → 大群：楼上在装修，中午会有钻孔声，大家见谅
[Day 1, 10:00] SYSTEM     | 张磊当前持有审批任务：RFQ-4401（供应商资质，截止Day7）、PO-8812（审批中，¥380,000，截止Day6）、CONTRACT-B221（合同谈判中，客户：东方集团，截止Day9）、TENDER-009（招标文件起草，截止Day12）、RISK-1105（风险评估，待审批，已等待3天）
[Day 1, 10:30] TEAMS      | 张磊 → 王总：我今天下午跟团队说我离职的事，具体工作交接明天开始
[Day 1, 11:00] TEAMS      | 全体：今天下午茶改为下午3点，因为有会议
[Day 1, 14:00] SYSTEM     | 张磊当前负责客户关系：东方集团（CONTRACT-B221谈判中，对接人：东方集团-刘副总）
[Day 1, 15:00] TEAMS      | 张磊 → 采购群：正式通知一下，我下周五最后一天，这段时间大家多担待
[Day 2, 09:00] DMN_ACTION | 预测触发：向王总汇报"张磊离职，持有5项开放任务，建议启动交接计划"
[Day 2, 09:00] DMN_ACTION | 目标脑区：limbic，置信度：0.92，实体：张磊/离职
[Day 2, 09:30] TEAMS      | 小李 → 大群：谁的共享单车停在消防通道了，保安在催
[Day 2, 10:00] SYSTEM     | PO-8812 审批节点自动提醒：已等待 24 小时，审批人：张磊（当前：审批中，无响应）
[Day 2, 10:30] TEAMS      | 全体：本周四有安全培训，强制参加，请大家安排好工作
[Day 2, 11:00] SYSTEM     | CONTRACT-B221 下一轮谈判会议预约：Day 4, 14:00，参与方：东方集团-刘副总
[Day 2, 14:00] TEAMS      | 采购群 → 全体：交接安排还没出来，有点乱
[Day 2, 16:00] SYSTEM     | 王总 查看了 DMN 汇报（只读），未产生后续操作
[Day 3, 09:00] TEAMS      | 全体：今天是植树节，环保提醒
[Day 3, 10:00] SYSTEM     | RFQ-4401 状态：评审进行中，截止 Day 7，当前负责人：张磊（即将离职）
[Day 3, 11:00] TEAMS      | 张磊 → 王总：我梳理了一下任务清单发给你了，主要是几个采购和一个合同谈判
[Day 3, 11:30] SYSTEM     | 系统收到张磊发送的交接清单文件（PDF，未分配给任何人）
[Day 3, 14:00] TEAMS      | 闲聊群 → 全体：最近天气变化大，大家注意保暖
[Day 3, 16:00] SYSTEM     | RISK-1105 状态：已等待 5 天，超出 SLA（标准3天），自动升级提醒发送至：张磊（收件人即将离职）
[Day 4, 09:00] SYSTEM     | 系统日历：CONTRACT-B221 谈判会议今天 14:00，与东方集团刘副总（无人确认出席）
[Day 4, 09:30] TEAMS      | 部门群 → 全体：季度KPI模板已发送，请各部门填写
[Day 4, 10:00] TEAMS      | 东方集团-刘副总（外部）→ 张磊：张总，今天下午的会议确认一下，我们那边人都到位了
[Day 4, 11:00] TEAMS      | 全体：食堂今天有烧鸭，推荐
[Day 4, 13:00] SYSTEM     | 张磊查看了 Teams 消息（已读），未回复
[Day 4, 14:00] SYSTEM     | CONTRACT-B221 谈判会议：东方集团方出席，我方无人到场（系统记录：会议爽约）
[Day 4, 16:00] TEAMS      | 东方集团-刘副总 → 张磊：张总，今天等了一个小时没见到人，请问是有什么变化吗？
[Day 5, 08:00] SYSTEM     | 张磊最后工作日。系统标记：张磊账户将在今日17:00停用
[Day 5, 09:00] TEAMS      | 采购群 → 全体：张磊今天最后一天，大家中午一起送别一下
[Day 5, 09:30] SYSTEM     | PO-8812 状态：审批超时（48小时），系统发送提醒至张磊（已失效）
[Day 5, 10:00] TEAMS      | 全体：今天下午3点有消防演练，请大家配合
`.trim(),
  },

  {
    name: "场景 H — 矛盾信号：系统说完成，人说有问题",
    description: "系统COMPLIANCE记录显示项目交付完成并关闭，但Teams里客户和内部项目经理的对话暗示交付物有严重问题。同时存在另一个正常完成的流程作为对照。重噪音。上轮DMN已预测过质量跟进",
    expected: "识别系统状态与实际沟通的矛盾；预测需要人工核查项目真实交付状态；对照组（正常完成的流程）不触发；不重复上轮已汇报的普通跟进",
    log: `
[Day 1, 10:00] SYSTEM     | 项目 PROJ-884 状态变更：进行中 → 已交付，交付人：项目组，客户：广联达集团
[Day 1, 10:05] COMPLIANCE | PROJ-884 交付确认，状态：关闭，合规记录生成
[Day 1, 10:10] SYSTEM     | 项目 PROJ-901 状态变更：进行中 → 已交付，交付人：项目组，客户：北方建工
[Day 1, 10:15] COMPLIANCE | PROJ-901 交付确认，状态：关闭，合规记录生成
[Day 1, 11:00] TEAMS      | 全体 → 大群：今天天气不错，午休可以去楼下走走
[Day 1, 14:00] TEAMS      | 项目经理赵总 → 广联达集团-孙总（外部）：孙总，PROJ-884 系统那边已经关闭了，您看一下验收报告
[Day 1, 14:30] TEAMS      | 广联达集团-孙总 → 赵总：赵总，报告我看了，这个数据迁移部分有问题，我们系统这边测试出来有记录丢失
[Day 1, 15:00] TEAMS      | 赵总 → 广联达集团-孙总：我让技术核查一下，应该是测试环境和生产环境的差异
[Day 1, 15:30] TEAMS      | 全体：下午3点有茶歇，大家去茶水间
[Day 2, 09:00] TEAMS      | 技术群-内部 → 赵总：昨天看了一下，广联达那边说的记录丢失是真实的，数据迁移脚本有个边界条件没处理
[Day 2, 09:15] TEAMS      | 赵总 → 技术群：严重吗？能修吗？
[Day 2, 09:20] TEAMS      | 技术-小陈 → 赵总：丢了大概2300条历史记录，可以修复但需要重新跑迁移，要停2小时的服务窗口
[Day 2, 09:30] TEAMS      | 北方建工-王总（外部）→ 项目经理李工：李工，PROJ-901 的报告收到了，我们验收没问题，下周正式开会做个交接就好
[Day 2, 10:00] TEAMS      | 全体：公司停车场开始收费了，大家办停车卡
[Day 2, 10:30] DMN_ACTION | 预测触发：向赵总确认 PROJ-884 广联达反馈是否需要项目重新开单处理
[Day 2, 10:30] DMN_ACTION | 目标脑区：limbic，置信度：0.72，实体：PROJ-884
[Day 2, 11:00] TEAMS      | 赵总 → 广联达集团-孙总：孙总，技术确认了，确实有问题，我们会修复，不影响您的主体业务流程，修复时间大概本周内
[Day 2, 14:00] TEAMS      | 大群 → 全体：下午有快递，请各部门认领
[Day 2, 16:00] SYSTEM     | 系统日志：PROJ-884 合规状态：已关闭（未更新，合规系统未感知到问题）
[Day 3, 09:00] TEAMS      | 广联达集团-孙总 → 赵总：赵总，昨天说本周内修，现在是周三了，什么时候能安排？我们IT部门要配合你们窗口
[Day 3, 09:30] TEAMS      | 全体：今天是国际妇女节，祝女同事们节日快乐
[Day 3, 10:00] TEAMS      | 赵总 → 技术群：广联达在催了，窗口能定下来吗
[Day 3, 10:30] TEAMS      | 技术-小陈 → 赵总：可以定周四晚上10点，低峰期，需要广联达IT配合
[Day 3, 11:00] TEAMS      | 闲聊群：附近新开了家健身房，有团购折扣
[Day 3, 14:00] SYSTEM     | PROJ-884 系统状态：已关闭（无更新）
[Day 3, 14:30] TEAMS      | 赵总 → 广联达集团-孙总：孙总，窗口定在周四晚10点，需要您这边IT部门届时配合
[Day 4, 09:00] TEAMS      | 全体：今天停电维护，9-11点部分楼层断电
`.trim(),
  },
];

// ─── Tool Use Schema ──────────────────────────────────────────────────────────

const DMN_TOOL = {
  name: "report_predictions",
  description: "输出 DMN 分析结果，包含预测、噪音过滤和不确定项",
  input_schema: {
    type: "object" as const,
    properties: {
      predictions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            confidence: { type: "number", description: "置信度 0-1" },
            target_brain: { type: "string", enum: ["limbic", "cortex", "brainstem"] },
            action: { type: "string", description: "具体动作描述" },
            trigger_condition: { type: "string", description: "何时/什么条件触发" },
            entity_ref: { type: "string", description: "关联实体（合同号、PO号等）" },
            reasoning: { type: "string", description: "推理说明" },
            cancellation_condition: { type: "string", description: "什么情况下取消这个预测" },
          },
          required: ["confidence", "target_brain", "action", "trigger_condition", "entity_ref", "reasoning"],
        },
      },
      ignored_signals: {
        type: "array",
        items: { type: "string" },
        description: "被判断为无关噪音的事件摘要",
      },
      uncertainty_notes: {
        type: "array",
        items: { type: "string" },
        description: "不确定的地方",
      },
    },
    required: ["predictions", "ignored_signals", "uncertainty_notes"],
  },
};

// ─── 运行测试 ─────────────────────────────────────────────────────────────────

async function runScenario(scenario: typeof scenarios[0]): Promise<void> {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`▶ ${scenario.name}`);
  console.log(`  ${scenario.description}`);
  console.log(`  期望结果：${scenario.expected}`);
  console.log("─".repeat(70));

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 4000,
    system: DMN_SYSTEM_PROMPT,
    tools: [DMN_TOOL],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: `以下是最近的 episodic 事件日志，请分析并通过 report_predictions 工具输出你的预测：\n\n${scenario.log}`,
      },
    ],
  });

  // 提取 tool_use block
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    const text = response.content.find((b) => b.type === "text");
    console.log("⚠️  模型未调用工具，原始输出：");
    console.log(text?.type === "text" ? text.text : "(empty)");
    return;
  }

  const output: DMNOutput = toolUse.input as DMNOutput;

  // 输出预测
  if (output.predictions.length === 0) {
    console.log("📭 无预测（DMN 判断无需主动介入）");
  } else {
    console.log(`\n📋 预测（${output.predictions.length} 条）：`);
    for (const p of output.predictions) {
      const bar = "█".repeat(Math.round(p.confidence * 10));
      console.log(`\n  [${p.target_brain.toUpperCase()}] ${p.action}`);
      console.log(`  实体：${p.entity_ref}`);
      console.log(`  触发：${p.trigger_condition}`);
      console.log(`  置信：${bar} ${Math.round(p.confidence * 100)}%`);
      console.log(`  推理：${p.reasoning}`);
      if (p.cancellation_condition) {
        console.log(`  取消：${p.cancellation_condition}`);
      }
    }
  }

  // 噪音过滤
  console.log(`\n🔇 识别为噪音（${output.ignored_signals.length} 条）：`);
  for (const s of output.ignored_signals) {
    console.log(`  · ${s}`);
  }

  // 不确定项
  if (output.uncertainty_notes.length > 0) {
    console.log(`\n❓ 不确定：`);
    for (const n of output.uncertainty_notes) {
      console.log(`  · ${n}`);
    }
  }
}

async function main() {
  console.log("DMN Predictive Activation — 早期验证测试");
  console.log(`使用模型：claude-opus-4-5`);
  console.log(`场景数量：${scenarios.length}`);

  for (const scenario of scenarios) {
    await runScenario(scenario);
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log("测试完成。");
}

main().catch(console.error);
