# 镜序 Desktop Bridge

这份文档定义 macOS App 与浏览器工作台之间的剪辑桥接边界，供后续 Codex / 人工开发检查。

## 1. 源素材直接拖到剪辑软件

只在 `镜序.app` 内启用；普通浏览器不伪造本机文件拖拽。

链路：

```text
素材 A/B/C 卡片 pointerdown
→ web/timeline_v2.js 通过 WKScriptMessageHandler 发送真实 media_path
→ EditorDragWebView 准备 file:// URL
→ 用户真正拖动鼠标
→ AppKit NSDraggingSession + NSDraggingItem
→ NSPasteboard fileURL / NSFilenamesPboardType
→ FCP / Premiere / Resolve / Finder 作为普通文件接收
```

约束：

- 拖出去的是原始源文件，不是镜序内部的逻辑 Take。
- 如果一个逻辑 Take 只使用源文件的一段，普通文件拖拽仍然得到完整源文件。这与 Finder 拖文件语义一致。
- 不生成代理文件，不复制媒体，不修改原始素材。
- 文件不存在时不开始拖拽。
- 时间线中只有能解析到真实源文件的 clip 才能直接拖出。

## 2. XML 时间线预览

入口：工作台顶部 `时间线`。

模式：

1. `当前项目`：由当前项目已登记的素材时间关系生成预览。
2. `加载 XML`：用户从本机选择 `.fcpxml` / `.xml`，只在浏览器内读取和预览，不改项目配置、不写回 XML。

解析支持：

- FCPXML rational seconds，例如 `1001/30000s`。
- FCPXML 1.8 及以前 `asset src`。
- FCPXML 1.9+ `asset > media-rep kind="original-media" src`。
- `asset-clip`、`ref-clip`、`mc-clip`、`clip`、`gap`、`video`、`audio`。
- 主 spine clip 没有 `offset` 时按 story 顺序连续排列。
- connected clip 有 `offset` 时按 parent timeline 计算位置。
- `media` / `multicam` resource 会收集内部 `asset-clip` 引用，用底层媒体路径尝试关联当前项目素材。

## 3. 时间线 ↔ 素材双向关联

关联证据优先级：

```text
真实 media_path
→ source_start 最接近的 occurrence
→ 文件/clip 名称 fallback
```

时间线 → 素材：

- 点击已关联时间线片段。
- 找到当前项目 `clip_id`。
- 找到包含该 clip 的逻辑 Take。
- 有剧本 candidate 时切到对应剧本段；没有时切到待归集。
- 自动选中机位素材并加载播放器。

素材 → 时间线：

- 用户在候选 Take 中点击 A/B/C 素材卡片。
- 时间线中具有同 `clip_id` 的块高亮。
- 时间线本身不改变 review、candidate 或人工归集。

无法关联的 XML 块必须显示 `未关联`，不能强行猜测。

## 4. 文件位置

```text
macos-app/MirrorOrderDesktopApp.swift  # 原生拖拽桥接 + App 壳
macos-app/build_app.sh                 # 当前实际构建入口
web/timeline.js                        # 轻量加载器
web/timeline_v2.js                     # FCPXML 预览/关联/拖拽 JS bridge
web/timeline.css                       # 时间线 UI
web/ux_fixes.js                        # 装载 timeline extension
```

旧 `macos-app/MaterialWorkspaceApp.swift` 与 `macos-app/MirrorOrderApp.swift` 不是当前构建入口，只保留做历史参考。

## 5. 构建与真机验收

```bash
git pull
zsh macos-app/build_app.sh
open "镜序.app"
```

必须在 macOS 真机检查：

1. App 自动进入工作台。
2. 从 A/B/C 素材卡拖到 Finder，Finder 接收到原始文件。
3. 从同一卡片拖到 Final Cut Pro Browser/Event，FCP 能按普通媒体文件接收。
4. 点击 `时间线 → 当前项目`，A/B/C 时间块位置合理。
5. 加载 FCP 导出的 1.9+ FCPXML，`media-rep` 文件能建立关联。
6. 加载主 spine 未写 `offset` 的 XML，片段按顺序排列而不是全部叠在 0 秒。
7. 点击时间线已关联素材能定位素材卡和播放器。
8. 点击素材卡能反向高亮时间线。
9. `review.json` SHA / 内容不因时间线浏览和拖拽发生变化。
10. 原始 FCPXML 与原始媒体不发生写入。

## 6. 后续不要误改

- 不要用 HTML5 `dataTransfer` 假装可以把网页文件路径拖到外部 App；外部文件拖拽必须继续由 AppKit 完成。
- 不要把逻辑 Take 自动渲染成临时媒体文件再拖出去，除非未来明确新增“导出子片段”功能。
- XML 预览是只读视图；若未来做可编辑时间线，必须建立单独的 edit model，不能直接改原始 FCPXML DOM。
