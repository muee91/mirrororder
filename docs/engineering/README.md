# 工程控制层

`docs/engineering/` 保存**当前工程管理事实**，用于让本地开发、Agent、worktree 和远端协作共享同一套轻量控制面。这里不取代产品/领域 authority，也不保存一次性验收报告。

## 四个文件各自负责什么

- [`STATUS.md`](./STATUS.md)：当前正在做什么、哪些风险未关闭、哪些 gate 实际执行过。
- [`BACKLOG.md`](./BACKLOG.md)：尚未进入当前工作包的工程事项，按优先级排队。
- [`DECISIONS.md`](./DECISIONS.md)：已经接受、会长期影响实现方式的工程决策。
- [`INVARIANTS.md`](./INVARIANTS.md)：任何分支、Agent 或实现都不能突破的高影响约束。

产品入口、UX、领域 authority 和跨层架构仍以 [`../README.md`](../README.md) 中列出的当前文档为准；一次性验证证据仍进入 [`../verification/`](../verification/)。

## 工程事实的 authority 顺序

遇到冲突时按以下顺序判断：

1. 当前产品/领域 authority 与 Core 实现；
2. `AGENTS.md` 与 `INVARIANTS.md` 的仓库级约束；
3. `DECISIONS.md` 已接受的工程决策；
4. `STATUS.md` 当前执行状态；
5. `BACKLOG.md` 未来计划；
6. `docs/verification/` 历史证据；
7. 聊天记录、临时 prompt、旧分支说明。

聊天可以帮助推进工作，但**不能成为唯一工程事实源**。

## 默认工作流

```text
main
  ↓
独立 branch + git worktree
  ↓
实现 / 测试 / diff review
  ↓
本地 source gate / fast gate
  ↓
必要时 full gate / native smoke
  ↓
更新 STATUS / DECISIONS / BACKLOG
  ↓
并回 main
  ↓
GitHub push / PR / release / optional CI
```

### 本地验证入口

在完整 checkout 中按可用工具链选择最低可执行层，但**低层通过不能替代高层**：

```bash
# Python-only：不依赖 Node/Cargo/网络
python scripts/check_python.py

# 日常跨栈 fast gate
python scripts/check_fast.py

# 合并高风险工作前的完整 source gate
python scripts/check_full.py
```

`check_python.py` 会执行 Python compileall 和当前 production contract smoke；缺少测试文件或 pytest 时 fail closed。它适合 Node/Rust 工具链暂不可用时尽早发现 Python/contract 回归，但不代表 TypeScript、Vitest、Rust/Tauri、packaged runtime 或 native media/FCP 已验证。

### 可以直接改 `main` 的范围

仅限低风险、可快速审阅且不会改变 contract 的修改，例如：

- 文档拼写或链接；
- 明显 typo；
- 极小测试修复；
- 已有行为的单文件低风险 bugfix；
- 不改变 schema、authority、runtime、API contract 或跨层依赖的配置修正。

### 默认必须 worktree 的范围

满足任意一条即使用独立 branch/worktree：

- 修改超过 3 个文件；
- 跨 Python / React / Tauri / Rust；
- API、DTO、schema、workspace 或 artifact contract 变化；
- durable task、runtime、媒体处理、模型运行时；
- 算法实验、自动剪辑、自动配乐、NLE adapter；
- 审计、迁移、重构或可能扩大 scope 的工作。

推荐命名：

```text
feature/<topic>
fix/<topic>
audit/<topic>
chore/<topic>
experiment/<topic>
```

本地示例：

```bash
git worktree add ../mirrororder-waveform -b fix/waveform-runtime main
```

分支不需要为了日常开发而立即 push 到 GitHub；远端是协作/备份层，不是本地开发控制面。

## 工作包关闭条件

一个工作包只有在以下事实明确后才可以从 `STATUS.md` 移到完成：

1. scope 已收敛，未解决项进入 `BACKLOG.md`；
2. authority / contract 变化已同步到对应长期文档；
3. 实际执行过的 gate 有明确结果；
4. 没有执行的 gate 明确写 `NOT RUN`，不能继承旧 PASS；
5. 如果新形成长期约束，更新 `DECISIONS.md` 或 `INVARIANTS.md`；
6. 并回 `main` 前完成 diff review。

GitHub Actions 是额外验证信号，不是上述流程成立的前提。