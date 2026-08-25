# 镜序（MirrorOrder）

镜序是面向短剧、多机位拍摄与后期协作的本地优先制作工具。它把素材、剧本、场记、人物身份、人工审阅、粗剪提案、时间线编辑和交付串成一套可追踪工作流。

## 当前主客户端

`desktop-v2/` 是唯一 Desktop 主实现：

- React / TypeScript：Production UI
- Tauri 2 / Rust：桌面生命周期、平台能力、Timeline bridge
- Rust Timeline Core：本机 authoritative timeline edit state
- Python MirrorOrder Core：项目、Review、Slate、Identity、Assistant、AI proposal、媒体身份、FCPXML 等业务权威
- Team Web：独立轻量 review / projection surface

旧 SwiftUI `macos-app/` 已按项目 owner 的 cutover 决策从主线删除，不再作为回退客户端维护。

## 权威边界

以下边界保持冻结：

```text
Python Core
  ├─ workspace / project lifecycle
  ├─ Review / Best / Keep / Reject
  ├─ Script Supervisor / Slate
  ├─ Identity / role confirmation
  ├─ Assistant / AI proposals
  ├─ media identity / device binding semantics
  └─ FCPXML delivery semantics

Rust Timeline Core
  └─ authoritative local timeline state + deterministic edit commands

React / TypeScript
  └─ production UI; not a second source of truth
```

AI 的权限链始终是：

```text
evidence → proposal → human confirmation → authority
```

AI proposal 不会自动成为 authoritative edit。

## Desktop v2 功能面

当前主工作区包括：

- 项目创建 / 打开 / 删除
- 素材 / 剧本归集
- episode-only placement
- Take / angle / clip-level 景别
- candidate evidence
- 场记快速录入与 revision-safe 保存
- 人物 / 说话人 identity 人工确认
- 小镜 Assistant + 模型连接
- 本机素材绑定与重定位
- 设置 / 状态 / 本地运行时
- Rust Timeline Core + persistence / journal / recovery
- Source / Program Monitor proxy workbench
- J / K / L、frame step、split / trim / move / ripple delete 等编辑入口
- Team Web Gateway 独立工作区
- FCPXML delivery + macOS Final Cut adapter

## 快速开发

```bash
cd desktop-v2
npm install
npm run dev
```

本地 RC 验证：

```bash
cd desktop-v2
npm run verify:rc
```

该命令会串联现有的 TypeScript、Vitest、Vite、Cargo 与 Python 检查；缺少 Rust 等必要工具时应明确失败，而不是跳过后声称通过。

## Production Host

Desktop Production Host 默认使用本机 `8765`：

```bash
python -m script_organizer.cli serve <workspace> --local-only --port 8765
```

Desktop 自己负责 Host 进程生命周期。Host 真正监听端口后才视为启动成功。

## Team Web Gateway

团队协作使用独立 Gateway，默认 `8766`，不会与 Production Host 共用进程状态：

```bash
python -m script_organizer.cli gateway workspace.toml --port 8766
```

支持：

- 多 workspace
- local-only / LAN
- pairing code
- trusted LAN
- workspace_id / project_id 路由

LAN Gateway 不应暴露到公网。

## 本机素材身份

镜序区分：

```text
clip_id  = 媒体在项目 / FCPXML 中的 occurrence
media_id = 物理媒体文件身份，与磁盘路径无关
```

每台设备只保存自己的媒体根目录和 media binding。本机路径不写回共享 workspace，也不进入 Review authority。

设备状态目录遵循平台规则：

- macOS：`~/Library/Application Support/MirrorOrder`
- Windows：`%APPDATA%/MirrorOrder`
- Linux：`$XDG_CONFIG_HOME/mirrororder`，缺省为 `~/.config/mirrororder`

## Timeline Core

`desktop-v2/src-tauri/crates/timeline-core` 提供整数帧时间线模型和命令：

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

Tauri persistence 层负责 checkpoint、append-only journal 和 crash recovery。React 不直接保存 authoritative timeline JSON。

## Runtime Packaging

安装包 runtime 是独立重功能 workstream：

```text
feat/desktop-v2-runtime-packaging
```

目标是让发行版显式携带：

- MirrorOrder Python Core
- Python 3.11+
- numpy / pandas / scipy
- ffmpeg / ffprobe
- first-party multicam sync engine

packaged 模式不允许静默 fallback 到系统 Python 或系统 FFmpeg。

详见：

- `docs/desktop-v2-runtime-packaging.md`
- `desktop-v2/phase7-parity.json`

## 仍需真机验证的发布门禁

旧 SwiftUI 已删除，但以下 gate **仍然必须作为 Desktop v2 发布质量门禁**，不能因为 cutover 而标记为已通过：

### macOS

- `cargo tauri build`
- packaged Python Host
- 真实素材播放
- multicam sync
- Timeline recovery
- Finder reveal
- FCPXML export
- Final Cut Pro import
- Team Web LAN 第二设备测试
- codesign / bundle / updater

### Windows

- `cargo tauri build`
- packaged Python Host
- WebView2 真实素材播放
- multicam sync
- Timeline recovery
- Explorer reveal
- Team Web LAN 第二设备测试
- installer / updater

GitHub Actions 不是这些 gate 的必要条件；可以在真实开发机上用本地命令完成验证并记录结果。

## 重功能隔离原则

主 Production workbench 不作为功能堆积入口。

以下能力默认先使用独立 module / branch / worktree：

- runtime packaging
- 重媒体处理
- 新 NLE adapters
- model-runtime infrastructure
- 实验自动化引擎

只有 contract、ownership boundary、failure isolation 和 native smoke gate 都清楚后，才进入主产品工作区。

## 主要文档

- `desktop-v2/README.md` — Desktop v2 工程说明
- `desktop-v2/phase7-parity.json` — Phase 7 / release gate 机器可读状态
- `docs/desktop-v2-phase7-cutover.md` — Desktop cutover 说明
- `docs/desktop-v2-tauri-plan.md` — Tauri 迁移设计
- `SYNC_MODEL.md` — 多设备同步边界
- `DESKTOP_BRIDGE.md` — Desktop / Host bridge 背景与接口约束

## 当前状态

`main` 以 Desktop v2 为唯一 Desktop 产品主线。Python Core 与 Team Web 继续保留各自既有职责；旧 SwiftUI 客户端不再维护。
