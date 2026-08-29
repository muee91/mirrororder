# Engineering Status

更新时间：2026-08-29

## 当前基线

- 主线：`main`
- 建立工程控制层时的主线 commit：`4e112efebf70159ff2d1ef91b530947e5efb7c3e`
- 工程控制层：`chore/engineering-control-plane`
- 当前 P1 工作分支：`fix/runtime-read-paths`
- GitHub Actions：当前不可作为必要 gate；本地验证优先。

## 产品就绪度

- 上一阶段基线：**68 / 100**
- Stage 1 — Runtime read-path safety 完成后的当前评分：**70 / 100**
- 评分只代表当前产品/工程就绪度判断，不替代 executable gate。

## 当前 P1

| 工作包 | 状态 | 说明 |
| --- | --- | --- |
| Media inventory durable scan | 已收口 | GET 只读 device-local snapshot；显式扫描进入 `media_inventory_scan` durable task。 |
| Waveform durable build | 已收口 | GET 只读 cache；显式生成进入 `waveform_build` durable task。 |
| Runtime read-path safety | 源码收口 / 待本地验证 | 删除旧 `/api/v1/local-runtime`；Settings 状态读不再递归扫模型缓存、localhost health probe、加载 native identity runtime 或 SHA 全量权重；Assistant GET 只读持久化 snapshot；旧 media-role inventory GET 与 Desktop 同步 scan fallback 已删除。 |
| Device-local model preparation durability | 待执行 | `LocalVisionRuntime.prepare_async()` 与 `IdentityRuntime.prepare_async()` 仍是设备级后台线程；模型下载、pip/native runtime 安装和模型加载属于重工作，下一阶段要进入 durable task / Status Center，而不是形成第二套后台任务控制面。 |
| Engineering control plane | 待本地验证 | worktree 规则、本地 gate、状态/决策/不变量文档和 repository guard 已接入；`main` 暂未修改。 |

## Stage 1 — Runtime read-path safety

源码层已完成：

- 删除 `automation_runtime.py` 中旧 `/api/v1/local-runtime` GET/POST 及其重复 runtime payload；
- `desktop-local-runtime` 成为唯一 Desktop 本机运行时 API；
- `LocalVisionRuntime.public()` 不再执行 localhost `/health` 或 `rglob` 模型缓存；缓存大小改读显式准备阶段生成的 device-local snapshot；
- `IdentityRuntime.public()` 不再 import `cv2` / `sherpa_onnx`，也不在状态 GET 中 SHA-256 扫描模型权重；完整验证保留在显式 prepare 路径；
- Assistant GET / Project state 只读取 `assistant.json`，不再因 stale 状态调用 `cycle()` 重建并写盘；
- runtime diagnostics 的 workspace writable 检查不再创建/删除探针文件；
- 删除 `media_role_runtime.py` 中会全目录枚举的旧 `media-inventory` GET；
- 删除 `desktop_runtime.py` 中同步 `scan/probe_roots` fallback；若 durable media runtime 未安装，明确失败而不是静默退回重工作；
- `automation_runtime.project_payload()` 不再在读路径调用 `sync_project_summary()` 写 Workspace DB；
- 新增 `tests/test_runtime_read_paths_contract.py`，并更新 local runtime contract tests。

## 当前验证状态

针对 `fix/runtime-read-paths`：

- Source / diff review：PASS（仅代表已审阅分支 diff 和关键 runtime contract）
- 新增/更新 contract tests：已写入，**NOT RUN**
- `python scripts/check_fast.py`：NOT RUN
- `python scripts/check_full.py`：NOT RUN
- Native packaged runtime smoke：NOT RUN
- GitHub Actions：NOT RUN / 不作为当前必要条件

任何未实际执行的命令都不得标为 PASS。

## 下一工作包

### P1 — Device-local model preparation durability

目标：模型下载、可选 Python/native runtime 安装和模型加载必须由显式 durable task 承担并进入 Status Center。

重点：

- `LocalVisionRuntime.prepare_async()`；
- `IdentityRuntime.prepare_async(face|speaker)`；
- 大模型下载 / llama-server 启动加载；
- `pip install` / native wheel 安装；
- device-local 路径不得进入共享 task target；
- 不得把设备级 runtime 准备随意绑定到某个随机项目来伪装成 project task。

### P2 — Runtime installation order

审计 `editorial_runtime.py` 等安装链，确保 monkeypatch/runtime install 顺序确定、幂等，并有 contract test。Stage 1 已删除两处“依赖后装 wrapper 才安全”的同步 fallback，后续继续降低安装顺序对安全性的影响。

### P2 — Python package migration plan

`src/script_organizer/` 的 flat namespace 是历史兼容区。先划分 coherent domains 和兼容 import / packaging / stage-runtime contract，再独立迁移；不与产品功能混改。

## 状态维护规则

- `STATUS.md` 只写“现在是什么状态”，不要堆实现日志。
- 完成的历史验收证据移到 `docs/verification/`；这里保留当前结论。
- 新发现但不属于当前 scope 的事项进入 `BACKLOG.md`。
- 新长期约束进入 `DECISIONS.md` 或 `INVARIANTS.md`。
