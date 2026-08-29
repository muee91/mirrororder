# Production Readiness Integration Plan

状态：**Prepared / merge blocked by executable gates**  
日期：2026-08-29

## 背景

`fix/runtime-read-paths` 从 `main@4e112efebf70159ff2d1ef91b530947e5efb7c3e` 开始，经过远端 Contents API 逐文件推进，目前形成大量机械小提交。最终 diff 是可审阅的工程工作包，但提交历史不是适合进入 `main` 的形态。

截至制定本计划时：

- branch：`fix/runtime-read-paths`
- merge base：`main@4e112ef...`
- changed files：约 50
- branch commits：约 105 个 Contents/API 小提交
- `main`：仍未修改

**不得直接把这 100+ 个机械提交 merge 到 `main`。**

## 为什么不在远端直接 squash

当前环境没有完整 checkout，也没有可执行 Rust/Node toolchain。远端重写 branch history 会同时带来：

- 无法在 squash 后真实运行 local gates；
- force-push / commit graph 重写风险；
- 很难证明重构后的每个中间 commit 都可构建；
- 当前多个 Stage 修改同一文件，按历史 stage 强拆 commit 可能制造从未真实存在过的半状态。

因此采用**本地最终树验证后 squash integration**，而不是在 GitHub API 上重放 100+ 个 commit。

## 集成前置条件

必须在完整本地 checkout 的 `fix/runtime-read-paths` 上真实执行：

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

只有实际成功才可以记录 PASS。任一失败都在当前 branch 修复并重跑，不通过删除测试、关闭 guard 或跳过 Rust/Tauri 来取绿灯。

涉及真实应用验收时，source gates 之后仍需单独执行适用的 packaged/native smoke：

- packaged macOS/Windows runtime；
- real media / FFmpeg / FFprobe；
- LAN / Team Web；
- FCPXML / Final Cut Pro；
- installer / reopen / crash recovery。

## 推荐集成方式

### 1. 保留工作分支作为原始审计历史

不要先删除或 force-push `fix/runtime-read-paths`。它保留 Stage 1–9 的逐步修改证据。

可选在本地/远端创建只读归档引用：

```bash
git branch archive/production-readiness-20260829 fix/runtime-read-paths
```

### 2. 从稳定 main 创建 integration worktree

```bash
git switch main
git pull --ff-only
git worktree add ../mirrororder-integration -b integration/production-readiness-1 main
cd ../mirrororder-integration
```

### 3. 只带入最终树，不 cherry-pick 105 个机械提交

```bash
git merge --squash fix/runtime-read-paths
```

此时**先不 commit**。

### 4. 审阅 staged final diff

至少检查：

```bash
git diff --cached --stat
git diff --cached --check
git diff --cached --name-status
```

预期变化域只能来自：

- engineering control / local gates / docs；
- runtime read-path / installation hardening；
- device-scope model tasks / Status Center；
- Golden Production / Delivery path safety；
- Rust Timeline authority / persistence；
- package migration plan/contracts。

出现真实 workspace、media、cache、output、model weights、secret、无关产品功能或未知二进制时立即停止集成。

### 5. 在 integration worktree 再跑一次 gates

即使源工作分支已经 PASS，squash 后仍重新执行：

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

原因：最终要进入 `main` 的对象是 squash 后的**集成树**，验证证据必须绑定它，而不是继承工作分支的 PASS。

### 6. 使用一个语义完整的主线提交

当前 diff 的 Stage 1–9 已经互相交织，例如：

- `desktop_runtime.py` 同时承载 read-path 与 device-task 收口；
- Timeline Rust/TS/tests 共同形成 authority contract；
- `check_python.py` / repository guard 引用本轮新增 docs/tests；
- runtime stack 与多个 domain installer 顺序互相约束。

因此不为了“看起来提交更小”而人为构造未经验证的中间状态。推荐一个经过完整 gates 的 squash commit：

```text
feat: harden production runtime and timeline authority
```

提交正文应概括：

- local engineering gates/control layer；
- durable device model preparation；
- deterministic runtime stack；
- golden production lifecycle；
- path-safe delivery artifacts；
- Rust Timeline stale-authority + persistence lifecycle；
- repository leakage and package migration contracts。

以后新的工作恢复小 slice / worktree，不再继续扩大该综合提交。

### 7. 集成后验证

```bash
git status --short
git log -1 --stat
python scripts/check_fast.py
```

如执行 native smoke，把结果写入 `docs/verification/`，再把 `STATUS.md` 的对应 gate 从 `NOT RUN` 改为真实结果。

## 风险排序

### Critical

- Rust Timeline `generation + revision` stale-authority contract；
- checkpoint / journal crash recovery；
- replacement path (`load` / `load_with_commands`) 不得绕过 authority。

### High

- device-scope durable model tasks 与取消传播；
- runtime installer order / retry / import side-effect；
- Desktop Status Center 对 project/device task 的统一控制。

### Medium

- Delivery logical artifact refs 与 localhost path resolution；
- Golden Production cross-domain semantics；
- repository leakage guard。

### Low

- engineering docs、score/status、future package plan 本身。

低风险文档不能用来抵消 Critical/High executable gate 的缺失。

## 禁止事项

- 不在当前无完整 checkout 的环境 force-push/squash remote branch。
- 不直接 merge 105 个机械 API commits 到 `main`。
- 不把旧 GitHub Actions 结果继承到 squash commit。
- 不因为 squash final tree 与工作分支文件内容相同，就跳过 integration worktree 的本地验证。
- 不在这个 integration commit 顺手执行 Python package 文件搬迁、自动配乐、自动剪辑新功能或其他新 scope。

## 完成定义

Integration stabilization 只有同时满足以下条件才算关闭：

1. 工作分支完整 checkout 上适用 gates 真实通过；
2. squash integration tree diff 审阅通过；
3. integration tree 上 gates 重新通过；
4. 单一主线 commit 创建；
5. `main` 更新后工作区 clean；
6. `STATUS.md` 绑定最终 commit 记录真实 gate 证据；
7. native/package smoke 未执行的部分继续明确写 `NOT RUN`。
