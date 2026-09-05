# 镜序文档索引

文档按**产品定义 / 当前 authority、领域契约、跨层架构、工程控制、验证历史**分层。文件名日期、旧 Stage、旧 Swift/Golden 说明或历史分支记录都不能覆盖当前 authority。

## 1. 先读这些

1. [`app-information-architecture.md`](./app-information-architecture.md) — **镜序产品定义 + 当前产品 IA authority**；先回答“镜序到底解决什么问题、四个工作区各自负责什么”。
2. [`ux-principles.md`](./ux-principles.md) — 专业后期工具 UX 原则与交互纪律。
3. [`design-system-v2.md`](./design-system-v2.md) — 当前视觉/组件语法与 token。
4. [`../desktop/README.md`](../desktop/README.md) — 当前 Desktop 开发与验证入口。
5. [`engineering/README.md`](./engineering/README.md) — 当前工程控制层。
6. [`engineering/STATUS.md`](./engineering/STATUS.md) — 当前 `main`、最近真实 CI 与 Product Recovery 状态。
7. [`engineering/BACKLOG.md`](./engineering/BACKLOG.md) — 当前 P0 Desktop Product Recovery 与后续 backlog。
8. [`engineering/INVARIANTS.md`](./engineering/INVARIANTS.md) — 长期 authority / workflow / UI 硬约束。
9. [`architecture/desktop-bridge.md`](./architecture/desktop-bridge.md) — Desktop / Python / Rust / Team Web 跨层边界。
10. [`architecture/repository-layout.md`](./architecture/repository-layout.md) — 源码仓库与运行时工作区边界。
11. [`architecture/project-package.md`](./architecture/project-package.md) — Project Package v1、`project.toml` schema 与项目可迁移边界。

冲突时：

- “镜序是什么 / 用户怎么工作 / 页面应该怎么组织” → `app-information-architecture.md`；
- 视觉与交互 → `ux-principles.md` / `design-system-v2.md`；
- 业务 authority → 对应领域 contract 与 Core 实现；
- 长期工程规则 → `engineering/DECISIONS.md` / `INVARIANTS.md`；
- 当前执行状态 → `engineering/STATUS.md`；
- 历史 verification 不能覆盖当前状态。

## 2. 当前产品定义摘要

镜序的主链固定为：

```text
原始素材 + 剧本 + 可选场记
  → 真实 Take / 多机位关系
  → 拍摄事实
  → 剧本 placement
  → 人工审阅 / Editorial Decision
  → Timeline
  → NLE / 交付
```

Desktop 项目内一级工作区固定为：

```text
素材 / 剧本 / 时间线 / 审阅
```

工程实现遵循：

> **共享对象，不共享工作流。**

canonical `TakeRow / MediaCard / ScriptBlock / SlateRow / PersonRow` 等可以复用；Material / Script / Timeline / Review workflow 不通过一个万能 `surface/mode` Workbench 合并。

AI、Audit、语义检索、小镜、人物/声纹识别、自动归集与粗剪建议都属于 evidence / proposal，不成为新的 authority 或一级工作区。

## 3. 领域契约

- [`electronic-script-supervisor.md`](./electronic-script-supervisor.md) — 电子场记 / Script Supervisor。
- [`media-camera-semantics.md`](./media-camera-semantics.md) — 素材角色、机位与同步语义。
- [`coverage-graph.md`](./coverage-graph.md) — Coverage 只读语义。
- [`review-read-model.md`](./review-read-model.md) — Review read model、Individual Opinion 与 Editorial Decision 协作语义。
- [`delivery-semantics.md`](./delivery-semantics.md) — Delivery / FCPXML。
- [`semantic-retrieval.md`](./semantic-retrieval.md) — 项目语义检索。
- [`assistant-orchestration.md`](./assistant-orchestration.md) — 小镜 / Assistant Orchestrator。
- [`ai-audit-learning-loop.md`](./ai-audit-learning-loop.md) — Audit 与学习闭环。
- [`material-card-spec-v1.md`](./material-card-spec-v1.md) — 素材卡显示契约；随 Media CSS ownership 清理再拆入语义与 Design System，不作为新的业务 authority。

## 4. 跨层架构

[`architecture/`](./architecture/) 保存长期跨层说明：Desktop bridge、Project Package、同步模型、自动化 pipeline、本地智能、仓库布局与 Python package boundaries。详细索引见 [`architecture/README.md`](./architecture/README.md)。

## 5. 工程控制层

`engineering/` 当前只保留五个文件：

- [`engineering/README.md`](./engineering/README.md)
- [`engineering/STATUS.md`](./engineering/STATUS.md)
- [`engineering/BACKLOG.md`](./engineering/BACKLOG.md)
- [`engineering/DECISIONS.md`](./engineering/DECISIONS.md)
- [`engineering/INVARIANTS.md`](./engineering/INVARIANTS.md)

一次性 Codex handoff、旧 integration plan、已结束 branch closeout 不作为长期当前文档保留；Git 历史已经保存它们。

## 6. Verification / historical reference

[`verification/`](./verification/) 只保存某次 commit/里程碑的验收证据。`PASS` 只对当次真实执行有效。

Swift V1 是历史实现，不再作为当前技术/视觉 authority；但其核心任务可用性可以作为最低回归基线。旧 Design System v1、旧 Native Production/Review boundary、单独 Editorial Collaboration 说明和重复 Desktop baseline 需要追溯时使用 Git 历史，不在当前文档树维护平行规范。

## 7. 新文档放哪里

- 产品定义 / 导航 / 工作区边界 → 更新 `app-information-architecture.md`，不要另建平行“产品定义”规范。
- UX / 视觉 → 更新现有 `ux-principles.md` / `design-system-v2.md`。
- 领域 authority / data contract → 对应领域文档。
- 跨多个技术层的长期工程架构 → `architecture/`。
- 当前状态 / backlog / decisions / invariants → `engineering/`。
- 一次性验收 → `verification/`。
- 一次性执行 prompt / closeout / integration script → 不提交为长期文档；完成后删除。

目标是让每个问题只有一个清晰的当前 authority，而不是维护更多 Markdown。
