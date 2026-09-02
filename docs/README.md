# 镜序文档索引

文档按**当前 authority、领域契约、跨层架构、工程控制、验证历史**分层。文件名日期、旧 Stage 或旧分支说明都不能覆盖当前 authority。

## 1. 先读这些

1. [`app-information-architecture.md`](./app-information-architecture.md) — 当前产品 IA 与入口 authority。
2. [`ux-principles.md`](./ux-principles.md) — 专业后期工具 UX 原则。
3. [`design-system-v2.md`](./design-system-v2.md) — 当前视觉/组件语法与 token。
4. [`desktop-development-baseline.md`](./desktop-development-baseline.md) — Desktop 技术栈与验证基线。
5. [`engineering/README.md`](./engineering/README.md) — 当前工程控制层。
6. [`engineering/STATUS.md`](./engineering/STATUS.md) — 当前 `main` 与未关闭风险。
7. [`architecture/repository-layout.md`](./architecture/repository-layout.md) — 源码仓库与运行时工作区边界。

冲突时：产品/领域文档和 Core 实现优先；工程长期规则看 `engineering/DECISIONS.md` / `INVARIANTS.md`；当前执行状态看 `engineering/STATUS.md`；历史 verification 不能覆盖当前状态。

## 2. 领域契约

- [`electronic-script-supervisor.md`](./electronic-script-supervisor.md) — 电子场记 / Script Supervisor。
- [`media-camera-semantics.md`](./media-camera-semantics.md) — 素材角色、机位与同步语义。
- [`coverage-graph.md`](./coverage-graph.md) — Coverage 只读语义。
- [`production-review-boundary.md`](./production-review-boundary.md) — Production / Review 边界。
- [`review-read-model.md`](./review-read-model.md) — Review read model 与投影。
- [`editorial-collaboration.md`](./editorial-collaboration.md) — Individual Opinion / Editorial Decision。
- [`delivery-semantics.md`](./delivery-semantics.md) — Delivery / FCPXML。
- [`semantic-retrieval.md`](./semantic-retrieval.md) — 项目语义检索。
- [`assistant-orchestration.md`](./assistant-orchestration.md) — 小镜 / Assistant Orchestrator。
- [`ai-audit-learning-loop.md`](./ai-audit-learning-loop.md) — Audit 与学习闭环。
- [`material-card-spec-v1.md`](./material-card-spec-v1.md) — 素材卡显示契约。

## 3. 跨层架构

[`architecture/`](./architecture/) 保存长期跨层说明：Desktop bridge、同步模型、自动化 pipeline、本地智能、仓库布局与 Python package boundaries。详细索引见 [`architecture/README.md`](./architecture/README.md)。

## 4. 工程控制层

`engineering/` 当前只保留五个文件：

- [`engineering/README.md`](./engineering/README.md)
- [`engineering/STATUS.md`](./engineering/STATUS.md)
- [`engineering/BACKLOG.md`](./engineering/BACKLOG.md)
- [`engineering/DECISIONS.md`](./engineering/DECISIONS.md)
- [`engineering/INVARIANTS.md`](./engineering/INVARIANTS.md)

一次性 Codex handoff、旧 integration plan、已结束 branch closeout 不作为长期当前文档保留；Git 历史已经保存它们。

## 5. Verification / historical reference

[`verification/`](./verification/) 只保存某次 commit/里程碑的验收证据。`PASS` 只对当次真实执行有效。

[`app-design-system-v1.md`](./app-design-system-v1.md) 是 Historical Reference，不是当前设计系统 authority；当前设计以 `design-system-v2.md` 为准。

## 6. 新文档放哪里

- 产品/导航规则 → 更新现有 IA / UX / Design System，不新建平行规范。
- 领域 authority / data contract → 对应领域文档。
- 跨多个技术层的长期工程架构 → `architecture/`。
- 当前状态 / backlog / decisions / invariants → `engineering/`。
- 一次性验收 → `verification/`。
- 一次性执行 prompt / closeout / integration script → 不提交为长期文档；完成后删除。

目标是让每个问题只有一个清晰的当前 authority，而不是维护更多 Markdown。
