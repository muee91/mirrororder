# 镜序 Desktop Bridge

这份文档定义 `镜序.app` 的本机剪辑能力，以及它与独立 Team Web 的边界。

多设备素材解析规则另见 `SYNC_MODEL.md`。

## 1. 硬边界：App 不嵌 Team Web

`镜序.app` 的 Production 主画布必须使用 SwiftUI / AppKit / AVKit 原生实现。

禁止重新建立：

```text
SwiftUI shell
  -> WKWebView
  -> production_mode.js / timeline.js / JS wrapper
  -> Host
```

Team Web 通过系统浏览器打开，由 gateway 提供 Review 页面；App 中“团队审阅”只负责调用 `NSWorkspace.shared.open(...)`。

旧源码中的 `DesktopWebView` / `EditorDragWebView` 和 `web/timeline_v3.js` 原生桥逻辑目前只属于迁移残留，不再是 Production UI 的运行入口。等原生拖拽 / 原生时间线迁移完成后应删除，而不是重新接回主界面。

## 2. 当前设备素材直接拖到剪辑软件

只在 `镜序.app` 内允许；普通浏览器不伪造本机文件拖拽。

目标链路：

```text
Native 素材 / Take 机位卡
→ clip_id / media_id
→ 当前设备 media resolver
→ 当前设备真实 file URL
→ AppKit NSDraggingSession + NSDraggingItem
→ NSPasteboard fileURL / NSFilenamesPboardType
→ FCP / Premiere / Resolve / Finder
```

约束：

- 拖出去的是当前设备对同一 `media_id` 解析出的真实素材文件，不是项目创建电脑的绝对路径。
- 一个逻辑 Take 只使用源文件一段时，普通文件拖拽仍得到完整媒体文件，与 Finder 拖文件语义一致。
- 不生成代理、不复制媒体、不修改原始素材。
- 当前设备没有解析到真实文件时不开始拖拽。
- `ref-clip` / `mc-clip` / multicam resource 如果只能解析到多个底层角度，不得随便挑第一个文件拖出。

设备绑定默认保存：

```text
~/Library/Application Support/MirrorOrder/media-bindings.json
```

不得写进共享 workspace。

### 当前迁移状态

原生 Production 工作台已经落地，但旧的网页拖拽装饰器不再有主界面入口。因此在新的原生文件拖拽 adapter 完成前，**不要把旧 WebKit bridge 的存在误写成“原生工作台拖拽已完成”**。

原生迁移需要新增一个只接受 `workspace_id + project_id + clip_id/media_id` 的 Host-local resolver，然后由 Swift/AppKit 发起 drag session。

## 3. 原生视频播放

Production 播放器使用 AVKit / AVFoundation。

Host read model 可以给出 HTTP media endpoint；当前 Mac 的媒体解析仍由 gateway/device resolver 负责。播放器不需要 WebView。

要求：

- source range / Take-relative range 必须正确应用；
- A/B/C 机位切换保持选中状态；
- 缺媒体必须明确显示，不得偷偷回退到错误同名文件；
- 本机绝对路径不能进入共享 read model。

## 4. XML / 时间线

时间线属于 Production App，不属于 Team Web。

目标实现是原生只读时间线：

```text
FCPXML / edit model
→ Swift parser / Host structured projection
→ Native Timeline View
→ clip_id / media_id 双向关联
```

仍需保持：

- FCPXML rational seconds，例如 `1001/30000s`；
- FCPXML 1.8 `asset src`；
- FCPXML 1.9+ `media-rep kind="original-media" src`；
- `asset-clip` / `ref-clip` / `mc-clip` / `clip` / `gap` / `video` / `audio`；
- project 主 sequence 优先；
- 主 spine 无 `offset` 时按 story 顺序；
- connected clip 的 parent timeline 关系；
- 无法可靠关联的块显示“未关联”。

XML 时间线只读，不修改原始 FCPXML，不改变项目分析结果，也不是 Delivery Adapter。

旧 `web/timeline.js` / `timeline_v3.js` 只作为迁移参考，不能重新成为 App 时间线实现。

## 5. 时间线 ↔ 素材双向关联

关联证据优先级：

```text
media_id / clip_id
→ source range
→ 项目来源身份参考
→ duration 轻量辅助
→ 文件名 fallback（旧项目兼容）
```

时间线 → 素材：

- 点击已关联时间线片段；
- 定位 `clip_id` 与逻辑 Take；
- 人工 placement / assignment 优先于自动 candidate；
- 只人工指定集数时进入对应待归集上下文，不冒充具体台词确认；
- 自动选中对应机位并加载原生播放器。

素材 → 时间线：

- 用户选中 Native 机位卡；
- 同 `clip_id` 的时间线块高亮；
- 时间线不改变 review / candidate / editorial 权威。

## 6. Team Web 与 App 的运行边界

```text
镜序 App
  ├─ NativeProjectWorkbench
  ├─ AVKit playback
  ├─ Native 人物 / 场记 / Production tools
  ├─ Host-local device resolver
  ├─ AppKit drag（迁移目标）
  └─ Native timeline（迁移目标）

Team Web
  ├─ browser Review workspace
  ├─ gateway HTTP media playback
  ├─ Individual Opinion / review collaboration
  └─ safe assistant review summary
```

Team Web 不得获得：

- 本机 `/Volumes/...` 路径；
- AppKit drag；
- Production timeline；
- 模型/runtime配置；
- 项目创建/素材绑定/生产任务；
- Host-local Final Editorial Decision。

## 7. 关键文件

```text
macos-app/MirrorOrderDesktopCore.swift       # Host 客户端、项目控制、设备级能力；仍含待删除旧 WebKit bridge 残留
macos-app/MirrorOrderDesktopUI.swift         # 原生项目列表 / 设置 / Production shell
macos-app/NativeProjectWorkbench.swift       # 当前原生 Production 主工作区
macos-app/prebuild_check.py                  # Native Production / Team Web Review 边界门禁
macos-app/build_ready.sh                     # preflight → pytest → build
macos-app/build_app.sh                       # App 打包入口
src/script_organizer/media_identity.py       # media_id + 设备本地绑定
src/script_organizer/device_media_runtime.py # 本机路径解析
web/                                         # 独立 Team Web；旧 Production JS 仅迁移/兼容残留
```

## 8. 构建与真机验收

```bash
git pull
zsh macos-app/build_ready.sh
open "镜序.app"
```

当前必须先验：

1. 主窗口直接进入 `NativeProjectWorkbench`，不出现网页加载过程、网页错误层或 HTML Production 导航。
2. 左栏项目切换不会创建/重载 WKWebView。
3. A/B/C 素材使用 AVKit 正常播放。
4. 人物库、场记、状态中心、设置均为原生窗口/Sheet。
5. “团队审阅”打开系统浏览器，不在 App 内打开网页面板。
6. Team Web 无项目创建、本机路径、Production timeline、runtime 或 AppKit drag。
7. 本机媒体绑定前后，共享 `material_index.json` / `matches.json` / `review.json` 不发生路径改写。

原生拖拽和原生时间线迁移完成后再恢复对应真机验收项；在完成前不以旧 WebKit bridge 冒充通过。

## 9. 后续不要误改

- App 主制作画布不得重新嵌入 WebView。
- 不要为“复用旧页面”重新接 `production_mode.js` / `timeline.js`。
- 不要用 HTML5 `dataTransfer` 假装可以把网页文件拖到外部 App；外部文件拖拽必须由 AppKit 完成。
- 不要把逻辑 Take 自动渲染成临时媒体再拖出去，除非未来明确新增“导出子片段”。
- 不要让自动 candidate 覆盖人工 placement。
- 不要把 `/Volumes/...` 或本机素材根目录回写为共享项目事实。
- XML 预览是只读视图；未来可编辑时间线必须建立独立 edit model。
