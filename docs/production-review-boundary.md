# MirrorOrder Production / Review Boundary

镜序把复杂度留在制作端，把清晰、可信、可直接判断的内容交给团队审阅。

这份文档是 `docs/ux-principles.md` 的工程落地补充。发生冲突时，以更严格的数据权威、人工审核和设备路径规则为准。

## 1. 产品边界

### App — Native Production

`镜序.app` 是唯一的 Production 客户端。主制作画布使用 SwiftUI / AppKit / AVKit 原生实现，负责：

- 项目创建、输入预检、素材目录与当前 Mac 的媒体绑定；
- 多机位同步、ASR、剧本匹配、自动归集与异常复核；
- 素材、剧本、Take 的细粒度检查；
- 人物、声纹、场记、内容证据与 Coverage；
- 镜序助理、生产任务、运行时、日志和诊断；
- 粗剪、组接、时间线、NLE 交付；
- 当前设备真实文件到 Finder / Final Cut Pro / Premiere / Resolve 的 AppKit 原生拖拽。

项目是 App 的一级对象。项目列表常驻左栏；选中项目后中央直接进入该项目的原生制作工作区。

**App 主制作画布不得嵌入 WebView。**

以下模式禁止重新成为 Production 主链：

```text
SwiftUI shell
  -> WKWebView
  -> production_mode.js / timeline.js / JS wrappers
  -> Host
```

原因不是视觉偏好，而是生产可靠性：WebView 导航、JS 加载顺序、动态 wrapper、桥接状态和 SwiftUI 生命周期会制造额外故障面。App 的制作能力必须由原生视图直接调用受约束的 Host API / 本机能力。

### Web — Team Review

Web 是独立的团队审阅客户端，通过浏览器访问 gateway，负责：

- 选择项目与集数；
- 按剧本查看候选 Take；
- 播放、切换机位；
- Best / Keep / Reject 与人工归集；
- Individual Opinion / 协作审阅；
- 搜索、人物上下文和安全的镜序助理审阅提醒。

普通 Team Web 不承担：

- 项目创建与本机素材目录管理；
- FFmpeg / 模型 / runtime / gateway / 端口设置；
- 生产任务启动、重跑与诊断；
- 本机文件拖入外部剪辑软件；
- XML Production 时间线；
- 身份聚类拆分、底层匹配参数或算法调参；
- Host-local Final Editorial Decision。

App 中的“团队审阅”只是使用 `NSWorkspace` 打开浏览器地址，不在 App 内嵌 Team Web。

## 2. Host 是共享语义层，不是 UI 容器

App 与 Web 可以消费同一 Host，但不共享 UI 实现。

```text
Canonical Production Data
  material_index
  script
  matches
  auto_decisions
  review
  editorial
  identities / evidence
  script_supervisor
        ↓
MirrorOrder Host
        ↓
versioned read/write APIs
        ├── Native Production App
        ├── Team Web Review
        └── constrained Agent API
```

`review.v1` 是 Host 的版本化只读投影。它可以同时给原生 App 和 Team Web 提供稳定的项目语义，但它不是新的写入权威，也不要求两端共享渲染代码。

原生 App 应优先直接消费结构化 Host API，而不是通过 JavaScript 解释底层文件。

## 3. 数据权威不变

必须继续遵守：

```text
人工 review.json / Final Editorial Decision
    > 自动 auto_decisions.json
    > 自动候选 / AI 建议 / Audit evidence
```

- 自动流程不得写 `review.json`；
- 不得自动 Reject；
- 人工 placement / assignment / review 不得被自动结果覆盖；
- Shadow Audit 不是审核权威；
- 镜序助理只能读取、分析、调度受限非权威工具和生成 proposal/question；
- 原始 FCPXML、原始媒体不可由展示层直接修改。

## 4. 多设备边界不变

共享的是项目事实与人工决定，不是某台电脑的绝对媒体路径。

```text
共享：script / material_index / matches / review / editorial / media_id
设备本地：media-bindings.json / /Volumes/... / Finder 路径 / native drag path
```

Native App 可以通过 `clip_id / media_id` 请求 Host-local resolver，拿到当前设备真实文件 URL 后再执行 AppKit 操作。

Team Web 只能通过 gateway 的 HTTP media endpoint 播放主机素材，不获得主机 `/Volumes/...` 路径，也不能伪造本机文件拖拽。

## 5. 原生 Production 迁移规则

当前原生化必须按业务语义迁移，而不是把旧网页直接翻译成 SwiftUI。

优先级：

1. 剧本 / Take / 播放 / 异常队列；
2. 人工归集与审核权威写入；
3. 本机 `media_id -> file URL` resolver + AppKit drag；
4. 场记独立大窗口；
5. 镜序助理 / Audit / 语义找素材；
6. Coverage / Rough Cut / Assembly；
7. 原生只读时间线与正式 NLE Delivery Adapter。

旧 `production_mode.js`、`timeline.js`、`timeline_v3.js` 等代码只能作为迁移参考或 Team Web 历史兼容实现，**不得再成为 App Production 的运行依赖**。

当某项原生能力完成后，应删除对应的 App-Web 兼容入口和相关测试，而不是长期保留双实现。

## 6. AppKit / AVKit 原生能力

### 播放

视频播放使用 AVKit / AVFoundation。Host 提供媒体 endpoint 或当前设备 resolver；播放器本身不需要 WebView。

### 外部文件拖拽

目标链路：

```text
Native Take / 素材卡
  -> clip_id / media_id
  -> current-device resolver
  -> real local file URL
  -> NSDraggingSession / NSDraggingItem
  -> NSPasteboard fileURL
  -> Finder / FCP / Premiere / Resolve
```

禁止使用 HTML5 `dataTransfer` 冒充外部文件拖拽。

### 时间线

原生时间线只读查看 edit/source structure；不能直接修改用户原始 FCPXML DOM。若未来支持编辑，必须建立独立 edit model。

## 7. UI 约束

Native Production 继续遵守镜序的专业后期工具视觉语言：

- 高信息密度、低视觉噪音；
- Pane / SplitView / Table / Inspector 优先；
- 项目常驻左栏；
- 文件名、机位、播放是素材卡主信息；
- 景别、人物、Audit 是克制的次级信息；
- 模型名、embedding、runtime 等实现术语只进入高级设置/诊断；
- 镜序助理是主动生产助理，不是右侧 ChatGPT 控制台。

## 8. 回归红线

- App Production UI 不得实例化 `DesktopWebView` / `WKWebView`；
- App Production 不得依赖 `production_mode.js` / `timeline.js` / JS wrapper 才能渲染；
- Team Web 不得获得项目创建、本机路径、runtime 或生产任务控制；
- 不得用 HTML5 `dataTransfer` 伪造外部文件拖拽；
- 不得把 `/Volumes/...` 或当前设备素材根目录写入共享项目状态；
- 不得让客户端展示分类写回自动或人工权威状态；
- 不得自动 Reject；
- 不得因为 App 原生化，就把 Team Web 重新做成制作控制台。
