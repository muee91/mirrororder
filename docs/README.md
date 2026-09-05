# 镜序文档索引

当前文档只保留**产品定义、真实生产领域 contract、必要跨层架构、当前工程控制**。历史阶段报告、旧 Swift/Golden 对照、一次性 verification、功能实验说明和迁移计划由 Git 历史保存，不继续作为当前 Markdown authority。

原则：

> **一个问题只有一个当前 authority。**

## 1. 接手项目先读

1. [`app-information-architecture.md`](./app-information-architecture.md) — **镜序产品定义 + 当前 Product/IA authority**。
2. [`engineering/STATUS.md`](./engineering/STATUS.md) — 当前 `main`、真实 CI 状态和 Product Recovery 事实。
3. [`engineering/BACKLOG.md`](./engineering/BACKLOG.md) — 当前 P0 Desktop Product Recovery 执行顺序。
4. [`engineering/INVARIANTS.md`](./engineering/INVARIANTS.md) — authority、workflow、UI 与数据硬约束。
5. [`ux-principles.md`](./ux-principles.md) — 专业后期工具交互纪律。
6. [`design-system-v2.md`](./design-system-v2.md) — canonical object、视觉与布局 authority。
7. [`architecture/desktop-bridge.md`](./architecture/desktop-bridge.md) — Desktop / Python / Rust / Team Web 边界。
8. [`architecture/repository-layout.md`](./architecture/repository-layout.md) — 源码仓库、workspace 与 device data 边界。

涉及具体领域时再读下面对应 contract，不要为了“了解全部项目”把所有 Markdown 都当必读。

## 2. 产品定义摘要

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

Desktop 一级工作区只有：

```text
素材 / 剧本 / 时间线 / 审阅
```

实现原则：

> **共享对象，不共享工作流。**

AI、Audit、语义检索、小镜、人物/声纹识别、自动归集、Coverage、Attention、Rough Cut / Assembly 都是主链的 evidence / projection / tool / proposal，不因代码模块存在而自动获得独立页面或业务 authority。

## 3. 当前领域 contract

只保留直接约束真实生产主链的数据与 authority：

- [`electronic-script-supervisor.md`](./electronic-script-supervisor.md) — 电子场记 / Script Supervisor 拍摄事实。
- [`media-camera-semantics.md`](./media-camera-semantics.md) — Media、A/B/C/AUX、机位与同步语义。
- [`review-read-model.md`](./review-read-model.md) — Review placement、Individual Opinion、Final Editorial Decision。
- [`coverage-graph.md`](./coverage-graph.md) — Script Coverage 的只读派生语义；不是独立工作台 authority。
- [`delivery-semantics.md`](./delivery-semantics.md) — Delivery / FCPXML 输出语义。

被删除的 Assistant、Semantic Retrieval、AI Audit 等专题文档不表示功能源码已删除；只是它们不再作为当前产品结构的独立 authority。P0 恢复完成后，确有长期 contract 价值的能力再基于真实产品需求重新定义。

## 4. 必要跨层架构

只保留长期稳定、跨多个实现层的边界：

- [`architecture/desktop-bridge.md`](./architecture/desktop-bridge.md) — Desktop bridge 与进程/authority 分层。
- [`architecture/project-package.md`](./architecture/project-package.md) — Project Package / `project.toml` / 可迁移边界。
- [`architecture/repository-layout.md`](./architecture/repository-layout.md) — source repo、runtime workspace 与设备数据位置。
- [`architecture/sync-model.md`](./architecture/sync-model.md) — 多设备共享事实与 device-local media binding。

自动化 pipeline、本地智能索引、Python package 迁移等实现方案不再作为长期架构入口。需要时从当前代码和 Git 历史重新评估，不继承旧方案。

## 5. 工程控制层

`engineering/` 只保留三份当前文件：

- [`engineering/STATUS.md`](./engineering/STATUS.md) — 当前事实与已知失败。
- [`engineering/BACKLOG.md`](./engineering/BACKLOG.md) — 当前待执行工作。
- [`engineering/INVARIANTS.md`](./engineering/INVARIANTS.md) — 长期不可突破的约束。

不再单独维护 Engineering README / Decisions：稳定规则已经进入 `AGENTS.md`、`INVARIANTS.md` 或对应 domain/architecture contract；历史决策过程由 Git 保存。

## 6. 历史材料

仓库当前文档树不保存 `verification/` 历史报告。某次 CI、某个 SHA、某轮 Swift/Golden parity 或阶段 closeout 只代表当时证据，继续留在当前 authority 树反而容易误导后续开发。

需要追溯时使用：

- Git history；
- GitHub Actions / CI logs；
- 对应历史 commit。

历史 Swift V1 仅作为最低可用性回归参照，不是当前技术或视觉规范。

## 7. 新文档规则

默认**不要新建 Markdown**。先判断是否可以更新现有 authority：

- “镜序是什么 / 工作区怎么分 / 功能属于哪里” → `app-information-architecture.md`；
- UX / 组件 /视觉 → `ux-principles.md` 或 `design-system-v2.md`；
- 业务数据与 authority → 对应领域 contract；
- 真正跨层且长期稳定的技术边界 → `architecture/`；
- 当前状态 / 当前计划 / 长期硬约束 → `STATUS / BACKLOG / INVARIANTS`。

一次性 prompt、重构计划副本、验收报告、分支 closeout、聊天 handoff 不提交为长期文档。
