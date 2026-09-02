# Engineering Backlog

这里只保存**尚未进入当前工作包**的工程事项，不记录阶段日志或旧分支计划。

## P1 — Engineering cleanup

### Desktop CSS ownership consolidation

- `desktop/src/main.tsx` 仍加载多层 base/theme/recovery/redesign/feature CSS。
- 目标是逐步明确 selector/token ownership，一次迁移一个小范围；不要机械合并所有 CSS，也不要破坏 feature-local 样式边界。

### Web legacy compatibility DOM

- `web/index.html` 仍保留供 legacy vanilla JS 使用的隐藏 DOM/state 结构。
- 先映射 ID/class consumer，再把状态与事件迁到直接 API/state；只有零 consumer 后才删除隐藏 DOM。

## P2

### Migration-era naming cleanup

- `Golden*`、`*_v2`、`*_v3`、`recovery`、`redesign`、`frozen` 中既有真实实现，也有 compatibility facade。
- 先确认 canonical implementation 与 caller，再迁移 import/name；禁止按文件名批量删除。

### Program Monitor A/V clock and audio monitoring

- Timeline 已有 audio-track authority 和 Delivery 音频语义，但实时 Program Monitor 仍需统一 video/audio playback clock。
- 平台能力不足时保持明确降级，不伪装 sample-accurate NLE playback。

### Source browser scalability

- 大项目需要 Take 分组、搜索和 camera / episode / scene filter。
- 筛选只改变浏览体验，不复制 Review Best/Keep/Reject，也不获得 Timeline authority。

### First Python package migration slice

- 长期边界见 [`../architecture/python-package-boundaries.md`](../architecture/python-package-boundaries.md)。
- 首选 slice 仍是 FCPXML adapter；迁移必须保持业务行为、authority、packaging 和 Desktop staging contract 不变。

### Validation ergonomics

- 记录 python/fast/full gate 的典型耗时和失败分类。
- 如果 fast gate 过慢，应拆分可解释的 smoke 层，而不是静默跳过必要检查。

## P3 / Experimental

### Automated music scoring

- 明确音乐来源/版权、生成模型、候选评分、缓存与人工确认 contract 后再进入 Production。

### Automatic editing engines

- 素材挑选、粗剪、音乐适配等输出保持 proposal/read-only preview；人工确认后才转换成 Rust Timeline commands。

## Backlog 规则

- 当前工作包能关闭的事项不新增 backlog。
- 条目描述问题和边界，不预先指定大规模重写方案。
- 已成为长期约束的内容进入 `DECISIONS.md` / `INVARIANTS.md`。
