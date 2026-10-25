# 镜序（MirrorOrder）

镜序是面向短剧与多机位后期整理的本地优先 Production 工具。

它的核心目标不是把所有能力堆进一个 App，而是把真实后期最费时间的一条链做短、做清楚、做可靠：

```text
混乱的原始素材 + 剧本 + 可选场记
        ↓
识别真实拍摄 Take 与多机位关系
        ↓
记录 / 修正拍摄事实
        ↓
把 Take 对到正确剧本位置
        ↓
看片并做人工判断
        ↓
形成可剪的 Timeline 结构
        ↓
进入 FCP / Premiere / Resolve 或完成交付
```

产品定义与信息架构以 [`docs/app-information-architecture.md`](docs/app-information-architecture.md) 为 authority；文档索引见 [`docs/README.md`](docs/README.md)。

## 当前技术基线

仓库当前只维护 `main` 作为开发与集成线。Desktop 位于 `desktop/`：

- React / TypeScript：Production UI；
- Tauri 2 / Rust：桌面生命周期与窄平台适配；
- Rust Timeline Core：authoritative local timeline edit state；
- Python MirrorOrder Core：Workspace/Project、Review、Slate、Identity、media identity/binding、Delivery/FCPXML 等业务 authority；
- Team Web：独立轻量 Review / Collaboration surface。

AI 权限链始终是：

```text
evidence → proposal → human confirmation → authority
```

React、AI、Team Web 都不能成为第二套 Review / Editorial / Timeline truth。

## 产品入口

```text
MirrorOrder Desktop = Production
Team Web            = Review / Collaboration
```

Desktop 项目内只保留四个一级工作区：

```text
素材 / 剧本 / 时间线 / 审阅
```

它们分别回答：

- **素材**：我拿到了什么？实际拍了什么？
- **剧本**：这些 Take 对应故事哪里？哪里缺失或冲突？
- **时间线**：当前可剪结构和成片结构是什么？
- **审阅**：哪些内容需要我看片并作人工决定？

场记 / 素材库 / Take / 人物属于素材域内的 view / task；Coverage 是剧本 projection；Rough Cut / Assembly / AI editing 是 Timeline proposal；“需关注”是审阅 filter。它们不建立新的一级工作台。

新项目第一次进入默认打开 **素材 → 场记**；已有项目恢复 canonical Production 上下文。状态中心、团队审阅和设置属于全局工具；`⌘K / Ctrl+K` 是项目搜索入口，小镜是 contextual drawer。

## 核心语义边界

```text
拍摄现场发生了什么？   = Script Supervisor / Slate fact
Take 对应剧本哪里？    = Review placement / mapping
Take 最后剪不剪？      = Editorial Decision
最终剪辑结构是什么？   = Rust Timeline authority
```

这些 authority 可以互相投影证据，但不能静默互相改写。

Desktop UI 的长期实现原则是：

> **共享对象，不共享工作流。**

`TakeCard / TakeListRow`、`MediaCard`、`ScriptBlock` 等 canonical renderer 可以跨工作区复用；素材、剧本、时间线、审阅必须分别拥有自己的 orchestration、主动作和写权限。禁止再用一个大型 `surface/mode` Workbench 同时承担多个一级工作区。

## 当前 Product Recovery 验收

真实项目上以下五件事必须顺畅走通，才算恢复“能用”：

1. 找到一个实际 Take；
2. 看懂它的拍摄事实、机位和当前归属；
3. 把它修正到正确剧本位置；
4. 看片并完成需要的人工决定；
5. 把需要的素材 / 决定组接并导出到外部 NLE 继续剪。

历史 Swift V1 不是实现或视觉 authority，只作为最低可用性回归基线：新版核心任务不能比它更难理解、更绕或更容易丢失当前对象。

当前恢复计划见 [`docs/engineering/BACKLOG.md`](docs/engineering/BACKLOG.md)，当前事实与 CI 状态见 [`docs/engineering/STATUS.md`](docs/engineering/STATUS.md)。

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

- [`docs/app-information-architecture.md`](docs/app-information-architecture.md) — 产品定义 + 当前 IA authority。
- [`docs/engineering/STATUS.md`](docs/engineering/STATUS.md) — 当前 main / CI / Product Recovery 状态。
- [`docs/engineering/BACKLOG.md`](docs/engineering/BACKLOG.md) — 当前 P0 执行计划。
- [`docs/engineering/INVARIANTS.md`](docs/engineering/INVARIANTS.md) — 长期工程硬约束。
- [`docs/ux-principles.md`](docs/ux-principles.md) — UX 纪律。
- [`docs/design-system-v2.md`](docs/design-system-v2.md) — 设计与 canonical object authority。
- [`docs/README.md`](docs/README.md) — 其余领域/架构文档索引。
- [`AGENTS.md`](AGENTS.md) — Agent 接手约束。
- [`desktop/README.md`](desktop/README.md) — Desktop 工程入口。

## 许可

本仓库源码采用 **Apache License 2.0**（全文见 [`LICENSE`](LICENSE)）。

分发打包版本时需要注意（结论待法务复核，不要当作已确认）：

- 随包媒体工具链是 **FFmpeg GPL-2.0-or-later** 构建，分发时须附带其许可证与源码获取途径；`desktop/scripts/runtime-tools.mjs` 已把 `--enable-nonfree` 作为拒绝条件。
- `vendor/multicam-audio-sync/` 的第一方实现参考了三个外部仓库的算法思路，upstream 许可证与版本记录尚缺，属于发布前必须补齐的溯源项。
- 剪映 / CapCut draft 的读写是**无官方规范的逆向兼容层**：上游版本变动即失效，且第三方代码的 MIT/Apache 许可证只覆盖代码本身，不构成对厂商加密措施的反规避授权。该通道是否对外提供，需要单独的产品与法务决策。
