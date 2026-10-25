# Engineering Backlog

更新时间：2026-10-25。本文只拥有**当前执行顺序**；当前事实见 `STATUS.md`，长期硬约束见 `INVARIANTS.md`。

## 总目标的变化

此前 backlog 只有「Desktop Product Recovery 收尾」。审计（2026-10-25 两轮）确认代码侧结构恢复确实已经收口，真正缺的是**把一个能跑的代码库变成一个能交付的产品**。因此按正规 App 开发路线重排为六个阶段，顺序不可打乱：先把证据与授权补齐，再让它可分发，然后才谈体验优化与还债。

## 最低产品验收（定义不变，仍是全站 P0 关闭条件）

真实项目上连续走通，且目标 commit 的必要自动 gate 真实通过：

1. 找到一个实际 Take；
2. 看懂拍摄事实、机位与当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到时间线继续剪。

CI green 不能替代这一条；这一条也不能替代 CI green。

---

## Phase 0 · 止血与授权（1 个工作日，阻塞后面一切）

- [ ] **推送并打 tag**：`main` 领先 `origin/main` 31 个提交（含符号链接拒收、registry 写串行化、journal 撕裂修复、局域网鉴权收口）。远端 CI 最后一次运行属于 `23bd253`（09-06），当前 HEAD 没有任何 CI 证据。
- [ ] **LICENSE 决策并落地**：仓库根与 `vendor/multicam-audio-sync/` 均无 LICENSE；GitHub 返回 `license: null`。需要 owner 明确商用闭源 / 开源。
- [ ] **vendored 移植溯源**：`multicam-audio-sync` 的算法自述移植自 AudioAlign / syncdrop / Zelqivo-Video-Program 三个上游仓库，无 upstream 版本与许可记录；`pycryptodome` 用于解密剪映加密 draft 容器的用途需法务判断。
- [ ] **Python 依赖声明**：`pyproject.toml` 无 `dependencies`，全仓无根 `requirements.txt`，但 core 实际使用 numpy（12 文件）/ pandas（8）/ scipy（6）。目标是干净 checkout 能装出可运行环境。
- [ ] **Cargo.lock 入库**：两个 lock 目前只被 `.git/info/exclude`（本地文件，不随仓库分发）排除，CI 与任何新 clone 都会重新解析 `tauri = "2"` 的任意 2.x。同批把 `crates/timeline-core/target/`、`gen/` 的忽略规则落进 `desktop/.gitignore`。

## Phase 1 · 可分发（发布工程）

- [ ] **让 `release.yml` 从脚手架变成真流水线**：文件头部已如实标注「SCAFFOLD, NOT VERIFIED END TO END」；需要配齐签名/公证 secrets、在 `bundle.macOS` 写 `signing_identity`/`entitlements`/`hardened_runtime`/`minimum_system_version`，并把 `MIRRORORDER_REQUIRE_CODESIGN=1` 从 opt-in 改默认。
- [ ] **补 notarization 检查**：`verify-macos-bundle.mjs` 目前不看签名/公证/stapler，只扫 Mach-O 依赖卫生。
- [ ] **打包内容黑名单**：`stage-runtime.mjs:183` 的 `copyDirectory` 无排除规则——上一份 bundle 里带着 `vendor/multicam-audio-sync/scripts/config.json`（内含 `/Volumes/TESTVOL` 与真实项目名）和约 5,000 个 `.pyc`，直接违反 `.gitignore:24-25` 自己写的「must never enter the repo or App bundle」。给 staging 加排除清单，并让 `verify-macos-bundle` 对 `/Volumes/`、`/Users/`、盘符做文本扫描即 fail。
- [ ] **禁止运行期写回 bundle**：`host.rs:186` 以 `-m` 起 Python 时未设 `-B`/`PYTHONDONTWRITEBYTECODE`/`PYTHONPYCACHEPREFIX`，DMG 只读卷挂载下会失败。
- [ ] **版本单一来源 + CHANGELOG**：`0.1.0` 目前手工散在 `tauri.conf.json`、两个 `Cargo.toml`、`package.json`、`pyproject.toml`。
- [ ] **决定本地智能能力的交付形态**：manifest 明列 `llama-server / faster_whisper / mlx_whisper / cv2 / model weights` 不随包，实测 staged site-packages 无 `onnxruntime`/`tokenizers`——即宣传中的向量检索/ASR 在装好的 app 里开箱不可用。要么随包，要么显式「首次启用时下载」，不能保持现状。
- [ ] **portable Python 换成单版本真 relocatable 构建**：上一份 staging 的 `lib/` 里同时有 `python3.11/3.12/3.14` 三棵树、numpy/pandas/scipy 各两份，617 MB app 里约 200 MB 是冗余；且 `pyvenv.cfg` 与 `sys._base_executable` 仍指回构建机，staging 的 relocation probe 只查 `sys.executable`/`prefix`，看不见这个洞。

## Phase 2 · 真实可用性（产品成立与否的证据）

- [ ] **五步主链真机验收**（在本机 `projects/` 下的在制真实项目上跑，项目数据不入库）：项目恢复与切换、大量 Take 搜索/滚动、A/B/C 多机位、场记→素材→剧本→审阅→Timeline 连续上下文、placement revision conflict、Viewer/media binding、Timeline insert/overwrite/replace/undo/redo/persistence、FCPXML/Premiere XML 导出、1280 与宽屏、light/dark、外部拖放。
- [ ] **把 `ux-real.mjs` 变成正式 gate**：它现在只打 timing 日志和 `/tmp` 截图、失败仅 `console.log` 继续跑、无断言无稳定退出码、不进 CI。要求：断言 + 非零退出 + 产物归档为 CI artifact，否则「真机验收」永远只有操作者记忆。注意它 mount 的是 `ProjectWorkbench` 共用壳，需要与 workspace ownership 现状对齐。
- [ ] **消灭主链上的重复重拉**：review-model 无共享缓存，`GoldenSlateWorkbench.tsx:324,347`、`ScriptWorkspace.tsx:124`、`ReviewWorkspace.tsx:74`、`MaterialTakeView` 各自 mount 即全量拉；`ProjectHome.tsx:64-72` 打开项目页对每个项目并发拉完整 payload；`ProjectWorkbench.tsx:227` 的 canvasKey 含 operatorRevision，改操作者即整画布 remount。
- [ ] **补齐失败态**：`EditorMonitors.tsx:224,232` 双 monitor 无播放失败态（看片到一半黑屏不提示）；全局只有一条 7 秒消失的顶部 message，409 placement 冲突信息容易被错过。
- [ ] **时间线区可维护性**：`TimelineStagePanel.tsx:13`、`TimelineWorkbenchView.tsx:7`、`TimelineInitialAssembly.tsx:3` 仍用 `{[key: string]: any}` 整体解构，editor 域 aria 仅 5 处、无键盘导航——这是唯一有写权限的核心区。
- [ ] **Timeline 规模上限实测**：每次 mutation/undo 返回全量 snapshot、单次编辑 3 份 project clone、`undo_stack: Vec<TimelineProject>` 保留每次编辑前整份 project。短剧 clip 量级下的内存与卡顿需要实测数字，不是猜测。

## Phase 3 · 质量与结构还债

- [ ] **服务端日志**：HTTP 500 仍把 `str(error)` 原样回给客户端且不落任何日志；全层近乎零 `logging`。专业工具没有可事后诊断的能力就没有支持能力。
- [ ] **测试形状**：Desktop 77 个测试文件里 35 个是 `readFileSync` 源码文本断言，真正 `render()` 的只有 5 个。把 `check-layout-runtime` 的真实盒子断言模式推广为渲染行为测试，并取消「源码文本断言」的 contract 身份。
- [ ] **CSS 收口**：`main.tsx` 全局层 11→10，但 `desktop-theme-frozen-surfaces.css`（现约 40 条硬编码 hex 的 Project Home 明暗规则）与 `media-binding-recovery.css`（67 行）仍在；`designSystemV2Contract.test.ts:10-18` 仍用 `indexOf` 锁 import 顺序，把债务固化。目标：配色迁进 token、失去 owner 的层删除、测试改为断言真实计算样式。
- [ ] **兼容债退出计划**：identity facade→v3→v2→legacy 四层活动 import 链（legacy 614 行仍在用）、前端 `LegacyReviewPayload`、素材/场记页里折叠的旧 `SlateWorkbench`。每条给 owner 或删除条件。
- [ ] **单测耗时隔离**：全量 pytest 142 秒里 134 秒来自单个用例 `tests/test_core.py:606`，且它依赖可选的 `faster_whisper`/`huggingface_hub` 是否在位——本机与 CI（只装 pytest）走的不是同一条代码路径。标为 integration 或由 CI 用独立 job 覆盖，让默认 gate 回到 10 秒级。
- [ ] **release gate 从声明变强制**：`development-baseline.json` 的 18 个 `release_gates` 里 9 个 macOS/Windows 原生门没有任何实现，`check-baseline.mjs:33-35` 仍只断言字符串等于 `"required"`。
- [ ] **Windows 要么真做要么删承诺**：`cfg!(windows)` 分支从未编译，`stage-runtime.mjs:96` 主动拒绝非 macOS，而 `tauri.windows.conf.json` 声明了 nsis/msi。
- [ ] **逃生通道的读面**：显式 `--host 0.0.0.0` 时 `GET /api/v1/*` 与素材 range 下载仍完全无鉴权（写侧已收口）。若保留这条通道，需要在 `INVARIANTS.md` 写清边界，否则读侧也上 token。

## Phase 4 · 协作面与商业形态

- [ ] Team Web 部署形态：无 Dockerfile/systemd/nginx，只能在制作主机手动起 gateway；补最小部署与运文档。
- [ ] 双机 LAN 配对端到端实测（含 30 秒真实冷却、角色隔离、HTTPS/明文边界）。
- [ ] 定价 / 授权模式 / 是否私有部署 / 支持 SLA——目前仓库内零痕迹。
- [ ] 隐私与数据说明：素材不出本机、AI 端点如何配置、备份与迁移路径（业务数据与 Timeline 权威当前落在两个不同根：`com.mirrororder.desktop` 与 `MirrorOrder/timeline-v1`，且目录名版本号为 v1 而 `PERSISTENCE_VERSION = 2`）。

## 执行纪律（沿用既有约束）

- 一个阶段一个阶段推进，每阶段以「可复核证据」结束：实跑命令 + 退出码 + 产物位置。
- 没有实际执行的检查不得写 PASS；未执行写 NOT RUN。
- 失败时修当前结构，不通过恢复旧 Workbench / 旧 route / 复制 renderer / 放宽 authority / 删测试来让绿灯变亮。
- 本轮不启动与主链无关的大规模 package migration，不新增产品面，不建第二套 Review / Editorial / Timeline authority。
