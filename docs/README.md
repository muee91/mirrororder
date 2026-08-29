# 镜序文档索引

这个目录按**当前 authority、领域契约、跨层工程架构、历史参考、验证记录**分层。不要通过文件名日期或旧验收报告推断当前产品状态。

## 1. 当前产品与工程 Authority

开发新界面、入口、导航或跨模块行为时，优先阅读：

1. [`app-information-architecture.md`](./app-information-architecture.md) — **当前产品 IA 与 Product Experience authority**；
2. [`ux-principles.md`](./ux-principles.md) — 专业后期工具的通用 UX 原则；
3. [`desktop-development-baseline.md`](./desktop-development-baseline.md) — 当前 React / Tauri / Rust / Python Desktop 工程基线；
4. [`architecture/repository-layout.md`](./architecture/repository-layout.md) — 源码仓库与运行时工作区的文件位置规则；
5. [`production-review-boundary.md`](./production-review-boundary.md) — Production 与 Review 的产品边界；
6. [`review-read-model.md`](./review-read-model.md) — Review 读取和投影语义。

如果这些文档之间出现冲突：

- 产品入口 / IA：`app-information-architecture.md` 优先；
- UX 语言：`ux-principles.md` 优先；
- 数据 authority：对应领域 contract 和 Core 实现优先；
- 仓库文件位置：`architecture/repository-layout.md` 优先；
- 历史报告不能覆盖当前 authority。

## 2. 领域契约

这些文档描述长期业务语义，应随实现变化同步维护：

- [`electronic-script-supervisor.md`](./electronic-script-supervisor.md) — 电子场记 / Script Supervisor；
- [`media-camera-semantics.md`](./media-camera-semantics.md) — 素材角色、机位与同步语义；
- [`coverage-graph.md`](./coverage-graph.md) — Coverage 只读语义；
- [`delivery-semantics.md`](./delivery-semantics.md) — Delivery / FCPXML 边界；
- [`editorial-collaboration.md`](./editorial-collaboration.md) — Individual Opinion 与 Editorial Decision；
- [`semantic-retrieval.md`](./semantic-retrieval.md) — 项目语义检索；
- [`assistant-orchestration.md`](./assistant-orchestration.md) — 小镜 / Assistant Orchestrator；
- [`ai-audit-learning-loop.md`](./ai-audit-learning-loop.md) — Audit 与学习闭环；
- [`material-card-spec-v1.md`](./material-card-spec-v1.md) — 素材证据卡几何与显示契约。

## 3. 跨层工程架构

跨 Python Core、Desktop、设备本地 runtime、同步模型等多个层的长期工程说明统一放在 [`architecture/`](./architecture/)：

- [`architecture/desktop-bridge.md`](./architecture/desktop-bridge.md) — Desktop / Python Core / Team Web / Rust Timeline bridge；
- [`architecture/sync-model.md`](./architecture/sync-model.md) — 多设备项目同步与本机素材边界；
- [`architecture/automation-pipeline.md`](./architecture/automation-pipeline.md) — 自动整理、AI Rescue、Shadow Audit 与后台任务；
- [`architecture/local-intelligence.md`](./architecture/local-intelligence.md) — 本地智能与可重建索引；
- [`architecture/repository-layout.md`](./architecture/repository-layout.md) — 仓库目录、工作区数据与 fixture 规则。

注意：`sync-model.md` 描述的生产 workspace 可以在团队设备间同步，但**真实 workspace/project 数据不因此属于源码仓库**。本仓库运行时的 `projects/` 整体 gitignore。

## 4. 仓库根目录入口

根目录只保留仓库级入口、构建配置与开发约束：

- [`../项目介绍.md`](../项目介绍.md) — 中文产品总览；
- [`../README.md`](../README.md) — 仓库安装 / 使用入口；
- [`../AGENTS.md`](../AGENTS.md) — Agent / 自动化修改仓库时的约束；
- `pyproject.toml`、`workspace.toml`、CLI/启动脚本等工程入口。

新的跨层架构 Markdown 不再放到根目录。

## 5. 历史设计参考

- [`app-design-system-v1.md`](./app-design-system-v1.md) — SwiftUI V1 阶段的视觉/交互纪律参考。

它不是当前技术栈、导航结构或默认入口 authority。仍可复用其高密度 Table、Split View、Toolbar、Inspector、低噪声等设计原则。

## 6. Verification / 历史验收

[`verification/`](./verification/) 只保存**某个 commit / 某次里程碑**的验证证据和历史审计结论。

规则：

- 验证记录必须标注日期、目标 commit / 分支（如果可得）和执行环境；
- `PASS` 只对该次实际执行有效；
- 不能把旧报告的 PASS 继承成当前 HEAD 状态；
- 一次性 Codex prompt、已结束 PR 的操作脚本不作为长期文档保留，Git 历史已经保存它们。

## 7. 新文档放哪里

新增 Markdown 前先判断：

- 产品/导航规则 → 更新现有 IA / UX 文档，不新建平行规范；
- 领域 authority / 数据 contract → 对应领域文档；
- 跨多个技术层的长期工程架构 → `architecture/`；
- 一次性验证结果 → `verification/`；
- 临时执行 prompt → 不提交，或在工作完成后删除；
- 纯历史设计 → 明确标注 Historical Reference。

目标不是减少 Markdown 数量，而是保证**每一种问题只有一个明确的当前 authority，且文件位置能表达它的角色**。
