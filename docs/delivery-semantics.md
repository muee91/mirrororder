# MirrorOrder Delivery Semantics

`delivery.v1` 定义 MirrorOrder 从制作/审阅状态进入剪辑交付时的权威顺序。

它首先作用于 `selection_manifest.json`。当前阶段仍**不会直接改写用户原始 FCPXML 的评分、关键词、多机位结构或剪辑内容**。

## 1. 为什么需要独立 Delivery 层

MirrorOrder 当前存在三类不同语义：

```text
auto_decisions.json
  自动剧本映射

review.json
  既有人工剧本归集 + legacy 创意审核

editorial.json
  Individual Opinion + Editorial Decision
```

它们不能直接混在一起决定 NLE 交付。

特别是：

- 自动高置信度匹配不等于“创意最佳”；
- 多数 Individual Opinion 不等于 Final Editorial Decision；
- Final Editorial Decision 不应该因为旧 review 状态而被降级；
- 没有 Final Decision 的旧项目仍需要保持现有导出兼容。

因此导出时增加一层显式 resolver。

## 2. `selection_manifest.json` v3

新的 manifest：

```text
version = 3
contract = delivery.v1
```

每个 `segment.groups[]` 除了保留：

```text
group_id
state
automatic_state
```

还增加：

```text
decision_source
decision_actor
decision_updated_at
legacy_state
```

顶层增加：

```text
revisions.review
revisions.editorial
decision_policy
summary.states
summary.sources
```

这样下游工具不必猜一个 Best / Keep / Reject 到底来自谁。

## 3. 交付权威顺序

精确顺序：

```text
1. Editorial Decision · assignment
2. Editorial Decision · group
3. legacy review.json · assignment
4. legacy review.json · inherited assignment
5. legacy review.json · group / clip
6. automatic mapping fallback（仅旧兼容）
```

### Editorial assignment

这是最具体的最终决定：

```text
segment_id + group_id → Best / Keep / Reject
```

它覆盖同一 target 上的 legacy review 和自动 fallback。

### Editorial group

如果当前剧本段没有 assignment-level final decision，但 Take 本身有最终决定，则使用 group decision。

### Legacy review

没有任何 Final Editorial Decision 时，继续尊重现有 `review.json`，保证旧项目的人工审核结果不因升级而改变。

### Automatic mapping fallback

历史 `selection_manifest v2` 会把 `exact_dialogue / possible_dialogue / manual` 候选在无人审核时兼容为 Keep。

v3 暂时保留这个行为，避免旧项目导出突然变化，但必须标记：

```text
decision_source = automatic_mapping_fallback
```

它是最低权威来源，不得伪装成 Final Editorial Decision。

未来若决定废除这一兼容行为，应单独做 manifest contract 升级，而不是悄悄改变 `delivery.v1`。

## 4. Individual Opinion 永远不参与交付投票

即使出现：

```text
剪辑 A → Best
导演 B → Best
制片 C → Best
```

只要没有显式 Editorial Decision，Delivery resolver 都不会根据 3:0 自动产生 Best。

`editorial.json.opinions` 不进入 `resolve_delivery_state()` 的决策输入。

团队意见可以帮助主剪/导演形成判断，但不能替代最终确认动作。

## 5. Final Decision 不从父 Take 静默继承

legacy `review.json` 为了兼容拆分前的人工工作，允许 child group 读取部分 parent 状态。

Final Editorial Decision 不做这种继承。

原因：

```text
G_PARENT → Reject
        ↓ 分析重跑 / 人工拆分
G_CHILD_A
G_CHILD_B
```

父 Take 的高权威最终判断不应在结构变化后自动扩散到两个新 target。

因此：

```text
editorial_parent_inheritance = false
```

child Take 必须重新形成最终决定。

## 6. FCPXML 当前仍保持只读安全边界

`organized.fcpxml` 当前行为不变：

- 如果项目有源 FCPXML，只做 byte-for-byte copy；
- 不声称写入 Rating / Keyword；
- 不改变 multicam 结构；
- 不修改用户同步时间线；
- 媒体目录项目不凭空合成 FCPXML。

所以当前真实交付关系是：

```text
Editorial / Review / Automatic states
        ↓
Delivery resolver
        ↓
selection_manifest.json · delivery.v1
        ↓
未来安全的 NLE adapter
```

不是：

```text
Editorial Decision
        ↓
直接修改原始 FCPXML
```

## 7. `export_report.json`

导出报告现在显式记录：

```text
selection_contract = delivery.v1
selection_manifest_version = 3
selection_summary
keywords_written = false
multicam_structure_modified = false
```

如果生成 `organized.fcpxml`，warning 会明确说明它仍是未修改副本，真正的交付决定位于 `selection_manifest.json`。

## 8. 下一阶段：NLE Delivery Adapter

下一阶段不应继续增加审核状态，而应把 `delivery.v1` 转成剪辑软件可安全消费的结果。

优先顺序建议：

1. 定义 Final Cut Pro 可安全表达的 Rating / Keyword 映射；
2. 先对独立测试 FCPXML fixture 做结构化写入，不碰用户原文件；
3. 对 multicam / asset-clip / ref-clip / range 做 round-trip 验证；
4. 输出独立 `mirrororder-delivery.fcpxml`，而不是覆盖 source；
5. 验证 FCP 导入后语义正确，再允许 App 显示“导出到 Final Cut Pro”；
6. Premiere / Resolve 后续消费同一 `delivery.v1`，不要各自重新解释审核状态。

## 9. 红线

- 不按 Individual Opinion 多数票生成交付状态。
- 不把自动剧本归集直接升级为 Final Decision。
- 不让 legacy review 覆盖显式 Final Editorial Decision。
- 不让 parent Final Decision 静默继承给分析后拆分的 child Take。
- 不因为新增 Delivery 层修改原始 FCPXML。
- 不让不同 NLE adapter 各自定义一套 Best / Keep / Reject 权威顺序。
