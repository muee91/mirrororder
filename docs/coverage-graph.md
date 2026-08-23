# Coverage Graph：场景覆盖与连续性事实图

Coverage Graph 是镜序从“素材审计”走向“粗剪规划”之间的中间事实层。

它解决的问题不是：

> AI 应该自动剪哪条？

而是：

> 当前这个剧本场景，已经可靠归集了哪些 Take；每个 Take 的 A/B/C 机位有哪些已知景别和 coverage role；哪些连续性风险已有证据；哪些最终编辑决定已经由人明确做出？

核心链路：

```text
Script Scene
↓
effective mapping
  human placement / assignment
  > completed automatic mapping
↓
Take Group
↓
per-clip Shot Intelligence
↓
Coverage Graph
↓
Continuity warnings
↓
Editorial Decision annotation
↓
未来 Rough Cut Planner
```

## 1. 契约

当前版本：

```text
coverage.v1
continuity.v1
```

实现：

```text
src/script_organizer/coverage_graph.py
src/script_organizer/coverage_runtime.py
web/coverage_ui.js
web/coverage.css
```

Coverage 是可重建的 read model，不新增共享业务权威文件。

## 2. 数据权威

Coverage Graph 只读取：

```text
script.json
material_index.json
auto_decisions.json
review.json
audit.json
editorial.json
```

剧本归集使用与生产链一致的 effective mapping：

```text
人工 placement / assignment
>
已完成的 automatic mapping
>
none
```

`needs_review` / `unresolved` 即使已有 candidate，也不能因为 candidate 看起来合理就出现在场景 Coverage 中。

因此：

> candidate-only Take ≠ 已有场景覆盖。

## 3. Shot Intelligence 是 clip_id 级事实

Coverage Graph 不把景别提升为 Take 全局属性。

例如：

```text
Take G_001
  A → medium / master
  B → closeup / dialogue
  C → medium_closeup / reaction
```

每个 angle 保存：

```text
clip_id
media_id
camera
name
duration
source range
shot_type
coverage_role
visible_people
technical_issues
```

不包含 Host 绝对路径。

历史数据即使错误地把路径塞进 `name`，Coverage 输出也只保留 basename。

## 4. 不从“没有证据”推断“缺镜头”

Coverage Graph 可以说：

```text
coverage_unobserved
  已有 Take，但尚无可复用景别证据

coverage_partial
  部分机位尚无景别证据
```

但当前版本不能因为没有看到 `master` 就说：

```text
缺主镜
```

也不能因为没有 `reaction` 就说：

```text
缺反应镜头
```

原因可能只是：

- 该 Take 尚未 Audit；
- 某机位尚无视觉证据；
- 实际拍摄策略本来就不需要某类 coverage；
- 该场景被拆成多个拍摄块；
- 场记或剧本结构不足以支持这种结论。

所以 `coverage.v1` 明确声明：

```text
missing_shots_are_not_inferred = true
```

## 5. Audit freshness 分层

Coverage 继承 Audit 的 split freshness。

### Analysis 仍 current，mapping 已变化

例如 Audit 时：

```text
G_001 → S_12
A = closeup
continuity_risk = high
```

之后人工改为：

```text
G_001 → S_18
```

Coverage 继续复用：

```text
A = closeup
```

因为这是素材画面事实。

但不会继续复用：

```text
旧 judge
旧 mapping issue
旧 role suggestion
旧 rough_cut guidance
旧 continuity_risk
```

此时：

```text
audit.visual_current = true
audit.mapping_current = false
audit.mapping_stale = true
```

### Analysis revision 已变化

旧 Shot Intelligence 也不再标为 current。

## 6. Continuity

`continuity.v1` 只汇总已经存在、且 mapping-current 的连续性证据。

当前不会重新调用模型推断连续性。

风险来自 Audit：

```text
rough_cut.continuity_risk
  low / medium / high / unknown

issues.code = continuity_risk
```

Coverage 按：

```text
Scene
→ Take
→ risk
→ issue detail
```

组织，供 App 和外部 read-scope Agent 使用。

旧 mapping 的 continuity judgment 不进入 current Continuity。

## 7. Editorial Decision 只是注释

Coverage Graph 可以显示：

```text
最终最佳
最终保留
最终隐藏
```

但这些值当前只来自 `editorial.json` 的显式 Final Decision。

Individual Opinion 完全不参与 Coverage 决定。

```text
个人意见 Best × 3
```

不能变成：

```text
Final Best
```

也不能影响 Coverage 中 Take 是否存在。

当前契约明确：

```text
editorial_decision_is_annotation_only = true
individual_opinions_used = false
delivery_authority_changed = false
```

因此本阶段没有修改：

```text
selection_manifest.json
organized.fcpxml
FCPXML export
NLE delivery
```

## 8. App / Web / Agent

### App Production

新增 Production 导航：

```text
覆盖
```

按场景显示：

```text
EP / 场景标题
Take 数
已知景别 / 总机位
Master / Dialogue / Reaction / Insert 等已有 coverage
连续性提醒
```

展开场景后按 Take 显示 A/B/C 景别、已有 Final Decision 注释和 freshness 提示。

点击 Take 回到现有看片工作流。

### Team Web

普通 Web 不增加 Coverage Production 导航。

`coverage_ui.js` 有 native bridge guard，CSS 仅在 `html.native-production` 下生效。

### Agent API

read scope 可读取：

```text
GET /api/agent/v1/projects/{project_id}/coverage
GET /api/agent/v1/projects/{project_id}/continuity
```

Gateway 使用已有 workspace-scoped rewrite。

App Host-local：

```text
GET /api/v1/projects/{project_id}/coverage
GET /api/v1/projects/{project_id}/continuity
```

支持：

```text
?scene_id=...
?episode=...
```

没有 Coverage 写 API。

## 9. Revision

`coverage_revision` 由以下来源组合：

```text
analysis revision
review revision
editorial revision
audit revision
auto_decisions updated_at
```

App 只在 Coverage 打开时根据 revision 刷新，不需要不停重建整张图。

## 10. Rough Cut Planner 的下一步边界

Coverage Graph 完成以后，下一步可以做 Rough Cut Planner，但仍建议先生成**纯规划产物**，不要直接写 FCPXML。

建议下一层：

```text
Coverage Graph
+
explicit Editorial Decision
+
script order
+
continuity constraints
↓
rough_cut_plan.v1
```

`rough_cut_plan.v1` 应先回答：

- 哪些已确认 Take 是当前场景可用候选；
- 哪些角度承担 master / dialogue / reaction / insert；
- 哪些 Final Best 应优先；
- 哪些 Reject 不应进入规划；
- 哪些 continuity risk 需要人工确认；
- 哪些剧本范围仍没有足够生产证据。

它仍不应该：

- 从 Individual Opinion 投票；
- 把 automatic confidence 当创意 Best；
- 自动生成新的人工决定；
- 直接修改原 FCPXML；
- 在没有明确 Delivery Semantics 迁移前改变当前导出结果。
