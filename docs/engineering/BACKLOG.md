# Engineering Backlog

当前只做 Desktop Product Recovery。新增产品面、AI Dashboard、大型 package migration、第二编辑器继续暂停。

## P0 总验收

真实项目必须顺畅完成：

1. 找到一个实际 Take；
2. 看懂拍摄事实、机位和当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到时间线继续剪。

## 已完成的主体恢复

- workspace ownership 与跨域万能 Workbench 切除；
- Material 资产 / 拍摄事实中心；
- Script-first placement + Coverage projection；
- Timeline 唯一 editor + Take/clip deep-link + Delivery contextual flow；
- Review viewer-first + `未决定 / 需关注 / Best / Keep / Reject` 队列 + Take 级 Final Editorial Decision；
- typed `ProductionNavigationIntent` 基础。

## 最终批次 — Convergence + Validation

### 1. Typed project context 补齐

`ProductionNavigationIntent` 只保存 selection/navigation intent，补齐：

- Script 内重新选择 Take 后的跨区 propagation；
- Material / Review / Script / Timeline 当前 Take / clip 的一致传递；
- 必要时扩展 ScriptBlock / timeline clip 定位，但不成为业务 truth。

### 2. 删除失去产品 owner 的残留

重点检查并收掉：

- `showEditorial` compatibility 与旧未使用 `EditorialDecisionPanel`；
- Desktop assignment-level Editorial UI，如果已无正式产品入口则删除 renderer，只保留底层兼容数据；
- Coverage / Delivery / Attention / Rough Cut / Assembly 的旧 page/workbench 残留；
- 无 consumer 的 drawer、route helper、CSS；
- migration / redesign / frozen 命名中已经完成迁移的层。

不能因为旧代码存在就保留一个产品面。

### 3. Product contract / UI authority 收口

- 锁定四个一级 workspace：`素材 / 剧本 / 时间线 / 审阅`；
- Review contract 锁定：Viewer-first、Take 级 Final Decision、`需关注`仅 queue、无 placement write；
- Timeline contract 锁定：唯一 editor、Delivery contextual；
- canonical renderer ownership 保持唯一；
- stale source-shape assertions 改成真实产品/authority contract；
- 不通过恢复错误架构让测试变绿。

### 4. 完整自动验证

结构收口后统一执行适用 gate，包括但不限于：

- Desktop typecheck / build；
- product surface contracts；
- UI authority；
- Python desktop bridge / authority contracts；
- Rust Timeline / Tauri 适用检查。

没有实际执行的检查不写 PASS；非必要不重复触发 CI。

### 5. 真实项目真机验收

使用《在制项目》或同等规模真实项目验证：

- 项目恢复与切换；
- 大量 Take 搜索 / 滚动；
- A/B/C 多机位；
- 场记 → 素材 → 剧本 → 审阅 → Timeline 连续上下文；
- placement revision conflict；
- Review 未决定队列 → Best/Keep/Reject → 下一条；
- Viewer / media binding；
- Timeline source / insert / overwrite / replace / undo / redo / persistence；
- Delivery / FCPXML / Premiere XML 入口；
- macOS 1280 与常用宽屏；
- light/dark；
- 外部拖放与 NLE 入口。

P0 只有在五步主链真机可用并且必要自动 gate 在目标 commit 上真实通过后才能关闭。
