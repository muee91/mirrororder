# 镜序 Desktop Bridge

这份文档定义 `main` 上 **Desktop v2** 与 Python Core、Rust Timeline Core、Team Web、设备本机媒体和 NLE 的边界。

旧 SwiftUI `macos-app/` 已按 owner cutover 决策删除；本文不再描述或保留 SwiftUI/WebKit 迁移路径。

多设备素材解析规则另见 `SYNC_MODEL.md`。

## 1. 当前 Desktop 架构

```text
React / TypeScript Production UI
          ↓ typed localhost / Tauri commands
Tauri 2 / Rust
  ├─ Production Host lifecycle :8765
  ├─ Team Gateway lifecycle    :8766
  ├─ dialog / reveal / URL / Final Cut platform adapters
  └─ Rust Timeline bridge
          ↓
Python MirrorOrder Core + Rust Timeline Core
```

权威边界：

- Python Core：workspace/project、Review、Slate、Identity、Assistant、AI proposal、media identity/binding、FCPXML/delivery。
- Rust Timeline Core：authoritative local timeline edit state。
- React：Production UI，不保存第二套业务/时间线权威。
- Team Web：轻量 Review / Projection 面。

## 2. Production Host 与 Team Gateway

Production Host 和 Team Web Gateway 是两个独立生命周期：

```text
Production Host  127.0.0.1:8765
Team Gateway     default :8766
```

要求：

- 两者使用不同 Tauri manager；停止一个不得停止另一个。
- Production Host 默认 `--local-only`。
- Team Gateway 可以 local-only 或 LAN，并继续使用 Python Core 的 pairing / trusted-LAN 语义。
- 子进程 `spawn()` 不等于 ready；只有目标 TCP 端口真实监听后才报告启动成功。
- Desktop 不复制 Python Gateway 的权限/Review 规则。

## 3. 本机媒体

```text
clip_id  → 项目/FCPXML occurrence
media_id → 物理媒体身份
```

Desktop 通过当前设备 media resolver 获取可播放素材。

约束：

- 本机绝对路径是 device-local state，不进入共享 workspace/Review。
- 媒体缺失必须明确显示；不得偷偷用错误同名文件。
- 同一 `media_id` 在不同设备可以映射到不同磁盘路径。
- 视频/代理帧不得通过 Tauri JSON/Base64 IPC 大量传输；沿用 HTTP media endpoint/Range 或未来窄 native adapter。
- 普通 Team Web 不获得 gateway 主机的本机路径。

设备状态默认遵循：

- macOS: `~/Library/Application Support/MirrorOrder`
- Windows: `%APPDATA%/MirrorOrder`
- Linux: `$XDG_CONFIG_HOME/mirrororder` 或 `~/.config/mirrororder`

## 4. Timeline Bridge

当前 Production Timeline 已不是迁移目标，而是 Rust authoritative edit model。

```text
React TimelineWorkbench
      ↓ commands
Tauri TimelineManager
      ↓
Rust Timeline Core
      ↓
checkpoint + journal + recovery
```

核心命令包括：

- Insert
- Overwrite
- Move
- Split
- Trim
- RippleDelete
- Disable
- MulticamSwitch
- SetMarker
- Undo / Redo

约束：

- React 不直接写 authoritative Timeline JSON。
- Python 不直接修改 Rust Timeline state。
- Rough Cut / AI 先形成 proposal；只有人工明确确认后才能转换成 Timeline commands。
- 新鼠标、键盘、importer、NLE 入口都应归一化为 Rust commands。
- Timeline persistence/recovery 是本机 edit state，不改变 Review/Editorial authority。

## 5. Source / Program Monitor

当前 Desktop v2 已有 Source Monitor、Program Monitor、waveform、J/K/L proxy transport 和 frame step。

这些是 proxy/WebView playback contract，不得冒充已经通过专业 native A/V clock gate。

真实 macOS/Windows：

- 播放时钟
- frame-step
- source range
- multicam angle
- WebView2/macOS WebView 媒体行为

仍应按 `phase7-parity.json` 做真机 smoke。

## 6. 外部文件/NLE 交互

普通网页不能伪造系统级本机文件拖拽。

未来如果增加“素材卡拖到 FCP/Premiere/Resolve”，应当满足：

```text
workspace_id + project_id + clip_id/media_id
→ current-device resolver
→ real local file URL
→ narrow native drag/platform adapter
```

要求：

- 拖出的是真实源文件 URL，与 Finder/Explorer 拖文件语义一致。
- 不自动生成临时子片段、代理或媒体副本。
- 无法唯一解析底层媒体时拒绝，而不是随便选择某个角度。
- 这是独立重平台能力；实现规模较大时必须独立 worktree。

## 7. FCPXML / Final Cut

FCPXML 业务语义继续属于 Python Core。

Desktop delivery 链：

```text
人工触发
→ Python delivery / fcpxml_exporter
→ organized.fcpxml + selection_manifest.json
→ Tauri platform adapter
→ Finder / Final Cut Pro
```

约束：

- 不修改原始 FCPXML。
- 不破坏既有 multicam/sync 结构。
- `organized.fcpxml` 的结构安全优先于“为了自动剪辑而重写 XML”。
- 当前明确 decision 继续由 `selection_manifest.json` 携带，除非未来实现并验证结构安全 writer。
- Final Cut adapter 只是打开已存在 `.fcpxml`，不复制 exporter 业务逻辑。

Resolve/Premiere 仍是 extension point，不是当前 cutover 必需能力。

## 8. Team Web 与 Production UI

Desktop 顶层明确分为：

```text
制作
团队协作
```

Team Web Gateway 不进入 ProjectWorkbench tabs。

Team Web 可以：

- Review workspace
- gateway HTTP media playback
- collaboration/opinion
- safe assistant review summary

Team Web 不可以：

- 项目创建/删除
- 本机素材绑定
- 本机路径读取
- Production Timeline authority
- 模型/runtime secret 配置
- Host-local Final Editorial Decision

## 9. Heavy capability isolation

不要把 Production tabs 当作插件槽。

以下能力优先独立 module / branch / worktree：

- packaged Python/runtime
- heavy proxy/media generation
- native external drag
- new NLE adapters
- model runtime infrastructure
- experimental automation engines

当前 packaging workstream：

```text
feat/desktop-v2-runtime-packaging
```

它负责 portable Python、numpy/pandas/scipy、ffmpeg/ffprobe、MirrorOrder Core、first-party multicam engine、Tauri resource layout 等发行问题。

packaged mode 必须 fail-closed，不能静默依赖用户系统 Python/FFmpeg。

## 10. 关键文件

```text
desktop-v2/src/app/App.tsx                         # 顶层制作 / 团队协作 shell
desktop-v2/src/features/production/ProjectWorkbench.tsx
desktop-v2/src/features/editor/TimelineWorkbench.tsx
desktop-v2/src-tauri/src/host.rs                  # Production Host 生命周期
desktop-v2/src-tauri/src/gateway.rs               # Team Gateway 生命周期
desktop-v2/src-tauri/src/timeline.rs              # Timeline Tauri bridge
desktop-v2/src-tauri/src/persistence.rs           # checkpoint / journal / recovery
desktop-v2/src-tauri/src/platform/mod.rs           # narrow OS adapters
desktop-v2/src-tauri/crates/timeline-core/         # authoritative edit model
src/script_organizer/media_identity.py             # media_id / device binding
src/script_organizer/desktop_runtime.py            # Desktop Host-local adapters
src/script_organizer/fcpxml_exporter.py            # delivery semantics
web/                                               # independent Team Web
```

## 11. 本地与真机验收

不要求 GitHub Actions；本地 RC gate：

```bash
cd desktop-v2
npm install
npm run verify:rc
```

仍需真实设备验收：

### macOS

- Tauri build
- packaged Python/FFmpeg runtime
- real media playback
- multicam sync
- Timeline recovery
- Finder reveal
- FCPXML export / Final Cut import
- Team Web LAN second-device smoke
- codesign/notarization/update

### Windows

- Tauri build
- packaged Python/FFmpeg runtime
- WebView2 real media playback
- multicam sync，尤其 symlink/layout 行为
- Timeline recovery
- Explorer reveal
- Team Web LAN second-device smoke
- installer/update/uninstall

## 12. 不要误改

- 不恢复 `macos-app/`。
- 不新增第二套 SwiftUI/Desktop 客户端。
- 不把 Team Web 嵌回 Production project tabs。
- 不让 React 或 Python 绕过 Rust Timeline commands。
- 不用 HTML5 `dataTransfer` 冒充系统级外部文件拖拽。
- 不让自动 candidate 覆盖人工 placement。
- 不把本机绝对路径写回共享项目事实。
- 不为了 NLE 自动化破坏原始 FCPXML/multicam 结构。
