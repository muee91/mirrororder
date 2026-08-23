# 机位与辅助素材语义

状态：`media_roles.v1`

镜序把“机位身份”和“素材用途”拆成两条独立轴。原因很直接：A/B/C 是同步与多机位结构；航拍、空镜、GoPro 等是剪辑素材角色。把后者伪装成 D/E 机，会让同步、Coverage 和后续 NLE 交付都产生错误语义。

## 1. 默认机位识别

行业常规优先作为默认规则，但始终允许人工纠正。

识别顺序：

1. 项目 `camera_patterns` 显式规则；
2. 最近父目录中的强机位标记；
3. 文件名中的强机位标记；
4. 无法确认时为 `?`，不猜。

默认强标记包括：

```text
A / B / C
A机 / B机 / C机
A1 / B2 / C3
A001 / B014 / C203
CAM_A / CAM-B
CAMERA_A / CAMERA-C
```

普通单词里偶然出现 A/B/C 不构成机位证据。例如 `AERIAL.mov` 不能因为含 A 就自动变成 A 机。

人工 `camera_override` 以 `media_id` 为键，因此文件移动、改名或更换磁盘后仍然有效。

## 2. 两条独立语义轴

### `camera`

用于：

- 多机位同步；
- A/B/C 展示顺序；
- ASR / 机位证据；
- Shot Intelligence；
- FCPXML 多机位结构。

典型值：`A`、`B`、`C`，也允许项目自定义机位。

### `source_role`

用于说明素材在剪辑中的生产角色：

```text
sync_camera  同步机位
aerial       航拍
broll        空镜 / B-roll
gopro        GoPro / 运动相机
insert       细节 / 插入镜头
custom       自定义辅助素材
```

`role_label` 可提供更具体的人类标签，例如“车载”“监控”“手机竖屏”“稳定器空镜”。

## 3. 同步策略

`sync_policy` 只有两种：

```text
auto     参与同步
exclude  不参与同步
```

默认：

- `sync_camera` → `auto`
- 其它辅助角色 → `exclude`

### 关键语义

> 没有时间码、没有音频，不等于“同步失败”。

无人机、GoPro、空镜等素材本来就可能没有可用 TC 或音轨。人工把它标为辅助素材并设为 `exclude` 后，它是**合法的非同步素材**。

重新运行多机位同步时，Host 只把以下共享事实投影到一次任务的临时配置：

```text
media_id
camera_override
source_role
sync_policy
```

不会投影：

- 本机绝对路径；
- scene note；
- actor 之外的协作数据；
- review / editorial / delivery 状态。

第一方同步引擎使用与 Host 相同的 quick content fingerprint 找到 `media_id`，因此经过 symlink staging 或多素材根目录时仍能识别排除项。

## 4. `media_roles.json`

共享文件：

```text
projects/<project>/output/media_roles.json
```

示例：

```json
{
  "version": 1,
  "contract": "media_roles.v1",
  "revision": 3,
  "media": {
    "M_abc123": {
      "media_id": "M_abc123",
      "display_name": "DJI_0042.MP4",
      "camera_override": "",
      "source_role": "aerial",
      "role_label": "航拍",
      "sync_policy": "exclude",
      "scene_id": "24-3",
      "note": "饭店外景建立镜头",
      "actor": "editor",
      "updated_at": "..."
    }
  }
}
```

它是共享的**人工生产事实**，不是设备绑定，也不是创意审核状态。

禁止写入：

```text
/Volumes/...
Finder 路径
本机素材根目录
media_id -> local path
```

本机路径仍只存在 `media-bindings.json`。

## 5. App / Web 边界

### App（Production）

App 可以：

- 扫描当前 Mac 已绑定的素材目录；
- 查看已进入/未进入 `material_index` 的媒体；
- 查看默认机位识别；
- 修改 `camera_override`；
- 设置 `source_role`；
- 设置 `sync_policy`；
- 把辅助素材归到 `scene_id`；
- 写制作备注；
- 重新同步时应用排除与机位覆盖。

写入使用 `expected_revision`，冲突时刷新，不做 last-write-wins 静默覆盖。

### Web（Review）

普通团队 Web 不提供素材目录扫描、机位生产配置或同步控制。

Web 只消费已经整理好的审阅内容。它不需要知道无人机文件在 Host 的哪个磁盘，也不应该出现 FFmpeg、同步引擎或本机路径。

## 6. Coverage

Coverage 同时呈现两类资源，但严格分开：

```text
24-3 饭店外

同步 Take
A  全景
B  中景
C  特写

辅助素材
航拍  DJI_0042.MP4
空镜  CAFE_EXT_03.MOV
GoPro GOPR0182.MP4
```

规则：

- `camera_override` 是有效机位；原始识别保留为 `detected_camera`；
- 辅助素材按人工 `scene_id` 进入场景；
- 未归场景辅助素材单独统计；
- 辅助素材不成为 Take；
- 辅助素材不证明对白覆盖；
- 辅助素材不拥有 Editorial authority；
- 辅助素材不改变 delivery.v1。

## 7. Rough Cut Planner

粗剪规划把辅助素材作为场景级 `auxiliary_pools`：

```text
aerial
broll
gopro
insert
custom
```

它们可作为建立、过场、细节、反应或节奏资源供后续组装使用，但当前阶段：

- 不自动替代 Best；
- 不成为 `primary_group_id`；
- 不参与 Best 多选冲突；
- 不从“航拍”推断应该插在哪一句台词；
- 不写 Selection Manifest；
- 不写 FCPXML。

后续真正的 Assembly / NLE Adapter 若要自动插入辅助素材，必须有独立、可审计的编辑规划语义，不能偷用 `source_role` 直接决定剪点。

## 8. 权威层级

机位/素材角色与其它权威互相独立：

```text
media_roles.json
= 人工生产元数据
= 机位 / 素材角色 / 同步参与 / 场景归属

review.json
= 历史人工归集与审核

editorial.json
= Individual Opinion + Final Editorial Decision

auto_decisions.json
= 自动剧本归集状态

selection_manifest.json / delivery.v1
= 交付选择语义
```

`media_roles.json` 可以影响“这条素材是否参加同步”和“它在 Coverage 里属于哪一类”，但不能产生 Best / Keep / Reject。

## 9. 红线

1. A/B/C 默认识别必须可被人工覆盖。
2. 不得用普通文件名中的任意 A/B/C 字符做弱猜测。
3. 无 TC / 无音频辅助素材不得记为同步失败。
4. `sync_policy=exclude` 必须在重新同步时真实生效。
5. 机位覆盖必须按 `media_id`，不能按机器路径作为共享身份。
6. 辅助素材不得自动成为 Take、Best 或 Primary。
7. 素材角色不得写 `review.json`、`editorial.json` 或 `auto_decisions.json`。
8. 普通 Web 不提供这些 Production 写入口。
9. 任何 NLE 写入仍必须遵守“不覆盖源 FCPXML”的安全边界。
