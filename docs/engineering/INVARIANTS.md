# Engineering Invariants

这些约束是跨分支、Agent、runtime 和客户端都必须遵守的高影响不变量。完整领域规则仍以 `AGENTS.md` 和对应 authority 文档为准；这里保留最容易因工程推进方式而被破坏的约束。

## 验证不变量

### MUST

- 只有实际执行并返回成功的 gate 才能写 `PASS`。
- 失败必须保留失败命令和失败层级，不能用“源码看起来没问题”覆盖。
- GitHub Actions 不可用时，继续使用本地 fast/full/native gate；不得把“CI 未运行”伪装成通过或失败。
- 并回 `main` 前必须完成适用的本地验证和 diff review。

### MUST NOT

- 从旧 commit、旧 verification 或别的分支继承 PASS。
- 因为远端 CI 不可用而跳过所有本地验证。
- 为了让 gate 更快而静默删除必要检查。

## 分支与 scope 不变量

### MUST

- 跨层、runtime、schema、API contract、审计、迁移、重构和实验工作默认独立 branch/worktree。
- 当前工作包之外的新问题先记录到 `BACKLOG.md`，除非它阻塞当前修复或属于同一根因。
- 新长期工程规则进入 `DECISIONS.md` 或本文件，而不是只留在聊天。

### MUST NOT

- 在 `main` 上持续展开大范围 scope。
- 把多个互不依赖的重构、产品功能和运行时迁移混成一个不可回滚工作包。

## Production 重工作不变量

### MUST

- 普通 GET / page open / object switch / Inspector expand 只消费 cache、snapshot 或 lightweight read model。
- 重工作由显式用户动作提交 durable task，并进入 Status Center。
- durable task 目标保持 path-free；设备绝对路径留在 device-local state/request 中。
- 取消尽可能传递到资源等待和外部子进程。

### MUST NOT

- 从普通 GET 偷偷执行全目录媒体枚举、长 hash/stat 循环、FFmpeg/FFprobe、模型下载/加载、全项目 embedding/index rebuild 或分钟级 provider/network call。
- 在项目页复制第二套完整 durable-task controller；Status Center 是唯一全局任务控制面。

## Authority 不变量

```text
evidence → proposal → human confirmation → authority
```

### MUST NOT

- 让 AI proposal、Audit、semantic score、Team Web opinion 自动落入 Final Editorial Decision、Review placement 或 Rust Timeline authority。
- 让 React/TypeScript 成为第二套业务 truth 或 Timeline source of truth。
- 让 Python 绕过 command bridge 直接修改 Rust Timeline authoritative state。

## Repository / device data 不变量

### MUST

- 测试项目数据使用 `tests/fixtures/` 中最小、合成、脱敏、可重建的 fixture。
- `projects/.gitkeep` 仅用于保留空 workspace 容器。

### MUST NOT

- 提交真实 `projects/registry.json`、`project.toml`、制作剧本/FCPXML/XML、副本、cache、output、review/tasks/locks。
- 提交 `/Volumes/...`、`/Users/...`、Windows 盘符等真实设备绝对路径到共享项目 artifact 或源码 Git。
- 把模型 API Key / secret 写进 workspace、project、review、audit、editorial 或同步产物。

## Python package 不变量

`src/script_organizer/` 的 flat namespace 是历史兼容区，不是继续无限堆顶层 runtime 的默认方案。

### MUST

- 新 coherent engine/store/runtime/support 组优先规划子 package。
- 大规模迁移独立工作包完成，并保留兼容 import、packaging、stage-runtime、pytest contract。

### MUST NOT

- 在产品功能提交里顺手完成大规模包搬家。
- 仅为了目录“看起来整齐”破坏现有 import/runtime contract。