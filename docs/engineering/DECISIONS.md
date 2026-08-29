# Engineering Decisions

这里记录已经接受、会长期影响开发方式的工程决策。新决策追加，不通过聊天记录隐式覆盖旧决策；如果决策被替代，必须明确标记 `Superseded` 并指向新条目。

## ADR-001 — 本地 Git 是日常开发事实源

- 状态：Accepted
- 日期：2026-08-29

日常开发、测试、审计、提交、回滚必须在完整本地 checkout 中独立成立。GitHub 负责远端备份、协作、PR、Release 和可选 CI，但不作为开发控制面的单点依赖。

结果：GitHub Actions、GitHub API 或网络暂时不可用时，工程仍能继续推进和验证。

## ADR-002 — `main` 是稳定集成线，不是默认工作区

- 状态：Accepted
- 日期：2026-08-29

跨层、runtime、schema、API contract、算法实验、审计、迁移、重构和超过 3 个文件的工作默认使用独立 branch + `git worktree`。

直接修改 `main` 仅限低风险、可快速审阅且不改变 contract 的小修正。并回前完成 diff review 和适用的本地 gate。

## ADR-003 — 本地 gate 是主验证链，GitHub CI 是附加信号

- 状态：Accepted
- 日期：2026-08-29

验证分层：

```text
L0  source / contract review
L1  local fast gate
L2  local full source gate
L3  native packaged/runtime smoke
L4  GitHub CI / release automation
```

L4 失败或不可用不能自动否定已经真实执行的 L1/L2/L3；反过来，L4 PASS 也不能替代本机/真实媒体/打包运行时等必要验证。

没有实际执行过的 gate 一律记录为 `NOT RUN`。

## ADR-004 — 工程状态进入仓库，不依赖聊天上下文

- 状态：Accepted
- 日期：2026-08-29

`docs/engineering/STATUS.md`、`BACKLOG.md`、`DECISIONS.md`、`INVARIANTS.md` 是轻量工程控制层。

聊天、临时 prompt、Agent scratchpad 可以辅助工作，但不能成为唯一的当前状态、长期决策或验收事实来源。

## ADR-005 — 重工作必须进入 durable task / Status Center

- 状态：Accepted
- 日期：2026-08-29

普通 GET、页面打开、对象切换、Inspector 展开等交互只读取 cache/snapshot/read model。目录全扫、媒体 fingerprint、FFmpeg/FFprobe、模型下载/加载、全项目 embedding/index rebuild 等重工作必须由显式用户动作提交 durable task，并进入 Status Center。

`media_inventory_scan` 和 `waveform_build` 是该模式的当前第一方实现。

## ADR-006 — 源码仓库与生产 workspace 是不同边界

- 状态：Accepted
- 日期：2026-08-29

源码 Git 不保存真实 `projects/` runtime 状态、制作输入或设备绝对路径。仓库只跟踪 `projects/.gitkeep` 作为空容器占位；生产 workspace 的同步语义由 `docs/architecture/sync-model.md` 定义。

这条决策不要求重写 Git 历史；历史清理属于独立、破坏性维护工作，必须单独决定。

## ADR-007 — Durable task 按 authority scope 分域

- 状态：Accepted
- 日期：2026-08-29

项目素材分析、同步、波形、语义索引等工作属于 project scope，继续由项目 `TaskManager` 和项目 `tasks.json` 管理。模型下载、本机可选 Python/native runtime 安装、本地视觉模型加载等工作属于 device scope，不得为了复用项目任务 API 而绑定到任意项目。

Device task 持久化在 MirrorOrder device state 中，target 只能包含逻辑模型 ID、`face|speaker` 等 path-free 参数；设备绝对路径、缓存根、密钥不得进入 durable target。Host 启动时恢复中断状态，普通 GET 只读 snapshot。

无论 scope 是 project 还是 device，用户控制面仍然只有一个：Desktop Status Center。设置页或具体工作台只能提交任务和显示轻量状态，不另建第二套完整任务控制器。

## ADR-008 — Python-only gate 是降级验证层，不是 fast/full 的替代品

- 状态：Accepted
- 日期：2026-08-29

当 Node、Cargo、Desktop 依赖或远端 CI 暂不可用，但存在完整源码 checkout 时，允许先执行 `python scripts/check_python.py`。该 gate 只覆盖 Python compile 与当前 production contract smoke，并且缺少 pytest、测试文件或源码时必须 fail closed。

验证层级因此补充为：

```text
L0   source / contract review
L0.5 python-only source gate
L1   local fast cross-stack gate
L2   local full source gate
L3   native packaged/runtime smoke
L4   GitHub CI / release automation
```

L0.5 的 PASS 只能证明 Python/source contracts 在该 checkout 上真实执行成功；不得把它表述为 TypeScript、Vitest、Rust/Tauri、packaged runtime、真实媒体或 FCP smoke 的通过结果。`check_fast.py` 应复用 `check_python.py`，避免同一 Python smoke 清单维护两份并产生漂移。