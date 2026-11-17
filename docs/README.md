# 镜序文档索引

**唯一产品定义：[`product/REBUILD_2026-11-17.md`](./product/REBUILD_2026-11-17.md)。** 本文仅负责导航，不另写产品方向。旧五步 Product Recovery、历史验收报告和旧 SHA 不再作为开发指令。

## 接手先读
1. [产品路线与验收](./product/REBUILD_2026-11-17.md)
2. [`engineering/STATUS.md`](./engineering/STATUS.md)：当前真实证据和未验证项
3. [`engineering/BACKLOG.md`](./engineering/BACKLOG.md)：当前执行顺序
4. [`engineering/INVARIANTS.md`](./engineering/INVARIANTS.md)：安全和权限不变量
5. [`../AGENTS.md`](../AGENTS.md)：Agent 工作约束

## 领域事实契约（按需读）
- [`electronic-script-supervisor.md`](./electronic-script-supervisor.md)：场记数据和人工拍摄事实。
- [`media-camera-semantics.md`](./media-camera-semantics.md)：机位角色、媒体用途和同步语义。
- [`review-read-model.md`](./review-read-model.md)：人工 Review 和 Editorial 权限。
- [`coverage-graph.md`](./coverage-graph.md)：剧本覆盖的只读派生语义，非独立主流程。
- [`delivery-semantics.md`](./delivery-semantics.md)：已有交付数据 contract，不代表 NLE 导入已经实测。

## 技术架构（按需读）
- [`architecture/desktop-bridge.md`](./architecture/desktop-bridge.md)
- [`architecture/project-package.md`](./architecture/project-package.md)
- [`architecture/repository-layout.md`](./architecture/repository-layout.md)
- [`architecture/sync-model.md`](./architecture/sync-model.md)

## 现有界面参考（不能反向定义产品）
- [`app-information-architecture.md`](./app-information-architecture.md)：已有代码/目标 UI 的映射，不再是独立产品 authority。
- [`ux-principles.md`](./ux-principles.md)、[`design-system-v2.md`](./design-system-v2.md)：交互规则与既有组件约束，旧页面布局无需照搬。
- [`user-guide.md`](./user-guide.md)：开发测试阶段使用提示。

历史决策、阶段进展和过期 TODO 已保留在 Git 历史与 GitHub Actions。新方案优先更新上述文件的唯一 owner，不创建另一份“最新方向.md”。
