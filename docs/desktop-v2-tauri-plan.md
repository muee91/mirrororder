# MirrorOrder Desktop v2 跨平台重构计划

> 分支：`feat/desktop-v2-tauri`
>
> 冻结基线：`6ab56e6800021bf3427872bc42de4aced47a82ac`
>
> 目标：在不重写 Python Core、不破坏 PR #7 粗场记语义的前提下，将桌面产品从 SwiftUI 主 UI 逐步迁移为 macOS / Windows 共用的 Tauri 2 + React/TypeScript，并为后续剪辑模块建立独立 Rust Timeline Core。

## 1. 长期架构

```text
React / TypeScript Desktop UI
  素材 / 剧本 / 场记 / 人物 / 小镜 / 剪辑
                │
                ├──────── typed localhost API ────────┐
                │                                      │
                ▼                                      ▼
        Tauri 2 Desktop Host                  MirrorOrder Python Core
        Rust native bridge                    AI / Script / Slate / Review
        lifecycle / dialogs                   Identity / Music / Rough Cut
        filesystem / updates                  FCPXML / Media analysis
                │                                      │
                └──────────────┬───────────────────────┘
                               │
                        Media / Editing layer
                 FFmpeg + proxy + Rust Timeline Core
                               │
                    ┌──────────┴──────────┐
                    │                     │
               macOS adapter        Windows adapter
               Finder / FCP          Explorer / future NLE
```

### 责任边界

- **Python Core**：继续作为产品业务和 AI 权威层，不迁移现有 review、rough placement、script supervisor、identity、assistant、music、rough cut、FCPXML 逻辑到 Rust/TS。
- **React/TypeScript**：负责桌面交互、工作台布局、素材卡、剧本、场记、人物、小镜展示、时间线 UI。
- **Tauri/Rust Host**：只负责桌面生命周期、sidecar/Host 管理、文件系统、系统选择器、窗口、更新、平台适配和后续 Timeline Core。
- **Team Web**：保持轻量审阅端。小镜由 App/Host 计算，Web 只投影 Host 结果，不在浏览器遍历整个项目重新计算。
- **媒体数据**：视频帧、proxy、缩略图、波形不得通过 JSON/Base64 Tauri IPC 搬运；使用本地媒体 endpoint、文件句柄或后续 native texture path。

## 2. 必须保持的产品不变量

重构不能改变以下语义：

1. 粗手写场记是一等生产输入。
2. `episode-only` placement 是合法完成状态，不要求补场/镜/对白。
3. 景别属于 angle/clip，不属于 Take。
4. AI 只能建议；人工确认后才写 review/editorial authority。
5. `review.json`、自动决策、script supervisor、人类审计链保持分离。
6. 人工场记、人工景别、人工备注优先于自动投影。
7. 小镜不得直接绕过 proposal/confirmation 修改审核权威。
8. Team Web 默认第一集快速可用；“全集”必须明确选择。
9. macOS FCP 专用能力作为平台 adapter，不阻止 Windows 使用素材整理、AI、场记、剪辑和通用导出。

## 3. 目录目标

第一阶段建议新增：

```text
desktop-v2/
  package.json
  vite.config.ts
  tsconfig.json
  src/
    app/
    api/
    components/
    features/
      projects/
      material-script/
      slate/
      identity/
      assistant/
      editor/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/
      main.rs
      host.rs
      platform/
        mod.rs
        macos.rs
        windows.rs
    crates/
      timeline-core/

src/script_organizer/        # 继续复用，不迁移
web/                         # Team Web 继续存在
macos-app/                   # 迁移期保留，功能追平后再退役
```

如果初始化 Tauri 2 后官方模板目录略有不同，可按模板调整，但上述职责边界不变。

## 4. API 策略

保留现有 Host HTTP API，而不是把 Python 业务改造成大量 Tauri commands。

Desktop v2 使用 typed API client 调用现有：

- workspace / projects
- review-model
- review write
- rough-placement
- script-supervisor
- identities
- assistant
- tasks
- media/proxy

Tauri commands 仅用于：

- 启停 Python Host
- 选择文件/目录
- Finder / Explorer reveal
- 系统权限和持久目录授权
- 原生窗口/菜单/更新
- 后续 native playback / Timeline engine bridge

## 5. 小镜边界

### App / Host

负责：

- 项目级分析
- 优先级排序
- 模型调用
- rough-placement parser
- proposal 生成
- assistant payload 持久化

### Team Web

只负责：

- 一个轻量小镜入口
- 用户点击后读取 `/assistant`
- 展示 Host 已生成的 summary/items
- 定位 Take / 打开人工归集

禁止 Team Web：

- 遍历所有 Take 构建 assistant queue
- 模型配置
- Agent 规划
- 语义模型配置
- 独立 assistant `/state` 轮询

## 6. 剪辑模块目标

### Timeline Core 必须独立于 React

Rust 数据模型第一版：

```text
Project
Sequence
Track
Clip
Source
Marker
MulticamGroup
Transition
Command
History
```

基础 deterministic commands：

```text
insert
overwrite
move
split
trim
ripple_delete
disable
multicam_switch
set_marker
undo
redo
```

人工 UI 和小镜自动剪辑最终都产生同一套 Timeline Command。

Python AI 只能生成 edit proposal，例如 trim/remove/multicam switch；用户确认后由 Timeline Core apply。

### 第一版性能目标

- proxy-first
- 1080p 预览
- 24/25/30fps
- 2–4 视频轨起步
- 多音频轨
- waveform
- frame-accurate trim
- J/K/L 和 frame step 后续进入 native playback gate
- 多机位 A/B/C switch
- 自动粗剪生成 timeline
- FCPXML / OTIO 等导出桥接

不在第一版承诺 8K RAW、多路原码实时调色或 Resolve/FCP 级 GPU 特效。

## 7. 媒体架构

导入后后台准备：

```text
original
  ├─ metadata
  ├─ thumbnails
  ├─ waveform
  ├─ transcript
  ├─ face/speaker evidence
  └─ edit proxy
```

素材/剧本工作台初期可以继续使用 WebView `<video>` + proxy。

真正 Program Monitor 在剪辑模块达到多轨、逐帧、J/K/L 阶段后升级为 native media engine。A/V clock 由 native audio/media layer 决定，不由 React timer 驱动。

## 8. 迁移阶段

### Phase 0 — 冻结旧架构行为

基线：`6ab56e6`

- PR #7 的粗场记语义作为迁移契约。
- SwiftUI App 暂不删除。
- Team Web 保持 Host 投影模式。

### Phase 1 — Desktop v2 可启动骨架

完成标准：

- Tauri 2 + React/TS 工程可构建。
- macOS/Windows target 配置存在。
- Tauri 能发现/启动或连接 Python Host。
- `/api/v1/ping`、workspace、project 列表可读取。
- 建 typed API client 和基础错误边界。
- 不复制 Python 业务规则。

### Phase 2 — 迁移“素材 / 剧本”

完成标准：

- 粗归集 / 精确剧本双阶段。
- episode-only drop。
- 素材卡 angle-level 景别。
- 独立置信度关系卡。
- player + Take + dialogue 同屏。
- AI候选 / 待归集 / 已归集状态。
- 大列表虚拟化。

旧 SwiftUI 对应界面继续作为回归参照。

### Phase 3 — 场记 / 人物 / 小镜

- 多机位场记迁移。
- `EP3 / 12-3-2 / 同场下一条 / 看片再定` 完整复用 Python parser。
- identity confirm / role suggestion。
- 小镜完整能力仅 Desktop App；Team Web 继续投影。

### Phase 4 — Rust Timeline Core

先测试核心，不先做重型播放器：

- serialization
- command apply
- undo/redo
- trim/split/move/ripple
- multicam switch
- timeline validation
- Python edit proposal → human confirm → Rust command bridge

### Phase 5 — 剪辑工作台

- timeline UI
- source/program monitor
- waveform
- proxy playback
- keyboard editing
- rough cut / music proposal integration

### Phase 6 — 平台完成度

macOS：

- Finder
- security-scoped media access（如仍需要）
- FCP / FCPXML adapter
- app bundle / codesign / updater

Windows：

- Explorer
- folder/file picker
- WebView2
- installer / updater
- Resolve/Premiere adapter 留扩展接口，不在首版强制完成

### Phase 7 — SwiftUI 退役

只有在 Desktop v2 对以下功能追平后才能删除旧 UI：

- project lifecycle
- material/script
- slate
- identity
- assistant
- settings/status
- media binding
- FCP integration on macOS

## 9. 测试矩阵

### 跨平台常规门禁

```text
Python        pytest
TypeScript    typecheck + unit tests
React         component/interaction tests
Rust          cargo test
API           contract tests
Timeline      deterministic state/undo tests
Web           build + syntax + browser smoke
```

### macOS 最终门禁

- `cargo tauri build`
- Python Host launch
- project open
- real media playback
- Finder/FCP integration
- codesign/bundle smoke

### Windows 最终门禁

- `cargo tauri build`
- Python Host launch
- project open
- real media playback
- Explorer/WebView2 smoke
- installer smoke

绝大多数 UI/业务变更不再依赖 Swift SDK；平台机器只承担 native integration gate。

## 10. 第一轮实现任务

新会话从这里开始，不重新讨论技术选型：

1. 检查 `feat/desktop-v2-tauri` HEAD 和本文件。
2. 盘点现有 Host 启动方式、workspace API、media endpoint 和 Web frontend 可复用部分。
3. 初始化 `desktop-v2/` 的 Tauri 2 + React + TypeScript 最小工程。
4. 先实现 `HostConnection`：ping、workspace、projects、错误状态。
5. 建 typed API model，不复制 Python review rules。
6. 做第一个可运行页面：项目库 → 项目 → 素材/剧本工作台壳。
7. Linux 可执行的 TS/Rust/Python 测试先建立；macOS/Windows 仅在需要时做平台 smoke。

## 11. 禁止事项

- 不把 Python Core 大规模重写成 Rust。
- 不把视频帧通过 Tauri JSON IPC 搬运。
- 不同时维护 macOS/Windows 两套产品业务 UI。
- 不在 React 中重新实现 review authority / rough placement parser。
- 不为了“跨平台”删除 FCP 专用能力；将其隔离为 macOS adapter。
- 不在 Desktop v2 尚未功能追平时删除 SwiftUI App。
- 不把架构迁移混回 PR #7 的产品语义提交。
