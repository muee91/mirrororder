# Engineering Status

更新时间：2026-08-29

## 当前基线

- 主线：`main`
- 建立工程控制层时的主线 commit：`4e112efebf70159ff2d1ef91b530947e5efb7c3e`
- 工程控制层：`chore/engineering-control-plane`
- 当前 P1 工作分支：`fix/runtime-read-paths`
- GitHub Actions：当前不可作为必要 gate；本地验证优先。

## 产品就绪度

- 初始评估：**68 / 100**
- Stage 1 — Runtime read-path safety：**70 / 100**
- Stage 2 — Device-local model preparation durability：**72 / 100**
- 评分只代表当前产品/工程就绪度判断，不替代 executable gate。

## 当前 P1

| 工作包 | 状态 | 说明 |
| --- | --- | --- |
| Media inventory durable scan | 已收口 | GET 只读 device-local snapshot；显式扫描进入 `media_inventory_scan` durable task。 |
| Waveform durable build | 已收口 | GET 只读 cache；显式生成进入 `waveform_build` durable task。 |
| Runtime read-path safety | 源码收口 / 待本地验证 | 删除旧 `/api/v1/local-runtime` 和隐藏同步 fallback；Settings / Assistant / diagnostics 等普通读路径保持 snapshot/cache/read-only。 |
| Device-local model preparation durability | 源码收口 / 待本地验证 | 本地视觉、Identity 模型/运行时准备进入 device-scope durable task，并统一进入 Status Center；不绑定随机项目。 |
| Runtime install ordering | 进行中 | 下一阶段审计 runtime/monkeypatch 安装顺序、幂等和失败隔离。 |
| Engineering control plane | 待本地验证 | worktree 规则、本地 gate、状态/决策/不变量文档和 repository guard 已接入；`main` 暂未修改。 |

## Stage 1 — Runtime read-path safety

已完成源码收口：

- 删除 `automation_runtime.py` 中旧 `/api/v1/local-runtime` GET/POST；`desktop-local-runtime` 成为唯一 Desktop 本机运行时入口；
- Local Vision 状态 GET 不做 localhost health probe / 模型目录递归扫描；Identity 状态 GET 不加载 native module、不 SHA 全量权重；
- Assistant GET 只读取 `assistant.json` snapshot；
- runtime diagnostics GET 不再创建/删除写探针；
- 删除旧 `media_role_runtime.py` media-inventory 全目录枚举；
- 删除 Desktop 同步 media scan/probe fallback；
- `automation_runtime.project_payload()` 不再在读路径同步写 Workspace DB；
- 已加入 read-path contract guard。

## Stage 2 — Device-local model preparation durability

已完成源码收口：

- 新增 `device_tasks.py`，设备任务持久化在 MirrorOrder device state，而不是项目 `tasks.json`；
- `local_vision_prepare` target 只保存逻辑模型 ID；`identity_runtime_prepare` target 只保存 `face|speaker`，不保存设备绝对路径；
- Host runtime 安装时恢复前一 runner 的 queued/running device task 为 `interrupted`；普通 GET 只读 task snapshot；
- Desktop `/api/v1/device-tasks` 提供 Host-local list/submit/cancel；
- Settings 的视觉/人脸/声纹准备不再调用 unmanaged `prepare_async()`，只提交 device durable task；
- Status Center 同时管理 project task 与 device task，统一查看、轮询、取消、重试；
- Local Vision 取消直接进入 llama-server 启动/模型加载循环；
- Identity 取消可传播到 pip 子进程、模型下载 chunk、SHA-256 chunk；
- 切换视觉模型、关闭视觉/人脸/声纹时会取消与新设置冲突的 active device task；
- Local Vision cache snapshot 绑定具体逻辑 model，切换模型后不会把旧模型 cache 大小误报为当前模型；
- `stage-runtime.mjs` 递归打包整个 `src/script_organizer`，新增 `device_tasks.py` 无额外 staging 白名单风险；
- 新增 `tests/test_device_tasks.py`，并更新 Desktop/runtime/status contract tests；
- ADR-007 固化 project-scope / device-scope durable task 分域规则。

## 当前验证状态

针对 `fix/runtime-read-paths`：

- Source / diff review：PASS（仅代表已审阅分支 diff 和关键 runtime contract）
- Stage 1 / Stage 2 新增及更新 tests：已写入，**NOT RUN**
- 临时环境直接 clone 分支：NOT RUN（运行环境无外网 DNS，无法获得完整 checkout）
- `python scripts/check_fast.py`：NOT RUN
- `python scripts/check_full.py`：NOT RUN
- Native packaged runtime smoke：NOT RUN
- GitHub Actions：NOT RUN / 当前额度不可用，不作为必要条件

任何未实际执行的命令都不得标为 PASS。

## 下一工作包

### P1 — Runtime installation order

目标：让 runtime/monkeypatch 安装链的正确性不依赖偶然 import 顺序，并保证重复安装幂等。

重点：

- `editorial_runtime.py` 及其安装链；
- Desktop、automation、media inventory、waveform、assistant、semantic、identity 等 wrapper 的顺序；
- 重复 install 不应重复包裹 handler / TaskManager method；
- install 失败不能留下半安装全局状态；
- device task manager 的启动恢复必须只发生一次且不污染普通 GET；
- 为确定顺序和幂等增加 contract tests。

### P2 — Python package migration plan

`src/script_organizer/` 的 flat namespace 是历史兼容区。先划分 coherent domains 和兼容 import / packaging / stage-runtime contract，再独立迁移；不与产品功能混改。

### P2 — Golden production project

用 synthetic/redacted fixture 打穿 Create → Slate → Mapping → Review → Coverage → Rough Cut → Timeline → Delivery → reopen，作为单元测试之外的生产闭环证据。

## 状态维护规则

- `STATUS.md` 只写“现在是什么状态”，不要堆实现日志。
- 完成的历史验收证据移到 `docs/verification/`；这里保留当前结论。
- 新发现但不属于当前 scope 的事项进入 `BACKLOG.md`。
- 新长期约束进入 `DECISIONS.md` 或 `INVARIANTS.md`。
