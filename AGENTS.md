# 镜序工程接手约束

## 当前基线

- 仓库只维护 `main` 作为开发与集成线。
- Desktop = React/TypeScript Production UI + Tauri 2/Rust 平台层 + Rust Timeline Core + Python MirrorOrder Core。
- Team Web 是独立 Review/Collaboration surface，不是 Production 主画布。
- 当前最高优先级是 Desktop Product Recovery：先恢复真实工作流可用性，不新增产品面。
- 不恢复已删除产品线，不建立第二套业务、Review、Editorial 或 Timeline authority。

修改产品代码前先读以下文件，够用就不要继续考古旧文档：

1. `docs/app-information-architecture.md` — 产品定义、四工作区与主流程 authority。
2. `docs/engineering/STATUS.md` — 当前 main、已知失败与 Recovery 状态。
3. `docs/engineering/BACKLOG.md` — 当前 P0 执行顺序。
4. `docs/engineering/INVARIANTS.md` — 不可突破的工程与产品边界。
5. `docs/ux-principles.md` — 交互与专业工具纪律。
6. `docs/design-system-v2.md` — canonical object、视觉与布局规则。
7. `docs/architecture/desktop-bridge.md` — Desktop / Python / Rust 跨层边界。
8. `docs/architecture/repository-layout.md` — 源码仓库与运行时数据边界。

涉及具体领域时再从 `docs/README.md` 读取对应 contract；不要把 Git 历史、旧 verification、旧 Swift/Golden 实现当成当前 authority。

## Product workflow

镜序主链固定为：

```text
原始素材 + 剧本 + 可选场记
→ 真实 Take / 多机位关系
→ 拍摄事实
→ 剧本 placement
→ 人工审阅 / Editorial Decision
→ Timeline
→ NLE / 交付
```

Desktop 一级工作区固定为：

```text
素材 / 剧本 / 时间线 / 审阅
```

核心实现原则：

> **共享对象，不共享工作流。**

`TakeCard / TakeListRow / MediaCard / ScriptBlock / SlateRow / PersonRow` 等 canonical renderer 可以复用；Material / Script / Timeline / Review 的 orchestration、主动作、selection state 和写权限必须各自拥有 owner。禁止再次用一个大型 `surface/mode` Workbench 同时承担多个一级工作区。

## Authority

- Script Supervisor / Slate：拍摄现场与素材附件人工事实。
- ReviewStore：人工 script placement / mapping authority。
- Final Editorial Decision：与 Review placement 分离的最终人工剪辑判断。
- Rust Timeline Core：authoritative local timeline edit state。
- Python MirrorOrder Core：Workspace/Project、Review、Slate、Identity、media identity/binding、Team Web security/review、Delivery/FCPXML 等业务 authority。
- React/TypeScript：交互和编排层，不成为第二 truth。
- Python 不得绕过 command bridge 直接修改 Rust Timeline state。

统一 AI 权限链：

```text
evidence → proposal → human confirmation → authority
```

AI proposal、Audit、retrieval score、Team Web Individual Opinion 都不能自动写入 Review placement、Final Editorial Decision 或 Timeline authority。

## Product semantics

- 人工结果高于自动结果；系统不得自动 Reject 素材。
- Exclusion、Slate `status=ng`、Editorial Reject 是不同语义。
- A/B/C 机位事实不得合并成 Take 全局景别。
- `episode-only` 是合法人工 placement，不得误标 pending。
- Coverage 是 Script projection；Attention 是 Review filter；Rough Cut / Assembly / AI editing 是 Timeline proposal，不建立第二套主工作台或 editor。
- 一个能力只有一个主要“家”；其它工作区只提供 read-only context、快捷入口或携带 selection 的 deep-link。

## Read path / durable work

- GET、页面打开、项目/对象切换、Inspector 展开必须轻量，只读 cache/snapshot/read model。
- 媒体扫描、长 hash/stat、FFmpeg/FFprobe、模型下载/加载、整项目索引等重工作必须由显式动作提交 durable task。
- Status Center 是 project/device durable task 的唯一全局控制面。
- project task 与 device task 分域；取消尽可能传递到资源等待、下载和外部子进程。

## Repository / device data

- 源码只跟踪空 `projects/.gitkeep`；真实 production `projects/*` 不进入 Git。
- 禁止提交真实 registry、project input、cache/output、review/tasks/locks、模型权重、secrets。
- 测试只使用 `tests/fixtures/` 的最小合成/脱敏 fixture。
- `clip_id` = 项目 occurrence；`media_id` = 与设备路径无关的物理媒体身份。
- 每台设备的 media roots / bindings 留在 device state。
- `/Volumes/...`、`/Users/...`、Windows 盘符等绝对路径不得进入共享 artifact、源码 Git 或 durable task target。

## Desktop / UI

- 这是专业后期工具，不是 Debug Dashboard、AI 展示页或工程模块目录。
- 每个 workspace 必须有一个明确 Primary Canvas；Inspector / drawer 解释当前选择，不成为第二套路由或控制中心。
- 同一 Product Surface 内，同一制作对象只保留一个 canonical renderer。
- 页面 CSS 只管 pane/grid/context layout；不得覆盖 canonical object 的核心 anatomy、固定 geometry、slot 顺序与 selection geometry。
- 不通过新的 global theme/redesign/frozen/recovery CSS 层掩盖错误结构；失去 owner 的结构和样式直接删除。
- native platform module 保持窄 adapter，不写业务规则；视频/代理帧不得通过 Tauri JSON/Base64 IPC 大量搬运。

## Python package

- `src/script_organizer/` flat namespace 是历史兼容区，不继续无限扩张。
- 新 coherent engine/store/runtime/support 组优先进入明确 domain package。
- compatibility facade 只能 re-export，禁止 import-time route registration、disk write、model load 或全局 mutation。
- `runtime_stack.py` 保持显式 composition root。
- Product Recovery 期间不启动与主链无关的大规模 package migration。

## 验证

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

需要定位时再运行 targeted Desktop/Rust/Python checks。没有实际执行的检查不得写 PASS；失败测试不得通过删除或弱化真正的行为红线规避。非必要不手动反复触发 CI，功能切片完成后再做适用验证。

## 文档维护

- 产品定义、导航、workspace ownership 更新 `docs/app-information-architecture.md`。
- UX / 视觉更新现有 `docs/ux-principles.md` / `docs/design-system-v2.md`。
- 领域 authority 更新对应领域 contract。
- 真正跨层且长期稳定的架构才进入 `docs/architecture/`。
- 当前状态、当前计划、长期硬约束分别只写 `STATUS.md`、`BACKLOG.md`、`INVARIANTS.md`。
- 一次性执行 prompt、阶段报告、旧验收记录、closeout 不作为当前 Markdown 保存；Git 历史和 CI/Actions 已经保存过程。
