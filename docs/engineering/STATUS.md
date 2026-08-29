# Engineering Status

更新时间：2026-08-29

## 当前基线

- 主线：`main@4e112efebf70159ff2d1ef91b530947e5efb7c3e`
- 当前工作分支：`fix/runtime-read-paths`
- 工程控制层起始分支：`chore/engineering-control-plane`
- GitHub Actions：当前额度不可用；不作为必要 gate。
- 当前原则：源码审阅不能替代 executable validation；未执行的 gate 一律 `NOT RUN`。

## 产品就绪度

| 阶段 | 总评分 |
| --- | ---: |
| 初始评估 | 68 |
| Stage 1 — Runtime read-path safety | 70 |
| Stage 2 — Device-local model preparation durability | 72 |
| Stage 3 — Runtime installation order | 74 |
| Stage 4 — Golden production project | 76 |
| Stage 5 — Delivery artifact path normalization | 77 |
| Stage 6 — Rust Timeline authority lifecycle | 80 |
| Stage 7 — Repository tracked-data leakage guard | 81 |
| Stage 8 — Python-only source gate | 82 |
| Stage 9 — Python package boundary plan | **83** |

评分代表当前产品/工程就绪度判断，不替代 fast/full/native gate。

## 当前已收口的关键能力

- Media Inventory 与 Waveform 的重工作已进入 durable task；普通 GET 只读 cache/snapshot。
- Local Vision / Identity 模型准备属于 device-scope durable task，并统一进入 Status Center。
- Production Host 使用单一 `runtime_stack` 安装编排；安装失败可重试，import 不再偷偷修改全局 runtime。
- Synthetic Golden Project 固定 Script → Slate → Mapping → Review/Editorial → Coverage → Rough Cut → Assembly → Delivery / reopen 语义。
- Delivery 持久化 artifact 只保存逻辑引用；设备绝对路径仅存在于 localhost runtime response。
- Rust Timeline 以 `generation + journal revision` 作为 authority token，保护 replacement/edit/undo/redo/checkpoint，并覆盖 journal replay / reopen。
- Git tracked workspace/shared structured fixture 有 device-path leakage guard；ignored 用户 workspace 不参与扫描。
- `scripts/check_python.py` 可独立执行 Python compile + production contract smoke；`check_fast.py` 复用该入口。
- `PYTHON_PACKAGE_PLAN.md` 已固定 flat namespace 的目标 ownership、依赖方向、slice 顺序、临时 import facade 与 staging/package contract；当前分支明确不执行 mass move。

## 当前验证状态

针对 `fix/runtime-read-paths`：

- Source / diff review：**PASS**（仅代表源码/contract 已审阅）
- `scripts/check_python.py` 本身：`py_compile` **PASS**（当前会话临时目录）
- `scripts/check_python.py` 在不完整临时目录执行：**EXPECTED FAIL**，因 contract tests 缺失而退出 1；证明缺材料时 fail closed，不等于仓库测试已执行
- Python production contract smoke：**NOT RUN**（当前环境没有完整 checkout）
- `python scripts/check_fast.py`：**NOT RUN**
- `python scripts/check_full.py`：**NOT RUN**
- Rust/Tauri executable tests：**NOT RUN**（当前环境无 Rust toolchain）
- TypeScript/Vitest executable tests：**NOT RUN**（当前环境无完整 Desktop checkout / `node_modules`）
- Native packaged runtime / real media / LAN / FCP smoke：**NOT RUN**
- GitHub Actions：**NOT RUN** / 当前额度不可用

## 当前 P1

### Local executable validation and integration stabilization

在完整本地 checkout 上依次执行：

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

要求：

- 失败回到对应 contract 修复，不允许通过删除/跳过测试取得绿灯；
- fast/full 都真实通过后再决定如何把当前大分支整理、squash 并集成到 `main`；
- packaged/native smoke 仍是独立验收层，不由 source gate 冒充。

## 下一 P2

- First Python package migration slice：通过当前大分支 executable gates 后，独立 `refactor/python-fcpxml-package` worktree，按 `PYTHON_PACKAGE_PLAN.md` 迁 FCPXML adapter；不与产品功能混改。
- Validation ergonomics：有完整 checkout 后记录 python/fast/full 的典型耗时和失败分类，再决定是否需要更窄 smoke。

## 状态维护规则

- `STATUS.md` 只保留当前事实，不继续堆阶段实现日志。
- 长期决策进入 `DECISIONS.md` / `INVARIANTS.md`。
- 历史验收证据进入 `docs/verification/`。
- 未进入当前工作包的事项进入 `BACKLOG.md`。
