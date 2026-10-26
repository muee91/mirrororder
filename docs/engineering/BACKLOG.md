# Engineering Backlog

更新时间：2026-10-26。本文只拥有**当前执行顺序**；当前事实见 `STATUS.md`，长期硬约束见 `INVARIANTS.md`。

## 总目标的变化

此前 backlog 只有「Desktop Product Recovery 收尾」。审计（2026-10-25 两轮）确认代码侧结构恢复确实已经收口，真正缺的是**把一个能跑的代码库变成一个能交付的产品**。因此按正规 App 开发路线重排为六个阶段，顺序不可打乱：先把证据与授权补齐，再让它可分发，然后才谈体验优化与还债。

## 产品方向修正（owner 2026-10-26 决策）

- **剔除内置剪辑面**：owner 判断当前剪辑模块基本不可用，不值得继续投入；镜序自身不承担剪辑，**主链终点改为导出**——人工决定 → 组接（assembly）→ FCPXML / Premiere XML 导出 → 在外部 NLE 继续剪。
- **导出质量即关键路径**：独立音轨与多机位同步导出已在活链路实现（见 STATUS）。**真实 NLE 导入验收（owner 2026-10-26 调整）放到最后**：当前 UI 仍是半成品、功能布局混乱、可读性差，先把界面验证和完善做在前面；导出验收在 UI 收口、素材可用后于收尾阶段执行（FCP/Premiere 实际打开、音画对齐、多机位可用）。
- **未来若恢复剪辑能力，必须模块化**：不回退到整体 Workbench；Rust Timeline Core 与 command bridge 保留为组接/导出引擎，剪辑 UI 若回归则以独立模块挂在时间线工作区，不与组接/导出耦合。
- 收缩切片（owner 2026-10-26 确认"按推荐执行"，同日落地，见 STATUS「组接 + 导出收缩轮」）：
  1. [x] 时间线工作区收缩为「组接 + 导出」视图：保留初始顺片、只读预览、交付抽屉；移除插入/覆盖/切分/修剪/移动/波纹删除/undo-redo UI。
  2. [x] 五步主链第 5 步措辞改为「把需要的素材/决定组接并导出到外部 NLE 继续剪」（README / IA / BACKLOG 三处）。
  3. [x] Rust Timeline Core 及编辑命令**不删**——组接/换镜次写入仍经 command bridge；仅移除 Desktop 精修 surface，为未来模块化剪辑留接口。
  4. [x] 裁决：`EditorMonitors` 的 Source/节目监看 + 波形保留——组接核对与素材检查仍需要，监看不是精修。

## UI 全工作区走查发现（2026-10-26，合成 fixture 项目，serve 模式 1440×900）

四个一级工作区及素材子页逐屏走查（截图 + 关键结论回查代码核实）。只记录已核实事实：

**横切问题**

- 「当前操作者 未设置」黄色警示在所有工作区顶栏常驻，无首次设置引导——责任归属动作全部前置阻塞。
- 状态标签无严重度分级：未归集 / 待处理 / 归集证据不足 / 自动决策落后 / N 机位可用 等多套灰橙 label 并存，无统一词汇表；同一含义多种表述（未关联场记、对白空、待处理常三处重复出现）。
- 10–11px 灰字小到视觉模型会误读（截图上读出的“素材盘在栈”“按最展开”经 grep 均不存在于代码，属误读）——本身就是可读性不达标的直接证据。正文下限应 12px、对比度达 AA。
- 数据口径矛盾：素材库横幅「尚未扫描」与统计「1502 可索引」并存；Take 汇总「素材异常 0」与 Take 详情「素材无法读取」并存。计数需要单一 read-model 口径。
- 媒体播放不可用是核心阻塞：WebView 解码失败提示在 GoldenSlateWorkbench / TakeInspector 已有，但素材库右栏同样撞墙且指引不一致。

**分工作区**

- 素材·场记：双栏 + 右侧详情结构可用，快捷录入条是亮点；主要欠操作者引导与状态分级。
- 素材·素材库：列表行缺时长 / 分辨率 / 场景 / Take 关联等决策字段，重复徽章多，信息层级失衡。
- 素材·Take：机位条全空占位且不区分「离线 / 未生成代理」原因；多机位对比可视化缺失；Take 详情抽屉进入即自动展开（Playwright 证实 load 时 backdrop 已拦截点击），且覆盖列表右侧信息列。
- 剧本：正文 / 覆盖 / 问题三视图 + 全宽搜索结构成立；placement 呈现的密度与状态重复问题与横切项同源。
- 时间线：现状为纵向单列说明型页面而非编辑布局——与「组接 + 导出」收缩方向一致；重构时导出应为 Primary 动作，当前导出入口不突出。
- 审阅：筛选计数 全部 668 / 未决定 668 / 需关注 668 —— 已核实为**正确投影而非计数 bug**（`reviewTakeAttention` 的 `hasAttention = 有任一 label`，fixture 中所有 take 均未决且均有 issue label）。暴露的真实问题是「需关注」无严重度阈值，退化数据下失去筛选意义；应仅 error 级计入，或分层展示。

**UI 修复顺序**（并入当前恢复切片，不另立体系）：① 媒体状态与恢复（切片 1，含素材库右栏与指引统一）；② 计数单一口径 + 「需关注」严重度分层（2026-10-26 已落地：审阅「需关注」分 阻断/证据过期/待关注 三层计数；Take 汇总「素材异常」更名「素材离线」并与筛选词统一，新增「本机播放失败」运行时计数上抛自 Take 详情；素材库 `scan_required` 时汇总条标注「上次清单」并降透明度——服务端声明可用与本机可播自此分开呈现）；③ 操作者首次设置引导（2026-10-26 已落地：未设置时首次自动弹出引导一次，可“暂不设置”；chip 文案改行动性“设置操作者”，弹层说明后果——不设置可浏览，写操作时会被要求）；④ 状态标签分级词汇表 + 字号对比度下限（2026-10-26 已写入 `design-system-v2.md`：三层审阅分层 + 媒体四口径唯一用词；10px 降历史存量、新代码 11px 起、灰字 AA——存量 157 处 8/9px 已全量提升至 10px（2026-10-26 专项，19 文件 47+110 处，layout/截图双验收）；⑤ Take 机位条空态说明（2026-10-26 已落地：槽位三态 无素材/素材离线/可用）；素材库列表行决策字段：时长与 Take 关联已落地（2026-10-26，`media_inventory.v1` +duration_seconds、前端双键连 Take；beef 已重连并实测出片（2026-10-26：根迁移一层，扫描两新根 + 1502 候选全确认，1533/1533 angle 可用、/media 出 206 真实字节；素材库行级 join 已解锁（provisional 文件名二次查找，beef 实测 3004/3004；索引 re-link 写路径留作后续恢复 exists/波形语义））；分辨率待扫描期 ffprobe 采样；⑥ 时间线按「组接 + 导出」重构信息架构（已随收缩切片完成，导出为 Primary）。

## 最低产品验收（定义不变，仍是全站 P0 关闭条件）

真实项目上连续走通，且目标 commit 的必要自动 gate 真实通过：

1. 找到一个实际 Take；
2. 看懂拍摄事实、机位与当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定组接并导出到外部 NLE 继续剪。

CI green 不能替代这一条；这一条也不能替代 CI green。

## 当前恢复切片的执行顺序

队列为空已归因并修正闸门；当前缺真实素材，先完成可以独立验证的主链失败路径，优先于能力替换和一般技术债：

1. **媒体状态与恢复**（服务端权威四态已落地 2026-10-26：review-model angle `playback.state` = verified/missing/unknown，decode 仅由本机播放产生；前端机位槽位/Take 判定已消费；UI 失败分类器与五面收敛此前完成）：URL 存在不能证明可播放，省略 available 不能显示机位可用；`verified` 不等于可解码。
2. **轻量摘要与状态口径**：统一“需关注”投影，修正历史中断任务耗时与 Team 权限说明；媒体恢复 GET 只读验证快照，全量核验走显式 durable task。大项目冷缓存开销需要量测。
3. **跨层最小验收**：在已有合成 Review 回归基础上，覆盖 React/Tauri/Python/Rust 的五步主链、持久化与导出，保留缺媒体、409、进程中断的负向验证。不能以声明 required、页面可渲染或 HTTP 200 代替。
4. **恢复真实证据**：素材可用后，再走真实看片/决定、native 编辑与重启恢复、NLE 实际导入。当前均 NOT RUN；签名/公证等需要 owner 的事项保持单独裁决。

---

## Phase 0 · 止血与授权（1 个工作日，阻塞后面一切）

- [ ] **推送并打 tag**：`main` 领先 `origin/main` 31 个提交（含符号链接拒收、registry 写串行化、journal 撕裂修复、局域网鉴权收口）。远端 CI 最后一次运行属于 `23bd253`（09-06），当前 HEAD 没有任何 CI 证据。
- [ ] **LICENSE 落地（owner 已决策：开源；许可证选 Apache-2.0，2026-10-26 确认）**：LICENSE/NOTICE 与 `pyproject.toml` 真实依赖声明已于 `5f8ed25` 落地。剩余：补齐 `vendor/multicam-audio-sync/` 移植溯源（自述移植自 AudioAlign / syncdrop / Zelqivo-Video-Program，无 upstream 版本与许可记录）、`pycryptodome` 解密剪映 draft 容器的用途注记、构建生成 THIRD_PARTY 清单。
- [ ] **vendored 移植溯源**：`multicam-audio-sync` 的算法自述移植自 AudioAlign / syncdrop / Zelqivo-Video-Program 三个上游仓库，无 upstream 版本与许可记录；`pycryptodome` 用于解密剪映加密 draft 容器的用途需法务判断。
- [ ] **Python 依赖声明**：`pyproject.toml` 无 `dependencies`，全仓无根 `requirements.txt`，但 core 实际使用 numpy（12 文件）/ pandas（8）/ scipy（6）。目标是干净 checkout 能装出可运行环境。
- [ ] **Cargo.lock 入库**：两个 lock 目前只被 `.git/info/exclude`（本地文件，不随仓库分发）排除，CI 与任何新 clone 都会重新解析 `tauri = "2"` 的任意 2.x。同批把 `crates/timeline-core/target/`、`gen/` 的忽略规则落进 `desktop/.gitignore`。

## Phase 1 · 可分发（发布工程）

- [ ] **让 `release.yml` 从脚手架变成真流水线**：文件头部已如实标注「SCAFFOLD, NOT VERIFIED END TO END」；需要配齐签名/公证 secrets、在 `bundle.macOS` 写 `signing_identity`/`entitlements`/`hardened_runtime`/`minimum_system_version`，并把 `MIRRORORDER_REQUIRE_CODESIGN=1` 从 opt-in 改默认。
- [ ] **补 notarization 检查**：`verify-macos-bundle.mjs` 目前不看签名/公证/stapler，只扫 Mach-O 依赖卫生。
- [x] **打包内容黑名单**（2026-10-25 已完成）：staging 与 bundle 闸门共用 `runtime-tools.mjs` 的同一份判定，排除 `config.json` / `__pycache__` / `*.pyc` / `._*` / `.DS_Store`，并对随包数据文件扫描 `/Volumes/`、`/Users/`、盘符路径。卷名含空格的形态由测试暴露后修正（按 JSON 分隔符收尾，不按空格截断）。
- [x] **禁止运行期写回 bundle**（2026-10-25 已完成）：`host.rs` 与 `gateway.rs` 起 Python 时设 `PYTHONDONTWRITEBYTECODE=1`。缺口：该行为目前只靠代码审查保证，`Command` 构造未抽成可测函数，补一个 Rust 单元测试即可闭环。
- [ ] **版本单一来源 + CHANGELOG**：`0.1.0` 目前手工散在 `tauri.conf.json`、两个 `Cargo.toml`、`package.json`、`pyproject.toml`。
- [ ] **决定本地智能能力的交付形态**：manifest 明列 `llama-server / faster_whisper / mlx_whisper / cv2 / model weights` 不随包，实测 staged site-packages 无 `onnxruntime`/`tokenizers`——即宣传中的向量检索/ASR 在装好的 app 里开箱不可用。要么随包，要么显式「首次启用时下载」，不能保持现状。
- [ ] **portable Python 换成单版本真 relocatable 构建**：上一份 staging 的 `lib/` 里同时有 `python3.11/3.12/3.14` 三棵树、numpy/pandas/scipy 各两份，617 MB app 里约 200 MB 是冗余；且 `pyvenv.cfg` 与 `sys._base_executable` 仍指回构建机，staging 的 relocation probe 只查 `sys.executable`/`prefix`，看不见这个洞。

## 开源优先替换清单（2026-10-25 选型结论）

原则：能借现成开源组件就不自研，但**权威状态不自外源**——Rust Timeline Core 仍是唯一编辑
权威，OSS 只做适配层与能力提供，不允许任何依赖变成第二套 truth。

| 能力 | 现在的自研 | 结论 | 许可证 / 注意 |
|---|---|---|---|
| EDL / Premiere(FCP7-xmeml) 读写 | `fcpxml_reader.py` 等手写 | **换 OpenTimelineIO** 的 `cmx_3600` / `fcp_xml` adapter | Apache-2.0；1.x 起 adapter 拆到 `OpenTimelineIO-Plugins`，社区维护、成熟度低于核心 |
| FCPXML 1.8 写出（含多机位） | 自研 exporter | **保留自研**——OTIO 的 `fcpx_xml` 实质只有导入、且 multicam 非一等公民 | 只可把 OTIO 用于"读回校验"，不可作为交付依赖 |
| 剪映 / CapCut draft | pycryptodome 解密 + 自建 draft | **保留但降级为逆向兼容层**，UI 与文档不得承诺稳定性，需单列法务结论 | 无官方规范；MIT/Apache 的上游代码许可**不等于**反规避授权 |
| 中文 ASR | 惰性 import whisper 系（且未随包） | **sherpa-onnx + SenseVoiceSmall(int8 ONNX)** 首选，Paraformer 备选 | 运行时与 SenseVoice 权重 Apache-2.0；Paraformer 权重需按 FunASR Model License 署名；显式传模型路径，不自动联网 |
| 句向量检索 | 自研 `semantic_index.py` + bundled encoder | **bge-small-zh ONNX 直推 + onnxruntime**（路线已正确，补随包即可）；向量存储 **sqlite-vec**，超过约 50 万条再换 hnswlib | 均 MIT / Apache-2.0；单项目剧本句级用 numpy 暴力扫也够 |
| 人物识别 | YuNet + SFace（OpenCV DNN） | **路线正确，继续用**；如需更高精度只走商业授权谈判 | 现用权重来自 OpenCV 侧（Apache 系）；**insightface 的 buffalo/antelopev2 权重是 research-only，禁止随包**；换任何新权重都要单独核 model card |
| 镜头 / Take 边界 | 自研分组 | **PySceneDetect（AdaptiveDetector）** 做候选边界，渐变转场再评估 TransNetV2 | BSD-3-Clause / MIT |
| 重复与跨设备同一媒体 | hash + 头尾指纹 | 保留确定性 hash 为主，**imagehash pHash + chromaprint/fpcalc** 做辅助 | chromaprint LGPL-2.1（动态链接可闭源）；**AcoustID 在线库是 CC BY-NC，不得接入** |
| 波形 | `waveform_runtime.py` 490 行 | **收缩为 ffmpeg 解码 + numpy 分桶 peaks**，删自研采样；不引 audiowaveform | audiowaveform 是 GPL-3.0，随包义务重，不划算 |
| 打包 / 更新 / 公证 | 手工 stage + adhoc | **tauri-apps/tauri-action + 官方 updater（minisign）+ GitHub Releases 静态 latest.json**；公证用 App Store Connect API key（.p8） | 前置条件是付费 Apple Developer 账号 |
| 制品可信 | 无 | GitHub artifact attestations（一条 Action）+ `cargo-license` / `pip-licenses` 生成 THIRD_PARTY_LICENSES + `syft` 出 SBOM | 成本近乎为零；`NOTICE` 已声明清单由构建生成而非手工维护 |
| 局域网配对 | 64bit 配对码 + 按来源限速 | 保留限速；把码交换升级为 **SPAKE2**（python-spake2 / RustCrypto），发现层用 **zeroconf + rcgen** 起 TLS | MIT / Apache-2.0；`--trusted-lan` 空码这条旁路必须收掉 |
| 日志与诊断 | 近乎零日志、500 直吐 error | **structlog**（Python）+ **tracing / tracing-subscriber**（Rust），500 改错误 ID + 本地关联；自建"导出支持包"按钮 | 默认不外发；将来若要外发选 GlitchTip（MIT）而非 Sentry（FSL，非 OSI 开源） |
| 视觉/无障碍回归 | 自研 layout-runtime 几何断言 | **几何断言保留**（无可替代），像素级加 Playwright `toHaveScreenshot` + `odiff-bin`，a11y 用 axe-core | axe-core MPL-2.0（仅测试依赖，不传染） |
| 时间线持久化 | checkpoint + journal + 撕裂尾修复 | **不替换**。redb / SQLite / RocksDB 解决的正是这套代码已经解决的事，Recovery 期不做迁移 | redb MIT OR Apache-2.0；RocksDB GPLv2/Apache 双许可 |

落地顺序：Phase 1 先做 updater/公证/SBOM 这三件"分发基建"；能力替换按 ASR → 向量随包 →
PySceneDetect → 波形收缩 的次序，每项都要带一条"打包后开箱可用"的真实验收，不接受
"requirements 里写了但 app 里没有"。


- [ ] **五步主链真机验收**（在本机 `projects/` 下的在制真实项目上跑，项目数据不入库）：项目恢复与切换、大量 Take 搜索/滚动、A/B/C 多机位、场记→素材→剧本→审阅→Timeline 连续上下文、placement revision conflict、Viewer/media binding、Timeline insert/overwrite/replace/undo/redo/persistence、FCPXML/Premiere XML 导出、1280 与宽屏、light/dark、外部拖放。
- [x] **真实 Host surface gate 与合成回归**：`ux-real.mjs` 已有断言、稳定退出码与归档，修正 compact Take 行选择器并验证实际换 Take；项目参数从 Host 读取真实摘要。播放是独立必需项，缺媒体仍退出 1。合成 ReviewWorkspace/WebM 行为回归已配置进 CI，真实数据不进入源码或 CI；原生应用与完整五步主链仍由上一条验收拥有。当前 owner 暂无真实素材，等素材恢复后继续，不能以合成回归替代。
- [ ] **消灭主链上的重复重拉**：review-model 无共享缓存，`GoldenSlateWorkbench.tsx:324,347`、`ScriptWorkspace.tsx:124`、`ReviewWorkspace.tsx:74`、`MaterialTakeView` 各自 mount 即全量拉；`ProjectHome.tsx:64-72` 打开项目页对每个项目并发拉完整 payload；`ProjectWorkbench.tsx:227` 的 canvasKey 含 operatorRevision，改操作者即整画布 remount。
- [ ] **补齐失败态**：`EditorMonitors.tsx:224,232` 双 monitor 无播放失败态（看片到一半黑屏不提示）；全局只有一条 7 秒消失的顶部 message，409 placement 冲突信息容易被错过。
- [ ] **时间线区可维护性**：~~6 处 `{[key: string]: any}` 整体解构~~（2026-10-26 已清零：面板 props 全部由 hook 返回类型的 `Pick` 推导，内层 any 一并去除）；剩余缺口是 editor 域 aria 仅 5 处、无键盘导航——这是唯一有写权限的核心区。
- [ ] **Timeline 规模上限实测**：每次 mutation/undo 返回全量 snapshot、单次编辑 3 份 project clone、`undo_stack: Vec<TimelineProject>` 保留每次编辑前整份 project。短剧 clip 量级下的内存与卡顿需要实测数字，不是猜测。

## Phase 3 · 质量与结构还债

- [ ] **服务端日志**：HTTP 500 仍把 `str(error)` 原样回给客户端且不落任何日志；全层近乎零 `logging`。专业工具没有可事后诊断的能力就没有支持能力。
- [ ] **测试形状**：Desktop 77 个测试文件里 35 个是 `readFileSync` 源码文本断言，真正 `render()` 的只有 5 个。把 `check-layout-runtime` 的真实盒子断言模式推广为渲染行为测试，并取消「源码文本断言」的 contract 身份。
- [ ] **CSS 收口**：`main.tsx` 全局层 11→10，但 `desktop-theme-frozen-surfaces.css`（现约 40 条硬编码 hex 的 Project Home 明暗规则）与 `media-binding-recovery.css`（67 行）仍在；`designSystemV2Contract.test.ts:10-18` 仍用 `indexOf` 锁 import 顺序，把债务固化。目标：配色迁进 token、失去 owner 的层删除、测试改为断言真实计算样式。
- [ ] **兼容债退出计划**：identity facade→v3→v2→legacy 四层活动 import 链（legacy 614 行仍在用）、前端 `LegacyReviewPayload`、素材/场记页里折叠的旧 `SlateWorkbench`。每条给 owner 或删除条件。
- [x] **死并行导出路径已删除（owner 2026-10-26 拍板，`eca1fd0`）**：`timeline_delivery.py`（552 行 v1 转换器，入口零生产调用方）+ `timeline_delivery_sync.py` + `timeline_audio_delivery.py` 及 3 个 v1 专属测试整体删除。删除时发现并处理一处此前未记录的耦合：活链路 `nle_delivery` 引用了 v1 模块的私有 helper，已原样提取为 `nle_delivery/delivery_support.py`（行为不变）。**音轨与多机位同步导出能力在活链路完整保留**：`nle_sequence_ir` 每角度 sync 帧 → FCPXML connected audio / mcAngled、Premiere typed range 换算，Rust 模型携带并校验同步帧。
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
