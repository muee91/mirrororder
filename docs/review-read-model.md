# MirrorOrder `review.v1` Read Model

`review.v1` 是 MirrorOrder Host 面向团队 Web Review 的版本化只读投影。

它的目标不是创建新的业务状态，而是让 Web 不再自行组合并解释 `material_index.json`、`script.json`、`matches.json`、`auto_decisions.json` 与 `review.json` 的内部语义。

## 边界

```text
Canonical Production Data
  material_index.json
  script.json
  matches.json
  auto_decisions.json
  review.json
  device-local safe identity labels
        ↓
MirrorOrder Host
        ↓
review.v1
        ↓
Team Web Review
```

`review.v1` 是 projection，不是 authority。

权威顺序仍然是：

```text
人工 review.json
  > auto_decisions.json
  > 自动候选 / 分析建议
```

自动流程不得写 `review.json`，不得自动 Reject，也不得因为 Read Model 引入第二套人工决定存储。

## API

多工作区 Gateway：

```text
GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/review-model
```

单工作区 Host 的内部兼容路由：

```text
GET /api/v1/projects/{project_id}/review-model
```

旧 `/script`、`/groups`、`/matches`、`/review` 路由暂时保留。原生 App 仍使用较完整的 Production 数据链，因为 AppKit 原生文件拖拽必须解析当前 Mac 的真实媒体文件路径。

普通 Web 使用 `review.v1`，不接收 Host 绝对文件路径。

## 顶层结构

```text
review.v1
  contract_version
  project
  revisions
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
    effective_mapping
    issues[]
  script_gaps[]
  review_state
```

### `project`

只包含团队审阅所需的项目名称、类型、统计和网关媒体覆盖数量。

设备 ID、设备名、素材 roots 与 `/Volumes/...` 路径不会进入此对象。

### `episodes / scenes / script_blocks`

Host 将剧本结构投影为稳定的集、场、剧本段层级。`script_gap` 会作为剧本段 issue 提供，Web 不需要自己解释 `matches.script_gaps`。

### `take_groups`

每个逻辑 Take 包含：

- `group_id / parent_group_id / take_index`
- 拍摄时间范围与机位列表
- `angles`
- 候选对白文本
- 安全的人物 / 声纹标签
- 自动映射状态
- 当前人工状态
- 实际生效的映射来源
- 需要人工注意的问题

### `angles`

Angle 可以包含：

```text
clip_id
media_id
camera
name
timeline/source range
playback.url
playback.available
```

不会包含：

```text
media_path
source_media_path
resolved_media_path
本机素材 root
Finder path
```

`playback.url` 指向当前 Gateway 的 HTTP Range media endpoint。浏览器只消费媒体流，不把 Gateway 文件系统路径冒充自己的本机文件。

### `automatic_state`

直接投影 Host 的自动决定语义：

```text
auto_confirmed
ai_confirmed
human_override
needs_review
unresolved
```

它描述的是**剧本映射状态**，不是创意意义上的 Best / Keep / Reject。

### `editorial_state`

当前 `review.json` v2 只有一套当前人工审核状态，还没有独立的 Individual Opinion 历史和最终 Editorial Decision 存储。因此 `review.v1` 明确返回：

```text
editorial_state
  legacy_manual
  individual_opinion = null
  editorial_decision = null
```

同时 capabilities 声明：

```text
individual_opinions = false
editorial_decision = false
```

这避免把尚未实现的协作模型伪装成正式能力。

### `effective_mapping`

这是 Host 对“当前应该把这个 Take 归到哪里”的只读解释：

1. 人工 placement / assignment 存在时，`source = human`；
2. 否则已完成的 `auto_confirmed / ai_confirmed / human_override` 可成为自动映射；
3. 仍无可靠结果时为 `source = none`。

它不写回任何文件。

### `issues`

第一版至少投影：

```text
needs_review
unresolved
missing_media
automation_stale
script_gap
```

这些 issue 用于 Web Review 聚焦异常，不用于修改自动或人工权威状态。

## Web 兼容迁移

当前 `web/app.js` 仍有成熟的剧本 / Take / Viewer 渲染逻辑。为了避免一次性重写看片链，`web/review_model.js` 在普通浏览器中将 `review.v1` 映射回现有前端运行时 state。

这只是前端兼容适配层：

- 正常 Web 分析读取走 `/review-model`；
- 原生 App 检测到 `window.webkit.messageHandlers.mirrorOrder` 后直接跳过 adapter；
- 审核写入继续走现有原子 `/review` action API；
- 搜索、配对、协作 revision polling 等独立 API 暂时保留；
- 后续可以逐步让 Web 组件直接消费 `review.v1`，再删除兼容 adapter。

## 安全与回归红线

- Read Model 不返回原始媒体绝对路径。
- Read Model 不返回 embedding、模型配置、API Key、runtime 设置或生产任务控制。
- Read Model 不成为新的写入权威。
- 人工映射永远优先于自动映射。
- `auto_confirmed` / `ai_confirmed` 不得伪装成人工 Keep / Best。
- 普通 Web 不获得 AppKit 原生文件拖拽能力。
- App 的 current-device media resolver 与 native drag bridge 不改。
- 旧读 API 在契约迁移完成前继续保留。

## 下一阶段

`review.v1` 建立了 Host → Web 的语义边界，但真正的多人 Editorial Model 仍未实现。下一步若引入：

```text
Individual Opinion
Editorial Decision
comments / decision history
```

应建立独立、revision-safe 的协作状态模型，再由 `review.v1` 投影；不要复用或重载当前 `review.json` 字段来假装两层语义已经存在。
