# MirrorOrder `review.v1` Read Model

`review.v1` 是 MirrorOrder Host 面向团队 Web Review 的版本化只读投影。它的目标不是创建新的业务状态，而是让 Web 不再自行组合并解释 `material_index.json`、`script.json`、`matches.json`、`auto_decisions.json`、`review.json` 与 `editorial.json` 的内部语义。

## 1. 边界

```text
Canonical Production Data
  material_index.json
  script.json
  matches.json
  auto_decisions.json
  review.json
  editorial.json
  device-local safe identity labels
        ↓
MirrorOrder Host
        ↓
review.v1
        ↓
Team Web Review
```

`review.v1` 是 projection，不是 authority。

剧本映射权威仍然是：

```text
人工 review.json placement / assignment
  > auto_decisions.json
  > 自动候选 / 分析建议
```

协作判断独立存储：

```text
editorial.json
  Individual Opinion
  Editorial Decision
```

`editorial.json` 不覆盖 `review.json`，自动流程也不得写入它。

## 2. API

多工作区 Gateway：

```text
GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/review-model
```

单工作区兼容路由：

```text
GET /api/v1/projects/{project_id}/review-model
```

普通 Web 使用 `review.v1`，不接收 Host 绝对文件路径。旧 `/script`、`/groups`、`/matches`、`/review` 路由暂时保留。原生 App 继续使用较完整的 Production 数据链，因为 AppKit 原生文件拖拽必须解析当前 Mac 的真实媒体文件路径。

## 3. 顶层结构

```text
review.v1
  contract_version
  project
  revisions
    analysis
    automation_analysis
    review
    editorial
  capabilities
  summary
  episodes[]
    scenes[]
      script_blocks[]
      take_group_ids[]
  take_groups[]
    angles[]
    transcript
    people
    candidates[]
    context
    automatic_state
    editorial_state
      legacy_manual
      individual_opinions
      editorial_decision
    effective_mapping
    issues[]
  script_gaps[]
  review_state
    legacy_review
    editorial
```

## 4. `angles`

Web 可以获得：

```text
clip_id
media_id
camera
name
timeline/source range
playback.url
playback.available
```

不会获得：

```text
media_path
source_media_path
resolved_media_path
本机素材 root
Finder path
```

`playback.url` 指向 Gateway HTTP Range media endpoint。浏览器消费媒体流，而不是把 Gateway 文件系统路径冒充自己的本机路径。

## 5. 自动映射与人工归集

`automatic_state` 使用：

```text
auto_confirmed
ai_confirmed
human_override
needs_review
unresolved
```

这些状态描述的是**剧本映射**，不是创意意义上的 Best / Keep / Reject。

`effective_mapping` 只解释当前 Take 应归到什么剧本范围：

1. `review.json` 存在人工作品范围时，`source = human`；
2. 否则已完成的自动状态可以成为 `source = automatic`；
3. 没有可靠结果时为 `source = none`。

Individual Opinion 与 Editorial Decision 都不会改变这条映射权威链。

## 6. Individual Opinion

多人协作意见存储在：

```text
output/editorial.json
```

每个意见有明确 target：

```text
group
  group_id

assignment
  segment_id
  group_id
```

每个 target 下按稳定 `reviewer_id` 分别保存，`actor` 只是显示昵称：

```text
reviewer-01 · 小王 → Best
reviewer-02 · 小王 → Keep
```

因此重名审核人也不会互相覆盖。

写入 API：

```text
POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/opinions
```

请求示例：

```json
{
  "target_kind": "assignment",
  "segment_id": "S_27_18",
  "group_id": "G_27_03",
  "state": "keep",
  "actor": "剪辑A",
  "reviewer_id": "b5d8..."
}
```

`state = unreviewed` 只清除该 reviewer 在该 target 上自己的意见。

当前 Team Web 的 Best / Keep / Reject 已迁移为 **“我的意见”**，写入 `/opinions`，不再把个人创意判断写入 legacy `/review`。浏览器在 localStorage 持久化 reviewer identity；昵称变更不会改变其协作身份。

## 7. Editorial Decision

最终编辑决定与个人意见分开存储，不通过“票数最多”自动产生。

写入 API：

```text
POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/editorial-decision
```

当前只允许 Host 本机 / 原生 App 使用。团队 LAN Web 只能查看最终决定，因为角色、权限与负责人模型尚未建立。

最终决定必须提交：

```text
expected_revision
```

如果提交者基于旧 revision 操作，Host 返回 conflict，而不是静默覆盖更新后的决定。

`editorial.json` 的 Editorial Decision **尚未替代 `review.json`** 作为 selection manifest / FCPXML / NLE 交付链的既有状态来源。迁移必须单独完成并验证。

## 8. `review.v1` 中的协作语义

启用 Editorial Runtime 后：

```text
capabilities.individual_opinions = true
capabilities.editorial_decision = true
capabilities.editorial_decision_write_scope = host_local
```

每个 Take：

```text
editorial_state
  legacy_manual
  individual_opinions
    group[]
    assignments[]
  editorial_decision
    group
    assignments[]
```

顶层：

```text
revisions.editorial
summary.collaboration
review_state.editorial
```

Web 不需要知道 `editorial.json` 的文件结构，只消费 Host 投影。

## 9. Team Web UI

普通 Web：

- B / K / X / U 操作的是当前浏览器 reviewer 的 Individual Opinion；
- Take 状态与“只看我未判断”按当前 reviewer 计算；
- 团队意见默认只显示紧凑汇总，展开后才显示审核人明细；
- 已存在的 Editorial Decision 只读显示为“最终”；
- 人工剧本归集继续使用 `review.json`，与创意意见保持独立。

普通 Web 不获得 Production timeline、本机路径、runtime、项目输入修改或最终决定写权限。

## 10. Production App UI

原生 App 绕过 Web read-model adapter，继续保留 current-device 路径和 AppKit native drag。

Viewer Inspector 增加“最终编辑决定”：

- 展示当前 target 的团队意见汇总；
- 显示现有最终决定；
- 可显式提交 Best / Keep / Reject / 清除；
- 使用 `expected_revision` 防止 stale overwrite；
- revision 冲突后必须基于最新团队状态重新确认。

当前最终决定只进入协作状态，**不会静默改变 FCPXML 或导出结果**。

## 11. 协作刷新

`/state` 包含：

```text
analysis_revision
review_revision
editorial_revision
editorial_updated_at
```

普通 Web 在 production analysis、legacy review 或 editorial revision 任一变化时重新读取 `review.v1`。其它审核人的新意见因此能在轮询周期内进入页面，而浏览器不直接读取共享文件。

原生 App 对 `editorial` 状态单独轮询，用于 Inspector 的团队意见与最终决定刷新；Production 媒体路径仍走原本的本机链路。

## 12. 多设备与同步

`editorial.json` 属于共享项目协作状态，不是 Device Local 数据。

推荐：

```text
同一个中央 MirrorOrder Host
        ↓
原子 opinion / decision API
        ↓
editorial.json
```

不要让多台机器通过 Dropbox / iCloud 同时直接写同一份 `editorial.json`。

仍然 Device Local 的数据包括：

```text
media-bindings.json
/Volumes/... 路径
Finder path
embedding
本机 runtime / model 状态
```

## 13. 安全与回归红线

- Read Model 不返回原始媒体绝对路径。
- Read Model 不返回 embedding、API Key、模型配置、runtime 设置或生产任务控制。
- 自动状态不得伪装成人工 Best / Keep。
- Individual Opinion 不得自动升级为 Editorial Decision。
- Editorial Decision 不得根据多数票自动生成。
- Editorial Decision stale revision 不得静默覆盖。
- `editorial.json` 不得写入 `review.json` 或 `auto_decisions.json`。
- App current-device media resolver 与 AppKit native drag bridge 不改。
- 当前交付/导出语义在专门迁移之前继续以既有人工审核链为准。

## 14. 下一阶段：Delivery Semantics

Editorial UI Migration 完成后，下一步是定义最终决定如何进入后期交付，而不是再造一套审核状态：

1. 定义 Editorial Decision 与 legacy `review.json` 创意状态的过渡优先级；
2. 让 selection manifest 可选择性消费最终决定；
3. 定义 Best / Keep / Reject 到 FCPXML / NLE 输出的明确转换规则；
4. 为没有 `editorial.json` 的旧项目提供兼容行为；
5. 在测试与真实项目验证后，再考虑收缩 `review.json` 中重叠的创意审核字段。
