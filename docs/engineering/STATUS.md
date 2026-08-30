# Engineering Status

更新时间：2026-08-30

## 当前基线

- 主线：本地 `main@eb905cee72daeab1b7ee9a93b29435bc5e0bdc79`；`origin/main@4e112efebf70159ff2d1ef91b530947e5efb7c3e`
- 稳定化基线：`fix/runtime-read-paths`
- 已验证功能基线：`feature/timeline-audio-ux@20d0febdd226d551628f9f11b4285d9b6efacdd6`。
- 当前恢复分支：`feature/swift-golden-product-parity`，从上述 Stage 17 基线独立演进；不直接合并到 `main`。
- 当前恢复分支相对 Stage 17 基线：0 behind；当前 source diff 仅涉及 React/TS 产品层、Python local adapters/contracts 与工程文档，没有修改 Rust Timeline Core / Timeline bridge / Delivery authority。
- GitHub Actions：当前无可用 status checks；不作为已通过 gate。
- 当前原则：源码审阅不能替代 executable validation；本分支的原生 Desktop、Python/Rust/Tauri 与 packaged build gates 已真实执行，未执行的 native smoke 仍明确标为 `NOT RUN`，不得继承 Stage 17 基线的 PASS。

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
| Stage 17 — Audio editing UX | 源码完成；native/FCP 阻塞，不计入关闭 |
| Stage 18 — Swift Golden product parity | **source/native gates PASS；packaged smoke partial，Finder drag-drop NOT RUN，暂不关闭** |

评分代表当前产品/工程就绪度判断，不替代 fast/full/native gate。当前官方评分仍为 **93/100**。

## 当前 parity 已接回的产品能力

- Workspace 恢复后先进入 Project Home，不再自动钻入上次项目；最近项目和全局工具仍在 Sidebar。
- Golden 多机位电子场记成为 Production 主场记：A/B/C/辅助列、独立空白记录、直接集/场/镜/次编辑、从 Take 加入、同场下一条、同上、dirty row 与顺序保存。
- Slate Inspector 已恢复：播放器、全部机位、I/O 可用范围、每机位 camera/shot/note 编辑、首选机位、场记备注、Take/剧本关系；`preferred_clip_id` 明确不等于 Editorial Best。
- Finder/Explorer 显式拖素材进入场记：只在 drop POST 解析 device-local media identity，项目持久化仍只保存 `media_id / clip_id` 等逻辑身份。
- Review placement 已降回辅助区：待归集 / 已归集 / 已排除 / 孤立素材 / 场景目标保留，但不再拥有第二张生产场记表。
- Material / Script 三栏产品结构恢复：左粗归集/精确剧本，中素材 Take，右 Take Inspector。
- 粗归集保持 `preview → human confirm → Review authority`；确认必须携带当前 Review revision，stale 预览 409 且 batch 零写入。
- `MirrorOrderMediaCard` 成为 Slate / Take / Inspector 共用视觉契约；`AngleEvidenceCard` 仅剩 ReviewAngle → MediaCard 适配，不再独立渲染素材状态。
- 项目右键恢复 Team Review、Finder/Explorer、本机素材/换素材盘、重整项目；重整只提交 durable `prepare_project` 并转到 Status Center。
- `本机素材` 成为正式 Production 页面，复用已有 DeviceMedia binding authority。
- Slate 播放快捷键恢复：Space 播放/暂停、J 后退 1 秒、K 暂停、L 正向播放；不伪造 WebView 不可靠的负 playback rate。
- Desktop Appearance 独立于 Team Web：System / Light / Dark 仅存 device-local storage；显式主题 root override 晚于 feature CSS 加载，覆盖 Project Home / Production / Slate / Material-Script / Status / Settings / Team Review 外壳。
- `project-local-location` 仅用于本机显式 reveal；GET 只读 registry + `project.toml`，不读 media binding snapshot，不做 scan/hash/FFmpeg/model/network work。
- `project-local-location` 已进一步 fail closed：registry config 必须精确落在 `projects/<project_id>/project.toml`，output 必须留在项目目录内；workspace path escape 返回 conflict。
- 长期 parity 契约记录于 `docs/engineering/SWIFT_GOLDEN_PARITY.md`。

## Authority 保持不变

- Python MirrorOrder Core 仍拥有 Workspace/Project、Review、Slate/Script Supervisor、media identity/binding、Identity、Assistant proposals 与 Delivery semantics。
- Rust Timeline Core 仍拥有 Timeline edit state、authority token、undo/redo、checkpoint/journal；Stage 18 没有修改其源码。
- React/Tauri 只负责产品 UI、device integration 与显式用户动作，不成为第二真相。
- AI 继续遵守 `evidence → proposal → human confirmation → authority`。
- device-local path 只允许出现在明确 local response/action，不进入 shared project artifacts。

## Stage 17 基线已执行的验证证据

以下证据属于 `feature/timeline-audio-ux`/其验证工作树，**不自动覆盖当前 parity 分支**：

- Stage 14 Timeline→FCPXML converter contract：11/11 pytest PASS。
- Stage 15 Timeline sync normalizer + Stage 14 converter：15/15 pytest PASS。
- Stage 15 TS synchronization core：`tsc --strict` + runtime assertions PASS。
- Stage 16 Timeline audio + Stage 14/15 converter：21/21 pytest PASS。
- Stage 16 Desktop audio command core：`tsc --strict` + runtime assertions PASS。
- `python scripts/check_python.py`：PASS，66 passed。
- `python scripts/check_fast.py`：PASS，28 个 Vitest 文件/130 tests，Rust Timeline 10、Tauri timeline 5、Tauri persistence 7、Python 66。
- `python scripts/check_full.py`：PASS，448 passed，1 个第三方 deprecation warning。
- runtime staging、`verify:rc`、macOS Tauri build、`verify:macos-bundle`：PASS。
- packaged Host/project/durable-task/cancel/restart/path-free smoke：部分 PASS；见 `docs/verification/2026-08-29-production-readiness.md`。

## 当前 parity 分支已执行的验证

验证记录：`docs/verification/2026-08-30-swift-golden-parity-full.md`；早期 targeted 证据仍见 `docs/verification/2026-08-30-swift-golden-parity-targeted.md`。

- GitHub 当前源逻辑隔离物化 + 最小 Tauri/React/Host stubs：全局 TypeScript strict compile **PASS**。
- Node 22 runtime assertions：`PARITY_TS_RUNTIME_PASS appearance=3 playback=6 roughPlacement=5 projectActions=3`，共 17 项 **PASS**。
- 仓库现有 4 个 TS test files 在最小 Vitest-compatible runner 下原样执行：**12/12 PASS**。
- Review stale batch behavioral probe：先建立 r1，再以 stale r0 提交两条 placement；`ReviewConflictError` 后 reopen 仍 `revision=1`、`placements={}`：**PASS**。
- Project-location safety probe：正常路径、registry escape、output escape：**3/3 PASS**。
- 当前仓库 `tests/test_project_location_runtime.py` + `tests/test_rough_placement_runtime_contract.py` 在最小依赖物化下由真实 pytest 执行：**6/6 PASS，0.07s**。
- 仓库原生 Vitest：**35 files / 155 tests PASS**；Desktop typecheck、Vite build、Python source gate、fast/full、runtime staging、RC、Tauri build/bundle verification 均已在本分支执行并通过。
- packaged product smoke：项目主页、Golden Slate、项目操作、本机素材、Appearance、Status Center 路径、粗归集 stale rejection 与 Material / Script 三栏均 PASS；Finder/Explorer 原生跨窗口拖入因 GUI 自动化服务 `noWindowsAvailable` 保持 **NOT RUN**。
- tracked/shared path guard：**6 passed**；权威 Review/Slate/Script Supervisor/Editorial/Audit/Delivery report JSON 均无设备绝对路径。合成 FCPXML 的本机分析索引、离线 learning-case 结果路径及交付 FCPXML 的本机媒体 URL 已在 full verification 中单独记录。

## 当前 parity 分支验证状态

- Source / diff scope review：已完成当前功能边界审计；相对 Stage 17 基线未发现 Rust Timeline Core / Timeline bridge / Delivery authority 修改。
- Native TypeScript typecheck + Vitest：**PASS；35 files / 155 tests**。
- `python3 scripts/check_python.py`：**PASS；75 passed**。
- `python3 scripts/check_fast.py`：**PASS**。
- `python3 scripts/check_full.py`：**PASS；457 passed，1 个第三方 `huggingface_hub` deprecation warning**。
- Rust/Tauri executable gates：由 fast/full 与独立命令真实执行并通过；Timeline 10、Tauri host 31。
- Packaged staging / RC / Tauri release build / macOS bundle verification：**PASS**。
- Packaged product smoke：除 Finder/Explorer 跨窗口拖入外，其余 closeout 项目已实测 **PASS**；粗归集 stale confirmation 已验证无额外写入。
- Finder/Explorer native drag-drop：**NOT RUN**；GUI 自动化服务两次返回 `noWindowsAvailable`，未伪造 PASS。
- Final Cut Pro / real authoritative FCPXML import smoke：**NOT RUN**。
- codesign/notarization、Windows native/installer gates、GitHub Actions：**NOT RUN**。

## 当前尚未接回的 Golden 能力

### Native speech / dictation

- 不使用 Web Speech API 冒充已恢复：Tauri macOS 使用 WKWebView，嵌入式 Web Speech 的可用性历史上不可靠。
- 当前可行路线需要独立的 microphone permission + local/native STT 生命周期（例如现有 ASR 复用或经过审计的 Tauri/local Whisper bridge）。
- 该能力单独进入后续 device-runtime slice；在完成模型/权限/任务生命周期和真实 native smoke 前不计入 parity 完成。

## 下一步

1. 补跑真实 Finder/Explorer 跨窗口拖入，并核对 drop 后 `media_id / clip_id` 与共享产物路径安全。
2. Final Cut Pro 可用时执行 authoritative FCPXML import smoke；在此之前保持 `NOT RUN`。
3. 语音听写独立分支实现，不与当前 parity source candidate 混为一体。
4. Finder drop 与适用的 FCP smoke 完成后，才重新评估 Stage 18 关闭与 integration/squash 路径。

## 状态维护规则

- `STATUS.md` 只保留当前事实，不继续堆阶段实现日志。
- 长期决策进入 `DECISIONS.md` / `INVARIANTS.md`。
- 历史验收证据进入 `docs/verification/`。
- 未进入当前工作包的事项进入 `BACKLOG.md`。
