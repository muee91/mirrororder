# Engineering Backlog

当前只做 Desktop Product Recovery 收尾。新增产品面、AI Dashboard、大型 package migration、第二编辑器继续暂停。

## P0 总验收

真实项目必须顺畅完成：

1. 找到一个实际 Take；
2. 看懂拍摄事实、机位和当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到时间线继续剪。

## 已完成的代码恢复

- P0.1 / P0.2：workspace ownership 与万能 Workbench 切除；
- P0.3：Material 资产 / 拍摄事实中心；
- P0.4：Script-first placement + Coverage projection；
- Timeline：唯一 editor、Take → Source/clip 定位、Delivery contextual flow；
- Review：Viewer-first、未决定/需关注/Best/Keep/Reject 队列、Take-level Final Editorial Decision；
- typed project context：Material / Script / Review / Timeline 的 Take / clip / ScriptBlock / Timeline clip selection/navigation intent 已统一；
- convergence：旧 Review assignment decision UI、独立 Planning Workbenches、死 theme patch 与 stale product/source-shape contract 已收口。

## 当前只剩 — Validation + Real Project Acceptance

### 自动 gate

在目标 commit 上统一执行：

- Python compile + pytest；
- Desktop development baseline；
- UI authority；
- TypeScript typecheck；
- Vitest；
- frontend build；
- Rust Timeline Core tests；
- Tauri Host tests / check。

没有实际执行成功的检查不得写 PASS。失败时修当前结构，不通过恢复旧 Workbench / 旧 route / 复制 renderer / 放宽 authority 来让测试变绿。

### 真机验收

使用《在制项目》或同等规模真实项目验证：

- 项目恢复与切换；
- 大量 Take 搜索 / 滚动；
- A/B/C 多机位；
- 场记 → 素材 → 剧本 → 审阅 → Timeline 连续上下文；
- placement revision conflict；
- Viewer / media binding；
- Timeline source / insert / overwrite / replace / undo / redo / persistence；
- Delivery / FCPXML / Premiere XML；
- macOS 1280 与常用宽屏；
- light/dark；
- 外部拖放与 NLE 入口。

P0 只有在五步主链真机可用并且必要自动 gate 在目标 commit 上真实通过后才能关闭。
