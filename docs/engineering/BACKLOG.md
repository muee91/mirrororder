# Engineering Backlog

更新时间：2026-10-26。本文只拥有**当前执行顺序**；当前事实见 `STATUS.md`，长期硬约束见 `INVARIANTS.md`。

## 总目标的变化

此前 backlog 只有「Desktop Product Recovery 收尾」。审计（2026-10-25 两轮）确认代码侧结构恢复确实已经收口，真正缺的是**把一个能跑的代码库变成一个能交付的产品**。因此按正规 App 开发路线重排为六个阶段，顺序不可打乱：先把证据与授权补齐，再让它可分发，然后才谈体验优化与还债。

## 产品方向修正（owner 2026-10-26 决策）

- **剔除内置剪辑面**：owner 判断当前剪辑模块基本不可用，不值得继续投入；镜序自身不承担剪辑，**主链终点改为导出**——人工决定 → 组接（assembly）→ FCPXML / Premiere XML 导出 → 在外部 NLE 继续剪。
- **导出质量即关键路径**：独立音轨与多机位同步导出已在活链路实现（见 STATUS），下一步的验收重心是**真实 NLE 导入**（FCP/Premiere 实际打开、音画对齐、多机位可用），而非浏览器内剪辑体验。
- **未来若恢复剪辑能力，必须模块化**：不回退到整体 Workbench；Rust Timeline Core 与 command bridge 保留为组接/导出引擎，剪辑 UI 若回归则以独立模块挂在时间线工作区，不与组接/导出耦合。
- 待执行切片（owner 确认范围后实施，产品定义同步改 `app-information-architecture.md`）：
  1. 时间线工作区收缩为「组接 + 导出」视图：保留初始顺片、时间线只读预览、交付抽屉；移除 EditorMonitors 精修编辑面（插入/覆盖/切分/修剪/移动/波纹删除/undo-redo UI）。
  2. 五步主链第 5 步措辞改为「把需要的素材/决定组接并导出到外部 NLE」。
  3. Rust Timeline Core 及编辑命令**不删**——组接写入仍经 command bridge；仅移除 Desktop 编辑 surface，为未来模块化剪辑留接口。
  4. `EditorMonitors` 的 Source 监看与失败态若仍被组接/审阅需要，单独裁决去留。

## 最低产品验收（定义不变，仍是全站 P0 关闭条件）

真实项目上连续走通，且目标 commit 的必要自动 gate 真实通过：

1. 找到一个实际 Take；
2. 看懂拍摄事实、机位与当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到时间线继续剪。

CI green 不能替代这一条；这一条也不能替代 CI green。

## 当前恢复切片的执行顺序

队列为空已归因并修正闸门；当前缺真实素材，先完成可以独立验证的主链失败路径，优先于能力替换和一般技术债：

1. **媒体状态与恢复**：以现有设备绑定/验证 authority 区分未知、已验证可用、缺失、解码失败；素材列表、Take、场记、审阅和 Timeline 使用一致语义。URL 存在不能证明可播放，省略 available 不能显示机位可用。EditorMonitors 补应用级失败原因、重试与携带当前对象的恢复入口，覆盖合成 404/解码失败/切换后的恢复。
2. **轻量摘要与状态口径**：统一“需关注”投影，修正历史中断任务耗时与 Team 权限说明；媒体恢复 GET 只读验证快照，全量核验走显式 durable task。大项目冷缓存开销需要量测。
3. **跨层最小验收**：在已有合成 Review 回归基础上，覆盖 React/Tauri/Python/Rust 的五步主链、持久化与导出，保留缺媒体、409、进程中断的负向验证。不能以声明 required、页面可渲染或 HTTP 200 代替。
4. **恢复真实证据**：素材可用后，再走真实看片/决定、native 编辑与重启恢复、NLE 实际导入。当前均 NOT RUN；签名/公证等需要 owner 的事项保持单独裁决。

---

## Phase 0 · 止血与授权（1 个工作日，阻塞后面一切）

- [ ] **推送并打 tag**：`main` 领先 `origin/main` 31 个提交（含符号链接拒收、registry 写串行化、journal 撕裂修复、局域网鉴权收口）。远端 CI 最后一次运行属于 `23bd253`（09-06），当前 HEAD 没有任何 CI 证据。
- [ ] **LICENSE 落地（owner 已决策：开源，2026-10-26）**：方向已定，剩余执行项——选定许可证（MIT / Apache-2.0 为候选，NOTICE 已声明清单由构建生成）、补齐 `vendor/multicam-audio-sync/` 移植溯源（自述移植自 AudioAlign / syncdrop / Zelqivo-Video-Program，无 upstream 版本与许可记录）、`pycryptodome` 解密剪映 draft 容器的用途注记，然后落 LICENSE 文件并接入构建生成 THIRD_PARTY 清单。
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
- [ ] **死并行导出路径的裁决（2026-10-26 事实修正后待 owner 重新表态）**：`timeline_delivery.py`（552 行，v1 转换器）本身生产零引用，是被 `nle_delivery` IR 路径取代的旧实现；`timeline_delivery_sync.py`（111 行）与 `timeline_audio_delivery.py`（323 行）是它的卫星模块。**音轨与多机位同步导出能力已在活链路完整实现**：`nle_sequence_ir` 接受 video/audio 轨道并建模每角度 `sync_start/end_frame`，FCPXML 导出为 connected audio + mcAngled 角度资源，Premiere 导出有 typed sync range 换算；Rust timeline-core 模型携带每角度同步帧并有校验。此前“导出会丢独立音轨/同步”的判断只对死路径成立。建议整体删除三个模块及其 4 个测试文件（约 986 行 + 测试），owner 基于修正后事实重新裁决；裁决前不得接线到交付链。
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
