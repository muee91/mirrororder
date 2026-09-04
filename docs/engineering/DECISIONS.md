# Engineering Decisions

这里只保留**当前仍生效**、会长期影响实现方式的工程决策。旧分支、阶段性 integration 和已完成 closeout 的决策过程由 Git 历史保存，不在当前控制层重复维护。

## D001 — `main` 是当前唯一开发与集成线

仓库当前不依赖长期 feature branch / worktree / PR 流程。修改应基于最新 `main`，scope 收敛后原子提交，并在提交前后运行适用验证。若以后恢复多分支协作，必须先显式更新工程控制层。

## D002 — 验证证据不可继承

验证分层仍按 source review → Python/fast/full source gates → native/packaged smoke → CI/release automation理解。只有目标 commit 上实际成功的检查可以写 PASS；旧 commit、旧 verification、别的环境或“源码看起来正确”都不能替代执行结果。

## D003 — Authority 不因 UI/AI 演进而改变

- Python MirrorOrder Core 持有 Product/Review/Slate/Identity/media/Delivery 等业务 authority。
- Rust Timeline Core 持有 authoritative local timeline edit state。
- React/Tauri 是 UI/device integration，不成为第二 truth。
- AI 只能走 `evidence → proposal → human confirmation → authority`。

## D004 — 重工作进入 durable task / Status Center

页面打开、GET、对象切换和 Inspector 展开只读取 cache/snapshot/read model。目录扫描、fingerprint、FFmpeg/FFprobe、模型下载/加载、全项目 embedding/index rebuild 等重工作必须由显式用户动作提交 durable task，并由 Status Center 作为唯一全局控制面。

## D005 — 源码仓库与生产 workspace 是不同边界

源码 Git 不保存真实 production `projects/*`、媒体输入、cache/output、设备绝对路径或 secrets。测试只使用最小、合成、脱敏、可重建 fixture；生产 workspace 的同步语义由 `docs/architecture/sync-model.md` 定义。

## D006 — Durable task 按 authority scope 分域

项目素材分析、同步、波形、语义索引属于 project scope；模型下载、本机可选 runtime 安装、模型加载属于 device scope。Device task target 只保存逻辑 ID 与 path-free 参数，设备路径和密钥留在 device-local state。

## D007 — Python package 迁移按 domain slice 进行

`src/script_organizer/` 的 flat namespace 是历史兼容区，不继续无限扩张。迁移按 coherent domain slice 完成，不把搬包、schema/API/authority 变化混在一起；root compatibility facade 只能纯 re-export、无 import-time side effect，并在 caller 迁完后删除。目标边界见 `docs/architecture/python-package-boundaries.md`。

## D008 — `project.toml` 是 MirrorOrder Project Package 的版本化 manifest

新建项目从 schema v1 起显式写入 `project.format = "mirrororder-project"` 与 `project.schema_version = 1`。历史未标记 manifest 作为 legacy schema 0 只读兼容，不在普通读取中静默迁移；未知格式和未来 schema fail fast。项目持久化路径必须可移植，device-local media root/binding 永不进入 v1 manifest。当前 workspace 内部仍保持 `projects/<project_id>/project.toml`，`.mirrorproj` 是可移动目录包的产品命名约定，不作为破坏性目录迁移理由。详细 contract 见 `docs/architecture/project-package.md`。

## D009 — Project transfer 使用 path-free durable task + device-local request indirection

外部 `.mirrorproj` 导入、项目另存和 `.mirrorpkg` 收集都属于显式用户动作；可能持续的复制/归档工作必须进入现有 Status Center。绝对源/目标路径只保存到 Application Support 下的 device-local transfer request，durable task target 只保存 `request_id`。外部项目不能通过 Registry 长期引用任意绝对路径，而是原子导入到受管 `projects/<project_id>/`；`.mirrorpkg` 可选媒体只通过 `DeviceMediaStore` 的 `media_id` 权威解析收集，`M_...` 必须通过内容指纹验证、`MP_...` 必须已有本机确认，归档清单不保存原 binding 路径。`output/tasks.json` 属于原 Host / runner 的 operational history，在 Import / Save As / Collect 中统一排除，不随项目身份移动。

## D010 — Production UI 对象使用单一实现权威

Design System v2 定义对象 anatomy、状态语义、机位语义和布局不变量；页面 Workbench 只负责组合制作对象，不再拥有重新发明这些对象的权力。

- 同一 Product Surface 内，同一制作对象只保留一个 canonical renderer。Desktop 与 Team Web 可以因职责不同拥有各自明确的组件族，但同一 surface 内不得并行存在多套 `MediaCard`、`TakeCard`、`SlateRow`、`ScriptBlock`、人物行等实现。
- canonical renderer 必须是可独立 import 的组件，不能长期隐藏为某个大 Workbench 内的私有函数。页面 adapter 可以完成 DTO → view model 映射，但不能复制机位、状态、selection、availability 或对象 anatomy。
- A/B/C/AUX 固定槽位、Take/机位排序、预留状态位和 no-shift 行为属于组件 contract，不是页面自由布局。共享语义必须由共享定义消费，禁止在每个页面重新声明一份常量或排序规则。
- 迁移遵循“确定 canonical → 替换 consumer → 删除重复实现/样式”。`Golden*`、`redesign`、`frozen`、`recovery` 等迁移层只能收缩，不能作为继续叠加新视觉层的命名模板。
- feature-local CSS 可以定义工作区布局，但不得通过新的全局覆盖层重新定义 canonical 对象的核心几何和状态位置。
