# 工程接手约束

## 当前产品主线

- `main` 上的 `desktop-v2/` 是镜序唯一 Desktop 实现。
- Desktop v2 = **React / TypeScript Production UI + Tauri 2 / Rust 平台层 + Rust Timeline Core + 现有 Python MirrorOrder Core**。
- 旧 `macos-app/` SwiftUI 客户端已经按 owner cutover 决策从 `main` 物理删除；**禁止恢复、复制或继续维护旧 SwiftUI 产品线**。
- Team Web 继续作为独立轻量 Review / Projection 面，不是 Production 主画布。
- 重功能默认独立 module / branch / worktree；当前 runtime packaging workstream 为 `feat/desktop-v2-runtime-packaging`。

## 写代码前

- 理解现有实现、调用链、状态流和权威边界后再改。
- 先读 `README.md`、`desktop-v2/README.md`、`DESKTOP_BRIDGE.md`、`SYNC_MODEL.md`、`AUTOMATION_PIPELINE.md`。
- Desktop cutover / 发布相关再读 `desktop-v2/phase7-parity.json`、`docs/desktop-v2-phase7-cutover.md`。
- runtime packaging 只在对应独立 workstream 中处理，并先读 `docs/desktop-v2-runtime-packaging.md`。
- 涉及 AI 审计、人物/声纹、算法迭代或粗剪准备时再读 `docs/ai-audit-learning-loop.md`。
- 涉及镜序助理、模型连接、Agent API 或自动生产编排时再读 `docs/assistant-orchestration.md`。
- 检查运行服务、项目配置、当前输出、`auto_decisions.json`、`review.json`、`editorial.json` 和已有 `audit.json`。
- 不确定时先给出证据和不确定点，禁止猜测式修改。

## 数据权威

- Python MirrorOrder Core 继续拥有 workspace/project、Review、Slate、Identity、Assistant、AI proposal、media identity/binding、FCPXML/delivery 等业务权威。
- Rust Timeline Core 是本机时间线 edit state 的唯一权威。
- React/TypeScript 是交互层，不得成为第二套业务状态或 Timeline source of truth。
- Python 不得绕过 command bridge 直接修改 Rust Timeline state。
- 当前生产自动判断只使用正式项目输入、ASR/分析缓存和人工 Review；禁止把 CSV、旧素材清单或旧 HTML 结果重新接回生产 matcher。
- `projects/beef/legacy_overrides.json` 仅为历史归档，不得重新接入牛肉项目分析。
- 人工结果永远高于自动结果。
- 系统不得自动 Reject 素材。
- 自动确认写 `auto_decisions.json`，不得伪装成人工审核，也不得直接写 `review.json`。
- `audit.json` 是可重建的只读审计证据，不是生产判断权威。
- `learning_cases.jsonl` 只用于离线 replay/eval/算法研发，生产 matcher 禁止读取它形成隐式反馈环。
- `assistant.json` 是可重建派生状态，不是 Review、Editorial Decision 或 Delivery 权威。

## AI / 自动整理权限链

统一遵守：

```text
evidence → proposal → human confirmation → authority
```

- AI proposal 不得自动落入 authoritative edit state。
- 默认产品目标是“自动完成，人工只处理异常”，不是让每个 Take 都人工点一次。
- `prepare_project` 是主机生产流水线：媒体目录同步 → FCPXML → ASR/剧本分析 → 自动确认/AI Rescue；不默认全量运行 Shadow Audit。
- 高置信度自动确认的语义默认是剧本归属/`keep`，不是创意意义上的“最佳镜头”。
- AI Rescue 只在低置信度/歧义时调用可选模型，不得默认把全项目 Take 发给大模型。
- AI Rescue 只能在本地算法给出的候选集合中选择，禁止自由发明位置。
- AI Rescue 结果必须再次经过本地最低分数、候选合法性和前后剧本顺序校验；失败则进入 `needs_review`。
- Shadow Audit 只能写 `audit.json` / `learning_cases.jsonl`，不得写 Review / Editorial / auto decisions。
- Audit `agree/disagree/insufficient_evidence` 不是新生产状态。
- 未配置模型 Provider 时主流程仍必须离线可用。
- Provider API Key 不得进入 workspace、project.toml、Review、Audit、Editorial 或可同步产物。

## 镜序助理、模型与 Agent

- 镜序助理是 Host 上方的受限生产编排层，不是拥有任意文件系统/审核写权限的通用 Agent。
- Assistant Orchestrator 只能执行 `AgentToolRegistry.SAFE_ACTIONS` 中登记的第一方工具。
- 新工具必须显式定义参数上限、写入边界、权限和测试。
- 高成本任务必须 bounded/scoped；禁止用“AI 接管”为理由默认全项目重算。
- `run_priority_audit`、`extract_visual_evidence`、`index_unknown_identities` 只能补证据，不得直接形成 Best/Reject/人工 placement/Editorial Decision。
- 模型生成的 tool name / arguments 必须由 Host 再次校验；未知工具拒绝。
- 模型连接和 API Key 属于设备本地状态；普通 Team Web 不得获得模型配置、API Key、Host runtime 或 App 助理聊天记录。
- 外部 Agent API 继续使用 Bearer + `read/analyze/propose` scope；不能直接写人工审核。

## 人物、声纹与角色推断

- 人物/声纹 embedding 与 cluster 属于设备本地感知数据；人工角色名是高优先级元数据。
- 已人工确认的人物/声纹身份不得因模型版本、profile 变化、普通重跑或局部重跑而被自动擦除。
- 只有明确的开发者强制重建才允许重新索引已完整人工确认的身份组。
- speaker cluster + 已可靠剧本归属可以提出角色候选，但必须 `requires_confirmation=true`。
- 多机位画面中的人不一定是正在说话的人；禁止仅凭台词角色给当前 camera face cluster 自动命名。
- Face → 角色默认保持人工确认；没有可靠 active-speaker / lip-motion / audio-visual binding 时不得自动关联。
- 人工已确认角色在素材卡上优先于候选。

## 多设备与本机素材

- `clip_id` = 项目/FCPXML occurrence；`media_id` = 物理媒体身份，二者不得混用。
- 跨设备素材身份使用 `media_id`；绝对路径不是共享身份。
- 有源文件可读时 `media_id` 必须由内容指纹产生；`MP_...` filename identity 只允许旧项目迁移 fallback。
- 每台设备自己的 media roots / bindings 保存在设备状态目录，不得写进共享 workspace。
- 默认设备状态目录：
  - macOS: `~/Library/Application Support/MirrorOrder`
  - Windows: `%APPDATA%/MirrorOrder`
  - Linux: `$XDG_CONFIG_HOME/mirrororder`，缺省 `~/.config/mirrororder`
- 不得把卷名、Finder/Explorer 路径、本机素材根目录写进 `material_index.json`、`review.json`、`audit.json` 或共享 project config 作为权威字段。
- HTTP media playback 必须优先解析当前设备 binding；缺媒体明确显示，不能偷偷匹配错误同名文件。
- 同内容媒体移动、改盘符、改目录甚至改名后，正式 `media_id` 应保持一致。
- 改多设备逻辑前先读 `SYNC_MODEL.md`。

## 多机位与 FCPXML

- 多机位同步/NLE XML 使用仓库内 `vendor/multicam-audio-sync` 第一方确定性引擎；不得依赖 Codex 私有技能或用户目录外部项目才能运行。
- 不修改原始 FCPXML，不重建或破坏已有同步关系。
- 媒体目录项目允许生成新的 `output/sync/synchronized.fcpxml`，不得覆盖用户已有 FCPXML。
- `organized.fcpxml` 默认必须与输入文件保持结构安全；当前 delivery decision 继续通过 `selection_manifest.json` 表达，除非有明确的结构安全 writer。
- 长素材按有效片内范围复用，禁止复制原始媒体。
- A/B/C 展示顺序不得打乱。
- Shot Intelligence 是 `clip_id` 级属性，不是 Take 全局属性；同一 Take 允许 A=全景、B=近景、C=特写。
- FCPXML 兼容要求至少覆盖 1.8 `asset src`、1.9+ `media-rep`、主 spine 隐式顺序和 multicam/media resource 引用。
- `MIRRORORDER_MULTICAM_SYNC_ROOT` 只能作为明确开发覆盖；发行版 runtime 来源由 packaging contract 管理，不能暗中依赖开发机目录。

## Desktop v2 架构

当前唯一 Desktop 入口是 `desktop-v2/`：

```text
React / TypeScript
        ↓ typed contracts
Tauri 2 / Rust
  ├─ Production Host lifecycle :8765
  ├─ Team Gateway lifecycle    :8766
  ├─ native dialogs / reveal / URL / FCP adapter
  └─ Rust Timeline bridge
        ↓
Python MirrorOrder Core + Rust Timeline Core
```

- 不得恢复 `macos-app/` 或新增第二套 SwiftUI 客户端。
- 不得以“复用旧版”为理由重新把 Production UI 放回 WKWebView/WebView shell。
- Team Web 是独立 top-level workspace，不是 Production project tab。
- Production Host 与 Team Gateway 是两套独立进程 manager；停止一个不得影响另一个。
- Host/Gateway `spawn()` 不等于 ready；只有预期 TCP 端口真实监听后才报告成功。
- 媒体视频/代理帧不得通过 Tauri JSON/Base64 IPC 大量搬运；视频走现有 HTTP media path/Range 或后续明确的 native media adapter。
- 原生 dialog/filesystem/platform 能力保持窄 adapter；不要把业务规则写进 Rust platform module。

## Timeline Core

- Rust Timeline Core 是 authoritative edit state；React 只发 commands/读 snapshots。
- 已有命令：Insert、Overwrite、Move、Split、Trim、RippleDelete、Disable、MulticamSwitch、SetMarker、Undo/Redo。
- Timeline persistence 使用 checkpoint + append-only journal + crash recovery；不要让 React 自己保存 authoritative Timeline JSON。
- Rough Cut / AI 只能生成 proposal；只有明确 human-confirmed selection 才能转换成 Rust commands。
- 当前 24fps seed 是 provisional fallback，不得冒充项目 native timebase。
- 新的鼠标/键盘/NLE/importer 入口都应归一化为 Rust commands，而不是旁路修改状态。
- Source/Program Monitor 当前是 proxy/WebView transport；native A/V clock 是否完成必须以真实平台 smoke 为准。

## Team Web 边界

Team Web 允许：

- browser Review workspace
- gateway HTTP media playback
- individual opinion / review collaboration
- safe assistant review summary

Team Web 不得获得：

- 本机绝对素材路径
- 项目创建/删除
- 本机素材绑定
- Production Timeline authority
- 模型/runtime secrets
- Host-local Final Editorial Decision

Gateway 的 LAN/pairing/trusted-LAN 语义继续由 Python Core 提供；Tauri 只负责生命周期和打开链接。

## 前端产品约束

- 这是剪辑工作台，不是算法展示页。
- 默认按剧本时间轴组织素材。
- 剧本、素材列表、播放器应保持可独立浏览/滚动。
- 文件名和机位是素材卡最重要信息；景别是克制的次级标签。
- A/B/C 机位事实不得合并成 Take 全局景别。
- 已确认角色优先显示；未确认角色必须明确写成“候选”。
- Audit 问题可以展示，但不得与人工 Best/Keep/Reject 混成同一 authority 状态。
- `episode-only` 是合法、完成的人工 placement，不得误标成 pending。
- candidate、pending、placed、rejected 必须保持独立语义。
- 不要为了展示算法细节把制作主画布变成 debug dashboard；诊断信息放设置/状态或独立 inspector。

## 重功能隔离 / worktree 规则

以下能力默认先独立 module + branch/worktree：

- runtime packaging
- portable Python / media toolchain
- 重媒体处理 / proxy generation infrastructure
- 新 NLE adapters
- model runtime infrastructure
- 实验自动化引擎

只有同时满足以下条件才并回 Production 主工作区：

1. typed contract 明确；
2. authority/ownership 明确；
3. failure isolation 明确；
4. 本地测试与 native smoke gate 明确；
5. 不复制 Python business logic；
6. 不把 Production project tabs 当插件垃圾场。

## Runtime packaging

- 主 packaging workstream: `feat/desktop-v2-runtime-packaging`。
- 发行版目标至少显式携带：MirrorOrder Python Core、Python 3.11+、numpy/pandas/scipy、ffmpeg/ffprobe、第一方 multicam engine。
- packaged mode 必须 fail-closed，不得静默 fallback 到系统 Python/FFmpeg。
- portable runtime staging 必须验证依赖、self-contained symlink、复制后的 relocation。
- 可选模型、llama-server、ASR/CV/声纹后端和 model weights 默认保持 optional/on-demand；不要为了“自包含”无限膨胀基础安装包。
- packaging 不得通过新增 Production tab 或复制业务逻辑解决。

## 本地验证与发布门禁

GitHub Actions 没有额度时不影响开发；不要依赖 Actions 才能继续。

主线本地验证优先：

```bash
cd desktop-v2
npm install
npm run verify:rc
```

或逐项：

```bash
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cd ..
pytest
```

- 禁止声称没有实际执行的测试已通过。
- 不允许为了过 gate 删除/降低断言，除非产品语义确实改变并有明确证据。
- 修真实 bug 时补对应回归测试。
- SwiftUI 已删除，不再作为 rollback client；Desktop v2 的 bug 直接在 Desktop v2 或对应 isolated workstream 修。

仍需真实机器验证的 release gates 以 `desktop-v2/phase7-parity.json` 为准，至少包括：

- macOS / Windows `cargo tauri build`
- packaged Python Host
- packaged ffmpeg/ffprobe + multicam sync
- real media playback
- Timeline persistence/recovery smoke
- Team Web 第二设备 LAN pairing/trusted-LAN smoke
- macOS Final Cut import + signing/notarization
- Windows WebView2 / installer/update smoke

## 最后原则

- 不恢复旧 SwiftUI。
- 不重写 Python Core 到 TS/Rust。
- 不让 AI 越过人工确认。
- 不让 React 成为第二套 Timeline authority。
- 不把本机路径写回共享项目事实。
- 不把重功能硬塞进主工作区。
- 先修真实 blocker，再做架构美化。
