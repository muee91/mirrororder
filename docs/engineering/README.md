# 工程控制层

`docs/engineering/` 只保存**当前工程管理事实**。一次性 Codex prompt、旧分支收尾脚本、历史 integration plan 和某次 PASS 证据不属于这里；这些信息由 Git 历史或 `docs/verification/` 保存。

## 当前文件

- [`STATUS.md`](./STATUS.md)：当前 `main` 状态、未关闭风险和最近真实验证。
- [`BACKLOG.md`](./BACKLOG.md)：尚未进入当前工作包的工程事项。
- [`DECISIONS.md`](./DECISIONS.md)：仍然生效的长期工程决策。
- [`INVARIANTS.md`](./INVARIANTS.md)：任何实现都不能突破的高影响约束。

长期跨层架构进入 [`../architecture/`](../architecture/)；产品/领域 authority 从 [`../README.md`](../README.md) 开始阅读。

## Authority 顺序

发生冲突时按以下顺序判断：

1. 当前产品/领域 authority 与 Core 实现；
2. `AGENTS.md` 与 `INVARIANTS.md`；
3. `DECISIONS.md`；
4. `STATUS.md`；
5. `BACKLOG.md`；
6. `docs/verification/` 与 Git 历史。

历史报告、聊天记录和旧执行计划不能覆盖当前 authority。

## 当前工作流：main-only

仓库当前只维护 `main` 作为开发与集成线。默认流程是：读取最新 `main` → 收敛 scope → 原子修改 → diff review → 运行适用 gate → 直接提交 `main`。不把长期 feature branch、worktree 或 PR 流程当作当前工程前提；如果以后恢复多分支协作，应先更新本文件和 `DECISIONS.md`。

本地验证入口：

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

低层 PASS 不能替代高层验证；没有实际执行的 gate 必须写 `NOT RUN`。GitHub Actions 是独立验证信号：CI 失败必须记录和修复，但不能用旧 CI、旧 commit 或源码审阅伪造当前 PASS。

## 文档维护

- 当前状态只写 `STATUS.md`，不堆阶段日志。
- 长期约束写 `DECISIONS.md` / `INVARIANTS.md`。
- 未来事项写 `BACKLOG.md`。
- 一次性验收写 `docs/verification/`。
- 长期跨层设计写 `docs/architecture/`。
- 已完成的一次性执行说明直接删除；Git 历史已保存它们。
