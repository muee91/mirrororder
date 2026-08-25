# 镜序工程接手约束

## 当前基线

- `main` 是唯一开发基线。
- Desktop 客户端位于 `desktop/`。
- Desktop = **React / TypeScript Production UI + Tauri 2 / Rust 平台层 + Rust Timeline Core + Python MirrorOrder Core**。
- Team Web 是独立轻量 Review / Projection 面，不是 Production 主画布。
- 不恢复已删除的旧 Desktop 产品线，不建立第二套客户端。
- 重功能默认独立 module + branch/worktree；当前保留 `work/runtime-packaging` 与 `work/auto-score`。

## 写代码前

先读：

- `README.md`
- `desktop/README.md`
- `desktop/development-baseline.json`
- `docs/desktop-development-baseline.md`
- `DESKTOP_BRIDGE.md`
- `SYNC_MODEL.md`
- `AUTOMATION_PIPELINE.md`

涉及 AI 审计、人物/声纹、镜序助理时，再读对应 `docs/` 文档。

不确定时先给证据和不确定点，不做猜测式修改。

## 权威边界

- Python MirrorOrder Core 拥有 workspace/project、Review、Slate、Identity、Assistant、AI proposal、media identity/binding、Team Web security/review、FCPXML/delivery 等业务权威。
- Rust Timeline Core 是本机时间线 edit state 的唯一权威。
- React/TypeScript 是交互层，不得成为第二套业务状态或 Timeline source of truth。
- Python 不得绕过 command bridge 直接修改 Rust Timeline state。
- Team Web 不得获得 Production Timeline authority、本机路径、模型 secrets 或 Host-local Final Editorial Decision。

统一 AI 权限链：

```text
evidence → proposal → human confirmation → authority
```

AI proposal 不得自动落入 authoritative edit state。

## Review / 自动整理

- 人工结果永远高于自动结果。
- 系统不得自动 Reject 素材。
- 自动确认不得伪装成人工审核，也不得直接写 `review.json`。
- `audit.json` 是可重建只读证据，不是生产判断权威。
- `learning_cases.jsonl` 只用于离线 replay/eval。
- `assistant.json` 是可重建派生状态，不是 Review、Editorial Decision 或 Delivery 权威。
- AI Rescue 只能在本地候选集合中选择，不得自由发明位置。
- 未配置模型 Provider 时主流程必须仍可离线运行。
- API Key 不得进入 workspace/project/review/audit/editorial 或可同步产物。

## 人物 / 声纹

- embedding 与 cluster 属于设备本地感知数据。
- 已人工确认的人物/声纹身份不得被普通模型更新或重跑自动擦除。
- speaker/face → 角色默认需要人工确认。
- 多机位画面中的人不等于正在说话的人，没有可靠 active-speaker/audio-visual binding 时不得自动绑定角色。

## 多设备与本机素材

- `clip_id` = 项目/FCPXML occurrence。
- `media_id` = 物理媒体身份，绝对路径不是共享身份。
- 每台设备自己的 media roots / bindings 保存在设备状态目录，不得写入共享 workspace。
- 缺媒体应明确显示，不能偷偷匹配错误同名文件。
- 同内容媒体移动、改盘符、改目录甚至改名后，正式 `media_id` 应保持一致。
- 改多设备逻辑前先读 `SYNC_MODEL.md`。

## 多机位与 FCPXML

- 多机位同步/NLE XML 使用仓库内 `vendor/multicam-audio-sync` 第一方确定性引擎。
- 不修改原始 FCPXML，不重建或破坏已有同步关系。
- 媒体目录项目可生成新的 `output/sync/synchronized.fcpxml`，不得覆盖用户原文件。
- Shot Intelligence 是 `clip_id` 级属性，不是 Take 全局属性；同一 Take 允许 A/B/C 不同景别。
- 长素材按有效片内范围复用，禁止复制原始媒体。

## Desktop 架构

当前入口：`desktop/`

```text
React / TypeScript
        ↓ typed contracts
Tauri 2 / Rust
  ├─ Production Host lifecycle :8765
  ├─ Team Gateway lifecycle    :8766
  ├─ native dialog / reveal / URL / FCP adapter
  └─ Rust Timeline bridge
        ↓
Python MirrorOrder Core + Rust Timeline Core
```

- Production Host 与 Team Gateway 是两套独立进程 manager；停止一个不得影响另一个。
- `spawn()` 不等于 ready；预期 TCP 端口真实监听后才算启动成功。
- 视频/代理帧不得通过 Tauri JSON/Base64 IPC 大量搬运。
- native platform module 保持窄 adapter，不写业务规则。

## Timeline Core

- Rust Timeline Core 是 authoritative edit state；React 只发 commands / 读 snapshots。
- 现有命令包括 Insert、Overwrite、Move、Split、Trim、RippleDelete、Disable、MulticamSwitch、SetMarker、Undo/Redo。
- persistence 使用 checkpoint + append-only journal + crash recovery。
- Rough Cut / AI 只能生成 proposal；人工确认后才转换成 Rust commands。
- 当前 24fps seed 是 provisional fallback，不得冒充项目 native timebase。
- 新编辑入口、importer、NLE adapter 应归一化为 Rust commands，而不是旁路修改状态。

## 产品 UI 约束

- 这是剪辑工作台，不是算法展示页。
- `episode-only` 是合法、完成的人工 placement，不得误标成 pending。
- candidate、pending、placed、rejected 保持独立语义。
- A/B/C 机位事实不得合并成 Take 全局景别。
- 已确认角色优先显示；未确认角色必须明确标记为候选。
- 诊断信息放设置/状态或独立 inspector，不把制作主画布变成 debug dashboard。

## 重功能隔离 / worktree

以下能力默认独立 branch/worktree：

- runtime packaging / portable Python / media toolchain
- 自动配乐与音乐生成
- 重媒体处理 / proxy generation infrastructure
- 新 NLE adapters
- model runtime infrastructure
- 实验自动化引擎

只有同时满足以下条件才并回主线：

1. typed contract 明确；
2. authority/ownership 明确；
3. failure isolation 明确；
4. 本地测试与 native smoke gate 明确；
5. 不复制 Python business logic；
6. 不把 Production project tabs 当插件容器。

## 验证

主线本地验证：

```bash
cd desktop
npm install
npm run verify:rc
```

单项 gate：

```bash
npm run check:baseline
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cd ..
python -m pytest -q
```

没有实际执行过的测试不得写成“已通过”。GitHub Actions 不是开发基线的必要条件。
