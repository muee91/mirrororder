# Production Readiness Integration Plan

状态：**Prepared / merge blocked by executable and native gates**  
日期：2026-08-29

## 当前候选树

- `main`: `4e112efebf70159ff2d1ef91b530947e5efb7c3e`
- 当前最终候选功能链：`feature/timeline-audio-ux`
- 当前 Stage 17 文档/Delivery 状态 commit：`2f219ff7e7e6f51733003a7ce1dff0af35328d1e`
- 当前候选树相对 `main`：约 147 个开发/API 小提交，0 behind
- `main` 仍未修改

这些提交记录了 Stage 1–17 的逐步实现和远端 API 写入历史，但**不是适合直接进入主线的提交历史**。最终进入 `main` 的对象必须是经过完整本地 gate、native smoke 和重新验证的最终树。

## 禁止直接 merge 当前开发历史

不得把 100+ 个机械/API 小提交原样 merge 到 `main`。原因：

- 多个 Stage 修改同一 runtime / Timeline / Delivery 文件；
- 中间提交包含后来被纠正的过渡设计；
- 当前远端环境没有完整 executable evidence；
- 只有最终树经过真实 gates 才能作为主线证据。

不要为了“提交看起来更小”人为构造未经验证的中间状态。

## 前置条件

在完整 checkout 上检出最终候选分支后，先完成 Stage 17 的唯一剩余 UI 接线，再运行：

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

Desktop 可单独执行：

```bash
cd desktop
npm install
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml timeline::tests::
cargo test --manifest-path src-tauri/Cargo.toml persistence::tests::
cargo check --manifest-path src-tauri/Cargo.toml
```

只有实际成功才记录 PASS。失败必须修代码并重跑，禁止删除测试、降低 guard、跳过 Rust/Tauri 或把 `0 tests` 当成功。

## Native / packaged 验证

Source gates 通过后仍必须单独验证：

- `npm run stage:runtime`
- `npm run verify:rc`
- `npm run tauri -- build`（macOS 主验证环境）
- `npm run verify:macos-bundle`
- packaged App 启动 / reopen / crash-recovery smoke
- real media / FFmpeg / FFprobe
- device task submit / cancel / restart recovery
- Team Web / LAN 基本 smoke（若本次发布包含）
- Timeline → FCPXML → Final Cut Pro 真实导入
- embedded audio + independent A1 connected-audio playback

Packaged/native/FCP smoke 未运行时必须继续写 `NOT RUN`。

## 推荐最终集成方式

### 1. 保留开发分支作为审计历史

不要先删除 `fix/runtime-read-paths`、Timeline feature branches 或 `feature/timeline-audio-ux`。

可选建立归档 tag/branch：

```bash
git branch archive/production-readiness-20260829 feature/timeline-audio-ux
```

### 2. 在最终候选分支先跑 gates

```bash
git switch feature/timeline-audio-ux
git pull --ff-only
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

全部成功后再继续。

### 3. 从干净 main 建 integration worktree

```bash
git switch main
git pull --ff-only
git worktree add ../mirrororder-integration -b integration/production-readiness-1 main
cd ../mirrororder-integration
```

### 4. 只带入最终树

```bash
git merge --squash feature/timeline-audio-ux
```

先不要 commit。

### 5. 审阅 staged final diff

```bash
git diff --cached --stat
git diff --cached --check
git diff --cached --name-status
```

允许的主要变化域：

- engineering control / source gates / docs
- runtime read-path / deterministic install / device durable tasks
- Golden Production / repository leakage guard
- Rust Timeline authority / journal / stale protection
- Source Monitor / Insert / Overwrite / Mark In-Out
- multicam synchronization evidence
- authoritative Timeline → FCPXML Delivery
- linked embedded audio + independent A-track delivery
- package migration plan/contracts

如出现真实 workspace、media、cache、model weights、secrets、未知二进制或无关实验，立即停止。

### 6. 在 squash tree 重新运行全部 gates

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

随后运行 applicable packaged/native/FCP smoke。工作分支上的 PASS **不能继承**给 squash commit。

### 7. 创建一个语义完整的主线提交

推荐：

```text
feat: harden production runtime and authoritative editing workflow
```

提交正文至少概括：

- deterministic runtime + durable device work
- engineering gates and repository guards
- Golden Production lifecycle
- Rust Timeline authority / persistence / stale recovery
- Source → Program manual editing and multicam sync
- authoritative Timeline FCPXML delivery
- linked + independent audio delivery

### 8. main 更新后最后复验

```bash
git status --short
git log -1 --stat
python scripts/check_fast.py
```

把真实执行证据写入 `docs/verification/`，并更新 `STATUS.md`。未运行的 native smoke 继续保持 `NOT RUN`。

## 风险排序

### Critical

- Rust Timeline generation + revision stale-authority
- checkpoint / journal crash recovery
- load / load_with_commands replacement guard
- Timeline snapshot → FCPXML source-time / multicam sync correctness

### High

- independent audio source range / connected-audio export
- device durable model tasks / cancellation / restart recovery
- runtime installer retry / import side-effect
- Status Center project/device task unification

### Medium

- Delivery logical refs / localhost path decoration
- Golden Production cross-domain semantics
- repository leakage guard

### Low

- status/score/docs themselves

低风险文档不能抵消 Critical/High executable evidence 的缺失。

## 完成定义

本轮 Production Readiness 只有同时满足以下条件才关闭：

1. Stage 17 Audio Editing UX 完成；
2. 最终候选分支 Python / TS / Rust/Tauri source gates 实际通过；
3. squash integration tree 上重新通过同一 gates；
4. packaged Desktop smoke 通过；
5. 一个真实最小项目完成媒体 → Review → Timeline → audio → FCPXML → Final Cut Pro 导入；
6. integration 以经过验证的最终树进入 `main`；
7. `STATUS.md` 与 `docs/verification/` 绑定最终 commit 记录真实证据。
