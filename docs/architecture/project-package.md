# MirrorOrder Project Package Contract v1

这份文档定义镜序制作项目的**可持久化与传输边界**：什么构成一个项目、`project.toml` 如何版本化、哪些数据可随项目移动、哪些数据必须留在设备本地，以及 `.mirrorproj` / `.mirrorpkg` 如何安全导入、另存与收集。它不改变 Review / Editorial / Timeline 等领域 authority，只规定这些 authority 落在“同一个项目”中的物理边界。

## 1. 产品概念与当前物理布局

镜序把一个制作项目视为 **MirrorOrder Project Package**。对外部可移动、可继续编辑的目录，标准命名后缀是：

```text
<name>.mirrorproj/
```

`.mirrorproj` 是**目录包**，不是 ZIP。当前受管工作区继续使用兼容布局：

```text
projects/<project_id>/
└── project.toml
```

因此“项目格式”与“workspace 内部目录命名”是两个不同问题。当前 `project_location_runtime` 对 `projects/<project_id>/project.toml` 的安全合同保持不变，不为了后缀形式做破坏性迁移。

`project.toml` 是 Project Package 的 canonical manifest。目录中其它业务状态仍由各自 domain authority 拥有，不能因为引入 package / transfer contract 而产生第二套 Review / Editorial / Timeline truth。

## 2. v1 manifest 标记

MirrorOrder Project v1 必须在 `[project]` 中声明：

```toml
[project]
format = "mirrororder-project"
schema_version = 1
id = "demo"
name = "Demo"
```

含义：

- `format`：格式族，当前固定为 `mirrororder-project`；
- `schema_version`：项目包 schema，当前为整数 `1`；
- `id`：稳定 `project_id`；
- `name`：用户可见项目名。

`format` 与 `schema_version` 必须成对出现。显式标记为未知格式或未来 schema 的 manifest 必须 fail fast，旧版本不能假装理解后继续写入。

### Legacy / schema 0

历史 `project.toml` 没有 `format` / `schema_version`。它们继续作为 **legacy schema 0** 读取，保持现有项目兼容；普通读取不得静默回写或偷偷升级 manifest。

显式“另存项目”允许把 legacy 项目复制成新的 v1 `.mirrorproj`：新副本获得新的 `project.id` / `project.name`，原项目不被修改。这属于用户发起的迁移，不违反“普通读取不静默迁移”。

未来如引入需要扫描媒体、重建索引或搬运大量文件的 schema migration，必须进入 durable task，而不是页面 GET/打开路径。

## 3. 项目相对路径是 portability contract

v1 中属于项目的持久化路径必须是**项目根目录相对路径**，例如：

```toml
[input]
script = "./inputs/script.docx"
fcpxml = "./inputs/source.fcpxml"

[output]
directory = "./output"

[asr]
transcript_dir = "./cache/transcripts"
```

以下形式不允许出现在 v1 portable manifest 的项目路径字段中：

- `/Volumes/...`、`/Users/...` 等 POSIX 绝对路径；
- `C:\...`、UNC 等 Windows 设备路径；
- `../...` 或其它逃逸项目根目录的路径；
- `~` / `$HOME` 等依赖当前设备环境的路径。

`compat.overrides`、`web.directory` 若需要写进 v1 manifest，也必须遵守同一项目相对路径规则。

作为项目依据保存的原始 FCPXML 可能天然包含其创建设备当时的 source URL；它是不可变输入参考，不是设备 binding authority。MirrorOrder 不会把这类历史 source reference 当成跨设备定位依据。

## 4. Media binding 永远不是项目事实

以下字段/事实不属于 Project Package v1：

```text
input.media_root
media.root
media.roots
media_id -> 本机绝对文件路径
本机素材根目录 / 磁盘名 / Finder 路径
PID / 本机日志 / secrets / runtime 临时文件
```

媒体跨设备身份使用 `media_id`；实际文件位置由每台设备自己的 `media-bindings.json` 解析。即使某个设备上的素材位于项目目录旁边，也不能把该设备路径写回共享 manifest。

因此一个 `.mirrorproj` 可以被复制到另一台电脑，而不要求原始媒体跟着移动；另一台设备只需重新建立自己的 media binding。

`.mirrorpkg` 在可选收集媒体时也遵守同一规则：归档清单只记录 `media_id`、归档内相对路径、文件名和字节数，不写入原设备 binding 的绝对路径。

## 5. Project Package 数据分层

Project Package 是项目物理边界，不是一个新的 domain store。数据按现有 authority 分层：

### Canonical manifest / immutable basis

- `project.toml`；
- `inputs/script.<ext>`；
- `inputs/source.fcpxml`（FCPXML 项目）；
- 其它明确作为项目依据保存的不可变输入副本。

新建项目默认复制输入到 `inputs/`，避免 project manifest 依赖用户当时选取位置的绝对路径。

### Shared project facts / human authority

按照各领域现有 contract 保存并跨设备同步，例如：

- `media_roles.json`：项目级人工媒体角色事实；
- `review.json`：人工 Review placement / state；
- `editorial.json`：Individual Opinion / Final Editorial Decision；
- 电子场记、人物身份等已有共享业务 authority。

这些文件的写入规则仍由对应 domain store / revision contract 决定。Package 层只规定它们属于项目，不接管业务语义。

### Shared derived / rebuildable data

例如：

- `material_index.json`；
- `script.json`；
- `matches.json`；
- 其它确定性派生索引。

它们可以随项目复制/归档以减少重复计算，但不能反向覆盖人工 authority。

### Cache / output

- `cache/`：可重建缓存；丢失后可以重新生成，不是人工 authority；
- `output/`：包含分析/交付结果以及当前历史实现中位于 output 下的部分项目状态，不能粗暴整体丢弃。

因此：

- 外部 `.mirrorproj` 导入默认复制项目内容，包括 cache；
- “另存项目”默认不复制 cache，但保留 output 与其中的项目 authority；
- “收集项目”默认不包含 cache，但保留项目目录其它文件；
- `output/tasks.json` 在 Import / Save As / Collect 中统一排除，因为 durable task history 属于原 Host / runner 的 operational state，不是可移植项目 authority；
- cache 以后可以作为显式选项，不改变 authority 定义。

## 6. 打开外部 `.mirrorproj`

Desktop 的“打开项目…”是**导入到当前 workspace**，不是把外部绝对路径永久登记进 Registry。

流程：

```text
用户选择 <name>.mirrorproj/
→ 轻量读取 project.toml 并校验 format/schema
→ 检查 project.id 是否与当前 workspace 冲突
→ 提交 device-scope project_package_import durable task
→ 原子复制到 projects/<project_id>/
→ 复制成功后才写 Workspace Registry
→ Desktop 刷新并打开受管项目
```

原因：删除项目、Finder 定位和其它本机安全合同都要求项目实际位于受管的 `projects/<project_id>/project.toml`。因此不能通过 Registry 长期保存任意外部绝对路径来“伪装打开”。

导入复制拒绝：

- 符号链接目录/文件；
- 特殊文件；
- 缺失/非法 manifest；
- 未支持的未来 schema；
- 已存在的目标项目 ID；
- 目标空间不足；
- 中途取消后的半成品发布。

任务取消或失败时，临时目录不会原子改名为正式项目，Registry 也不会提前登记。外部包中的 `output/tasks.json` 不会导入当前 Host。复制完成后还会复核源文件 size / mtime；若项目在传输过程中被其它写入修改，本次导入不发布混合快照。

## 7. 另存项目 `.mirrorproj`

“另存项目…”从当前受管项目创建**独立的外部可编辑目录包**：

```text
当前 projects/<project_id>/
→ project_save_as durable task
→ <new name>.mirrorproj/
```

新副本获得新的 `project.id` 和用户可见名称；原项目身份、Review、Editorial、Timeline 等 authority 不被改写。

另存默认排除可重建 `cache/`，保留 output / shared project facts；`output/tasks.json` 由统一传输边界排除，因为 durable task history 属于原 project_id / runner 的 operational state，不能进入可移动项目。整个目标先写入目标父目录下的临时目录，复制后复核源文件 size / mtime；只有源快照未变化、目标完成校验且未被取消时才原子发布。

外部 Save As 的目标**不会自动注册回当前 workspace**。它是一个新的可移动项目包；需要使用时可通过“打开项目…”导入。

## 8. `.mirrorpkg` 收集归档 v1

`.mirrorpkg` 现在正式定义为**归档/交换文件**，不是工作中直接编辑的项目目录。当前实现使用 ZIP64 容器，结构：

```text
<name>.mirrorpkg
├── mirrorpkg.json
├── project/
│   ├── project.toml
│   ├── inputs/
│   ├── output/
│   └── ...
└── media/                  # 可选
    └── <media_id>/
        └── <original-name>
```

`mirrorpkg.json` 当前声明：

```json
{
  "format": "mirrororder-project-archive",
  "schema_version": 1,
  "project": {
    "format": "mirrororder-project",
    "schema_version": 1,
    "project_id": "demo",
    "name": "Demo",
    "root": "project/"
  },
  "includes": {
    "cache": false,
    "media": true
  },
  "media": [
    {
      "media_id": "M_...",
      "archive_path": "media/M_.../A001.mov",
      "name": "A001.mov",
      "bytes": 123
    }
  ],
  "device_binding_paths_included": false
}
```

### 默认收集

默认包含项目目录除 `cache/` 与 `output/tasks.json` 外的可移植项目文件，不包含原始媒体。

### 可选收集媒体

用户显式选择“含原始媒体”后，任务通过当前设备的 `DeviceMediaStore` 解析 `media_id`，把项目素材索引中的物理媒体复制进 `media/<media_id>/...`。正式 `M_...` 身份必须通过内容指纹校验；legacy `MP_...` provisional identity 必须已在当前设备人工确认。任务不得因为历史来源路径“当前仍存在”就绕过身份校验。归档清单只保存 archive-relative path；原本机路径只在任务运行时读取。

如果用户要求含媒体，但当前设备未定位或无法验证全部所需 `media_id`，任务 fail fast，不生成一个假装完整的归档。

### 原子与取消

`.mirrorpkg` 先写到目标目录的临时文件，进行空间预检，并在文件复制循环中响应取消。ZIP 写完后再次复核项目文件与已选媒体的 size / mtime；若源在收集过程中变化，本次归档失败且不发布。只有源快照稳定且最终取消检查通过后才 `os.replace` 为正式目标。

`.mirrorpkg` 当前**不能直接作为实时项目打开/编辑，也还没有实现从 `.mirrorpkg` 解包导入**。要继续编辑，应使用 `.mirrorproj`；`.mirrorpkg` 是收集、备份与交换边界。

## 9. Durable task 与设备路径边界

Project transfer 的源/目标绝对路径是 device-local 信息，但导入/另存/收集又可能持续很久，需要 durable task。为同时满足两条约束：

```text
Desktop local action
→ Application Support/project-transfer-requests/<request_id>.json
   （device-local，可保存绝对源/目标路径）
→ durable task target = { request_id }
   （path-free）
→ worker 运行时按 request_id 读取 device-local request
```

任务成功后删除 request 文件；失败/取消时保留 request，以支持 Status Center 重试。任务记录本身永不成为第二个 device path registry。

scope：

- `project_package_import`：device scope，因为导入开始前目标 project 尚不存在；
- `project_save_as`：project scope；
- `project_collect`：project scope。

所有操作都使用现有 Status Center 的任务列表、取消、失败与重试语义，不创建平行进度控制器。

## 10. 打开、注册与未来版本

Workspace Registry 在注册/打开受管项目时先检查 Project Package manifest：

```text
无 format/schema
→ legacy schema 0
→ 继续读取，不静默迁移

format=mirrororder-project + schema_version=1
→ 验证必填字段、项目相对路径和 device-local 禁入规则
→ 允许读取

未知 format / 未来 schema / malformed marker
→ fail fast
→ 不继续按旧 schema 写入
```

新建项目必须直接写 v1 标记；不再制造新的 legacy manifest。

外部 `.mirrorproj` 的“打开”增加一层 package suffix、identity、复制安全与 Registry conflict 检查，但不改变 manifest schema authority。

## 11. 当前明确不做的事

Project Package / Transfer v1 **不**意味着：

- 把现有 `projects/<project_id>/` 批量改名为 `.mirrorproj`；
- 普通打开项目时自动迁移 legacy manifest；
- 把 device-local media binding 同步进项目；
- 新建平行 Review / Editorial / Timeline 数据库；
- `.mirrorpkg` 已支持直接打开、增量编辑或原地写回；
- “含媒体”已经支持 used-only / Proxy / optimized media 等高级收集策略；
- 当前已经提供跨 workspace 的素材 Library authority。

这些能力以后可以独立设计，但不能反向破坏 v1 的 portability、task 与 authority 边界。

## 12. 实现 authority

Python MirrorOrder Core 持有 Workspace / Project package / transfer contract。当前实现入口：

```text
src/script_organizer/project_package.py
src/script_organizer/workspace.py
src/script_organizer/project_transfer/operations.py
src/script_organizer/project_transfer/request_store.py
src/script_organizer/project_transfer/runtime.py
```

职责：

- `project_package.py`：轻量 TOML/schema/path contract，不扫描媒体、不写盘；
- `project_transfer/operations.py`：原子目录复制、身份重写、ZIP64 收集、磁盘预检与取消；
- `project_transfer/request_store.py`：device-local path indirection；
- `project_transfer/runtime.py`：Host local action、project/device durable task 接线；
- React/Tauri：文件选择、意图确认和状态展示，不实现第二套 schema / copy authority。
