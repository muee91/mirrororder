# Engineering Status

更新时间：2026-08-29

## 当前基线

- 主线：`main@4e112efebf70159ff2d1ef91b530947e5efb7c3e`
- 稳定化工作分支：`fix/runtime-read-paths`
- 当前功能分支：`feature/timeline-editor-basics`（基于稳定化分支；不反向污染已冻结的稳定化 branch）
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
| Stage 9 — Python package boundary plan | 83 |
| Stage 10 — Integration stabilization audit | 84 |
| Stage 11 — Timeline authority UX | **85** |

评分代表当前产品/工程就绪度判断，不替代 fast/full/native gate。

## 当前已收口的关键能力

- Media Inventory 与 Waveform 的重工作已进入 durable task；普通 GET 只读 cache/snapshot。
- Local Vision / Identity 模型准备属于 device-scope durable task，并统一进入 Status Center。
- Production Host 使用单一 `runtime_stack` 安装编排；安装失败可重试，import 不再偷偷修改全局 runtime。
- Synthetic Golden Project 固定 Script → Slate → Mapping → Review/Editorial → Coverage → Rough Cut → Assembly → Delivery / reopen 语义。
- Delivery 持久化 artifact 只保存逻辑引用；设备绝对路径仅存在于 localhost runtime response。
- Rust Timeline 以 `generation + journal revision` 作为 authority token，保护 replacement/edit/undo/redo/checkpoint，并覆盖 journal replay / reopen。
- Timeline Desktop 在 stale/authority-required 冲突时恢复最新 persisted Rust snapshot，但**不自动重放失败编辑**；已有 Timeline 从 Rough Cut 重建必须二次确认。
- Git tracked workspace/shared structured fixture 有 device-path leakage guard；ignored 用户 workspace 不参与扫描。
- `scripts/check_python.py` 可独立执行 Python compile + production contract smoke；`check_fast.py` 复用该入口。
- `PYTHON_PACKAGE_PLAN.md` 已固定 flat namespace 的目标 ownership、依赖方向、slice 顺序、临时 import facade 与 staging/package contract；稳定化分支明确不执行 mass move。
- `INTEGRATION_PLAN.md` 已固定综合稳定化分支的本地 gate → squash integration worktree → 复验 → 单一主线 commit 流程。

## 当前验证状态

### `fix/runtime-read-paths`

- Source / diff review：**PASS**（仅代表源码/contract 已审阅）
- `scripts/check_python.py` 本身：`py_compile` **PASS**（当前会话临时目录）
- Python production contract smoke：**NOT RUN**（当前环境没有完整 checkout）
- `python scripts/check_fast.py`：**NOT RUN**
- `python scripts/check_full.py`：**NOT RUN**
- Rust/Tauri executable tests：**NOT RUN**（当前环境无 Rust toolchain）
- TypeScript/Vitest executable tests：**NOT RUN**（当前环境无完整 Desktop checkout / `node_modules`）
- Native packaged runtime / real media / LAN / FCP smoke：**NOT RUN**
- GitHub Actions：**NOT RUN** / 当前额度不可用

### `feature/timeline-editor-basics`

- 相对稳定化分支 diff：3 files；Source / diff review **PASS**
- `desktop/src/api/timeline.test.ts`：authority-conflict classification tests 已写入，**NOT RUN**
- TypeScript typecheck：**NOT RUN**
- Vitest：**NOT RUN**
- Tauri/Rust：本分支未修改 Rust；基础 Stage 6 Rust executable evidence 仍 **NOT RUN**

## 当前 P1

### Local executable validation and integration stabilization

先在完整 checkout 验证 `fix/runtime-read-paths`：

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

全部通过后按 `INTEGRATION_PLAN.md` 把稳定化分支 squash/revalidate 集成到 `main`。

随后对 `feature/timeline-editor-basics` 至少执行：

```bash
cd desktop
npm run typecheck
npm test
```

如果稳定化分支在本地 gate 暴露回归，先修 base；不把功能分支当作掩盖 base failure 的手段。

## 下一 P2

- Timeline source-to-program editing：在 authority UX 验证后，再设计明确 source selection / source in-out → Rust Insert/Overwrite 的交互；不把当前“选中 timeline clip 的 Source Monitor”误当成完整 source browser。
- First Python package migration slice：稳定化分支成功集成后，独立 `refactor/python-fcpxml-package` worktree。
- Validation ergonomics：记录真实 python/fast/full gate 耗时与失败分类。

## 状态维护规则

- `STATUS.md` 只保留当前事实，不继续堆阶段实现日志。
- 长期决策进入 `DECISIONS.md` / `INVARIANTS.md`。
- 历史验收证据进入 `docs/verification/`。
- 未进入当前工作包的事项进入 `BACKLOG.md`。
