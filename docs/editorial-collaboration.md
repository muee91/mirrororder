# MirrorOrder Editorial Collaboration

这份文档描述 `editorial.json` 的协作职责、当前 UI 语义与后续交付迁移顺序。

## 当前职责

- `review.json`：既有人工剧本归集与旧人工审核；当前导出链继续使用。
- `editorial.json`：多人 Individual Opinion 与独立 Editorial Decision。
- `auto_decisions.json`：自动剧本映射状态。

三者不得互相伪装。

## 协作原则

1. 每个审核人的意见按稳定 `reviewer_id` 独立保存；显示昵称 `actor` 只用于协作呈现，同名审核人不会互相覆盖。
2. Individual Opinion 不按多数票自动升级为最终决定。
3. Editorial Decision 需要显式操作和 revision 冲突保护。
4. 在角色/权限模型完成前，最终决定只允许 Host 本机或原生 App 写入。
5. 协作状态由中央 Host 原子写入；不要依赖网盘让多台电脑直接并发修改 `editorial.json`。

## 当前 UI

### Team Web Review

普通 Web 的 Best / Keep / Reject 已迁移为 **“我的意见”**：

- 写入 `/opinions`，不再写 legacy `/review` 创意状态；
- 浏览器持久化稳定 `reviewer_id`；
- “只看未核对”按当前审核人的意见计算；
- Take 行以低噪声方式显示团队意见汇总，展开后才显示审核人明细；
- 已存在的 Editorial Decision 只读显示为“最终”，普通 LAN Web 暂不能修改。

人工剧本归集仍继续走 `review.json` placement / assignment 权威链，不因协作判断迁移而改变。

### MirrorOrder Production App

原生 App 保持完整 Production 数据链与 AppKit native drag。Viewer Inspector 增加 **“最终编辑决定”**：

- 显示当前 Take / 当前剧本段的团队意见；
- 可显式确定 Best / Keep / Reject 或清除最终决定；
- 写入要求 `expected_revision`；
- revision 过期时拒绝静默覆盖并要求基于最新协作状态重新确认。

当前 Editorial Decision **不会改变 FCPXML、selection manifest 或既有导出结果**。

## reviewer identity

`actor` 是显示昵称，不是协作主键。

```text
reviewer-01 · 小王 → Best
reviewer-02 · 小王 → Keep
```

浏览器使用本地持久化 `reviewer_id`。旧 `editorial.json v1` 的 actor-keyed opinions 会在读取时兼容迁移为 fallback reviewer identity。

## 下一步：Delivery Semantics

UI 迁移完成后，下一阶段不应继续增加新的审核存储格式，而应明确 **Editorial Decision 如何进入交付**：

1. 定义 Editorial Decision 与 legacy `review.json` 的过渡优先级；
2. 明确 selection manifest 如何消费最终决定；
3. 明确 FCPXML / NLE 输出中 Best / Keep / Reject 的具体转换规则；
4. 为旧项目提供无 `editorial.json` 时的兼容行为；
5. 完成验证后再考虑收缩 `review.json` 中重叠的创意审核字段。

## 不允许

- 不允许把自动归集当作 Keep / Best。
- 不允许把个人意见直接当最终决定。
- 不允许 Editorial Decision 根据多数票自动产生。
- 不允许 stale revision 覆盖更新后的最终决定。
- 不允许 `editorial.json` 保存设备绝对媒体路径、embedding、API Key 或 runtime 配置。
- 不允许因为协作层破坏 AppKit native drag、原始 FCPXML 或既有人工剧本归集权威。
- 在 Delivery Semantics 专门迁移完成前，不允许新 Editorial Decision 静默改变既有交付结果。
