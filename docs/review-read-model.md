# MirrorOrder `review.v1` Read Model

`review.v1` 是 MirrorOrder Host 面向团队 Web Review 的版本化只读投影。

它的目标不是创建新的业务状态，而是让 Web 不再自行组合并解释 `material_index.json`、`script.json`、`matches.json`、`auto_decisions.json`、`review.json` 与协作状态的内部语义。

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

普通 Web 使用 `review.v1`，不接收 Host 绝对文件路径。旧 `/script`、`/groups`、`/matches`、`/review` 路由暂时保留，原生 App 继续使用较完整的 Production 数据链，因为 AppKit 原生文件拖拽必须解析当前 Mac 的真实媒体文件路径。

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

`playback.url` 指向 Gateway 的 HTTP Range media endpoint。浏览器消费媒体流，而不是把 Gateway 文件系统路径冒充自己的本机路径。

## 5. 自动映射与人工归集

`automatic_state` 继续使用：

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

多人协作意见使用：

```text
output/editorial.json
```

每个意见都有明确 target：

```text
group
  group_id

assignment
  segment_id
  group_id
```

每个 target 下按稳定 `reviewer_id` 分别保存，`actor` 只是显示昵称：

```text
reviewer-01 · 剪辑A → Best
reviewer-02 · 小王   → Keep
reviewer-03 · 小王   → Reject
```

因此即使两个人使用相同昵称，也不会互相覆盖。旧调用如果暂时没有 `reviewer_id`，Host 会用昵称兼容键保存；正式 Web UI 迁移后应始终发送稳定 reviewer identity。

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
  "reviewer_id": "reviewer-7f9f..."
}
```

`state = unreviewed` 只清除该 reviewer identity 在该 target 上自己的意见，不会删除其他人的意见。

当前阶段**不会把现有 Web B/K/X 自动迁移成 Individual Opinion**。旧按钮仍走成熟的 `/review` 原子 action，避免在没有完整 UI 和导出迁移前改变既有审核语义。

## 7. Editorial Decision

最终编辑决定与个人意见分开存储，不通过“票数最多”自动产生。

写入 API：

```text
POST /api/v1/workspaces/{workspace_id}/projects/{project_id}/editorial-decision
```

当前只允许 Host 本机 / 原生 App 使用。团队 LAN Web 暂时不能直接写最终决定，因为角色、权限和负责人模型尚未建立。

最终决定要求：

```text
expected_revision
```

如果提交者基于旧 revision 操作，Host 返回 conflict，而不是静默覆盖更新后的最终决定。

这是为了避免：

```text
主剪 A 看到 revision 8
导演 B 已经提交 revision 9
主剪 A 又用旧页面覆盖 B
```

当前 `editorial.json` 的 Editorial Decision 只进入协作投影，**尚未替代 `review.json` 作为导出/selection manifest 的既有人工状态来源**。迁移必须单独完成并验证，不能因为新字段存在就改变交付结果。

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

Web 不需要知道 `editorial.json` 的文件结构，只需要消费 Host 投影。

## 9. 协作刷新

`/state` 增加：

```text
editorial_revision
editorial_updated_at
```

普通 Web 在以下任一 revision 变化时重新加载 `review.v1`：

```text
analysis_revision
review_revision
editorial_revision
```

因此其它审核人的新意见可以在轮询周期内进入当前审阅页面，而不需要浏览器直接读取共享文件。

## 10. 多设备与同步

`editorial.json` 属于**共享项目协作状态**，不是 Device Local 数据。

推荐：

```text
同一个中央 MirrorOrder Host
        ↓
原子 opinion / decision API
        ↓
editorial.json
```

不要让多台机器通过 Dropbox / iCloud 同时直接写同一份 `editorial.json`。它与 `review.json` 一样需要单一在线写入权威。

仍然 Device Local 的数据包括：

```text
media-bindings.json
/Volumes/... 路径
Finder path
embedding
本机 runtime / model 状态
```

## 11. Web 兼容迁移

`web/app.js` 仍有成熟的剧本 / Take / Viewer 渲染逻辑。`web/review_model.js` 把 `review.v1` 映射回现有前端 state，避免一次性重写看片链。

当前迁移规则：

- 普通 Web 分析读取走 `/review-model`；
- 原生 App 检测到 `window.webkit.messageHandlers.mirrorOrder` 后跳过 adapter；
- 普通 Web 不显示生产时间线、更换剧本、runtime 等制作入口；
- 旧审核写入继续使用 `/review`；
- 协作意见 API 已具备，但 B/K/X 尚未迁移；
- 后续 UI 可以直接消费 `take.editorial_state`，然后逐步减少 legacy adapter。

## 12. 安全与回归红线

- Read Model 不返回原始媒体绝对路径。
- Read Model 不返回 embedding、API Key、模型配置、runtime 设置或生产任务控制。
- 自动状态不得伪装成人工 Best / Keep。
- Individual Opinion 不得自动升级为 Editorial Decision。
- Editorial Decision 不得根据多数票自动生成。
- Editorial Decision stale revision 不得静默覆盖。
- `editorial.json` 不得写入 `review.json` 或 `auto_decisions.json`。
- App current-device media resolver 与 AppKit native drag bridge 不改。
- 当前交付/导出语义在专门迁移之前继续以既有人工审核链为准。

## 13. 下一阶段

下一步是 **Editorial UI Migration**，而不是继续增加存储格式：

1. Web 的 Best / Keep / Reject 改成“我的意见”，并为浏览器生成稳定 reviewer identity；
2. Take/剧本段附近显示团队意见汇总，但控制视觉噪音；
3. App Production Inspector 提供明确的“最终编辑决定”动作；
4. 再定义 Editorial Decision 与 FCPXML / selection manifest /交付选择之间的转换规则；
5. 完成迁移后，才考虑逐步退出 `review.json` 中重叠的创意审核语义。
