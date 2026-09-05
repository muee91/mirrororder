# Engineering Status

更新时间：2026-09-06

## 当前基线

- 仓库只维护 `main`。
- Desktop 仍处于 **Product Recovery**；未完成最终自动 gate 与真实项目验收前不能称为可用版本。
- 一级工作区固定：`素材 / 剧本 / 时间线 / 审阅`。
- 核心原则：**共享对象，不共享工作流。**

## 已完成的产品恢复

- Material / Script / Review 已拆除跨域万能 Workbench，各自拥有独立 workflow。
- Material 已收成资产与拍摄事实中心：场记 / 素材库 / Take / 人物为内部 view，本机素材只做修复工具。
- ScriptBlock 已成为剧本 Primary Canvas；Coverage 是 `正文 / 覆盖 / 问题` projection；人工 placement 只在 Script 写。
- Timeline 已成为唯一正式本机 editor；Material / Review 可携带 Take（Review 还携带 clip）进入 Timeline，优先定位已有 timeline clip，否则定位同 Take Source。
- Delivery 已降为 Timeline 内 `交付 / 导出` contextual flow；历史 delivery route canonicalize 到 Timeline。
- 项目内已建立 typed `ProductionNavigationIntent` 作为 selection/navigation intent，不建立第二业务 truth。
- Review 已完成主体收口：
  - 队列不再按 placement 的“候选 / 待归集 / 已归集”组织，改为 `全部 / 未决定 / 需关注 / Best / Keep / Reject`；
  - Viewer / 机位播放位于人工决定之前，制作证据保持按需展开；
  - Take 级 Final Editorial Decision 由 Review 自己拥有，不再依附 TakeInspector workflow；
  - 团队个人意见作为决定上下文保留；剧本段级反馈只做提示，不在 Review 展开第二套段落裁决工作台；
  - `需关注` 只形成看片队列，不在 Review 修 placement / 素材 / Timeline；
  - 当前 Take 明确可“在素材中打开 / 在剧本中打开 / 到时间线”；
  - 在“未决定”队列做出最终决定后，Review model 刷新，当前 Take 退出该队列并自然进入下一条。

## 仍未完成

现在只剩 **最终 convergence + validation**：

- Script 内重新选择 Take 后的 typed cross-workspace context propagation；
- 清理旧 `showEditorial` compatibility、旧未使用 EditorialDecisionPanel / assignment-level Desktop UI 等失去产品 owner 的残留；
- product contract / UI authority / Python source-shape assertions 与当前结构统一；
- 收掉失去 owner 的 route / CSS / migration 残留；
- 完整自动验证；
- 真实项目五步 happy path 真机验收。

## 最低产品验收

真实项目必须连续完成：

1. 找到实际 Take；
2. 理解拍摄事实、机位和当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到 Timeline 继续剪。

## 验证策略

- 当前 Recovery 先完成 coherent 功能批次，非必要不手动反复触发 CI。
- 未实际执行的检查不得写 PASS。
- 下一批次直接做最终 convergence，随后统一跑适用自动 gate，再做真实项目真机验收。
