# 镜序跨层工程架构

这个目录保存**跨多个产品领域或技术层的长期工程说明**。产品入口、UX 与领域 authority 仍以 `docs/` 根目录中的当前 contract 为准；一次性验收证据只进入 `docs/verification/`。

## 当前文档

- [`repository-layout.md`](./repository-layout.md) — 源码仓库、运行时工作区、测试 fixture、Desktop 与 Python 文件落位规则。
- [`desktop-bridge.md`](./desktop-bridge.md) — React / Tauri / Python Core / Rust Timeline / Team Web 边界。
- [`sync-model.md`](./sync-model.md) — 多设备项目同步与 device-local media binding 模型。
- [`automation-pipeline.md`](./automation-pipeline.md) — 自动整理、AI Rescue、Shadow Audit 与 durable task 边界。
- [`local-intelligence.md`](./local-intelligence.md) — 本机可重建感知、身份与语义索引。

## 源码仓库 ≠ 生产工作区

`sync-model.md` 中的 workspace/project 文件描述的是**制作数据如何在团队设备之间同步**，不是要求把真实制作项目提交到 MirrorOrder 源码仓库。

本仓库的根 `workspace.toml` 只是开发入口。运行时 `projects/`、registry、项目配置、剧本/FCPXML 输入副本、cache、output、review/tasks 等都属于工作区数据，默认不进入 Git。
