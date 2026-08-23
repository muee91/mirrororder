# Electronic Script Supervisor v2

电子场记表把纸质场记单的二次录入变成 MirrorOrder 的共享人工生产事实。

它不是审核页，也不是 AI 控制台。

## 核心对象

`script_supervisor.v2` 的一级对象是 `record`：

> 一条场记记录 = 一次实际拍摄记录。

场记记录不以算法 `group_id` 作为身份。即使未来重跑同步或算法重新拆分逻辑 Take，已经录入的场、镜、次、备注和素材附件仍可以保留。

```json
{
  "record_id": "slate-...",
  "source_group_id": "G_...",
  "script_scene_id": "SC_...",
  "episode": 24,
  "scene": "3",
  "shot": "2B",
  "take_number": 4,
  "status": "partial",
  "note": "只要前半段，后面演员笑场",
  "usable_range": {"start": 1.2, "end": 8.7},
  "attachments": []
}
```

`source_group_id` 和 `script_scene_id` 都可以为空。

## 素材附件

一条场记记录可以挂多个素材：

```text
24场 / 3镜 / T2
  A001.mov
  B001.mov
  C001.mov
```

也可以只挂：

```text
DJI_0038.MP4 · 航拍
```

附件使用 `clip_id` / `media_id`，不保存设备绝对路径。

附件可以记录：

- camera
- source_role
- 人工 shot_type
- 机位备注

人工景别只覆盖同一个附件/clip 的 AI 景别，不复制到其它机位。

## 四种录入方式

### 1. Take 一键带入

镜序把尚未录入场记的逻辑 Take 放在左侧待录入区。

点击后：

- 新建一条场记 record；
- A/B/C 素材成为附件；
- 如果已有明确人工归集集数，可以带入单一 episode；
- 算法 Take 只是录入捷径，不是场记身份。

### 2. 文件名搜索

照纸质场记单抄录时，可直接搜索文件名或 Take。

文件搜索来自当前 Mac 的安全 `media-inventory`，可以包含没有进入同步索引的素材。

### 3. Finder 拖入

App 的电子场记工作区接受 Finder 文件拖入作为录入捷径。

当前实现只使用浏览器拖入对象的**文件名**与 App-only 本机 inventory 匹配：

- 不上传文件；
- 不复制文件；
- 不把 Finder 路径写进共享项目；
- 同名多条时要求人工从搜索结果选择；
- 不在当前绑定素材目录中的文件要求先绑定/扫描。

这与“从 App 向 Final Cut/Finder 拖出真实文件”的 AppKit bridge 是两条不同链。对外拖出仍必须使用原生 `NSDraggingSession`。

### 4. 文本 / 语音快速录入

可以输入：

```text
24场3镜第二次，B近景，前半段可用，后面笑场
```

确定性 parser 优先提取：

- 集
- 场
- 镜
- 次
- A/B/C 等机位景别
- usable / partial / NG
- 前半段 / 后半段语义提示

“上一条 / 同上”可以继承上一条的基础字段。

如果设备配置了 Assistant Language Model，可用它增强自然语言解析；结果仍必须经过 Host schema 清洗。

### 语音

电子场记提供 `Option + Space` 语音入口。

如果 WKWebView 提供 SpeechRecognition，则识别成中文文本后进入同一 parser；如果系统没有暴露该能力，则退化为聚焦输入框并提示使用 macOS 系统听写。

语音只是录入方式，不产生更高的数据权威。

## AI 红线

场记原话是人工证据，AI 派生理解不是原始事实。

AI 可以：

- 把自然语言转成字段；
- 向镜序助理解释场记备注；
- 在粗剪准备时提醒“只要前半段”“后半段穿帮”等约束；
- 提出需要看片确认的可用区间。

AI 不可以：

- 把“前半段”猜成某个秒数；
- 自动写 Best / Keep / Reject；
- 自动改变 Editorial Decision；
- 仅凭场记自然语言自由发明剧本位置；
- 把“说台词的角色”自动认成当前多机位画面中的演员。

精确可用范围必须来自人工 I/O、可靠时间证据或未来明确的人机确认流程。

## 场景关联

`scene` 是给人的场次文本；`script_scene_id` 是镜序内部明确剧本场景身份。

二者不能自动等同。

独立航拍/空镜进入 Coverage/Rough Cut 必须满足其一：

1. 场记 record 明确拥有 `script_scene_id`；或
2. 附着媒体已经由人工 `media_roles.v1` 明确设置同一个 `scene_id`。

如果只填“24场”但没有明确内部场景关联，系统不得猜测并加入 Coverage。

## Coverage / Rough Cut

与逻辑 Take 绑定的场记记录通过兼容 `entries` 投影继续约束现有 Coverage/Rough Cut：

- 人工景别 > AI 景别；
- `NG` 可以阻止粗剪计划自动使用，但 **NG 不等于 Delivery Reject**；
- `partial` 没有精确范围时必须保持 pending；
- `preferred_clip_id` 才能明确多机位组接优先角度；未指定时保持“机位待定”。

独立辅助素材以 `slate_auxiliary_media` 进入明确场景的辅助素材池：

- 不成为 Take；
- 不成为 Primary；
- 不替代 Final Best；
- 只作为建立镜、空镜、航拍、GoPro、细节等可选覆盖。

## Team Web

Team Web 不提供电子场记编辑。

它只在对应 Take 上看到安全的：

- 场 / 镜 / 次；
- 人工景别；
- status；
- note。

完整场记 records、快速录入、Finder drag、本机 inventory 和语音入口属于 App Production。

## 快捷键

电子场记工作区：

- `Tab / Shift+Tab`：字段移动；
- `Enter`：普通单元格保存并进入下一字段；
- `Cmd/Ctrl + Enter`：备注保存并进入下一字段；
- `Option + Space`：语音录入；
- `Space / K`：预览播放暂停；
- `J / L`：前后移动；
- `I / O`：设置精确可用入点 / 出点；
- `Esc`：关闭素材预览。

## 数据安全

- revision-safe 原子写；
- 每次写入要求 actor；
- `display_name` 只保留 basename；
- 不保存 `/Volumes/...`；
- 不修改原始素材；
- 不修改源 FCPXML；
- 不写 `review.json` / `editorial.json` / `auto_decisions.json`。
