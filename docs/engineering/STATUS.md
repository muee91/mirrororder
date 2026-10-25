# Engineering Status

更新时间：2026-10-26

## 当前基线

- 仓库只维护 `main`；本轮验证基线 HEAD `6386bf3`，与本地 `origin/main` 引用一致；审阅闸门修正与 2026-10-26 结构收敛轮（见下）尚在工作树。
- 本轮远端 CI：**NOT RUN**，不沿用旧提交的 CI 结论。
- Desktop 仍处于 Product Recovery 之后的**可交付化阶段**：代码结构恢复已收口，缺口在发布工程、授权与真实可用性证据（顺序见 `BACKLOG.md` Phase 0/1/2）。
- 一级工作区固定：`素材 / 剧本 / 时间线 / 审阅`；原则仍是**共享对象，不共享工作流**。

## 2026-10-26 组接 + 导出收缩轮（owner 拍板后执行，已实跑验证）

- **时间线工作区收缩为「组接 + 导出」**：移除帧级精修 UI——Source 面板的入/出点标记与插入/覆盖视频音频动作、Inspector 的「精修与技术操作」块（切分/入出点 ±1f/停用/波纹删除/移动）、Stage 工具条的撤销/重做/保存/标记。保留初始顺片、只读轨道预览（选择 + 播放头）、Source/节目双监看 + JKL + 波形（owner 裁决：监看为组接核对所需，保留）、换镜次与多机位决定（经 command bridge 写 Rust Timeline Core）、交付抽屉升为标题栏主按钮。随删死代码：`timelineAudioEditing.ts`、`buildManualSourceCommand`/`insertCutsExistingClip`、markIn/markOut、undo/redo/checkpoint/split 客户端函数、model 中 sourceIn/sourceDuration/moveStart/插入阻塞推导，及对应孤儿 CSS；`api/timeline.ts` 与 Rust/Python 编辑命令未动（未来模块化剪辑的接口面）。`editorLocalizationContract` 新增"精修不回到时间线工作区"的反向断言。
- **死 v1 并行导出路径删除**：`timeline_delivery.py` / `timeline_delivery_sync.py` / `timeline_audio_delivery.py`（约 986 行）+ 3 个 v1 专属测试。事实修正：v1 入口确无生产调用方，但其私有 helper 被活链路 `nle_delivery` 引用——已原样提取为 `nle_delivery/delivery_support.py`，活链路四个测试改为从包导入。
- **文档同步**：五步主链第 5 步改为「组接并导出到外部 NLE 继续剪」（README / IA / BACKLOG）；`app-information-architecture.md` §3.3 时间线改写为组接+导出定位（镜序不承担帧级精剪，交付为主终点动作）。
- 本轮验证（全部实跑）：`check_python` exit 0；`check_fast` exit 0（含 Rust 持久化契约 + cargo check）；`tsc --noEmit` exit 0；Vitest 75 文件 / 371 项全过（较上轮 -2 文件 -8 项，均为被删 v1/手动编辑行为的专属测试）；`test:ux-real` 9/9。
- LICENSE（Apache-2.0）与 NOTICE、`pyproject.toml` 真实依赖声明已于 `5f8ed25` 落地，本轮仅确认。

## 2026-10-26 媒体词汇收敛与机位槽位三态（切片 1 收尾 + 修复顺序④⑤，已实跑验证）

- **失败文案全面收敛**：场记（GoldenSlate）与素材库右栏的播放失败详情改用共享 `playbackFailure` 分类器（缺失/解码/连接），与 Take 详情、时间线双监看同一词汇；标题保留各面锚点（ux-real 门与安全契约断言不变，契约同步到新 onError 形态）。至此五个面的媒体失败提示共享一套原因与指引。
- **机位槽位三态**：Take 列表行与完整卡片的机位槽位区分 `无素材`（该机位未拍摄）/ `素材离线`（有素材但服务端判定不可用，警示色 + “离” 标记）/ 可用（含部分离线标注）。走查中“空白占位分不清没拍还是出问题”的问题消除。`takeSlotAvailability` 导出共享。
- **状态词汇表与字号下限入 authority**（`design-system-v2.md` §5/§6.1）：需关注三层（阻断/证据过期/待关注）与媒体四口径（无素材/素材离线/本机播放失败×三因/声明可用未验证）成为唯一用词，禁止再造同义分叉；`10px` 降为历史存量、新代码与被触碰表面 11px 起、辅助灰字对比度 AA。
- **量化债**：低于 10px 存量下限的字号仍有 157 处（8/9px，分布 20 个 CSS 文件）——盲扫有挤爆紧凑组件风险，按“随表面触碰迁移到 11px”执行，另设带截图验收的专项清偿。素材库列表行决策字段（时长/分辨率/场景/Take 关联）受 `MediaInventoryItem` 投影限制（仅 6 字段），补字段需服务端扩展投影，记为服务端前置项。
- 验证：tsc exit 0；Vitest 77 文件 / 379 项全过；`test:ux-real` 9/9；`test:layout-runtime` desktop + compact OK。

## 2026-10-26 媒体失败态补齐（恢复切片 1 的 UI 侧，已实跑验证）

- **共享失败分类器 `media/playbackFailure.ts`**：`video.error` 分不清 HTTP 404（素材缺失）与解码失败（Chromium 都报 code 4），报错后用一次 1 字节 Range 探测把失败分为 缺失 / 解码失败 / 连接失败 三种可行动原因（仅在 video 报错后调用，不进正常读路径）。行为单测 3 组覆盖 206/404/403/410/500/网络异常。
- **EditorMonitors 双监看失败态（此前完全无提示黑屏）**：素材/节目监看的 `<video>` 报错后显示失败卡——分类标题、行动指引、当前素材名、重试、以及「到素材·恢复」入口（`onOpenRepair` 经 TimelineWorkbench/View/SourcePanel 从 ProjectWorkbench 的 `navigate("media-binding")` 接入）。素材切换即复位失败态，重新挂载后不残留旧失败。
- **Take 详情（含审阅 Viewer）接分类详情**：失败卡标题保持「素材无法读取」（ux-real 门的 404 断言锚点），详情行改为分类结果——404 给出挂载指引、可达但解码失败给出编码指引、Host 不可达给出服务指引。
- 遗留（并入切片 1 后续）：场记（GoldenSlate）与素材库右栏的失败文案收敛到共享词汇；「未知/已验证可用/缺失/解码失败」四态在五工作区的完整统一投影。
- 验证：tsc exit 0；Vitest 77 文件 / 379 项全过（新增分类器 3 项）；`test:ux-real` 9/9；`test:layout-runtime` desktop + compact OK。

## 2026-10-26 UI 计数口径统一（修复顺序②，已实跑验证）

- **审阅「需关注」分层**：`reviewTakeAttention` 投影新增 `tier`（blocking=error 级 / stale=证据过期 / watch=其余），审阅头部条件显示 阻断/证据过期 计数、筛选按钮 aria 读出三层分布。fixture 数据（668 Take 全部 warning、668 条「自动决策落后」= 项目级过期）此前让 全部=未决定=需关注 三计数相同；分层后该状态可解释为「证据过期 668」。
- **Take 汇总双层口径**：服务端 `available=false`（改名「素材离线」，与筛选 chip 同词）与本机运行时加载失败（Take 详情 video onError 上抛 → 新增「本机播放失败 N」计数）分开呈现；实测 fixture `available=false` 为 0 而详情 404 报错，两层不再互相冒充。
- **素材库过期清单标注**：`scan_required` 时汇总条降透明度并加「上次清单 · 当前需要重新扫描」整行标签，数字不再以当前状态呈现（修复「尚未扫描 vs 1502 可索引」同屏矛盾）。
- 验证：tsc exit 0；Vitest 76 文件 / 376 项全过（新增 reviewAttentionTier 行为测试 4 项 + 契约分层断言）；`test:ux-real` 9/9。
- **操作者首次引导**：未设置且未引导过时，`CurrentOperatorControl` 首次挂载自动弹出一次，可“暂不设置”（记忆在 device-local）；未设置 chip 文案改为行动性的「设置操作者」并在弹层说明后果。验证同轮：tsc / Vitest 376 / ux-real 9/9。
- **已知 CI 抖动模式（记录，不改门）**：run 40231676152 的 ux-real 门报「媒体解码错误 4」——无头 Chromium 在 CI 负载下偶发无法解码合成 WebM；本地 9/9 无法复现，重跑同 job 即绿。与 2026-10-26 早前修掉的采样竞态（原子化已修）是两种不同失败：本例是环境解码，不弱化门的红线，仅记录观察频率。

## 2026-10-26 结构收敛轮（已实跑验证）

本轮目标：全栈子功能核查 + 收敛无序扩张，不新增产品面、不做 package migration。

已落地并验证的收敛：

- **时间线面板链类型断裂清零**：`TimelineWorkbenchView / StagePanel / SourcePanel / InspectorPanel / SuggestionsPanel / InitialAssembly` 的 6 处 `props: { [key: string]: any }` 全部改为从三个 hook 的真实返回类型（`timelineWorkbenchProps.ts` 组合的 `Pick`）推导；顺带删除面板内可推导的 `(item: any)/(clip: any)/(track: any)/(angle: any)/(suggestion: any)/(issue: any)`，并为 Stage/Source/Inspector 补上 `snapshot/sequence` 空值守卫——此前 any 掩盖了“仅在非空时挂载”这一契约。`grep "\[key: string\]: any" desktop/src` 现为 0 命中。
- **errorMessage 17 处重复收敛**：16 份逐字相同的本地实现 + Delivery 的子集实现统一为 `api/host.ts` 的单一导出（与 `HostConnectionError` 同址）；editor 域 `timelineWorkbenchSupport.errorMessage` 因行为不同（解析 `{message, issues[]}` 载荷）保留不动。
- **页面 canonicalize 单一 owner**：`ProjectWorkbench.safeProductionPage` 不再复制旧页面映射，改委托 `resumeState.canonicalProductionPage`；`App.tsx` 页面标题表删除 6 条永不可达的旧键（attention/overview/coverage/rough-cut/assembly/delivery）。`swiftGoldenParity` 的源码文本断言同步改为断言“委托存在 + 映射仍在 resumeState”，行为红线由 `resumeState.editorMigration.test.ts` 继续以真实调用覆盖。
- **删除一处无引用脚本**：`desktop/scripts/ux-probe.mjs`（dev-only 一次性探针，不在任何 npm script）。
- **拒绝两笔误删**：`web/automation.js` 是被 3 个契约测试锁定的注入桥（有意不进 bootstrap），不是死代码。`timeline_delivery_sync.py`/`timeline_audio_delivery.py` 初判为“已建未接线能力”**有误**（2026-10-26 深挖修正）：它们与 `timeline_delivery.py` v1（同样零引用，552 行）同属被 `nle_delivery` IR 路径取代的死并行导出实现；**独立音轨与多机位同步导出在活链路已完整实现**（IR 每角度 sync 帧 → FCPXML connected audio / mcAngled、Premiere typed range 换算，Rust 模型携带并校验同步帧）。裁决记录见 BACKLOG。
- **无调用方端点复核**：`POST /api/v1/agent-tokens` 有 `_local_only()` 保护且与 CLI `agent-token-create` 对等，保留；`workspace-database`、`intelligence-settings` 仅测试使用，维持现状并记录。

本轮验证（全部实跑）：

- `python3 scripts/check_python.py` exit 0；`python3 scripts/check_fast.py` exit 0；`python3 scripts/check_full.py` exit 0（含 614 Python / 379 Vitest / tsc / build / cargo；终态复跑再次 exit 0）。
- 改动后复跑：`npx tsc --noEmit` exit 0；`npx vitest run` 77 文件 / 379 项全过；`npm run build` 成功；`test:layout-runtime` 桌面 + compact 视口 OK；`check:ui-authority` OK；`check:baseline` OK；`test:ux-real` 9/9（连续 5 次）。
- 三个源码文本契约（`swiftGoldenParity.test.ts`、`test_product_surface_contract.py`、`test_production_review_boundary.py`）中锁定 workbench 内联归并映射的断言，已同步改为断言“workbench 委托 `canonicalProductionPage` + 映射仍在 resumeState”；归并行为本身由 `resumeState.editorMigration.test.ts` 以真实调用继续覆盖。
- **抖动已修**：`test:ux-real` 的「media 404 remains a playback failure」曾约 5 次运行失败 1 次——`verifyReviewPlayback` 在等待命中后二次取值，与 React 在媒体错误后的 remount 竞态，404 被读成“duration 无效”。已改为 `waitForFunction` 命中轮次内原子采样载荷；修复后连续 5 次运行 9/9。
- 用户角度读路径抽查：Host（`mirrororder-host`）loopback 启动，21 个只读探针全 200（项目/剧本/groups/review/review-model/editorial/script-supervisor/media-binding/media-inventory/coverage/assembly-timeline/assistant/tasks/device-tasks/desktop-status/desktop-local-runtime/desktop-collaboration/settings/semantic-search 等）。实测单项目载荷：`review-model` 4.3 MB、`groups` 1.0 MB、`media-binding` 508 KB、`tasks` 406 KB——为 BACKLOG“重复重拉”债提供了量化基线。未做任何写入。

## 审阅主链恢复（当前事实）

- **队列为空已归因于闸门选择器误报**：canonical compact row 是 `article.mo-take-list-row[data-ui-authority="take-compact"]`，旧闸门未识别。两个本机项目实际有 668 / 610 个未作最终决定的 Take，默认筛选为“全部”；fixture 与真实 React App 入口的 Take ID 序列一致，均能连续切换 1→2→3。
- `check:ux-real` 已修正队列识别并验证 selection 与 Viewer 一致；使用 `MIRRORORDER_UX_PROJECT_ID` 选择项目，fixture 从 Host 读取项目摘要。媒体 metadata 与播放时间推进是单独的**必需**项，缺媒体不能被队列通过掩盖；未执行的人工写入和原生验收显式记录为 NOT RUN。
- 两个真实项目复跑：队列与导航 PASS；媒体播放 FAIL，退出码均为 1。素材盘当前不可用，owner 已明确暂缺真实素材，先完成独立验证。真实看片、人工决定、完整五步主链和打包应用验收仍为 **NOT RUN**，未改写项目 authority 或设备绑定。
- `npm run test:ux-real`：9 项真实 ReviewWorkspace 行为测试通过，使用最小合成 Take/WebM，覆盖空队列、无效 Next、媒体 404、metadata 后播放停滞和播放启动超时；旧选择器已实测让正向用例失败。CI 已配置运行这组回归，远端执行结果仍是 NOT RUN。
- 本轮独立验证：`python3 scripts/check_full.py` exit 0，包含 614 项 Python、77 文件 / 379 项 Vitest、15 项 Timeline Core、33 项 Host，以及 TypeScript、前端 build、cargo check；UI authority 与 layout runtime 通过。`check_python.py` 的 78 项检查已通过；`check_fast.py` 未单独重跑，打包后的原生验收仍为 **NOT RUN**。
- 审阅 Node 回归与 layout 并行运行曾因共享 Vite 预构建缓存而挂载超时，已受控复现 `504 Outdated Optimize Dep`；回归脚本隔离临时 cacheDir 后，两组再次并行均 exit 0，审阅 9/9 通过。全量 source gate 是缓存隔离前执行，修正后验证限于这两组。

## 子功能审计（当前事实）

- 真实 React App + 本机 Host 下检查两个项目，覆盖 45 项子能力及 22 个界面步骤；35 个 GET 探针和 6 个交付读取均 HTTP 200，只证明读取成功。未执行真实项目的创意决定、重绑、删除或导出写入，也未主动调用外部 AI 发送项目内容。
- **媒体就绪状态不可信**：同一素材列表“可播放”、Inspector“无法播放”；恢复页 0/1502 可用，Take 仍显示离线/异常 0。列表把播放 URL 存在视作可播放，Take 把省略的 `available` 视作可用；场记 404 提示仍断言已经定位成功。
- **EditorMonitors 失败恢复缺失已复现**：合成 404 挂载真实组件后，Source/Program 没有应用级失败原因、重试或恢复入口；浏览器控件自身有无法播放语义。
- **摘要与状态存在口径冲突**：项目侧栏与卡片“需关注”分别为 68/668、46/607；历史中断任务缺少 completed_at 时，耗时仍以当前时间增长；团队入口的“不能改剧本归集”与受限 reviewer placement contract/实现不一致。
- **读路径隐含重工作**：`GET media-binding` 调用 `DeviceMediaStore.summary()`，受控 3 个小文件触发 3 次未缓存内容指纹计算；大项目冷缓存 I/O 尚未量测。
- 两项目 assembly 均 `needs_review`、timebase 为空。原生 Timeline UI、真实音画/同步/ASR、外部 AI 质量、双机与 NLE 实际导入均 **NOT RUN**；不能把浏览器 native 限制当作已确认的产品缺陷，也不能把 source gate 通过当作主链完成。

以下修复轮记录不替代上述当前验证范围。

## 2026-10-25 修复轮（已复核，非自述）

审计后落地的 6 个提交（`a44327b..8e26b0a`）逐条独立验证，结论如下。

真实修复：

- **局域网无鉴权写人工 authority 已收口**：`cli.py` 的 `serve`/`gateway` `--host` 默认改 `127.0.0.1`，启动脚本同步收紧。实测默认参数启动后 `lsof` 只有 `127.0.0.1` 监听、局域网 IP 连接被拒；`_require_review_access` 从空函数变为非回环来源 403，网关子类改为配对 session + `reviewer` 角色；新增 `tests/test_web_security_boundary.py` 为行为测试（含 IPv4-mapped 回环判定、配对 429 节流、64 bit 配对码）。
- **CSP** 从 `null` 改为默认拒绝（`object-src 'none'`、`base-uri 'self'`、`form-action 'self'`）。
- **npm 供应链**：`desktop/package-lock.json` 入库，201 个 package 缺 integrity 数为 0；CI 改 `npm ci`；可选依赖钉版本。
- **CSS canonical 所有权**：六个全局层中针对 `.mo-media-card / .take-card / .take-list-row / .script-block / .slate-row` 的选择器命中数实测为 0，对象自有样式表建立。
- **假视口门**：`check-layout-runtime.mjs` 改为真实越界断言（`innerWidth` 漂移检查、`documentWidth <= innerWidth`、9 个盒子 `getBoundingClientRect`）；compact 视口 1024→1180 的依据核对为真（`tauri.conf.json:19` 与 `styles.css:12` 均为 1180）。
- **死代码与版本链**：`legacy.py`/`multicam.py`/`html_renderer.py` 删除；新增 AST 级版本族私有实现边界守卫。
- **一处测试实质改善**：`test_automation_creative_boundary.py` 从源码 grep 重写为真实调用 `resolve_project`/`ReviewStore`/`EditorialStore` 的行为断言。
- **第一份用户文档** `docs/user-guide.md`：抽查其界面承诺（`Shift+F10`/`ContextMenu`、工作区重新定位、状态中心）均在源码中存在。

仍不完整（不要当成已解决）：

- 显式 `--host 0.0.0.0` 时**读接口与素材 range 下载仍无鉴权**（实测可取回 workspace 数据）。
- `release_gates` 的强制逻辑未变：`check-baseline.mjs:33-35` 仍只断言字符串等于 `"required"`；18 个门中 9 个 macOS/Windows 原生门零实现。
- `Cargo.lock` 仍未入库（排除依据还是本地 `.git/info/exclude`）；`pyproject.toml` 仍无 `dependencies`。
- 无 LICENSE、无 CHANGELOG、无 updater、无 tag。
- `stage-runtime.mjs` / `verify-macos-bundle.mjs` / `host.rs` 本轮未触及：打包内容黑名单、`.pyc` 写回 bundle、`base_executable` 指回构建机、三棵 Python 树冗余全部仍在。
- Phase 2 的体验项未动：review-model 无共享缓存、项目页逐项全量拉取、`EditorMonitors` 无播放失败态、时间线区 3 处 `{[key: string]: any}`。

## 自动 gate 状态（2026-10-25 本机实跑）

| 命令 | 结果 |
|---|---|
| `python3 scripts/check_fast.py` | exit 0 |
| `python3 scripts/check_full.py` | exit 0 |
| `python3 -m pytest -q` | 614 passed（基线 587 + 新增 27），142.53s；其中单用例 `test_core.py:606` 占 134.33s |
| `npx vitest run` | 77 files / 373 passed |
| `npx tsc --noEmit` | exit 0 |
| `vite build` | 成功；JS 598.73 kB、CSS 296 kB（Rollup 500 kB 提示为既有非阻塞告警） |
| `cargo test`（timeline-core / host） | 15 passed / 33 passed |
| `python3 scripts/check_python.py` | 78 passed（注意：它只跑 14 个 contract 文件，不是全量） |
| `./script-organizer serve --help` | exit 0（README 记录的启动方式已可用） |

执行环境为 macOS arm64 + Python 3.14 + Node 22/24；**CI 目标为 Python 3.11**，两者在未声明的可选依赖上走不同分支，本表绿灯不等价于 CI 绿灯。

## NOT RUN（不得写成 PASS）

- `tauri build` 的 macOS/Windows 产物、签名与公证；`.dmg` 完整性；Windows 全平台分支（从未编译）。
- 在制真实项目（本机 `projects/` 下，不入库）五步主链真机验收；真实媒体播放、多机位同步精度、Final Cut / Premiere 导入。
- 远端 CI 在当前 HEAD 上的运行；Team Gateway 双机配对与 30 秒真实冷却；CSP 真机效果；CSS 迁移的像素级对比。
- 大规模 Take（数百到数千）下的前端性能与 Timeline 内存曲线。

## 本轮仓库整理（同日）

- 删除可再生产物：541 个 `__pycache__`、4 个 `.DS_Store`、create-dmg 中断残留的 478 MB `rw.*.dmg`、空壳目录 `.v2c`/`out`；按 owner 决定执行 `cargo clean`（`desktop/src-tauri/target` + `crates/timeline-core/target`），仓库体积 6.1 GB → 754 MB。冷重建代价实测为 `cargo check` 33.7 秒。
- **保留**：`projects/`（真实项目数据，仍被 gitignore）、`.workspace/`（运行态与各轮修复的过程记录）、`desktop/src-tauri/resources/mirrororder-*`（480 MB 运行时暂存，`cargo clean` 不触及，重新打包仍可复用）。
- `.gitignore` 补齐外部工具留下的未跟踪杂物（`.zwork/`、`.video_agent/`、`.v2c/`、`out/`）。
- 一次性审计/验证报告不再进源码 Git：`docs/verification/` 已移除，历史记录移到 `.workspace/audits/2026-10-25/`；`docs/README.md` §6 与 `docs/architecture/repository-layout.md` 之间「是否允许 verification/」的相反规则已统一为前者。
- 文档命令修正：`README.md` 与 `AGENTS.md` 的 gate 命令 `python` → `python3`（本机不存在 `python`，原命令实测 exit 127）；`desktop/README.md` 新增打包 runtime staging 所需变量与已知良好来源。
