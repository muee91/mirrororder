# 镜序 Desktop Bridge

这份文档定义 macOS App 与 Team Web 之间的剪辑桥接边界，供后续 Codex / 人工开发检查。

多设备素材解析规则另见 `SYNC_MODEL.md`。

## 1. 当前设备素材直接拖到剪辑软件

只在 `镜序.app` 内启用；普通浏览器不伪造本机文件拖拽。

链路：

```text
共享项目 clip / media_id
→ 当前设备 media resolver
→ 当前设备真实文件路径
→ 素材 A/B/C 卡片 pointerdown
→ web/timeline_v3.js 通过 WKScriptMessageHandler 发送 resolved media_path
→ EditorDragWebView 准备 file:// URL
→ 用户真正拖动鼠标
→ AppKit NSDraggingSession + NSDraggingItem
→ NSPasteboard fileURL / NSFilenamesPboardType
→ FCP / Premiere / Resolve / Finder 作为普通文件接收
```

约束：

- 拖出去的是**当前设备对同一 `media_id` 绑定出来的真实素材副本**，不是项目创建电脑的绝对路径。
- 如果当前设备刚好仍能访问项目来源路径，也可以直接使用该文件；但绝对路径不是共享身份。
- 如果一个逻辑 Take 只使用源文件的一段，普通文件拖拽仍然得到完整媒体文件。这与 Finder 拖文件语义一致。
- 不生成代理文件，不复制媒体，不修改原始素材。
- 当前设备没有解析到真实文件时不开始拖拽。
- A/B/C 素材卡只要在当前设备有真实媒体绑定即可直接拖出。
- XML 时间线上的 `asset-clip` / `video` / `audio` 只有在能明确落到单个当前设备真实媒体文件时才允许直接拖出。
- `ref-clip` / `mc-clip` / multicam resource 可以用底层媒体帮助关联当前项目 Take，但不得随便挑第一个角度作为拖拽文件。

设备绑定默认保存：

```text
~/Library/Application Support/MirrorOrder/media-bindings.json
```

这个文件不得写进共享 workspace。

## 2. XML 时间线预览

入口：**镜序 App → 剪辑 → 时间线**。

普通 Team Web 不加载 Production 时间线。`web/timeline.js` 只是旧 App shell 的兼容 loader，本身也必须检查 WKWebView 原生桥接；它不能再顺带加载旧 `automation.js`。

模式：

1. `当前项目`：由当前项目已登记的素材时间关系生成预览。
2. `加载 XML`：用户从本机选择 `.fcpxml` / `.xml`，只在 App WebView 内读取和预览，不改项目配置、不写回 XML。

解析支持：

- FCPXML rational seconds，例如 `1001/30000s`。
- FCPXML 1.8 及以前 `asset src`。
- FCPXML 1.9+ `asset > media-rep kind="original-media" src`。
- `asset-clip`、`ref-clip`、`mc-clip`、`clip`、`gap`、`video`、`audio`。
- 优先读取 project 下的 sequence，避免把 multicam resource 内部 sequence 当成用户要预览的主时间线。
- 主 spine clip 没有 `offset` 时按 story 顺序连续排列。
- connected clip 有 `offset` 时按 parent timeline 计算位置。
- `media` / `multicam` resource 会收集内部 `asset-clip` 引用，用底层媒体路径尝试关联当前项目素材。

XML 时间线是只读预览，不修改原始 FCPXML，不改变项目分析结果，也不是 Delivery Adapter。

## 3. 时间线 ↔ 素材双向关联

项目内部关联证据优先级：

```text
media_id / 项目 clip_id
→ 项目来源路径 + 当前设备解析路径
→ source_start 最接近的 occurrence
→ duration 轻量辅助
→ 文件/clip 名称 fallback（仅兼容旧项目）
```

时间线 → 素材：

- 点击已关联时间线片段。
- 找到当前项目 `clip_id`。
- 找到包含该 clip 的逻辑 Take。
- 如果这个 Take 有人工 `placement.script_segment_ids`，人工剧本范围优先于自动 candidate。
- 如果只人工指定了集数，则进入该集的待归集视图，不冒充具体台词确认。
- 没有人工范围时才使用自动剧本 candidate。
- 自动选中机位素材并加载播放器；播放器的 HTTP media endpoint 由当前设备 resolver 读取本机文件。

素材 → 时间线：

- 用户在候选 Take 中点击 A/B/C 素材卡片。
- 时间线中具有同 `clip_id` 的块高亮。
- 时间线本身不改变 review、candidate 或人工归集。

无法关联的 XML 块必须显示 `未关联`，不能强行猜测。

## 4. Team Web 与 App 的加载边界

```text
Team Web
  ├─ review workspace
  ├─ gateway 媒体播放
  └─ device_media.js：显示“服务端素材”覆盖率

镜序 App
  ├─ 上述 Review 基础
  ├─ production_mode.js
  ├─ device_media.js：显示“本机素材”覆盖率
  └─ timeline.js → timeline_v3.js
       ├─ XML 时间线
       └─ native drag decorator
```

`ux_fixes.js` 可以装载 `device_media.js` 给两种客户端使用，但只有检测到 `window.webkit.messageHandlers.mirrorOrder` 时才可以装载 `timeline.js`。

## 5. 文件位置

```text
macos-app/MirrorOrderDesktopCore.swift       # Host / WebKit / AppKit bridge
macos-app/MirrorOrderDesktopUI.swift         # 原生项目与设置 UI
macos-app/prebuild_check.py                  # 构建前产品/Agent/运行时静态契约
macos-app/build_ready.sh                     # preflight → pytest → build
macos-app/build_app.sh                       # 当前实际 App 打包入口
src/script_organizer/media_identity.py       # media_id + 每台设备本地绑定
src/script_organizer/device_media_runtime.py # 服务运行时本机路径解析
web/production_mode.js                       # App Production 导航，含 剪辑 → 时间线
web/timeline.js                              # App-only 兼容 loader
web/device_media.js                          # 本机/服务端素材覆盖状态
web/timeline_v3.js                           # FCPXML预览 / 双向关联 / native drag JS bridge
web/timeline.css                             # 时间线 UI；隐藏旧顶栏入口
web/ux_fixes.js                              # Review 公共补丁 + 原生能力条件装载
tests/test_device_media.py                   # 多设备媒体身份与绑定回归
tests/test_desktop_bridge.py                 # 桥接层静态回归约束
```

## 6. 构建与真机验收

推荐交接构建：

```bash
git pull
zsh macos-app/build_ready.sh
open "镜序.app"
```

第一台 Mac：

1. App 自动进入 Production 工作台。
2. 当前项目正常播放。
3. `剪辑` 下能看到 `粗剪 / 组接 / 时间线`，普通 Team Web 看不到 Production 导航。
4. 从 A/B/C 素材卡拖到 Finder，Finder 接收到真实文件。
5. 从同一卡片拖到 Final Cut Pro Browser/Event，FCP 能按普通媒体文件接收。
6. 普通点击素材卡仍只负责选中/播放，不被拖拽桥误伤。

第二台 Mac：

7. 仅当第二台 Mac 自己运行镜序并需要本机播放或原生拖拽时，打开相同共享项目数据。
8. `设置 → 这台 Mac 的素材副本 → 为当前项目绑定素材目录`。
9. 工作台显示第二台 Mac 自己服务的素材覆盖率。
10. 播放同一 clip 时读取第二台 Mac 的媒体副本。
11. 从素材卡拖到 Finder/FCP 时得到第二台 Mac 自己磁盘上的文件。
12. 本机扫描前后共享 `material_index.json` / `matches.json` / `review.json` 不发生路径改写。

一个 App gateway 可以同时加载多个工作区；素材目录绑定默认只作用于当前 `workspace_id + project_id`，一次选择多个目录会合并到该项目的本机绑定。`扫描当前工作区全部项目` 是明确的高级操作，不是默认行为。

局域网浏览器访问某台 gateway 时，不需要绑定自己的媒体副本：HTTP 播放由 gateway 主机解析和读取素材。浏览器不具备原生文件拖拽能力，也不暴露 XML Production 时间线。

时间线：

13. 在 App 进入 `剪辑 → 时间线`，切换 `当前项目` 后 A/B/C 时间块位置合理。
14. 加载 FCP 导出的 1.9+ FCPXML，`media-rep` 文件能建立关联。
15. 加载主 spine 未写 `offset` 的 XML，片段按顺序排列而不是全部叠在 0 秒。
16. 第二台 Mac 即使素材目录不同，加载第一台 Mac 导出的 XML 仍能通过项目来源路径 / media identity 关联到本机素材。
17. 点击时间线已关联素材能定位素材卡和播放器。
18. 人工归集过的 Take 从时间线进入时遵守人工剧本范围，而不是旧自动匹配。
19. 点击素材卡能反向高亮时间线。
20. `ref-clip` / `mc-clip` 如果只知道多个底层角度，不提供任意单文件拖拽。
21. 原始 FCPXML 与原始媒体不发生写入。

## 7. 后续不要误改

- 不要用 HTML5 `dataTransfer` 假装可以把网页文件路径拖到外部 App；外部文件拖拽必须继续由 AppKit 完成。
- 不要把逻辑 Take 自动渲染成临时媒体文件再拖出去，除非未来明确新增“导出子片段”功能。
- 不要让自动 candidate 覆盖人工 placement。
- 不要为 multicam/ref-clip 随意选择一个角度充当“该时间线片段的文件”。
- 不要把 `/Volumes/...` 或本机素材根目录回写成共享项目权威数据。
- XML 预览是只读视图；若未来做可编辑时间线，必须建立单独的 edit model，不能直接改原始 FCPXML DOM。
- 不要因为 `timeline.js` 仍存在就把它重新暴露给 Team Web；它是 App compatibility loader。
