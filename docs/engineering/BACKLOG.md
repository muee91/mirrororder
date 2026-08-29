# Engineering Backlog

这里只保存**尚未进入当前工作包**的工程事项。优先级变化时移动条目，不在这里记录长实现日志。

## P2

### First Python package migration slice

- 迁移机制和目标边界已经固定在 `PYTHON_PACKAGE_PLAN.md`；当前大分支不执行真实文件搬迁。
- 当前首选 slice：`fcpxml_reader.py` + `fcpxml_exporter.py` → `adapters/fcpxml/`。
- 启动条件：当前 `fix/runtime-read-paths` 在完整 checkout 上完成 `check_python` / `check_fast` / `check_full` 的真实执行，并先处理任何现存回归。
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
