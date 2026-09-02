# 镜序跨层工程架构

这里保存**跨多个产品领域或技术层的长期工程说明**。产品入口、UX 与领域 authority 仍以 `docs/` 根目录中的当前 contract 为准；一次性验收证据进入 `docs/verification/`。

## 当前文档

- [`repository-layout.md`](./repository-layout.md) — 源码仓库、运行时工作区、fixture 与文件落位规则。
- [`desktop-bridge.md`](./desktop-bridge.md) — React / Tauri / Python Core / Rust Timeline / Team Web 边界。
- [`sync-model.md`](./sync-model.md) — 多设备同步与 device-local media binding。
- [`automation-pipeline.md`](./automation-pipeline.md) — 自动整理、AI Rescue、Audit 与 durable task 边界。
- [`local-intelligence.md`](./local-intelligence.md) — 本机可重建感知、身份与语义索引。
- [`python-package-boundaries.md`](./python-package-boundaries.md) — Python domain ownership、依赖方向与渐进迁移 contract。

`sync-model.md` 描述的是生产 workspace 如何同步，不代表真实制作项目应进入源码 Git。源码仓库只保留空 `projects/.gitkeep`；真实项目状态、媒体、cache/output 与设备路径属于运行时 workspace/device state。
