# Engineering Backlog

这里只保存**尚未进入当前工作包**的工程事项。优先级变化时移动条目，不在这里记录长实现日志。

## P1

### Runtime install ordering

- 盘点 `editorial_runtime.py` 等 runtime/monkeypatch 安装链。
- 明确安装顺序、幂等要求和失败隔离。
- 为关键 install chain 增加 contract test。
- 继续删除依赖“后装 wrapper 覆盖前层危险 fallback”才能成立的路径。
- 明确 device-task runtime 与 project-task runtime 的安装先后和重复安装行为。

## P2

### Python package boundary

- 识别 `src/script_organizer/` 中可独立迁移的 coherent domains。
- 为迁移设计兼容 import、packaging、stage-runtime 和 pytest contract。
- 不做一次性大搬家，不与产品功能提交混合。

### Repository leakage guard

- 在本地完整 checkout 上增加 tracked-file/path guard，检查源码 Git 是否重新出现真实 workspace、设备绝对路径或制作输入。
- Guard 只能扫描源码/fixture 范围，避免误报用户本地 ignored workspace。

### Validation ergonomics

- 记录 fast/full gate 的典型耗时和失败分类。
- 若 fast gate 超出日常反馈预算，再拆分为更窄的 smoke 子集；不要通过静默跳过必要检查来“提速”。

### Golden production project

- 建立最小、合成、脱敏的短剧 Golden Project，覆盖剧本、FCPXML/素材、场记、Take、NG/Best、缺媒体、重复素材和多机位。
- 用同一 fixture 验证 Create → Slate → Mapping → Review → Coverage → Rough Cut → Timeline → Delivery → reopen 生命周期。
- Golden Project 只能保存可重建的 synthetic fixture，不得恢复真实 `projects/` 数据进源码 Git。

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
