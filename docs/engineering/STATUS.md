# 镜序当前工程状态

> 核对：2026-11-17。**只有可追溯的当前事实**，旧修复轮次/过期 SHA 请查 Git history。产品定义：[`../product/REBUILD_2026-11-17.md`](../product/REBUILD_2026-11-17.md)。

## Git 与自动验证
- `main`：`88e585e1c5d44ad7698888a54683ab04a03596c3`，尚未合并重制。
- Draft PR [#3](https://github.com/muee91/mirrororder/pull/3) 位于 `rebuild/sync-first-workflow-20261117`。
- 重制分支 CI #132（对应整理之前的 commit）：Python 成功、macOS 成功、Linux Desktop 测试失败，**不是全绿**。后续文档修改须以新 SHA 重新检查。

## 已存在的代码能力（不是交付证明）
- 第一方多机位同步引擎、机位规则、任务与媒体身份索引、设备本机媒体绑定。
- FCPXML、Premiere XML 和部分剪映兼容输出代码；存在代码不代表四款 NLE 原生多机位可用。
- Slate、剧本映射、Review、Identity、ASR / 模型和检索模块。
- Draft PR #3 接通进度检查点、最近任务活动和同步失败信息，并让媒体目录项目先进入同步入口。
- 2026-11-17 实盘证据：视频 3,064 条；A/B/C/D/E/F 为 723/781/739/740/40/39 条，另有 2 条未分类；294 条独立 WAV **尚未完成同步验收**。

## 尚未验证 / 不得写成 PASS
- 同步时间线仍是只读概览；缺联动预览、播放头、缩放、漂移核对、人工修正。
- 视频和独立 WAV 的逐帧音画对齐、复杂错时码与跨 Take 同台词纠错。
- 同步母版与原生多机位素材两种交付在 Resolve / Premiere / Final Cut Pro / 国内剪映（Windows/macOS）的真实导入。
- 新剧直接创建、完成同步、分发工程、剪辑过程中检索素材的完整生产闭环。
- 本地/第三方模型长期运行、团队跨机映射与工程交接的完整实测。

只有实际完成的目标 commit/CI 和真实素材/NLE 操作才能更新为 PASS。下一步只看 [`BACKLOG.md`](./BACKLOG.md)。
