# Engineering Status

更新时间：2026-08-29

## 当前基线

- 主线：`main`
- 建立工程控制层时的主线 commit：`4e112efebf70159ff2d1ef91b530947e5efb7c3e`
- 工程控制层：`chore/engineering-control-plane`
- 当前工作分支：`fix/runtime-read-paths`
- GitHub Actions：当前不可作为必要 gate；本地验证优先。

## 产品就绪度

- 初始评估：**68 / 100**
- Stage 1 — Runtime read-path safety：**70 / 100**
- Stage 2 — Device-local model preparation durability：**72 / 100**
- Stage 3 — Runtime installation order：**74 / 100**
- Stage 4 — Golden production project：**76 / 100**
- Stage 5 — Delivery artifact path normalization：**77 / 100**
- 评分只代表当前产品/工程就绪度判断，不替代 executable gate。

## 当前工作包

| 工作包 | 状态 | 说明 |
| --- | --- | --- |
| Media inventory durable scan | 已收口 | GET 只读 device-local snapshot；显式扫描进入 `media_inventory_scan` durable task。 |
| Waveform durable build | 已收口 | GET 只读 cache；显式生成进入 `waveform_build` durable task。 |
| Runtime read-path safety | 源码收口 / 待本地验证 | 删除旧 `/api/v1/local-runtime` 和隐藏同步 fallback；Settings / Assistant / diagnostics 等普通读路径保持 snapshot/cache/read-only。 |
| Device-local model preparation durability | 源码收口 / 待本地验证 | 本地视觉、Identity 模型/运行时准备进入 device-scope durable task，并统一进入 Status Center；不绑定随机项目。 |
| Runtime install ordering | 源码收口 / 待本地验证 | Host 使用单一 runtime stack；Editorial 单职责；全栈失败可重试、禁止重入；Identity compatibility import 不再安装全局 wrapper。 |
| Golden production project | 源码收口 / 待本地验证 | synthetic 2 集 / 3 场 / 5 Take fixture 固定 Script → Slate → Mapping → Review/Editorial → Coverage → Rough Cut → Assembly → Delivery / reopen 语义。 |
| Delivery artifact path normalization | 源码收口 / 待本地验证 | delivery.v1 v4 / export report v2 只持久化逻辑 artifact ref；Desktop localhost response 才解析本机绝对路径。 |
| Timeline golden lifecycle | 进行中 | 为 Rust Timeline Core 固定 seed → edit → undo/redo → serialize/reopen 的 authority lifecycle。 |
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

- 新增 device-scope durable task；本地视觉和 Identity runtime 准备不再伪装成随机 project task；
- task target 只保存逻辑模型 ID / `face|speaker`，不保存设备绝对路径；
- Host 启动恢复旧 runner 的 queued/running device task 为 `interrupted`；普通 GET 只读 snapshot；
- Settings 只提交任务；Status Center 统一查看、轮询、取消、重试；
- Local Vision 取消进入 llama-server 启动/加载循环；Identity 取消可传播到 pip、下载 chunk、SHA chunk；
- 切换模型或关闭视觉/人脸/声纹会取消冲突 active task；
- 新增 device task 与 Desktop contract tests；ADR-007 固化 project/device task 分域。

## Stage 3 — Runtime installation order

已完成源码收口：

- 新增 `src/script_organizer/runtime_stack.py`，Production Host / Gateway 使用单一 `install_production_runtime()`；
- `RUNTIME_INSTALL_ORDER` 显式记录 18 个 first-party runtime layer；Media Role 明确先于 Coverage/Rough Cut，Desktop 明确先于 durable media inventory adapter；
- stack 只有全部 installer 成功后才置 `installed=true`；失败保留错误并允许再次执行；重复调用幂等；重入直接拒绝；
- `editorial_runtime.py` 恢复单职责，不再作为 Audit/Identity/Coverage/Desktop 等模块的隐藏 bootstrap；
- `identity_runtime.py` compatibility import 不再执行 `install_identity_role_inference()`；Identity API installer 显式拥有该安装职责；
- CLI `serve/run/gateway` 不再各自维护散落安装顺序；`agent-context` 保留有意的最小非 Host runtime；
- 新增 runtime stack contract tests，覆盖失败重试、禁止重入、关键顺序和 import-time installer 副作用；旧 Coverage/Rough Cut 测试已改为断言中央 runtime stack，不再守旧架构。

## Stage 4 — Golden production project

已完成源码收口：

- 新增 `tests/fixtures/golden-mini-drama/scenario.json`：2 集、3 场、5 个逻辑 Take group，全为 synthetic logical IDs / filename；不保存真实媒体或设备绝对路径；
- 场景包含双机位显式 Best、另一 Take 的 reviewer Best opinion + 场记 NG、人工 placement、Keep、不归集素材、明确 usable range 与 preferred angle；
- 生命周期测试通过 `ReviewStore` / `ScriptSupervisorStore` / `EditorialStore` 写人工事实，而不是手写伪 authority JSON；
- 固定 Coverage 的 effective mapping、candidate-only 禁止升级、NG 不等于 Delivery Reject、Keep 不自动升级 Best、显式 Best 才进入 Assembly primary；
- 固定多段剧本共用同一 Take 时 Assembly 只生成一个 source block，并消费人工 1s–7s usable range 与 B 机位 preferred angle；
- 固定 Delivery decision precedence 与 individual opinion 非 authority；
- 重新实例化项目后 Coverage/RoughCut/Delivery 以及 Review/Editorial/Slate revision 必须稳定；
- Golden contract 已进入 `scripts/check_fast.py` 的 Python production smoke 集合。

## Stage 5 — Delivery artifact path normalization

已完成源码收口：

- `delivery.v1` manifest 升为 v4；项目仍处雏形阶段，因此直接删除 `manual_review_path`、`editorial_path`、绝对 `source_fcpxml`，不保留 deprecated alias；
- manifest 使用 `source.input_kind` / `source.fcpxml_name` 和 `artifacts.review/editorial` 逻辑引用，并声明 `device_paths_exposed=false`；
- `delivery_export_report.v1` 升为 v2，只持久化 `organized.fcpxml` / `selection_manifest.json` 项目输出逻辑引用，不再持久化绝对 output path；
- Host 内部仍以真实 `Path` 进行 FCPXML 解析、复制和 keyword 注入；路径只存在于当前进程；
- `delivery_runtime` 的 localhost-only API 响应通过 allowlist 将固定逻辑引用解析成本机路径，继续支持 Desktop Finder/FCP 打开；持久化 report 不变；
- `../../outside.json`、绝对路径等非 allowlist artifact ref 不会被解析；
- Desktop Delivery 类型显式区分 `<artifact>_ref`、本地 resolved path、`persisted_report_path_safe` 和 `device_paths_scope`；
- 新增 delivery path-safety tests，并加入 fast gate。

## 当前验证状态

针对 `fix/runtime-read-paths`：

- Source / diff review：PASS（仅代表已审阅分支 diff 和关键 runtime/production contract）
- Stage 1–5 新增及更新 tests：已写入，**NOT RUN**
- 临时环境直接 clone 分支：NOT RUN（运行环境无外网 DNS，无法获得完整 checkout）
- `python scripts/check_fast.py`：NOT RUN
- `python scripts/check_full.py`：NOT RUN
- Native packaged runtime smoke：NOT RUN
- GitHub Actions：NOT RUN / 当前额度不可用，不作为必要条件

任何未实际执行的命令都不得标为 PASS。

## 下一工作包

### P1 — Timeline golden lifecycle

目标：Rust Timeline authoritative state 具备可重复的最小生命周期验证，而不是只证明 Python proposal/read model 成立。

重点：

- synthetic seed / native timebase；
- 通过 Rust command 执行 trim / split / replace 中现有支持的编辑；
- revision 与 stale-command 防护（按现有 API 能力）；
- undo / redo；
- serialize / reopen 后 authoritative state 等价；
- Python/React 不直接修改 Rust Timeline state。

### P2 — Python package migration plan

`src/script_organizer/` 的 flat namespace 是历史兼容区。先划分 coherent domains 和兼容 import / packaging / stage-runtime contract，再独立迁移；不与产品功能混改。

## 状态维护规则

- `STATUS.md` 只写“现在是什么状态”，不要堆实现日志。
- 完成的历史验收证据移到 `docs/verification/`；这里保留当前结论。
- 新发现但不属于当前 scope 的事项进入 `BACKLOG.md`。
- 新长期约束进入 `DECISIONS.md` 或 `INVARIANTS.md`。
