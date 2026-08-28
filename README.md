# 镜序（MirrorOrder）

镜序是面向短剧、多机位拍摄与后期协作的本地优先 Production 工具。它把素材、剧本、场记、人物身份、人工审阅、粗剪提案、时间线编辑和交付串成一套可追踪工作流。

当前产品与文档 authority 从 [`docs/README.md`](docs/README.md) 开始阅读；中文产品总览见 [`项目介绍.md`](项目介绍.md)。

## 当前开发基线

`main` 是开发基线，Desktop 客户端位于 `desktop/`：

- React / TypeScript：Production UI；
- Tauri 2 / Rust：桌面生命周期和窄平台适配；
- Rust Timeline Core：本机 authoritative timeline edit state；
- Python MirrorOrder Core：项目、Review、Slate、Identity、Assistant、媒体身份和 FCPXML 等业务权威；
- Team Web：独立轻量 Review / Collaboration surface。

机器可读基线：

- `desktop/development-baseline.json`
- `docs/desktop-development-baseline.md`

产品入口与默认页以 `docs/app-information-architecture.md` 为准。

## 产品入口

打开项目后，Production 只保留四个一级制作区：

```text
素材：场记 / 素材库 / Take / 人物
剧本：剧本 / 覆盖
剪辑：粗剪 / 组接 / 时间线 / 交付
审阅：看片 / 待处理 / 概览
```

新项目第一次进入默认打开 **素材 → 场记**；已有项目恢复上次 Production 页面。

全局工具位于项目导航之外：

- 状态中心：统一后台任务与失败/重试/近期完成；
- 团队审阅：Team Web 协作入口；
- 设置：团队审阅偏好、本地模型、外部/自定义模型连接、成员权限与高级诊断。

项目语义搜索使用 `⌘K / Ctrl+K`；小镜是右侧 contextual drawer，不是独立页面。模型 Provider / Base URL / API Key 属于全局设置，不属于小镜。

## 权威边界

```text
Python Core
  ├─ workspace / project lifecycle
  ├─ Review placement
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

人工映射、场记事实和最终剪辑判断必须分开。统一 AI 权限链是：

```text
evidence → proposal → human confirmation → authority
```

AI、Audit、语义检索或 Team Web Individual Opinion 都不能绕过人工确认成为 Final Editorial Decision、Review placement 或 Timeline authority。

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

该命令应串联 TypeScript、Vitest、Vite、Cargo 与 Python 检查。缺少必要工具时必须明确失败；没有实际执行过的 gate 不得写成“已通过”。

## Production Host / Team Gateway

Production Host 默认使用本机 `8765`：

```bash
python -m script_organizer.cli serve <workspace> --local-only --port 8765
```

Team Web 使用独立 Gateway，默认 `8766`：

```bash
python -m script_organizer.cli gateway workspace.toml --port 8766
```

Production Host 与 Team Gateway 是两套独立生命周期。健康状态必须验证 MirrorOrder service identity，不能只因为某端口可连接就认为服务正确。

## 本机素材身份

```text
clip_id  = 媒体在项目 / FCPXML 中的一次 occurrence
media_id = 物理媒体文件身份，与磁盘路径无关
```

每台设备只保存自己的媒体根目录和 media binding。本机绝对路径不写回共享 workspace，也不进入 Review authority。

设备状态目录：

- macOS：`~/Library/Application Support/MirrorOrder`
- Windows：`%APPDATA%/MirrorOrder`
- Linux：`$XDG_CONFIG_HOME/mirrororder`，缺省为 `~/.config/mirrororder`

## Timeline Core

`desktop/src-tauri/crates/timeline-core` 提供整数帧时间线模型、deterministic commands、Undo/Redo、checkpoint、journal 和 crash recovery。

Timeline authoritative state 由 Rust 持有；React 只发 commands 和读取 snapshots。Python proposal 只有在人工确认后才可转换成 Timeline commands。

## 重功能隔离

Runtime packaging、自动配乐、重媒体处理、新 NLE adapter、模型 runtime infrastructure 和实验自动化默认先在独立 branch/worktree 验证，再按 typed contract、authority、failure isolation 和 native smoke gate 决定是否并回主线。

## 文档入口

- [`docs/README.md`](docs/README.md)：文档索引与 authority 层级；
- [`docs/app-information-architecture.md`](docs/app-information-architecture.md)：当前产品 IA；
- [`docs/ux-principles.md`](docs/ux-principles.md)：当前 UX 原则；
- [`AGENTS.md`](AGENTS.md)：工程接手与自动化修改约束；
- [`desktop/README.md`](desktop/README.md)：Desktop 工程基线；
- [`DESKTOP_BRIDGE.md`](DESKTOP_BRIDGE.md)：Desktop / Python Core / Team Web / Timeline 边界；
- [`SYNC_MODEL.md`](SYNC_MODEL.md)：跨设备同步与本机素材边界；
- [`AUTOMATION_PIPELINE.md`](AUTOMATION_PIPELINE.md)：自动整理与 AI 权限边界。
