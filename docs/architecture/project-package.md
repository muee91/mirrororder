# MirrorOrder Project Package Contract v1

这份文档定义镜序制作项目的**可持久化格式边界**：什么构成一个项目、`project.toml` 如何版本化、哪些数据可随项目移动、哪些数据必须留在设备本地，以及未来如何安全迁移。它不改变 Review / Editorial / Timeline 等领域 authority，只规定这些 authority 落在“同一个项目”中的物理边界。

## 1. 产品概念与当前物理布局

镜序把一个制作项目视为 **MirrorOrder Project Package**。对外部可移动目录，首选命名后缀是：

```text
<name>.mirrorproj/
```

`.mirrorproj` 是**目录包命名约定**，不是压缩文件，也不是要求当前 workspace 立刻改目录名。当前受管工作区继续使用兼容布局：

```text
projects/<project_id>/
└── project.toml
```

因此“项目格式”与“workspace 内部目录命名”是两个不同问题。当前 `project_location_runtime` 对 `projects/<project_id>/project.toml` 的安全合同保持不变，不为了后缀形式做破坏性迁移。

`project.toml` 是 Project Package 的 canonical manifest。目录中其它业务状态仍由各自 domain authority 拥有，不能因为引入 package contract 而产生第二套 Review / Editorial / Timeline truth。

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

真正的 schema migration 必须是显式、可审计、原子操作，并在迁移前后保持项目 authority 一致。未来如引入需要扫描媒体、重建索引或搬运大量文件的迁移，必须进入 durable task，而不是页面 GET/打开路径。

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

`compat.overrides`、`web.directory` 若未来仍需要写进 v1 manifest，也必须遵守同一项目相对路径规则。

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

它们可以同步以减少重复计算，但不能反向覆盖人工 authority。

### Cache / output

- `cache/`：可重建缓存；丢失后可以重新生成，不是人工 authority；
- `output/`：交付/导出结果；是项目生成物，不是 Review / Timeline 的第二 truth。

Project Package 被复制或备份时，可以按目的选择是否包含 cache/output；但 `project.toml`、项目依据和共享 authority 不能因此丢失。

## 6. `.mirrorproj` 与未来归档格式

当前 v1 只正式定义**可编辑目录包**。工作中的 `.mirrorproj` 不应是 ZIP：Review、Timeline journal、任务状态和索引会频繁更新，压缩容器会放大写入成本和故障恢复复杂度。

`.mirrorpkg` 预留给未来“收集项目 / 归档 / 交换”能力，但**当前不代表已实现或可依赖的格式**。若实现，应由显式用户动作选择是否收集原始媒体、已用媒体、Proxy、cache、output 等；大文件复制/打包必须进入 durable task，并具备磁盘空间预检、取消和失败恢复。

## 7. 打开、注册与未来版本

当前 Workspace Registry 在注册/打开项目时应先检查 Project Package manifest：

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

## 8. 当前明确不做的事

Project Package Contract v1 **不**意味着：

- 把现有 `projects/<project_id>/` 批量改名为 `.mirrorproj`；
- 把原始媒体复制进项目；
- 把 device-local media binding 同步进项目；
- 新建平行 Review / Editorial / Timeline 数据库；
- 在普通项目打开时自动迁移旧项目；
- 当前已经支持 `.mirrorpkg` 归档；
- 当前已经提供跨 workspace 的素材 Library authority。

这些能力以后可以独立设计，但不能反向破坏 v1 的 portability 与 authority 边界。

## 9. 实现 authority

Python MirrorOrder Core 持有 Workspace / Project package contract。当前实现入口：

```text
src/script_organizer/project_package.py
src/script_organizer/workspace.py
```

`project_package.py` 只做轻量 TOML 检查与路径合同，不扫描媒体、不 fingerprint、不加载模型、不写盘。任何未来 UI 只消费 Core 给出的项目能力和错误，不在 React/Tauri 再实现第二套 schema 判断。
