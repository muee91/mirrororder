# 镜序（MirrorOrder）

镜序是可在不同短剧项目反复使用的多机位后期准备与检索工具。

**先对齐音视频并分发多轨同步母版和可切机位的剪辑工程；再后台关联场记、剧本、实际对白、演员与镜头语义，供剪辑中随时检索。**

```text
原始视频 + 独立录音
→ 智能多机位同步 + 人工核对异常
→ 多轨同步母版 / 各剪辑软件多机位工程
→ 剪辑师开工，同时镜序后台分析与归集素材
→ 按实际拍摄顺序、剧本顺序、演员、对白定位视频和录音
```

当前产品唯一权威是 [`docs/product/REBUILD_2026-11-17.md`](docs/product/REBUILD_2026-11-17.md)。**旧五步 Product Recovery 不再决定开发优先级。** 已有 `素材 / 剧本 / 时间线 / 审阅` 四域只是代码组织方式，不是新项目的四个强制步骤。

## 技术组成与验收

- React / TypeScript Desktop Production UI。
- Tauri 2 / Rust 平台层 + Rust Timeline Core。
- Python Core：媒体身份、同步、Slate、Review、Identity、ASR、NLE 交付。
- Team Web 是独立协作表面。AI 只提供证据/候选，不得静默修改人工事实和已分发同步母版。

目标剪辑软件是 DaVinci Resolve、Premiere Pro、Final Cut Pro 和国内剪映专业版（Windows/macOS）。XML 可导入不代表原生多机位可切换；四软件均须实机验收。当前能力与缺口见 [`docs/engineering/STATUS.md`](docs/engineering/STATUS.md)。

## 快速开发

Python core（需要 Python 3.11+；macOS 自带的 `python` 不存在，请用 `python3`）：

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -e ".[dev]"        # 可选：".[dev,asr,local-intelligence,capcut]"
```

未做 editable 安装时，用仓库根的 `./script-organizer` 包装脚本即可，它自己把 `src/` 加进路径。

Desktop（需要 Node 22+ 与 Rust stable）：

```bash
cd desktop
npm ci
npm run dev
```

Production Host 默认只监听本机 `127.0.0.1:8765`：

```bash
./script-organizer serve <workspace> --port 8765
```

需要局域网直连时才显式绑定（审阅写入仍只接受本机；Team Web 协作请走下面的 Gateway）：

```bash
./script-organizer serve <workspace> --host 0.0.0.0 --port 8765
```

Team Gateway 默认只监听本机 `127.0.0.1:8766`，开局域网必须显式绑定，
首次访问时用终端打印的配对码完成配对，配对失败会按来源限速：

```bash
./script-organizer gateway workspace.toml --host 0.0.0.0 --port 8766
```

## 验证

```bash
python3 scripts/check_python.py
python3 scripts/check_fast.py
python3 scripts/check_full.py
```

只有实际成功的目标 commit/run 可以写 PASS。CI red 需要修复，但测试绿灯不能替代真实产品可用性验收。

## 源码仓库与生产数据

源码仓库只跟踪空 `projects/.gitkeep`；真实 `projects/*`、媒体输入、cache/output、review/tasks/locks、设备绝对路径和 secrets 不进入源码 Git。

```text
clip_id  = 项目/FCPXML 中的一次 occurrence
media_id = 与设备路径无关的物理媒体身份
```

设备绝对路径只属于当前设备 media binding，不进入跨设备共享项目事实。同步语义见 [`docs/architecture/sync-model.md`](docs/architecture/sync-model.md)，仓库/工作区边界见 [`docs/architecture/repository-layout.md`](docs/architecture/repository-layout.md)。

## 关键文档

- [`docs/product/REBUILD_2026-11-17.md`](docs/product/REBUILD_2026-11-17.md)：唯一产品定义。
- [`docs/engineering/STATUS.md`](docs/engineering/STATUS.md)：当前已验证状态。
- [`docs/engineering/BACKLOG.md`](docs/engineering/BACKLOG.md)：唯一执行顺序。
- [`docs/engineering/INVARIANTS.md`](docs/engineering/INVARIANTS.md)：硬约束。
- [`docs/README.md`](docs/README.md)：领域/架构索引。
- [`docs/architecture/repository-layout.md`](docs/architecture/repository-layout.md)：源码与本机数据。
- [`docs/architecture/sync-model.md`](docs/architecture/sync-model.md)：跨机媒体身份与路径。
- [`AGENTS.md`](AGENTS.md)：Agent 接手约束。
- [`desktop/README.md`](desktop/README.md)：Desktop 工程入口。

## 许可

本仓库源码采用 **Apache License 2.0**（全文见 [`LICENSE`](LICENSE)）。

分发打包版本时需要注意（结论待法务复核，不要当作已确认）：

- 随包媒体工具链是 **FFmpeg GPL-2.0-or-later** 构建，分发时须附带其许可证与源码获取途径；`desktop/scripts/runtime-tools.mjs` 已把 `--enable-nonfree` 作为拒绝条件。
- `vendor/multicam-audio-sync/` 的第一方实现参考了三个外部仓库的算法思路，upstream 许可证与版本记录尚缺，属于发布前必须补齐的溯源项。
- 剪映 / CapCut draft 的读写是**无官方规范的逆向兼容层**：上游版本变动即失效，且第三方代码的 MIT/Apache 许可证只覆盖代码本身，不构成对厂商加密措施的反规避授权。该通道是否对外提供，需要单独的产品与法务决策。
