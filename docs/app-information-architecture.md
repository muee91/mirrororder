# 镜序 Desktop 现有信息架构映射

> **不是当前产品定义。** 唯一产品目标在 [`product/REBUILD_2026-11-17.md`](./product/REBUILD_2026-11-17.md)。本文件只解释已有 React/Python/Rust 代码如何承接重制，历史 2026-09 四域优先流程可从 Git history 查看。

## 当前代码责任

- `desktop/src/features/production/ProjectWorkbench.tsx` 仍包含 `素材 / 剧本 / 时间线 / 审阅` 四个域；它们是工程所有权，**不是新项目的四步强制流程**。
- `desktop/src/features/editor/MulticamSyncTimeline.tsx` 是同步时间线概览；同步进度、任务持久化由 Python Core / Host / Desktop 联动。
- Material/Slate、Script/Review、Identity/Search 和 Rust Timeline Core 的权威事实不因重制而互相覆盖。

## 目标入口与当前缺口

| 用户任务 | 当前基础 | 重制方向 |
| --- | --- | --- |
| 新建剧集并同步 | 媒体目录、机位识别、Sync engine、durable task | 第一屏明确同步任务、真实进度与错误 |
| 核对同步 | 只读机位时间线 | 可播放、缩放、对轨/漂移核对、人工纠偏 |
| 分发工程 | FCPXML/Premiere/剪映兼容生成代码 | 多轨母版 + 可切机位素材，按 NLE 真实验收 |
| 日常找素材 | Slate/Take/剧本映射/搜索代码 | 按拍摄顺序和剧本顺序检索，关联演员实际对白 |
| 团队交接 | media_id / device-local binding | 不共享绝对路径，跨机复用稳定素材身份 |

**同步母版不是创意组接时间线。** 不要在同一视图同时堆叠同步预览、完整 Source/Program、粗剪建议、场记和导出。AI 后台分析不是剪辑师先交付工程的前提。

组件纪律见 [`ux-principles.md`](./ux-principles.md) / [`design-system-v2.md`](./design-system-v2.md)；真实验收见 [`engineering/STATUS.md`](./engineering/STATUS.md)。
