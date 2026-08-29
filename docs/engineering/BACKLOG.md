# Engineering Backlog

这里只保存**尚未进入当前工作包**的工程事项。优先级变化时移动条目，不在这里记录长实现日志。

## P1

### Delivery artifact path normalization

- `delivery.v1` Selection Manifest 当前仍包含 `manual_review_path` / `editorial_path` 的 Host 绝对路径；共享/可持久化 delivery artifact 不应携带设备路径。
- 将这些字段改成项目相对或逻辑 artifact 引用，并为 FCPXML source provenance 明确“共享 identity”与“Host-local source path”的边界。
- 增加 path-safety contract，确保 `/Volumes/...`、`/Users/...`、Windows 盘符不会进入可共享 delivery manifest。

## P2

### Timeline golden lifecycle

- Python Golden Project 已固定 Script → Slate → Mapping → Review/Editorial → Coverage → Rough Cut → Assembly → Delivery / reopen。
- 下一步在 Rust Timeline Core 增加对应最小 golden command sequence：seed → trim/split/replace → undo/redo → serialize/reopen。
- Timeline authority 只通过 Rust commands 改变；Python/React 不直接修改 authoritative timeline state。

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
