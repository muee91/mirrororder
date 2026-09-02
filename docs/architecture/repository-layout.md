# 镜序仓库文件位置规范

这份文档定义 MirrorOrder **源码仓库**中的长期文件落位。它解决的是“代码和工程资料放哪里”，不是制作项目内部的数据同步协议。

## 1. 顶层目录

```text
mirrororder/
├── README.md                     仓库与产品入口
├── AGENTS.md                     自动化/Agent 修改约束
├── pyproject.toml                Python 包与测试配置
├── requirements-*.txt            明确的开发/运行依赖入口
├── workspace.toml                仓库开发工作区描述；不包含真实项目
├── script-organizer              CLI 入口脚本
├── 启动素材工作台.command         本地开发启动入口
├── src/script_organizer/         Python MirrorOrder Core
├── desktop/                      React / Tauri / Rust Desktop
├── web/                          Team Web 静态资源/轻量前端
├── docs/                         当前产品、领域与工程文档
│   ├── architecture/             跨层长期工程架构
│   └── verification/             某个 commit/环境的一次性验证证据
├── tests/                        Python 合同、单元与集成测试
├── projects/.gitkeep             仅用于保留空的本地 workspace 容器目录
├── vendor/                       固定的第一方/第三方 vendored runtime source
└── branding/                     产品品牌静态资源
```

根目录只保留**入口、构建配置和仓库级约束**。新的架构说明不得继续以大写 Markdown 散落在根目录。

## 2. 源码仓库与运行时工作区必须分开

根 `workspace.toml` 只是开发 Host 的工作区描述。它可以指向：

```text
./projects/registry.json
```

`projects/` 是**运行时工作区容器**。源码仓库只跟踪一个空的 `projects/.gitkeep`，保证全新 checkout 中目录存在；除此之外，`projects/*` 全部由 `.gitignore` 排除。

这样既不把真实项目带进源码 Git，又满足当前项目预检对 `projects/` 目录存在且可写的要求。普通 GET 不需要为了仓库初始化而写盘。

源码仓库不得跟踪：

- `projects/registry.json`；
- 真实 `projects/<project_id>/project.toml`；
- 用户剧本、FCPXML/XML、媒体或它们的项目输入副本；
- `cache/`、`output/`、`.workspace/`；
- `review.json`、`editorial.json`、`tasks.json`、锁文件等真实制作状态；
- `/Volumes/...`、`/Users/...`、盘符路径或其它设备绝对路径。

这些文件可以属于一个**生产 workspace**并在团队设备之间按 `sync-model.md` 同步，但不能因此进入 MirrorOrder 的源码 Git 历史。

### 从旧 checkout 迁移

历史版本曾把 `projects/` 作为 tracked source 提交，其中甚至包含真实项目输入和设备绝对路径。本规范开始执行时会停止跟踪这些文件，仅保留 `.gitkeep`。

如果某台开发机仍把仓库内旧 `projects/` 当作正在使用的生产/测试工作区，**切换到移除这些 tracked 文件的 commit 前应先复制/备份该目录**。更新源码后，再把需要继续使用的 workspace 内容恢复到本地 `projects/`；除 `.gitkeep` 外的内容都被 `.gitignore` 排除，不会再次进入源码提交。

稳定的 `workspace.id` 不因这次仓库整理而变化，避免现有 device-local media binding 被误认为另一个工作区。

如果测试需要项目数据，使用 `tests/fixtures/` 中的**最小、合成、脱敏 fixture**。不要把真实项目复制进 fixture。

## 3. 文档

文档按 authority 类型落位：

- `README.md`：唯一根级产品/仓库总览；
- `docs/README.md`：唯一文档索引；
- `docs/*.md`：当前产品 IA、UX、领域 contract；
- `docs/architecture/*.md`：跨 Python/Desktop/Runtime/Sync 等多个层的长期工程架构；
- `docs/verification/*.md`：带日期、commit、执行环境的一次性验证/审计证据。

临时 prompt、迁移清单、已经结束的操作脚本不作为长期文档提交；Git 历史已经承担过程留档。

## 4. Desktop

```text
desktop/src/api/                 localhost/native typed clients 与 DTO
desktop/src/app/                 应用壳、一级导航与全局 workspace
desktop/src/features/<domain>/   领域 UI、hooks、样式和领域内测试
desktop/src-tauri/src/           窄平台 adapter / lifecycle / native bridge
desktop/src-tauri/crates/        可独立测试的 Rust core，例如 timeline-core
desktop/scripts/                 构建、staging、smoke、release 工具
desktop/src-tauri/resources/     构建生成/占位的 packaged resources
```

规则：

- feature 组件和专属 CSS/test 尽量 colocate，不把业务 UI 重新堆回 `desktop/src/` 根；
- Host API contract 放 `desktop/src/api/`，不要在各 Workbench 里复制 fetch 逻辑；
- Tauri adapter 保持窄，不把 Python business authority 搬进 Rust 平台层；
- 生成的 runtime 不提交，资源目录只保留 `.gitkeep`、manifest schema 或明确的源码级配置。

## 5. Python Core

当前 `src/script_organizer/` 仍有历史 flat namespace。为降低主线 import 和 packaging 风险，不做一次性全包搬家；它是**兼容区，不是鼓励继续无限扩张的模板**。

新代码遵循：

- 单一领域的核心业务语义与已有领域模块 colocate；
- HTTP/runtime adapter 保持 `*_runtime.py` 的薄层，不复制 store/engine 逻辑；
- device-local state 不能因为方便而写进 project/shared store；
- 一个领域开始出现多组 engine/store/runtime/support 文件时，优先规划独立子 package，再以兼容 import 逐步迁移，而不是继续堆几十个顶层模块；
- 大规模 package 迁移必须作为独立、可审阅的原子工作包，并有 import、packaging、stage-runtime 与 pytest contract，不能和产品功能修改混在一个提交中。

详细目标 ownership、dependency direction、compatibility facade 与迁移 slice 见 [`python-package-boundaries.md`](./python-package-boundaries.md)。

## 6. 测试与 fixture

- Python：`tests/`；
- React/Vitest：与 `desktop/src/` 对应实现 colocate，使用 `*.test.ts(x)`；
- Rust：对应 crate 自己的 tests/module tests；
- 跨层源码位置守卫：`tests/test_repository_layout_guard.py`；
- 大媒体、真实剧本和真实客户项目不是测试 fixture。

需要媒体结构时，优先生成几 KB 级 synthetic data，或使用明确脱敏并可重新生成的最小 fixture。

## 7. Vendor、品牌与生成物

- `vendor/` 只放明确纳入发行/运行边界、版本和来源可追踪的代码/资源；
- `branding/` 只放产品品牌源资源；
- build output、`.app`、portable runtime staging、浏览器 QA artifact、模型缓存等必须被 ignore 或生成到专用 build/resource target；
- provider secret、API Key、设备媒体目录和本机 runtime config 永不进入仓库。

## 8. 新文件提交前检查

提交新文件前回答四个问题：

1. 它是**源码**、**长期文档**、**测试 fixture**还是**运行时状态**？
2. 如果是文档，哪个现有 authority 应该更新，是否真的需要新文件？
3. 如果包含路径/媒体/项目内容，它是否会把某台机器或真实制作数据带进 Git？
4. 如果是重 runtime/实验能力，是否已经形成独立 package/process boundary、可审阅 scope 和对应验证，而不是把实验面直接扩张进 Production？

无法明确归类的文件默认不要放到仓库根目录。
