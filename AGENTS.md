# 镜序工程接手约束

## 当前基线

- 仓库当前只维护 `main` 作为开发与集成线。
- Desktop = React/TypeScript Production UI + Tauri 2/Rust 平台层 + Rust Timeline Core + Python MirrorOrder Core。
- Team Web 是独立 Review/Collaboration surface，不是 Production 主画布。
- 不恢复已删除产品线，不建立第二套业务/Timeline authority。

修改前先读：

1. `docs/README.md`
2. `docs/engineering/README.md`
3. `docs/engineering/STATUS.md`
4. `docs/engineering/INVARIANTS.md`
5. `docs/app-information-architecture.md`
6. `docs/ux-principles.md`
7. `docs/design-system-v2.md`
8. `docs/architecture/repository-layout.md`
9. `docs/architecture/desktop-bridge.md`
10. `docs/architecture/sync-model.md`

涉及具体领域时再读 `docs/README.md` 列出的对应 contract。

## Authority

- ReviewStore：人工 script placement / mapping authority。
- Script Supervisor / Slate：生产事实与场记证据；不能静默改写 Review placement 或 Editorial Reject。
- Final Editorial Decision 与 Review placement 分离。
- Python MirrorOrder Core：Workspace/Project、Review、Slate、Identity、Assistant proposals、media identity/binding、Team Web security/review、Delivery/FCPXML 等业务 authority。
- Rust Timeline Core：authoritative local timeline edit state。
- React/TypeScript：交互层，不成为第二 truth。
- Python 不得绕过 command bridge 直接修改 Rust Timeline state。

统一 AI 权限链：

```text
evidence → proposal → human confirmation → authority
```

AI proposal、Audit、semantic score、Team Web Individual Opinion 不得自动写入 authoritative edit state、Review placement、Best 或 Final Editorial Decision。

## Read path / durable work

- GET、页面打开、项目/对象切换、Inspector 展开必须轻量，只读 cache/snapshot/read model。
- 媒体全扫、长 hash/stat、FFmpeg/FFprobe、模型下载/加载、全项目 embedding/index rebuild 等重工作必须由显式动作提交 durable task。
- Status Center 是 project/device durable task 的唯一全局控制面。
- 取消尽可能传递到资源等待、下载循环和外部子进程。
- project task 与 device task 分域；模型下载/本机 runtime 安装不得为了复用 API 绑定到任意 project_id。

## Repository / device data

- 源码只跟踪空 `projects/.gitkeep`；其余生产 `projects/*` 不进入 Git。
- 禁止提交真实 registry、`project.toml`、剧本/FCPXML/XML 输入、cache/output、review/tasks/locks、模型权重、secrets。
- 测试项目只使用 `tests/fixtures/` 的最小合成/脱敏 fixture。
- `clip_id` = 项目/FCPXML occurrence；`media_id` = 与路径无关的物理媒体身份。
- 每台设备的 media roots / bindings 保存在 device state，不写回共享 workspace。
- `/Volumes/...`、`/Users/...`、Windows 盘符等绝对路径不得进入共享 artifact、源码 Git 或 durable task target。

## Product semantics

- 人工结果高于自动结果；系统不得自动 Reject 素材。
- Exclusion、Slate `status=ng`、Editorial Reject 是不同语义。
- A/B/C 机位事实不得合并成 Take 全局景别。
- `episode-only` 是合法人工 placement，不得误标 pending。
- Rough Cut / Assembly / AI 只提供 proposal/preview；人工确认后才转换成 Rust Timeline commands。
- 一个能力只保留一个主要入口；废弃入口要删除或明确降为历史/内部组件。

## Desktop / UI

- 这是专业后期工具，不是 Debug Dashboard 或 AI 展示页。
- 状态中心承载后台任务；诊断信息进入设置高级区或 Status Center，不污染 Production Canvas。
- 产品结构、响应式规则、Pane/Table/Inspector 语法和设计 token 以 IA、UX 与 Design System v2 文档为准。
- native platform module 保持窄 adapter，不写业务规则。
- 视频/代理帧不得通过 Tauri JSON/Base64 IPC 大量搬运。

## Python package

- `src/script_organizer/` flat namespace 是历史兼容区。
- 新 coherent engine/store/runtime/support 组优先进入明确 domain package。
- compatibility facade 只能 re-export，禁止 import-time install/route registration/disk write/model load/global mutation。
- `runtime_stack.py` 是显式 composition root。
- 长期边界见 `docs/architecture/python-package-boundaries.md`。

## 验证

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

需要定位时可单独运行 Desktop baseline/typecheck/Vitest/Vite、Rust Timeline/Tauri tests 与 cargo check。没有实际执行的检查不得写 PASS；失败测试不得通过删除或弱化 guard 规避。

## 文档维护

- 产品/导航规则更新现有 IA/UX/Design System，不新建平行规范。
- 领域 authority 更新对应 contract。
- 跨层长期架构放 `docs/architecture/`。
- 当前状态/backlog/decisions/invariants 放 `docs/engineering/`。
- 一次性验收放 `docs/verification/`。
- 一次性 Codex prompt、branch closeout、integration script 完成后删除；Git 历史保存过程。
