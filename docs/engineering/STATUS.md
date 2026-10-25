# Engineering Status

更新时间：2026-10-25

## 当前基线

- 仓库只维护 `main`；HEAD `8e26b0a`。
- **`main` 领先 `origin/main` 31 个提交**（`23bd253` 之后未推送）。远端 CI 最后一次运行是 2026-09-06，因此**当前 HEAD 没有任何 CI 证据**；`git tag` 为 0。
- Desktop 仍处于 Product Recovery 之后的**可交付化阶段**：代码结构恢复已收口，缺口在发布工程、授权与真实可用性证据（顺序见 `BACKLOG.md` Phase 0/1/2）。
- 一级工作区固定：`素材 / 剧本 / 时间线 / 审阅`；原则仍是**共享对象，不共享工作流**。

## 2026-10-25 修复轮（已复核，非自述）

审计后落地的 6 个提交（`a44327b..8e26b0a`）逐条独立验证，结论如下。

真实修复：

- **局域网无鉴权写人工 authority 已收口**：`cli.py` 的 `serve`/`gateway` `--host` 默认改 `127.0.0.1`，启动脚本同步收紧。实测默认参数启动后 `lsof` 只有 `127.0.0.1` 监听、局域网 IP 连接被拒；`_require_review_access` 从空函数变为非回环来源 403，网关子类改为配对 session + `reviewer` 角色；新增 `tests/test_web_security_boundary.py` 为行为测试（含 IPv4-mapped 回环判定、配对 429 节流、64 bit 配对码）。
- **CSP** 从 `null` 改为默认拒绝（`object-src 'none'`、`base-uri 'self'`、`form-action 'self'`）。
- **npm 供应链**：`desktop/package-lock.json` 入库，201 个 package 缺 integrity 数为 0；CI 改 `npm ci`；可选依赖钉版本。
- **CSS canonical 所有权**：六个全局层中针对 `.mo-media-card / .take-card / .take-list-row / .script-block / .slate-row` 的选择器命中数实测为 0，对象自有样式表建立。
- **假视口门**：`check-layout-runtime.mjs` 改为真实越界断言（`innerWidth` 漂移检查、`documentWidth <= innerWidth`、9 个盒子 `getBoundingClientRect`）；compact 视口 1024→1180 的依据核对为真（`tauri.conf.json:19` 与 `styles.css:12` 均为 1180）。
- **死代码与版本链**：`legacy.py`/`multicam.py`/`html_renderer.py` 删除；新增 AST 级版本族私有实现边界守卫。
- **一处测试实质改善**：`test_automation_creative_boundary.py` 从源码 grep 重写为真实调用 `resolve_project`/`ReviewStore`/`EditorialStore` 的行为断言。
- **第一份用户文档** `docs/user-guide.md`：抽查其界面承诺（`Shift+F10`/`ContextMenu`、工作区重新定位、状态中心）均在源码中存在。

仍不完整（不要当成已解决）：

- 显式 `--host 0.0.0.0` 时**读接口与素材 range 下载仍无鉴权**（实测可取回 workspace 数据）。
- `release_gates` 的强制逻辑未变：`check-baseline.mjs:33-35` 仍只断言字符串等于 `"required"`；18 个门中 9 个 macOS/Windows 原生门零实现。
- `Cargo.lock` 仍未入库（排除依据还是本地 `.git/info/exclude`）；`pyproject.toml` 仍无 `dependencies`。
- 无 LICENSE、无 CHANGELOG、无 updater、无 tag。
- `stage-runtime.mjs` / `verify-macos-bundle.mjs` / `host.rs` 本轮未触及：打包内容黑名单、`.pyc` 写回 bundle、`base_executable` 指回构建机、三棵 Python 树冗余全部仍在。
- Phase 2 的体验项未动：review-model 无共享缓存、项目页逐项全量拉取、`EditorMonitors` 无播放失败态、时间线区 3 处 `{[key: string]: any}`。

## 自动 gate 状态（2026-10-25 本机实跑）

| 命令 | 结果 |
|---|---|
| `python3 scripts/check_fast.py` | exit 0 |
| `python3 scripts/check_full.py` | exit 0 |
| `python3 -m pytest -q` | 614 passed（基线 587 + 新增 27），142.53s；其中单用例 `test_core.py:606` 占 134.33s |
| `npx vitest run` | 77 files / 373 passed |
| `npx tsc --noEmit` | exit 0 |
| `vite build` | 成功；JS 598.73 kB、CSS 296 kB（Rollup 500 kB 提示为既有非阻塞告警） |
| `cargo test`（timeline-core / host） | 15 passed / 33 passed |
| `python3 scripts/check_python.py` | 78 passed（注意：它只跑 14 个 contract 文件，不是全量） |
| `./script-organizer serve --help` | exit 0（README 记录的启动方式已可用） |

执行环境为 macOS arm64 + Python 3.14 + Node 22/24；**CI 目标为 Python 3.11**，两者在未声明的可选依赖上走不同分支，本表绿灯不等价于 CI 绿灯。

## NOT RUN（不得写成 PASS）

- `tauri build` 的 macOS/Windows 产物、签名与公证；`.dmg` 完整性；Windows 全平台分支（从未编译）。
- 在制真实项目（本机 `projects/` 下，不入库）五步主链真机验收；真实媒体播放、多机位同步精度、Final Cut / Premiere 导入。
- 远端 CI 在当前 HEAD 上的运行；Team Gateway 双机配对与 30 秒真实冷却；CSP 真机效果；CSS 迁移的像素级对比。
- 大规模 Take（数百到数千）下的前端性能与 Timeline 内存曲线。

## 本轮仓库整理（同日）

- 删除可再生产物：541 个 `__pycache__`、4 个 `.DS_Store`、create-dmg 中断残留的 478 MB `rw.*.dmg`、空壳目录 `.v2c`/`out`；按 owner 决定执行 `cargo clean`（`desktop/src-tauri/target` + `crates/timeline-core/target`），仓库体积 6.1 GB → 754 MB。冷重建代价实测为 `cargo check` 33.7 秒。
- **保留**：`projects/`（真实项目数据，仍被 gitignore）、`.workspace/`（运行态与各轮修复的过程记录）、`desktop/src-tauri/resources/mirrororder-*`（480 MB 运行时暂存，`cargo clean` 不触及，重新打包仍可复用）。
- `.gitignore` 补齐外部工具留下的未跟踪杂物（`.zwork/`、`.video_agent/`、`.v2c/`、`out/`）。
- 一次性审计/验证报告不再进源码 Git：`docs/verification/` 已移除，历史记录移到 `.workspace/audits/2026-10-25/`；`docs/README.md` §6 与 `docs/architecture/repository-layout.md` 之间「是否允许 verification/」的相反规则已统一为前者。
- 文档命令修正：`README.md` 与 `AGENTS.md` 的 gate 命令 `python` → `python3`（本机不存在 `python`，原命令实测 exit 127）；`desktop/README.md` 新增打包 runtime staging 所需变量与已知良好来源。
