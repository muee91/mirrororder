# MirrorOrder Desktop

`desktop/` is the current Desktop development baseline on `main`.

## Start here

当前产品与开发优先级：[`../docs/product/REBUILD_2026-11-17.md`](../docs/product/REBUILD_2026-11-17.md)。真实状态见 `../docs/engineering/STATUS.md`，待办见 `../docs/engineering/BACKLOG.md`。不再以旧五步 Product Recovery 或旧 IA 当作下一轮 UI 实现目标。

P0 是**同步音视频、核对异常、分发剪辑工程**；剧本/场记/搜索/AI 可后台继续。已有多域代码应复用，不新建第二套业务/Timeline authority。

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

## Existing workspaces

目前 `素材 / 剧本 / 时间线 / 审阅` 是内部代码责任划分，不是必须让剪辑师依次完成的步骤。新媒体目录项目先显示「同步与交付」，同步期间仍可检查素材；同步完成后再以场记/剧本检索提供长期素材访问。

同步母版与创意组接不能混在同一时间线。已有 Media/Take/Slate 等 canonical 组件可以复用，权限和人工事实不能绕过业务 Core。

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
npm run test:ux-real
npm run build
cargo test --locked --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Rust validation uses `--locked` so stale or missing Cargo lockfiles fail instead of silently changing dependency resolution.

The experimental `timebase.v1` Rust adapter accepts UTF-8 FCPXML and validates XML declarations, processing instructions, CDATA placement and DOCTYPE syntax. Special-node names are limited to ASCII, while Unicode content and metadata remain supported. It never loads external DTDs and rejects non-empty internal DTD subsets, whose entities or default attributes could alter sequence metadata. Python remains the production timebase authority; these parity tests do not imply a production cutover or full XML/DTD support.

Python tests remain at repository root:

```bash
python3 -m pytest -q
```

A gate is only PASS if it actually ran successfully on the tested commit. During Product Recovery, finish a coherent functional slice before running the necessary targeted validation; do not repeatedly dispatch CI for intermediate cosmetic edits.

`npm test` includes a synthetic Assembly proposal → Python FCPXML/Premiere export regression. It requires Python 3 (`python3`, or `python` on Windows); set `MIRRORORDER_PYTHON` to use a specific interpreter. It writes only temporary synthetic assets and does not require an installed NLE.

### 真实 Host 的画布与播放闸门

从仓库根目录显式启动 Host（服务身份必须是 `mirrororder-host`）：

```bash
PYTHONPATH=src python3 script-organizer serve workspace.toml --port 8795
```

另一个终端进入 `desktop/`，按项目运行，无须改 fixture 源码：

```bash
MIRRORORDER_HOST_URL=http://127.0.0.1:8795 MIRRORORDER_UX_PROJECT_ID=project npm run check:ux-real
MIRRORORDER_HOST_URL=http://127.0.0.1:8795 MIRRORORDER_UX_PROJECT_ID=beef npm run check:ux-real
```

fixture 从 Host 工作区读取所选项目摘要。审阅分别断言 canonical 队列、实际换 Take 与 Viewer 一致、媒体 metadata 和播放时间推进；缺媒体仍会失败。退出码 `2` 表示 Host 不可用或服务身份不符（NOT RUN），`1` 表示必需项失败，`0` 表示已执行项通过。报告和截图在 `artifacts/ux-real/<run>/`，报告含 project_id。

`npm run test:ux-real` 使用 `tests/fixtures/desktop-review/` 的最小合成项目和 WebM，覆盖非空/空队列、无效导航、媒体 404 和播放停滞；CI 执行这组行为回归。它不需要真实 Host 或素材盘。

这些闸门不写真实 placement、Final Editorial Decision 或 Timeline，不替代完整五步主链、原生播放/声音与打包应用验收；未执行部分在报告中保留 NOT RUN。

## Packaged runtime staging

`src-tauri/tauri.conf.json` runs `prepare:icons && stage:runtime` before every production
build, so `tauri build` fails unless the runtime inputs are supplied. They are not stored in
this repository. `desktop/scripts/stage-runtime.mjs` requires four variables:

```bash
export MIRRORORDER_PORTABLE_PYTHON_ROOT=<self-contained CPython 3.11 tree>
export MIRRORORDER_MEDIA_TOOLS_ROOT=<dir containing bin/ffmpeg, bin/ffprobe, lib/*.dylib>
export MIRRORORDER_MEDIA_TOOLS_SOURCE=<provenance string, recorded into the manifest>
export MIRRORORDER_MEDIA_TOOLS_LICENSE=<license classification>
```

The last two are mandatory with no implicit default, and staging refuses non-macOS unless
`MIRRORORDER_ALLOW_NON_MAC_RUNTIME_STAGE` is set. Known-good inputs recorded by the last
staged build (`src-tauri/resources/mirrororder-runtime/mirrororder-runtime-manifest.json`):
CPython `3.11.15` for the interpreter, and the Homebrew `ffmpeg` arm64 formula (`8.1.2_1`,
`GPL-2.0-or-later` build, license files bundled) for the media toolchain.

```bash
npm run stage:runtime          # populate src-tauri/resources/mirrororder-*
npm run verify:macos-bundle    # check a built bundle against the manifest contract
npx tauri build                # full .app + .dmg
```

`src-tauri/resources/mirrororder-*` staging output is git-ignored and survives
`cargo clean`, so re-staging is only needed when the interpreter or FFmpeg version changes.
`ASR / embedding / vision` backends (`faster_whisper`, `mlx_whisper`, `llama-server`, `cv2`,
model weights) are **not** staged by this path; the packaged app therefore does not ship
local intelligence features until that decision is made explicit.

## Current usability acceptance

真实素材要完成导入、同步、视频/独立音频核对、多轨母版导出、目标 NLE 实际导入及可切机位验证。旧五步测试可作为回归参考，但不能阻塞最初同步工程交付。
