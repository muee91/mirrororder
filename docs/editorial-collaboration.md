# MirrorOrder Editorial Collaboration

这份文档描述 `editorial.json` 的协作职责、当前 UI 语义与交付边界。

## 当前职责

- `review.json`：既有人工剧本归集与旧人工审核；剧本归集权威继续使用。
- `editorial.json`：多人 Individual Opinion 与独立 Editorial Decision。
- `auto_decisions.json`：自动剧本映射状态。
- `selection_manifest.json v3 / delivery.v1`：把最终编辑决定解析成统一交付语义。

四者不得互相伪装。

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

原生 App 保持完整 Production 数据链与 AppKit native drag。Viewer Inspector 提供 **“最终编辑决定”**：

- 显示当前 Take / 当前剧本段的团队意见；
- 可显式确定 Best / Keep / Reject 或清除最终决定；
- 写入要求 `expected_revision`；
- revision 过期时拒绝静默覆盖并要求基于最新协作状态重新确认。

## reviewer identity

`actor` 是显示昵称，不是协作主键。

```text
reviewer-01 · 小王 → Best
reviewer-02 · 小王 → Keep
```

浏览器使用本地持久化 `reviewer_id`。旧 `editorial.json v1` 的 actor-keyed opinions 会在读取时兼容迁移为 fallback reviewer identity。

## Delivery Semantics 已落地

Editorial Decision 现在已经进入：

```text
selection_manifest.json
version = 3
contract = delivery.v1
```

交付解析顺序：

```text
Editorial assignment
  > Editorial group
  > legacy review assignment
  > legacy review group / clip
  > automatic mapping fallback（旧兼容）
```

Individual Opinion 不参与多数票，也不会自动产生任何交付 Best / Keep / Reject。

没有 `editorial.json` 或没有 Final Decision 的旧项目继续按 legacy review 与旧自动 fallback 兼容导出。

当前 `organized.fcpxml` 仍只是源 FCPXML 的未修改副本；Delivery 层不会直接修改原始 FCPXML、多机位结构、Rating 或 Keyword。

详见 `docs/delivery-semantics.md`。

## 下一步：NLE Delivery Adapter

下一阶段不再增加新的审核状态，而是让剪辑软件安全消费 `delivery.v1`：

1. 定义 Final Cut Pro Rating / Keyword 映射；
2. 在独立测试 FCPXML fixture 上实现结构化写入；
3. 验证 multicam / asset-clip / ref-clip / range round-trip；
4. 输出独立 `mirrororder-delivery.fcpxml`，绝不覆盖 source；
5. 验证真实 FCP 导入行为后，再在 App 暴露正式“导出到 Final Cut Pro”；
6. Premiere / Resolve 后续复用同一 `delivery.v1`，不得另造审核权威顺序。

## 不允许

- 不允许把自动归集伪装成 Final Editorial Decision。
- 不允许把个人意见直接当最终决定。
- 不允许 Editorial Decision 根据多数票自动产生。
- 不允许 stale revision 覆盖更新后的最终决定。
- 不允许同名审核人因为昵称相同而覆盖彼此意见。
- 不允许 `editorial.json` 保存设备绝对媒体路径、embedding、API Key 或 runtime 配置。
- 不允许因为协作/交付层破坏 AppKit native drag、原始 FCPXML 或既有人工剧本归集权威。
- 不允许任何 NLE adapter 重新定义 Best / Keep / Reject 的权威顺序。
