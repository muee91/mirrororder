# Engineering Backlog

当前只做 Desktop Product Recovery。新增产品面、AI Dashboard、大型 package migration、第二编辑器继续暂停。

## P0 总验收

真实项目必须顺畅完成：

1. 找到一个实际 Take；
2. 看懂拍摄事实、机位和当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到时间线继续剪。

## 已完成

- P0.1 / P0.2：workspace ownership 与万能 Workbench 切除。
- P0.3：Material 资产 / 拍摄事实中心。
- P0.4：Script-first placement + Coverage projection。
- Timeline 主体恢复：唯一 editor、Take → Timeline Source/clip 定位、Delivery contextual flow、typed navigation intent 基础。

## 下一批次 — Review 收口

目标：让审阅只回答“这个 Take 我看了吗、怎么决定”。

要求：

- Viewer / playback 是视觉与交互第一优先级；
- 当前 Take、机位、必要 Script context 清楚；
- Best / Keep / Reject / Final Editorial Decision 明确且不与 placement 混淆；
- `需关注` 只是 filter / queue；
- 不复制场记编辑、素材 relink、人物治理、placement editor、Timeline edit；
- 明确提供“在素材中打开 / 在剧本中打开 / 到时间线”；
- 从 Review 到 Timeline 携带当前 Take + clip。

完成条件：看片和人工决定不被其它生产治理动作打断。

## 最终批次 — Convergence + Validation

### Typed project context 补齐

`ProductionNavigationIntent` 只保存 selection/navigation intent，继续补齐：

- Script 内重新选择 Take 后的跨区 propagation；
- Material / Review / Script / Timeline 当前 Take / clip 的一致传递；
- 必要时扩展 ScriptBlock / timelineClip 定位，但不成为业务 truth。

### Product contract / UI authority

- 锁定四个一级 workspace；
- Delivery / Coverage / Attention / Rough Cut / Assembly 不再恢复为并列主页面；
- canonical renderer ownership 保持唯一；
- 清理 stale source-shape assertions；
- 收掉无 owner CSS / route / Workbench / migration 残留；
- 不通过恢复错误架构让测试变绿。

### 完整验证

完成结构后统一执行适用自动 gate；没有实际执行的检查不写 PASS。

### 真机验收

使用《在制项目》或同等规模真实项目验证：

- 项目恢复与切换；
- 大量 Take 搜索 / 滚动；
- A/B/C 多机位；
- 场记 → 素材 → 剧本 → 审阅 → Timeline 连续上下文；
- placement revision conflict；
- Viewer / media binding；
- Timeline source / insert / overwrite / replace / undo / redo / persistence；
- Delivery / FCPXML / Premiere XML 入口；
- macOS 1280 与常用宽屏；
- light/dark；
- 外部拖放与 NLE 入口。

P0 只有在五步主链真机可用并且必要自动 gate 在目标 commit 上真实通过后才能关闭。
