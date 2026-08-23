# 短剧素材核对平台 GPT 版

这是一个面向剪辑人员的本地多机位素材整理平台。它解决的问题是：

> 拿到拍摄混乱的 A/B/C 多机位素材和一份剧本后，快速把实际拍摄 Take 按剧本顺序整理出来，并允许剪辑人员直接看片、修正归集、多人协作审核和把本机素材拖进剪辑软件。

项目的工作台与 API 保持原生 HTML/CSS/JavaScript 和 Python 标准库服务，不依赖 React、Vue、数据库、云服务或 Docker。媒体目录多机位同步使用仓库内第一方引擎所列的本地 Python 科学计算依赖；视频通过 HTTP Range 读取当前设备的真实媒体文件，不复制视频。

当前版本是本地多项目工作台。每个项目由稳定 `project_id` 注册在 `projects/registry.json`，工作台与智能体统一使用版本化项目 API。

## 核心数据模型

镜序区分：

```text
clip_id  = 这个媒体在项目 / FCPXML 中的 occurrence
media_id = 物理媒体文件身份，不依赖它位于哪块硬盘
```

因此同一份 `A001.mov` 可以在不同电脑上分别位于：

```text
Mac Studio:  /Volumes/PSSD/牛肉/A/A001.mov
MacBook Pro: /Volumes/T9/备份/0814/A001.mov
```

只要内容一致，正式 `media_id` 一致。每台电脑把这个 `media_id` 绑定到自己的本机文件。

设备本地绑定默认保存：

```text
~/Library/Application Support/MirrorOrder/media-bindings.json
```

这个文件**不进入共享 workspace，也不应该在设备之间同步**。完整同步边界见 [SYNC_MODEL.md](SYNC_MODEL.md)。

绑定在设备状态中的键是 `workspace_id + project_id + media_id`。即使两个工作区都存在同名项目，它们的本机素材根目录和映射也不会互相复用。

## 当前项目

当前内置回归项目为《在制项目》：

- 素材数量：1502
- 逻辑 Take：610
- 可用 ASR 缓存素材：1014
- 对白匹配组：355
- 邻近上下文组：237
- 仍无可靠线索组：18
- 无可用对白组：22

自动结果只提供候选。人工的 Best、Keep、Reject、多集归属和剧本范围修正永远优先于算法。

## 快速启动

重新构建当前源码对应的 App：

```bash
zsh macos-app/build_app.sh
open "镜序.app"
```

当前 `镜序.app` 是**工作台优先**的原生 macOS 应用：

1. 打开 App 后自动检查并启动本机镜序服务；
2. 服务就绪后主窗口直接显示剧本 / Take / 播放器工作台；
3. App 内素材卡可以通过 AppKit 原生文件拖拽直接拖到 Finder / Final Cut Pro / Premiere / Resolve；
4. `时间线` 可以预览当前项目或加载本地 FCPXML / XML，并和素材页双向关联；
5. 工作区、本机素材绑定、服务状态和日志都在右上角 `设置`。

App 管理的是一个多工作区 gateway，默认使用可配置的 `8766` 端口；它可以同时加载多个带稳定 `workspace_id` 的工作区，不接管已有的 `8765` 实例。

局域网入口使用：

```text
http://局域网地址:8766/?workspace_id=<workspace_id>&project_id=<project_id>
```

默认首次访问需要输入 App 显示的一次性配对码；也可以在 App 中切换为可信局域网免登录。工作区 ID 是稳定路由标识，不是安全凭据。

浏览器和智能体使用工作区前缀 API：

```text
/api/v1/workspaces/{workspace_id}/projects/{project_id}/...
/api/agent/v1/workspaces/{workspace_id}/projects/{project_id}/...
```

一个工作区可以注册多个项目；同一局域网服务不需要为每个项目增加端口。多个浏览器窗口可以分别固定不同的工作区和项目。

`projects/registry.json` 中的 `config_path` 始终相对 workspace 根目录保存，移动或复制整个工作区后仍可解析项目配置。

## 局域网 Web 从网关主机读取素材

局域网浏览器打开上述入口后，剧本、审核和视频都由运行 gateway 的这台 Mac 提供。播放器请求 `/media/...` 时，gateway 在主机上使用主机自己的 `media-bindings.json` 解析 `media_id`，再通过 HTTP Range 将视频流发送给浏览器。

因此，访问 Web 的其它电脑不需要选择素材目录，也不需要拥有 `/Volumes/...` 路径或素材副本；工作台显示的是 gateway 主机的素材覆盖率。普通浏览器不能把主机文件作为本机文件拖到剪辑软件。

## 第二台 Mac 使用自己的素材副本（可选）

只有第二台 Mac 需要自己运行镜序、离线使用，或从其本机 App 原生拖拽文件到 FCP / Premiere / Resolve 时，才需要绑定自己的素材副本。假设硬盘名和文件夹不同：

```text
1. 同步或复制同一个 MirrorOrder workspace
2. 安装 / 构建相同版本的 镜序.app
3. 打开 App
4. 设置 → 这台 Mac 的素材副本
5. 点击“为当前项目绑定素材目录”
6. 选择这台 Mac 上保存素材的根目录
7. 镜序通过 media_id / 内容指纹建立本机映射
8. 工作台刷新后，播放器和原生拖拽使用这台 Mac 自己的文件
```

App 扫描不会改写共享 `material_index.json`、`matches.json` 或 `review.json` 中的项目事实。

命令行也可以执行：

```bash
./script-organizer media-scan workspace.toml beef "/Volumes/T9/在制项目"
./script-organizer media-status workspace.toml beef
```

如果一个素材根目录里包含多个项目，或需要一次重建本机全部项目映射：

```bash
./script-organizer media-scan-all workspace.toml "/Volumes/T9/短剧素材"
```

正式 `M_...` media ID 使用：

```text
文件大小 + 文件头 1 MiB + 文件尾 1 MiB
```

生成 quick content fingerprint。移动、改盘符、改目录甚至改文件名不会改变 ID；内容变化会改变 ID。

旧的、尚未重新分析生成 `media_id` 的项目可以暂时用唯一文件名 fallback (`MP_...`) 完成迁移，但这是兼容路径，不等同于内容级确认。

## 多设备之间需要同步什么

### 必须同步

```text
workspace.toml
projects/registry.json
projects/<project>/project.toml
项目依据的剧本 / FCPXML 或不可变副本
material_index.json
script.json
matches.json
review.json
```

其中最关键的是：

- `material_index.json`：clip/group/media_id/时间关系；
- `script.json`：统一剧本结构；
- `matches.json`：自动候选；
- `review.json`：人工决定，是共享业务状态的最高优先级。

### 推荐同步

为了避免别的设备重新计算：

```text
ASR / transcript cache
known-text alignment cache（可移植部分）
selection_manifest.json / 导出结果（按需要）
```

### 不同步

```text
~/Library/Application Support/MirrorOrder/media-bindings.json
每台电脑的 /Volumes/... 路径
本机素材根目录
磁盘名
PID
本机日志
临时文件
原生拖拽时的本机路径
```

如果每台设备本来就有视频拷贝，**镜序不需要同步原始视频本身**。

完整说明见 [SYNC_MODEL.md](SYNC_MODEL.md)。

## 多人同时审核

如果多人同时改 Best / Keep / Reject / 人工归集，`review.json` 必须有**单一写入权威**。

推荐：

```text
中央项目状态 / review API
+
每台设备自己的 media resolver / native drag bridge
```

不要让多台电脑各自运行服务，再单纯依靠 Dropbox / iCloud 同时直接修改同一个 `review.json`；文件同步无法提供可靠的跨机器锁和 revision 冲突控制。

## 浏览器与 App 的区别

浏览器工作台支持：

- 剧本 / 候选 Take / 审核；
- XML 时间线；
- 时间线 ↔ 素材关联；
- 通过它所连接的 gateway 从网关主机播放媒体。

`镜序.app` 额外提供：

- 当前 Mac 的素材目录扫描与绑定；
- AppKit 原生文件拖出到 FCP / Premiere / Resolve / Finder。

浏览器远程访问某个 gateway 时，看到的是**gateway 主机**的媒体覆盖率；视频也由该主机读取和发送，不会把主机路径冒充浏览器客户端自己的本机路径。

## 重新分析

指定项目的增量分析：

```bash
./script-organizer analyze workspace.toml beef
```

分析会按剧本、逻辑 Take、有效片内范围、ASR 内容和匹配配置生成确定性缓存键。未变化的 Take 会复用局部匹配缓存，再统一重跑顺序对齐和邻近上下文推断。

如果老项目需要正式跨设备 `media_id`，建议在能够读取原始媒体的机器使用当前版本重新跑一次 analyze；未重跑前仍有 filename provisional relink 作为兼容方案。

## 显式可信局域网服务

如需让其它浏览器访问同一台镜序主机，使用当前多工作区 gateway：

```bash
./script-organizer gateway workspace.toml --host 0.0.0.0 --port 8766
```

仅本机：

```bash
./script-organizer gateway workspace.toml --local-only --port 8766
```

不要把端口映射到公网。项目创建、路径选择和令牌创建接口只接受本机请求。

## 项目与智能体

- GUI 可创建 FCPXML 或媒体目录项目，剧本支持 DOCX、TXT、Markdown。
- 媒体目录不伪造多机位同步；只有已登记的 FCPXML 才保留其原始同步关系。
- 新项目会把剧本复制到 `projects/<project_id>/inputs/`，FCPXML 复制为 `inputs/source.fcpxml`，输出和缓存默认留在项目目录内；共享 `project.toml` 不保存本机素材根目录。
- 媒体目录项目的素材根目录只进入当前设备的 `media-bindings.json`。创建前会预检剧本段落、FCPXML 逻辑片段、工作区写权限和本机同步环境。
- 媒体目录项目的多机位同步由仓库内第一方 `vendor/multicam-audio-sync` 引擎完成。它随 App 一起发布，不依赖 Codex 或开发机的 `~/.agents/skills`；生成 FCPXML 后会自动执行内置结构校验。
- 媒体目录自动同步在 Host 上需要 `ffmpeg` / `ffprobe` 以及第一方引擎的 `numpy`、`pandas`、`scipy` 依赖；缺失时任务会在开始前给出明确错误。已有 FCPXML 项目不需要这组同步依赖。
- 全新 Mac 可先运行：

```bash
PYTHONPATH=src python3 -m script_organizer.cli doctor workspace.toml
```

该检查只报告当前 Host 的命令、Python 模块、第一方引擎与工作区写权限，不下载模型或修改项目数据。
- 后台任务仅支持 `incremental_analyze`、`transcribe`、`evidence_extract`；任务只写 ASR 缓存和派生产物。
- 智能体 Gateway 位于 `/api/agent/v1/workspaces/{workspace_id}`，使用单独 Bearer 令牌、项目白名单、`read/analyze/propose` 范围、有效期、速率限制和审计日志。
- 智能体只能提交带有效片内范围和证据的归集提案。GUI 人工确认后才会原子写入 `review.json`；revision 变化会拒绝应用旧提案。

创建智能体令牌：

```bash
./script-organizer agent-token-create workspace.toml beef --name codex
```

本机 stdio MCP：

```bash
export SCRIPT_ORGANIZER_URL=http://127.0.0.1:8766
export SCRIPT_ORGANIZER_WORKSPACE_ID=ws_9b9a4e7f2c1d4aa6b80c3f8b7e2d1a90
export SCRIPT_ORGANIZER_AGENT_TOKEN='创建时显示的令牌'
PYTHONPATH=src python3 -m script_organizer.mcp_server
```

## 测试

```bash
python3 -m py_compile src/script_organizer/*.py
python3 -m pytest -q
zsh macos-app/build_app.sh
```

第二台 Mac 自己运行镜序时，多设备真机验收至少检查：

1. 第二台 Mac 对同一共享项目选择不同素材根目录；
2. 本机素材覆盖率正确；
3. 同一素材能够从第二台的文件播放；
4. 从 App 拖到 Finder / FCP 得到第二台的文件路径；
5. 加载第一台导出的 FCPXML 仍能关联到第二台本地素材；
6. 本机扫描前后共享 `material_index.json` / `matches.json` / `review.json` 不被路径改写。

## 主要目录

```text
src/script_organizer/                 Python分析、分组、匹配、审核和Web服务
src/script_organizer/media_identity.py  media_id 与设备本地绑定
src/script_organizer/device_media_runtime.py  服务运行时本机路径解析
web/                                  三栏核对工作台 / XML时间线
workspace.toml                        工作区入口
projects/registry.json                多项目注册表
macos-app/MirrorOrderDesktopApp.swift 当前工作台优先 + 原生拖拽 App
macos-app/build_app.sh                当前 App 构建脚本
vendor/multicam-audio-sync/           第一方多机位同步、NLE XML、剪映适配与校验引擎
vendor/multicam-audio-sync/requirements.txt  媒体目录同步所需 Python 依赖
tests/                                核心回归测试
DESKTOP_BRIDGE.md                     时间线 / 原生拖拽边界
SYNC_MODEL.md                         多设备同步边界
AGENTS.md                             后续开发必须遵守的工程约束
```

## 安全边界

- 不读取 CSV 或旧素材清单参与自动判断。
- 不改变原始 FCPXML，不重建或破坏已有多机位同步关系。
- `organized.fcpxml` 默认保持输入 FCPXML 的字节级原样副本。
- 系统不自动 Reject 素材；无对白素材只能给邻近集数建议。
- `review.json` 是人工结果的共享持久化来源，修改前后都要验证人工记录未丢失。
- 本机 `media-bindings.json` 永远不是共享项目状态。
- 智能体无权直接写审核、Reject 素材、修改原始文件或改变全局匹配阈值。

继续开发前阅读 [项目介绍.md](项目介绍.md)、[AGENTS.md](AGENTS.md)、[DESKTOP_BRIDGE.md](DESKTOP_BRIDGE.md) 和 [SYNC_MODEL.md](SYNC_MODEL.md)。
