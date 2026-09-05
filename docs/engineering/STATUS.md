# Engineering Status

更新时间：2026-09-06

## 当前基线

- 仓库只维护 `main`。
- Desktop 仍处于 **Product Recovery**，未完成真实项目验收前不能称为可用版本。
- 一级工作区固定：`素材 / 剧本 / 时间线 / 审阅`。
- 核心原则：**共享对象，不共享工作流。**

## 已完成的恢复切片

- P0.1 / P0.2：删除跨域 `MaterialScriptWorkbench`，Material / Script / Review 分离 ownership。
- P0.3：Material 收成一个资产与拍摄事实中心，场记 / 素材库 / Take / 人物为内部 view，本机素材为修复工具。
- P0.4：ScriptBlock 成为剧本 Primary Canvas；Coverage 合并为 `正文 / 覆盖 / 问题` projection；placement 仍只由 Script 写入。
- 当前批次完成 Timeline + cross-workspace context 的主体恢复：
  - `TimelineWorkbench` 是唯一正式本机 editor；
  - Material / Review 可携带当前 Take（Review 还携带当前 clip）进入 Timeline；
  - 项目内使用 typed `ProductionNavigationIntent` 传递 selection/navigation intent，不建立第二业务 truth；
  - Timeline 优先定位已有 timeline clip，否则定位同 Take 的可播放 Source；
  - Source 工具在带入 Take 时自动展开，可直接 Insert / Overwrite；
  - Timeline clip 主标签优先显示人能识别的 Take，而不是内部 group/clip id；
  - Delivery 不再是 Timeline 的并列页面，改由 Timeline 内 `交付 / 导出` 打开 contextual flow；历史 `delivery` resume/page request canonicalize 到 Timeline。

## 仍未完成

- Review 还需要最后一次纯化：Viewer-first、人工决定优先，并补齐“回素材 / 到时间线 / 在剧本中打开”的最终交互层级。
- typed project context 已建立，但 Script 内重新选择 Take 后的跨区 selection propagation 仍要在最终 convergence 中补齐。
- product contract / UI authority / stale source-shape assertions 尚未统一收口；当前不宣称自动 gate PASS。
- 真实项目五步 happy path 尚未真机验证。

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
- 最终 convergence 后统一跑适用自动 gate，再做真实项目真机验收。

## 下一批次

直接处理 **Review 收口**：看片与人工决定成为唯一主任务，去除其它治理噪声，并补全当前对象到 Material / Script / Timeline 的明确出口。

随后只剩最终 convergence：typed context 补齐、contract/CSS ownership、遗留 route/Workbench 清理、完整验证与真机验收。
