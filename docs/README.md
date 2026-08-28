# 镜序文档索引

这个目录按**当前 authority、领域契约、历史参考、验证记录**分层。不要通过文件名日期或旧验收报告推断当前产品状态。

## 1. 当前产品与工程 Authority

开发新界面、入口、导航或跨模块行为时，优先阅读：

1. [`app-information-architecture.md`](./app-information-architecture.md) — **当前产品 IA 与 Product Experience authority**；
2. [`ux-principles.md`](./ux-principles.md) — 专业后期工具的通用 UX 原则；
3. [`desktop-development-baseline.md`](./desktop-development-baseline.md) — 当前 React / Tauri / Rust / Python Desktop 工程基线；
4. [`production-review-boundary.md`](./production-review-boundary.md) — Production 与 Review 的产品边界；
5. [`review-read-model.md`](./review-read-model.md) — Review 读取和投影语义。

如果这些文档之间出现冲突：

- 产品入口 / IA：`app-information-architecture.md` 优先；
- UX 语言：`ux-principles.md` 优先；
- 数据 authority：对应领域 contract 和 Core 实现优先；
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

## 3. 仓库根目录工程说明

以下文件保留在根目录，因为它们是跨目录工程入口或项目总览：

- [`../项目介绍.md`](../项目介绍.md) — 中文产品总览；
- [`../README.md`](../README.md) — 仓库安装 / 使用入口；
- [`../AGENTS.md`](../AGENTS.md) — Agent / 自动化修改仓库时的约束；
- [`../DESKTOP_BRIDGE.md`](../DESKTOP_BRIDGE.md) — Desktop / Host / 平台 bridge；
- [`../SYNC_MODEL.md`](../SYNC_MODEL.md) — 同步模型；
- [`../AUTOMATION_PIPELINE.md`](../AUTOMATION_PIPELINE.md) — 自动整理流水线；
- [`../LOCAL_INTELLIGENCE.md`](../LOCAL_INTELLIGENCE.md) — 本地智能与可重建索引。

## 4. 历史设计参考

- [`app-design-system-v1.md`](./app-design-system-v1.md) — SwiftUI V1 阶段的视觉/交互纪律参考。

它不是当前技术栈、导航结构或默认入口 authority。仍可复用其高密度 Table、Split View、Toolbar、Inspector、低噪声等设计原则。

## 5. Verification / 历史验收

[`verification/`](./verification/) 只保存**某个 commit / 某次里程碑**的验证证据和历史审计结论。

规则：

- 验证记录必须标注日期、目标 commit / 分支（如果可得）和执行环境；
- `PASS` 只对该次实际执行有效；
- 不能把旧报告的 PASS 继承成当前 HEAD 状态；
- 一次性 Codex prompt、已结束 PR 的操作脚本不作为长期文档保留，Git 历史已经保存它们。

## 6. 新文档放哪里

新增 Markdown 前先判断：

- 产品/导航规则 → 更新现有 IA / UX 文档，不新建平行规范；
- 领域 authority / 数据 contract → 对应领域文档；
- 一次性验证结果 → `verification/`；
- 临时执行 prompt → 不提交，或在工作完成后删除；
- 纯历史设计 → 明确标注 Historical Reference。

目标不是减少 Markdown 数量，而是保证**每一种问题只有一个明确的当前 authority**。
