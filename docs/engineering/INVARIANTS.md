# Engineering Invariants

这些是不随具体功能变化的高影响约束。完整领域规则仍以 `AGENTS.md`、产品/领域文档和 Core 实现为准。

## 验证

### MUST

- 只有实际执行并成功的 gate 才能写 `PASS`。
- 失败要记录失败层级；未执行写 `NOT RUN`。
- 修改前后以目标 `main` commit 为验证对象，不能继承旧证据。

### MUST NOT

- 删除/弱化必要测试来制造绿灯。
- 用源码审阅、旧 CI 或历史 verification 冒充当前执行结果。

## Authority

```text
evidence → proposal → human confirmation → authority
```

### MUST NOT

- 让 AI proposal、Audit、semantic score 或 Team Web opinion 自动写入 Final Editorial Decision、Review placement 或 Rust Timeline authority。
- 让 React/TypeScript 成为第二套业务 truth。
- 让 Python 绕过 command bridge 直接修改 Rust Timeline authoritative state。

## Read path / durable work

### MUST

- GET、page open、object switch、Inspector expand 只消费 cache/snapshot/lightweight read model。
- scan/hash/FFmpeg/model/index rebuild 等重工作由显式动作提交 durable task。
- Status Center 是 project/device durable task 的唯一全局控制面。
- 取消尽可能传递到资源等待、下载和外部子进程。

### MUST NOT

- 在普通读取路径偷偷执行分钟级工作或 provider/network inference。
- 在具体页面复制第二套完整任务控制器。

## Repository / device data

### MUST

- 测试项目只使用 `tests/fixtures/` 的最小合成/脱敏数据。
- `clip_id` 表示项目 occurrence；`media_id` 表示与路径无关的物理媒体身份。

### MUST NOT

- 提交真实 production `projects/*`、媒体输入、cache/output、review/tasks/locks。
- 把 `/Volumes/...`、`/Users/...`、Windows 盘符等设备绝对路径写入共享 artifact、源码 Git 或 durable task target。
- 把模型 API key/secret 写进 workspace/project/review/audit/editorial 或同步产物。

## Production UI implementation authority

### MUST

- 同一 Product Surface 内，同一制作对象只消费一个 canonical renderer；页面只组合对象或适配数据。
- A/B/C/AUX 固定槽位和排序从共享 camera presentation 定义读取；缺少 B 时仍保留 B 空槽，C 不得左移。
- `MediaCard`、`TakeCard`、`SlateRow`、`ScriptBlock`、人物候选/已确认人物等 canonical renderer 必须可独立 import，并有对应 contract test 或 authority gate。
- CSS ownership 迁移必须收缩旧层：替换 consumer 后删除失去 owner 的覆盖或兼容样式。

### MUST NOT

- 在 Workbench 内再声明第二个同语义 `MediaCard` / `TakeCard` / `SlateRow` / `ScriptBlock` / 人物行实现。
- 在 feature 内复制 A/B/C/AUX slot 常量、相同对象的排序规则或状态位置规则来制造局部变体。
- 为修一个页面继续向 `desktop/src/main.tsx` 叠加新的全局 theme/redesign/frozen/recovery CSS 层；需要新视觉时应修改现有 owner 或完成替换后移除旧 owner。
- 用 page-specific CSS 覆盖 canonical 对象的核心 anatomy、固定尺寸、slot 顺序和 selection geometry。

## Python package

- `src/script_organizer/` flat namespace 只作为迁移期兼容区。
- 新 coherent engine/store/runtime/support 组优先进入明确 domain package。
- compatibility facade 只能 re-export，不得在 import 时注册 route、安装 runtime、写磁盘、加载模型或修改全局 registry。
- `runtime_stack.py` 保持显式 composition root；domain import 不得触发全栈安装。
- 目标 ownership 与迁移顺序见 `docs/architecture/python-package-boundaries.md`。
