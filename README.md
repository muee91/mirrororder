# 镜序（MirrorOrder）

镜序是面向短剧、多机位拍摄与后期协作的本地优先制作工具。它把素材、剧本、场记、人物身份、人工审阅、粗剪提案、时间线编辑和交付串成一套可追踪工作流。

## 当前开发基线

`main` 是当前开发基线，Desktop 客户端位于 `desktop/`：

- React / TypeScript：Production UI
- Tauri 2 / Rust：桌面生命周期、平台能力、Timeline bridge
- Rust Timeline Core：本机 authoritative timeline edit state
- Python MirrorOrder Core：项目、Review、Slate、Identity、Assistant、AI proposal、媒体身份、FCPXML 等业务权威
- Team Web：独立轻量 review / projection surface

机器可读基线见：

- `desktop/development-baseline.json`
- `docs/desktop-development-baseline.md`

## 权威边界

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

AI 权限链始终是：

```text
evidence → proposal → human confirmation → authority
```

## 当前功能面

- 项目创建 / 打开 / 删除
- 素材 / 剧本归集与 candidate evidence
- episode-only placement
- Take / angle / clip-level 景别
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
cd desktop
npm install
npm run dev
```

本地 RC 验证：

```bash
cd desktop
npm run verify:rc
```

该命令会串联 TypeScript、Vitest、Vite、Cargo 与 Python 检查；缺少必要工具时应明确失败，而不是跳过后声称通过。

## Production Host

Desktop Production Host 默认使用本机 `8765`：

```bash
python -m script_organizer.cli serve <workspace> --local-only --port 8765
```

## Team Web Gateway

团队协作使用独立 Gateway，默认 `8766`：

```bash
python -m script_organizer.cli gateway workspace.toml --port 8766
```

支持多 workspace、local-only / LAN、pairing code、trusted LAN 和 workspace/project 路由。LAN Gateway 不应暴露到公网。

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

`desktop/src-tauri/crates/timeline-core` 提供整数帧时间线模型和命令：Insert、Overwrite、Move、Split、Trim、RippleDelete、Disable、MulticamSwitch、SetMarker，以及 Undo/Redo。

Timeline authoritative state 由 Rust 持有；React 只发 commands 和读取 snapshots。Python proposal 只有在人工确认后才可转换成 Timeline commands。

## 重功能隔离

当前独立 workstream：

- `work/runtime-packaging`：portable Python、ffmpeg/ffprobe、Tauri resources 与发行运行时。
- `work/auto-score`：自动配乐、音乐分析与生成。

重媒体处理、新 NLE adapter、模型 runtime infrastructure、实验自动化引擎默认先独立 branch/worktree，不直接堆进 Production project tabs。

## 进一步文档

- `AGENTS.md`：工程接手约束
- `DESKTOP_BRIDGE.md`：Desktop / Python Core / Team Web / Timeline 边界
- `SYNC_MODEL.md`：跨设备同步与本机素材边界
- `AUTOMATION_PIPELINE.md`：自动整理与 AI 权限边界
- `docs/desktop-development-baseline.md`：当前 Desktop 开发基线与发布门禁
