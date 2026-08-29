# Engineering Backlog

这里只保存**尚未进入当前工作包**的工程事项。优先级变化时移动条目，不在这里记录长实现日志。

## P2

### Program Monitor A/V clock and audio monitoring

- Timeline 已有 Rust audio-track authority、人工 A1 command builder 和 Final Cut Pro connected-audio delivery 语义。
- 尚缺实时监听与 Program Monitor A/V clock：播放时必须证明 video frame、embedded/linked audio、独立 A-track 使用同一播放时钟，不能靠两个独立 HTML media element 自行漂移。
- 进入实现前先固定 seek/play/pause/rate/change-source 的 clock ownership；若平台能力不足则保持监看降级，不伪装成 sample-accurate NLE playback。

### Source browser scalability

- 当前 Source select 已能基于 Review playable evidence 安全编辑，但大项目需要 Take 分组、搜索、camera / episode / scene filter。
- 筛选只改变浏览/选择体验，不复制 Review Best/Keep/Reject，也不获得 Timeline authority。

### First Python package migration slice

- 迁移机制和目标边界已经固定在 `PYTHON_PACKAGE_PLAN.md`；当前功能链不执行真实文件搬迁。
- 当前首选 slice：`fcpxml_reader.py` + `fcpxml_exporter.py` → `adapters/fcpxml/`。
- 启动条件：当前功能链在完整 checkout 上完成 `check_python` / `check_fast` / `check_full`、Desktop typecheck/Vitest、Rust/Tauri 和 packaged/native smoke 的真实执行，并先处理任何现存回归。
- 首个 slice 必须建立 old/new import identity、setuptools package discovery、recursive Desktop staging 和 packaged import contract。

### Validation ergonomics

- 记录 python/fast/full gate 的典型耗时和失败分类。
- 若 fast gate 超出日常反馈预算，再拆分为更窄的 smoke 子集；不要通过静默跳过必要检查来“提速”。

## P3 / Experimental

### Automated music scoring

- 保持独立 experiment/worktree。
- 明确音乐来源/版权、生成模型、候选评分与人工确认 contract 后再进入 Production。

### Automatic editing engines

- 素材挑选、粗剪、音乐适配等实验不得直接获得 Timeline authority。
- 输出保持 proposal/read-only preview，人工确认后才转换成 Rust Timeline commands。

## Backlog 规则

- 能在当前工作包内关闭的，不新增条目。
- 新条目必须说明“要解决的问题”，而不是预先指定大规模重写方案。
- 进入实际开发时，从这里移入 `STATUS.md` 的当前工作包。
- 已明确成为长期约束的内容，应进入 `DECISIONS.md` / `INVARIANTS.md`，而不是永久挂在 backlog。
