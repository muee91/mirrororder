# MirrorOrder Editorial Collaboration

这份文档描述 `editorial.json` 的协作职责与迁移顺序。

## 当前职责

- `review.json`：既有人工审核与人工剧本归集，当前导出链继续使用。
- `editorial.json`：多人 Individual Opinion 与独立 Editorial Decision。
- `auto_decisions.json`：自动剧本映射状态。

三者不得互相伪装。

## 协作原则

1. 每个审核人的意见独立保存，不互相覆盖。
2. Individual Opinion 使用稳定 `reviewer_id` 区分人，显示昵称 `actor` 不能作为唯一身份；同名审核人必须可以并存。
3. Individual Opinion 不按多数票自动升级为最终决定。
4. Editorial Decision 需要显式操作和 revision 冲突保护。
5. 在角色/权限模型完成前，最终决定只允许 Host 本机或原生 App 写入。
6. 协作状态由中央 Host 原子写入；不要依赖网盘让多台电脑直接并发修改 `editorial.json`。

## UI 迁移顺序

1. Web 为当前浏览器生成并保存稳定 reviewer identity，同时显示团队意见摘要。
2. 再把 Web B/K/X 从 legacy review 迁移为“我的意见”。
3. App Inspector 增加“最终编辑决定”。
4. 明确 Editorial Decision 如何进入 selection manifest / FCPXML / NLE 交付。
5. 完成验证后再考虑收缩 `review.json` 中重叠的创意审核字段。

## 不允许

- 不允许把自动归集当作 Keep/Best。
- 不允许把个人意见直接当最终决定。
- 不允许两个同名审核人因为昵称相同而覆盖彼此意见。
- 不允许 stale revision 覆盖更新的最终决定。
- 不允许 `editorial.json` 保存设备绝对媒体路径、embedding、API Key 或 runtime 配置。
- 不允许因为新增协作层破坏 AppKit native drag、原始 FCPXML 或既有人工剧本归集权威。
