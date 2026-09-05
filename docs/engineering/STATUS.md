# Engineering Status

更新时间：2026-09-06

## 当前基线

- 仓库只维护 `main`。
- Desktop 仍处于 **Product Recovery**；真实项目验收完成前不能称为可用版本。
- 一级工作区固定：`素材 / 剧本 / 时间线 / 审阅`。
- 核心原则：**共享对象，不共享工作流。**

## P0 结构恢复状态

P0 的代码结构恢复已收口：

- Material / Script / Timeline / Review 各自拥有 loader、selection、toolbar、drawer 与写权限；
- `MaterialScriptWorkbench` 已删除；
- Material 是资产与拍摄事实中心，场记 / 素材库 / Take / 人物为内部 view，本机素材为 contextual repair；
- ScriptBlock 是剧本 Primary Canvas，Coverage 为 `正文 / 覆盖 / 问题` projection，placement 只由 Script 写；
- Review 是 Viewer-first 的看片与 Take-level Final Editorial Decision 工作区，`需关注` 只是 queue/filter；
- Timeline 是唯一正式本机 editor，Delivery / export 是 Timeline contextual flow；
- `ProductionSelectionContext` + `ProductionNavigationIntent` 统一承载跨工作区 Take / clip / ScriptBlock / Timeline clip 的选择与导航意图，不成为业务 truth；
- canonical `Take / ScriptBlock / Media / Slate / Identity` renderer 保持单一 owner；
- 旧 Review assignment decision UI、独立 Coverage/Rough Cut/Assembly Workbench、旧 Material/Script theme patch 等无 owner recovery 残留已移除；
- legacy resume 值仍只作为内部兼容入口 canonicalize 到 Script / Timeline / Review，不恢复旧页面。

## 当前验证状态

- 本轮 convergence 代码完成后必须统一执行适用自动 gate。
- 在目标 commit 的自动 gate 真正完成前，**不记录 PASS**。
- 真实项目五步 happy path 仍需要 macOS 桌面环境实际验收。

## 最低产品验收

真实项目必须连续完成：

1. 找到实际 Take；
2. 理解拍摄事实、机位和当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到 Timeline 继续剪。

P0 关闭条件是：上述主链真机可用，并且目标 commit 的必要自动 gate 实际通过。CI green 不能替代真实可用性验收。
