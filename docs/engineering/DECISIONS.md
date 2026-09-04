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
