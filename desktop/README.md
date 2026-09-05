# MirrorOrder Desktop

`desktop/` is the current Desktop development baseline on `main`.

## Start here

Before changing Production UI, start from the repository documentation index, then read the current authorities:

- `../docs/README.md`
- `../docs/app-information-architecture.md`
- `../docs/engineering/STATUS.md`
- `../docs/engineering/BACKLOG.md`
- `../docs/engineering/INVARIANTS.md`
- `../docs/ux-principles.md`
- `../docs/design-system-v2.md`
- `../docs/architecture/desktop-bridge.md`
- `../docs/architecture/repository-layout.md`

Current P0 is **Desktop Product Recovery**. Do not add product surfaces before the real five-step workflow is usable.

## Architecture

- React / TypeScript — Production UI and interaction orchestration.
- Tauri 2 / Rust — desktop lifecycle and narrow platform adapters.
- Rust Timeline Core — authoritative local timeline edit state.
- Python MirrorOrder Core — project / Review / Slate / Identity / media / Delivery business authority.
- Team Web — separate lightweight Review / Collaboration surface.

Desktop code is organized by responsibility:

```text
src/api/                 typed localhost/native clients and DTOs
src/app/                 application shell and global navigation
src/features/<domain>/   workspace UI, hooks, styles and colocated tests
src-tauri/src/            narrow platform adapters and lifecycle managers
src-tauri/crates/         independently testable Rust cores such as timeline-core
scripts/                  build, staging, smoke and release tooling
src-tauri/resources/      generated/packaged resource targets
```

Do not move product business authority into Tauri adapters or React state. Generated runtime/media-tool contents are build outputs, not hand-maintained source.

## Product workspaces

Desktop 项目内只有四个一级工作区：

```text
素材 / 剧本 / 时间线 / 审阅
```

- **素材**：Media / Take / Person / Slate。场记、素材库、Take、人物是同一 Material workspace 的 view/task；本机素材 relink 是 contextual tool。
- **剧本**：Script / ScriptBlock 是 Primary Canvas；Coverage 是同一 Script 上下文的 projection；Review placement / mapping 修正以这里为主家。
- **时间线**：唯一 authoritative local editor；Rough Cut / Assembly / AI editing 只能提供 proposal/preview，人工确认后转换为 Timeline commands；Delivery/export 是后续 flow。
- **审阅**：Viewer + 当前 Take + 必要剧本上下文 + 人工 Editorial Decision；“需关注”只是 filter/queue。不要在这里复制场记、relink、人物治理、完整 placement editor 或 Timeline edit。

核心实现原则：

> **共享对象，不共享工作流。**

允许复用 canonical `TakeCard / TakeListRow / MediaCard / ScriptBlock / SlateRow / PersonRow / Viewer primitives`。不允许通过一个 `surface/mode` Workbench 把多个一级 workspace 的 loader、toolbar、selection、drawer 和写权限重新合并。

跨 workspace 跳转应保留当前 Take / media / ScriptBlock / Timeline source 等 selection intent，但 selection context 不成为业务 truth。

## Global surfaces

以下不属于项目四工作区：

- 状态中心 — durable tasks、失败、重试与完成记录的唯一全局控制面；
- 团队审阅 — Team Web collaboration surface；
- 设置 — 本机 runtime、连接、协作访问和高级诊断。

`⌘K / Ctrl+K` 是项目搜索入口，小镜是 contextual drawer。普通 GET、页面切换、对象选择、Inspector 展开不得启动全盘扫描、长 FFmpeg、模型下载或整项目索引；重工作必须显式提交 durable task。

## Authority boundary

- ReviewStore owns human script placement / mapping.
- Script Supervisor / Slate owns shooting/production facts.
- Final Editorial Decision is separate from Review placement.
- Python Core owns workspace/project lifecycle and non-Timeline business authority.
- Rust Timeline Core owns deterministic edit state, validation, undo/redo, persistence and recovery.
- React/TypeScript owns interaction, not a second truth.
- Team Web never receives device paths, local model secrets, Timeline authority or Final Editorial Decision authority.
- Video/proxy frames are not transported through Tauri JSON/Base64 IPC.

AI authority remains:

```text
evidence → proposal → human confirmation → authority
```

## Local validation

```bash
npm install
npm run verify:rc
```

Targeted gates when locating failures:

```bash
npm run check:baseline
npm run check:ui-authority
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Python tests remain at repository root:

```bash
python -m pytest -q
```

A gate is only PASS if it actually ran successfully on the tested commit. During Product Recovery, finish a coherent functional slice before running the necessary targeted validation; do not repeatedly dispatch CI for intermediate cosmetic edits.

## Current usability acceptance

P0 is not closed until a real project can smoothly complete:

```text
找到 Take
→ 理解拍摄事实 / 机位 / 当前归属
→ 修正剧本 placement
→ 看片并作人工决定
→ 带入 Timeline 继续剪
```

Swift V1 is only a minimum usability regression baseline, not a visual or technical implementation target.
