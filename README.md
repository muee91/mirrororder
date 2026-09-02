# 镜序（MirrorOrder）

镜序是面向短剧、多机位拍摄与后期协作的本地优先 Production 工具。它把素材、剧本、场记、人物身份、人工审阅、粗剪提案、时间线编辑和交付串成一套可追踪工作流。

文档 authority 从 [`docs/README.md`](docs/README.md) 开始。

## 当前技术基线

仓库当前只维护 `main` 作为开发与集成线。Desktop 位于 `desktop/`：

- React / TypeScript：Production UI；
- Tauri 2 / Rust：桌面生命周期与窄平台适配；
- Rust Timeline Core：authoritative local timeline edit state；
- Python MirrorOrder Core：Workspace/Project、Review、Slate、Identity、Assistant、media identity/binding、Delivery/FCPXML 等业务 authority；
- Team Web：独立轻量 Review / Collaboration surface。

AI 权限链始终是：

```text
evidence → proposal → human confirmation → authority
```

React/AI/Team Web 都不能成为第二套 Review/Editorial/Timeline truth。

## 产品入口

```text
MirrorOrder Desktop = Production
Team Web            = Review / Collaboration
```

项目 Production 保持四个一级制作区：

```text
素材：场记 / 素材库 / Take / 人物
剧本：剧本 / 覆盖
剪辑：粗剪 / 组接 / 时间线 / 交付
审阅：看片 / 待处理 / 概览
```

新项目第一次进入默认打开 **素材 → 场记**；已有项目按当前 IA 恢复 Production 页面。状态中心、团队审阅和设置属于全局工具；`⌘K / Ctrl+K` 是项目语义搜索，小镜是 contextual drawer。

Team Web 可以做团队看片、Individual Opinion、协作审阅和受限项目投影，但不能修改本机素材目录、电子场记、Timeline authority 或 Final Editorial Decision。

产品入口以 [`docs/app-information-architecture.md`](docs/app-information-architecture.md) 为准，UX 以 [`docs/ux-principles.md`](docs/ux-principles.md) 为准。

## 核心语义边界

```text
Take 对应剧本哪里？ = Review placement / mapping
Take 最后剪不剪？   = Editorial Decision
```

Script Supervisor / 电子场记记录拍摄现场与素材附件事实；ReviewStore 管人工剧本 placement；Editorial Decision 管最终人工剪辑判断。三者可以互相投影证据，但不能静默互相改写 authority。

自动分析、语义检索、Audit、小镜和 rough-cut 都只能产生 evidence / proposal；只有显式人工确认才能改变相应 authority。

## 快速开发

```bash
cd desktop
npm install
npm run dev
```

Production Host 默认本机 `8765`：

```bash
python -m script_organizer.cli serve <workspace> --local-only --port 8765
```

Team Gateway 默认 `8766`：

```bash
python -m script_organizer.cli gateway workspace.toml --port 8766
```

两者是独立生命周期；ready 必须验证 MirrorOrder service identity，不能只检查端口可连接。

## 验证

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

只有实际成功的目标 commit/run 可以写 PASS。GitHub Actions 是独立验证信号；CI red 需要修复，但旧 CI、旧 verification 或源码审阅不能替代当前执行结果。

当前状态见 [`docs/engineering/STATUS.md`](docs/engineering/STATUS.md)。

## 源码仓库与生产数据

源码仓库只跟踪空 `projects/.gitkeep`；真实 `projects/*`、媒体输入、cache/output、review/tasks/locks、设备绝对路径和 secrets 不进入源码 Git。

```text
clip_id  = 项目/FCPXML 中的一次 occurrence
media_id = 与设备路径无关的物理媒体身份
```

设备绝对路径只属于当前设备 media binding，不应进入跨设备共享项目事实。

生产团队的跨设备同步语义见 [`docs/architecture/sync-model.md`](docs/architecture/sync-model.md)，仓库/工作区文件位置见 [`docs/architecture/repository-layout.md`](docs/architecture/repository-layout.md)。测试数据只使用 `tests/fixtures/` 中最小、合成、脱敏、可重建 fixture。

## 关键文档

- [`docs/README.md`](docs/README.md) — 文档索引与 authority。
- [`docs/engineering/README.md`](docs/engineering/README.md) — main-only 工程控制层与 gate 规则。
- [`docs/app-information-architecture.md`](docs/app-information-architecture.md) — 当前产品 IA。
- [`docs/ux-principles.md`](docs/ux-principles.md) — 当前 UX 原则。
- [`docs/design-system-v2.md`](docs/design-system-v2.md) — 当前设计系统。
- [`docs/architecture/README.md`](docs/architecture/README.md) — 跨层架构索引。
- [`AGENTS.md`](AGENTS.md) — Agent 修改仓库时的硬约束。
- [`desktop/README.md`](desktop/README.md) — Desktop 工程入口。
