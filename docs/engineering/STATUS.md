# Engineering Status

更新时间：2026-08-30

## 当前基线

- 主线：本地 `main@eb905cee72daeab1b7ee9a93b29435bc5e0bdc79`；`origin/main@4e112efebf70159ff2d1ef91b530947e5efb7c3e`
- 稳定化基线：`fix/runtime-read-paths`
- 当前功能链：`feature/timeline-audio-ux`，基于已完成的 Timeline source/edit/delivery/audio 分支继续演进。
- 当前功能链相对本地 `main`：160 commits ahead / 0 behind；这不是允许原样进入主线的集成历史。
- GitHub Actions：当前无可用 status checks；不作为已通过 gate。
- 当前原则：源码审阅不能替代 executable validation；未执行的 gate 一律 `NOT RUN`。

## 产品就绪度

| 阶段 | 总评分 |
| --- | ---: |
| 初始评估 | 68 |
| Stage 1 — Runtime read-path safety | 70 |
| Stage 2 — Device-local model preparation durability | 72 |
| Stage 3 — Runtime installation order | 74 |
| Stage 4 — Golden production project | 76 |
| Stage 5 — Delivery artifact path normalization | 77 |
| Stage 6 — Rust Timeline authority lifecycle | 80 |
| Stage 7 — Repository tracked-data leakage guard | 81 |
| Stage 8 — Python-only source gate | 82 |
| Stage 9 — Python package boundary plan | 83 |
| Stage 10 — Integration stabilization audit | 84 |
| Stage 11 — Timeline authority UX | 85 |
| Stage 12 — Timeline Source → Program editing | 87 |
| Stage 13 — Source cursor / Mark In / Mark Out | 88 |
| Stage 14 — Authoritative Timeline → Delivery | 91 |
| Stage 15 — Timeline multicam synchronization | 92 |
| Stage 16 — Timeline audio semantics | **93** |
| Stage 17 — Audio editing UX | **源码完成；native/FCP 阻塞，不计入关闭** |

评分代表当前产品/工程就绪度判断，不替代 fast/full/native gate。

## 当前已收口的关键能力

- Media Inventory 与 Waveform 的重工作已进入 durable task；普通 GET 只读 cache/snapshot。
- Local Vision / Identity 模型准备属于 device-scope durable task，并统一进入 Status Center。
- Production Host 使用单一 `runtime_stack` 安装编排；安装失败可重试，import 不再偷偷修改全局 runtime。
- Synthetic Golden Project 固定 Script → Slate → Mapping → Review/Editorial → Coverage → Rough Cut → Assembly → Delivery / reopen 语义。
- Delivery 持久化 artifact 只保存逻辑引用；设备绝对路径仅存在于 localhost runtime response。
- Rust Timeline 以 `generation + journal revision` 作为 authority token，保护 replacement/edit/undo/redo/checkpoint，并覆盖 journal replay / reopen。
- Timeline Desktop 在 stale/authority-required 冲突时恢复最新 persisted Rust snapshot，但不自动重放失败编辑；已有 Timeline 从 Rough Cut 重建必须二次确认。
- Timeline source pool 把当前 Review 中所有可播放 angle 注册为人工可选素材，但只有 `explicit_best` 自动进入 Rough Cut Timeline；非 Best 只有用户明确 Insert/Overwrite 后才获得 Timeline authority。
- Source Monitor 支持独立 source preview、Source cursor、逐帧微调、Mark In/Out，并受 Review playable range ∩ persisted media duration 约束。
- Timeline multicam synchronization evidence 使用版本化 `multicam_sync_v1` 持久化在 Rust-owned `TimelineClip.metadata`；Program Monitor 与 Delivery 使用同一同步证据，缺失/损坏时 fail closed。
- Authoritative Timeline Delivery 从 Rust persisted snapshot 生成 FCPXML，保留 split / trim / move / Insert / Overwrite / selected angle，不从 Review 再推导另一条时间线。
- Independent A-track 使用现有 Rust Timeline audio track 和标准 commands；FCPXML 导出为 connected audio-only `asset-clip`，视频资产的 embedded audio 继续 linked 保留。
- Timeline audio delivery 已有独立 source/track/range/overlap/no-audio fail-closed contract；Delivery UI 已显示 audio track/clip 数和真实导出语义。
- Git tracked workspace/shared structured fixture 有 device-path leakage guard；ignored 用户 workspace 不参与扫描。
- `scripts/check_python.py` 可独立执行 Python compile + production contract smoke；`check_fast.py` 复用该入口。
- `PYTHON_PACKAGE_PLAN.md` 已固定 flat namespace 的目标 ownership、依赖方向、slice 顺序、临时 import facade 与 staging/package contract；尚未执行 mass move。
- `INTEGRATION_PLAN.md` 已固定综合功能链的本地 gate → squash integration worktree → 复验 → 单一主线 commit 流程。

## 已执行的局部验证证据

- Stage 14 Timeline→FCPXML converter contract：11/11 pytest PASS。
- Stage 15 Timeline sync normalizer + Stage 14 converter 组合：15/15 pytest PASS。
- Stage 15 TS synchronization core：`tsc --strict` + runtime assertions PASS。
- Stage 16 Timeline audio + Stage 14/15 converter 组合：21/21 pytest PASS。
- Stage 16 Desktop audio command core：`tsc --strict` + runtime assertions PASS。
- 上述结果都是精确子集验证，不等于整仓 gate。

## 当前未完成的代码项

当前没有待完成的 Stage 17 代码接线；`TimelineWorkbench` 已接入四个 Video/Audio Source edit 动作，Audio 仍只通过 Rust A1 authority 写入。

## 当前 P1 — Executable validation and integration

- `python scripts/check_python.py`：PASS，66 passed，1.24s。
- `python scripts/check_fast.py`：PASS，28 个 Vitest 文件/130 tests，Rust Timeline 10、Tauri timeline 5、Tauri persistence 7、Python 66，8.53s。
- `python scripts/check_full.py`：PASS，448 passed，1 个第三方 deprecation warning，125.36s。
- packaged runtime staging、`verify:rc`、Tauri macOS build、`verify:macos-bundle`：PASS。
- packaged Host/project/durable-task/cancel/restart/path-free smoke：部分 PASS；详见 `docs/verification/2026-08-29-production-readiness.md`。
- packaged 已建立 Timeline 的 checkpoint/journal reopen、stale authority UI recovery、真实 media playback、LAN/Finder smoke：NOT RUN。
- Final Cut Pro 不存在；真实媒体与 FCPXML import 全部 NOT RUN。
- 未创建 squash integration worktree；未生成新的 main commit。不能继承 feature branch 的 PASS。

## 下一 P2

- Program Monitor A/V clock 与音频监听：当前 Timeline 已有音频 authority 和 Delivery 语义，但实时监听/同步还未达到 NLE 成熟度。
- Source browser scalability：大项目需要 Take 分组、搜索、camera/episode/scene filter；不能复制 Review decision authority。
- First Python package migration slice：主线集成和 executable gates 完成后，独立 `refactor/python-fcpxml-package` worktree。
- Validation ergonomics：记录真实 python/fast/full gate 耗时与失败分类。

## 当前验证状态

- Source / diff review：已完成；`git diff --check`：PASS。
- Python converter/audio 局部 contracts：PASS；见上方证据。
- `python scripts/check_python.py`：**PASS**，66 passed。
- `python scripts/check_fast.py`：**PASS**，TS/Vitest/Rust/Tauri/Python 全部通过。
- `python scripts/check_full.py`：**PASS**，448 passed，1 个第三方 deprecation warning。
- `npm install`、runtime staging、`verify:rc`、macOS Tauri build、`verify:macos-bundle`：**PASS**。
- Packaged Host/project/durable-task/cancel/restart/path-free smoke：**部分 PASS**；详见验证报告。
- Packaged Timeline checkpoint/journal reopen、stale authority UI recovery、真实 media/LAN/Finder：**NOT RUN**。
- Final Cut Pro / real media / authoritative FCPXML import smoke：**NOT RUN**，本机没有 Final Cut Pro。
- codesign/notarization、Windows native/installer gates、GitHub Actions：**NOT RUN**。

## 状态维护规则

- `STATUS.md` 只保留当前事实，不继续堆阶段实现日志。
- 长期决策进入 `DECISIONS.md` / `INVARIANTS.md`。
- 历史验收证据进入 `docs/verification/`。
- 未进入当前工作包的事项进入 `BACKLOG.md`。
