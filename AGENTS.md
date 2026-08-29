# 镜序工程接手约束

## 当前基线

- `main` 是开发基线。
- Desktop 客户端位于 `desktop/`。
- Desktop = **React / TypeScript Production UI + Tauri 2 / Rust 平台层 + Rust Timeline Core + Python MirrorOrder Core**。
- Team Web 是独立轻量 Review / Collaboration surface，不是 Production 主画布。
- 不恢复已删除的旧 Desktop 产品线，不建立第二套客户端。
- 重功能默认独立 module + branch/worktree，再通过明确 contract 和验证并回。

## 写代码前

先读以下当前 authority：

1. `docs/README.md` — 文档分层与 authority 索引；
2. `docs/app-information-architecture.md` — 当前产品入口、默认页与壳层 authority；
3. `docs/ux-principles.md` — 当前 UX 语言；
4. `desktop/README.md`；
5. `desktop/development-baseline.json`；
6. `docs/desktop-development-baseline.md`；
7. `docs/architecture/repository-layout.md` — 源码仓库与运行时工作区的文件位置；
8. `docs/architecture/desktop-bridge.md`；
9. `docs/architecture/sync-model.md`；
10. `docs/architecture/automation-pipeline.md`。

涉及具体领域时再读 `docs/README.md` 列出的对应 contract。`docs/verification/` 和 Historical Reference 不能覆盖当前 authority。

不确定时先给证据和不确定点，不做猜测式修改。

## 仓库文件位置

- 仓库根目录只保留入口、构建配置和仓库级约束；新的跨层架构说明放 `docs/architecture/`，一次性验收记录放 `docs/verification/`。
- 根 `workspace.toml` 只是开发工作区描述。运行时 `projects/` 整体属于 workspace 数据并被 Git 忽略。
- **禁止提交真实** `projects/registry.json`、`project.toml`、剧本/FCPXML/XML 输入副本、cache、output、Review/Editorial/tasks/locks，以及 `/Volumes/...`、`/Users/...`、Windows 盘符等设备绝对路径。
- 测试需要项目数据时，只使用 `tests/fixtures/` 下最小、合成、脱敏且可重建的 fixture；不得复制真实制作项目。
- Desktop typed clients / DTO 放 `desktop/src/api/`；领域 UI、专属 hooks、CSS、Vitest 尽量 colocate 在 `desktop/src/features/<domain>/`；Tauri `src-tauri` 只放窄平台 adapter、生命周期和 Rust Core。
- `src/script_organizer/` 当前 flat namespace 是历史兼容区，不是继续无限堆顶层模块的模板。出现一组 engine/store/runtime/support 时优先规划子 package；大规模包迁移必须独立提交并有 import、packaging、stage-runtime、pytest contract，不能和产品功能改动混在一起。

生产 workspace 可以按同步模型在团队设备之间同步；**“可同步的生产 workspace”与“MirrorOrder 源码 Git 仓库”是两个不同边界**。

## 当前产品入口

项目 Production 只保留四个一级制作区：

```text
素材：场记 / 素材库 / Take / 人物
剧本：剧本 / 覆盖
剪辑：粗剪 / 组接 / 时间线 / 交付
审阅：看片 / 待处理 / 概览
```

- 新项目第一次进入默认 **素材 → 场记**；已有项目恢复上次 Production 页面。
- 状态中心、团队审阅、设置是全局工具，不得塞回项目二级导航。
- `⌘K / Ctrl+K` 是项目语义搜索，不得重新变成 Tab。
- 小镜是 contextual drawer，不是页面；Provider / Base URL / API Key 等模型连接属于全局设置，不属于小镜。
- 一个能力只保留一个主要入口。废弃入口要么明确标为历史/内部组件，要么物理删除，不能留下可误接的平行 Workbench。

## 权威边界

- **ReviewStore** 是人工 script placement / mapping authority。
- **Script Supervisor / Slate** 是生产事实与场记证据，不能静默改写 Review placement 或 Editorial Reject。
- **Final Editorial Decision** 与 Review placement 分离，并保持 Host-local / revision-safe 语义。
- Python MirrorOrder Core 拥有 workspace/project、Review、Slate、Identity、Assistant、AI proposal、media identity/binding、Team Web security/review、FCPXML/delivery 等业务权威。
- Rust Timeline Core 是本机时间线 edit state 的唯一权威。
- React/TypeScript 是交互层，不得成为第二套业务状态或 Timeline source of truth。
- Python 不得绕过 command bridge 直接修改 Rust Timeline state。
- Team Web 不得获得 Production Timeline authority、本机路径、模型 secrets 或 Final Editorial Decision。

统一 AI 权限链：

```text
evidence → proposal → human confirmation → authority
```

AI proposal、Audit、semantic retrieval score 或 Team Web Individual Opinion 不得自动落入 authoritative edit state、Review placement、Best 或 Final Editorial Decision。

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
- Exclusion、Slate `status=ng` 与 Editorial Reject 是三套不同语义，禁止合并。

## Production UX / 重工作

- GET、打开页面、切换项目/对象、展开 Inspector 等普通交互必须保持轻量，不得偷偷触发全盘媒体枚举、长 FFmpeg/FFprobe、模型下载、全项目 embedding/索引或其它分钟级工作。
- 重工作必须由显式用户动作提交 durable task，并进入 Status Center；项目页只显示必要的轻量状态或失败提示。
- 素材库 GET 只读 device-local inventory snapshot；显式重扫使用 `media_inventory_scan`。
- Waveform GET 只读缓存；cache miss 由显式 `waveform_build` durable task 生成。
- 取消必须尽可能传递到等待资源和外部子进程，不能只改 UI 状态。

## 人物 / 声纹 / 语义向量

- face / speaker embedding 与 cluster 属于设备本地感知数据。
- 文本 semantic embedding 同样属于本机可重建 retrieval evidence，不得成为编辑判断 authority。
- 已人工确认的人物/声纹身份不得被普通模型更新或重跑自动擦除。
- speaker/face → 角色默认需要人工确认。
- 多机位画面中的人不等于正在说话的人，没有可靠 active-speaker/audio-visual binding 时不得自动绑定角色。
- 不得把 face/speaker identity embedding 与 text semantic embedding 混成同一向量空间。

## 多设备与本机素材

- `clip_id` = 项目/FCPXML occurrence。
- `media_id` = 物理媒体身份，绝对路径不是共享身份。
- 每台设备自己的 media roots / bindings 保存在设备状态目录，不得写入共享 workspace。
- 缺媒体应明确显示，不能偷偷匹配错误同名文件。
- 同内容媒体移动、改盘符、改目录甚至改名后，正式 `media_id` 应保持一致。
- 改多设备逻辑前先读 `docs/architecture/sync-model.md`。

## 多机位与 FCPXML

- 多机位同步/NLE XML 使用仓库内 `vendor/multicam-audio-sync` 第一方确定性引擎。
- 不修改原始 FCPXML，不重建或破坏已有同步关系。
- 媒体目录项目可生成新的同步 FCPXML，不得覆盖用户原文件。
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
- `spawn()` 或 TCP open 都不等于 ready；应通过 `/api/v1/ping` 验证预期 MirrorOrder service identity 与 `status=ok`。
- 视频/代理帧不得通过 Tauri JSON/Base64 IPC 大量搬运。
- native platform module 保持窄 adapter，不写业务规则。

## Timeline Core

- Rust Timeline Core 是 authoritative edit state；React 只发 commands / 读 snapshots。
- persistence 使用 checkpoint + append-only journal + crash recovery。
- Rough Cut / Assembly / AI 只提供 read-only proposal / preview；人工确认后才转换成 Rust commands。
- 当前 24fps seed 是 provisional fallback，不得冒充项目 native timebase。
- 新编辑入口、importer、NLE adapter 应归一化为 Rust commands，而不是旁路修改状态。

## 产品 UI 约束

- 这是剪辑工作台，不是算法展示页或 Debug Dashboard。
- `episode-only` 是合法、完成的人工 placement，不得误标成 pending。
- candidate、pending、placed、excluded、rejected 保持独立语义。
- A/B/C 机位事实不得合并成 Take 全局景别。
- 已确认角色优先显示；未确认角色必须明确标记为候选。
- 诊断信息放设置的高级区域或状态中心，不污染 Production Canvas。
- 状态中心是 durable tasks 的唯一全局入口；项目页只能显示轻量进度/失败提示，不复制完整任务控制器。

## 重功能隔离 / worktree

以下能力默认独立 branch/worktree：

- runtime packaging / portable Python / media toolchain；
- 自动配乐与音乐生成；
- 重媒体处理 / proxy generation infrastructure；
- 新 NLE adapters；
- model runtime infrastructure；
- 实验自动化引擎。

只有同时满足以下条件才并回主线：

1. typed contract 明确；
2. authority/ownership 明确；
3. failure isolation 明确；
4. 本地测试与 native smoke gate 明确；
5. 不复制 Python business logic；
6. 不把 Production project tabs 当插件容器。

## 文档维护

- 新产品/导航规则优先更新现有 IA / UX 文档，不新建平行规范。
- 领域 authority 更新对应 contract。
- 跨 Python/Desktop/runtime/sync 等多个层的长期工程说明放 `docs/architecture/`。
- 一次性验收结果进入 `docs/verification/`；历史 PASS 只对当次 commit 有效。
- 一次性 Codex prompt 不作为长期项目文档保留。
- 旧设计如果仍有参考价值必须明确标 `Historical Reference`。

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
