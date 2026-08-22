# 短剧素材核对平台 GPT 版

这是一个面向剪辑人员的本地多机位素材整理平台。它解决的问题是：

> 拿到拍摄混乱的 A/B/C 多机位素材、可信度有限的场记信息和一份剧本后，快速把实际拍摄 Take 按剧本顺序整理出来，并允许剪辑人员直接看片、修正归集和多人协作审核。

项目保持原生 HTML/CSS/JavaScript 与 Python 标准库服务，不依赖 React、Vue、数据库、云服务或 Docker。视频通过 HTTP Range 直接读取原始素材，不复制视频文件。

当前版本是本地多项目工作台。每个项目由稳定 `project_id` 注册在 `projects/registry.json`，浏览器与智能体统一使用版本化项目 API，不保留旧的单项目 `/api/...` 契约。

## 当前项目

当前内置回归项目为《在制项目》：

- 输入 FCPXML：`/Volumes/TESTVOL/工程/syc/交付/牛肉_两天三机位_音频同步_capcut.fcpxml`
- 输入剧本：`/Volumes/TESTVOL/副本拍摄定【在制项目】(1).docx`
- 素材数量：1502
- 逻辑 Take：610
- 可用 ASR 缓存素材：1014
- 对白匹配组：355
- 邻近上下文组：237
- 仍无可靠线索组：18
- 无可用对白组：22
- 场景前导近邻救援组：1

自动结果只提供候选。人工的最佳、保留、隐藏、多集归属和剧本范围修正永远优先于算法。

## 快速启动

```bash
cd "/Users/editor/Code workspace/短剧素材核对平台GPT版"
open "镜序.app"
```

`镜序.app` 是原生 macOS 启动应用，支持选择工作区、本机或可信局域网模式、启动/停止服务、打开工作台、复制局域网地址、查看项目状态和最近日志，并管理前端主题、密度、默认模式和协作刷新设置。

当前局域网地址示例：

```text
http://192.168.0.105:8765/
```

脚本入口仍可用：

```bash
./启动素材工作台.command
```

脚本默认监听可信局域网；仅本机使用时传入 `SCRIPT_ORGANIZER_HOST=127.0.0.1`。日志位于 `.workspace/logs/`。

如需可信局域网协作，显式使用：

```bash
./script-organizer serve workspace.toml --host 0.0.0.0 --port 8765
```

只允许本机访问：

```bash
./script-organizer serve workspace.toml --local-only --port 8765
```

不要把端口映射到公网。项目创建、路径选择和令牌创建接口只接受本机请求。

## 全新环境使用

`镜序.app` 内置平台服务程序、网页工作台和 MCP 适配器；交付给新机器时只需要复制完整的 `镜序.app`，项目数据不要放进 App 包内。

首次打开 App 后，按运行概览中的顺序完成：

1. 检查 Python 3.11 或更高版本。缺少时先安装 Python，再在 App 中点击刷新。
2. 按需安装 FFmpeg 与 `faster-whisper`。它们只在新素材需要 ASR 转写时必需；仅浏览、审核或复用已有 ASR 缓存时不阻塞。
3. 点击“创建工作区”，选择一个普通可写目录。App 会创建 `workspace.toml`、`projects/` 和 `.workspace/`，但不会创建或复制任何素材。
4. 启动服务，打开工作台，在“新建项目”中选择 FCPXML 或媒体目录，以及 DOCX、TXT 或 Markdown 剧本。
5. 项目素材、ASR 缓存、分析输出和 `review.json` 都保留在工作区；后续更新只替换 `镜序.app`，不要覆盖工作区。

完整发布包必须保留 App 的内部运行时资源。不要只复制 `MaterialWorkspace` 可执行文件，也不要把端口映射到公网。

## 重新分析

指定项目的增量分析：

```bash
./script-organizer analyze workspace.toml beef
```

分析会按剧本、逻辑 Take、有效片内范围、ASR内容和匹配配置生成确定性缓存键。未变化的 Take 会复用局部匹配缓存，再统一重跑顺序对齐和邻近上下文推断。

## 项目与智能体

- GUI 可创建 FCPXML 或媒体目录项目，剧本支持 DOCX、TXT、Markdown。
- 媒体目录不伪造多机位同步；只有已登记的 FCPXML 才保留其原始同步关系。
- 后台任务仅支持 `incremental_analyze`、`transcribe`、`evidence_extract`；任务只写 ASR 缓存和派生产物。
- 智能体 Gateway 位于 `/api/agent/v1`，使用单独 Bearer 令牌、项目白名单、`read/analyze/propose` 范围、有效期、速率限制和审计日志。
- 智能体只能提交带有效片内范围和证据的归集提案。GUI 人工确认后才会原子写入 `review.json`；revision 变化会拒绝应用旧提案。

创建一个仅能访问 `beef` 的智能体令牌：

```bash
./script-organizer agent-token-create workspace.toml beef --name codex
```

令牌只在创建时显示一次，服务端只保存哈希值。不要把令牌提交到项目、日志或聊天记录。

本机 stdio MCP 适配器：

```bash
export SCRIPT_ORGANIZER_URL=http://127.0.0.1:8765
export SCRIPT_ORGANIZER_AGENT_TOKEN='创建时显示的令牌'
PYTHONPATH=src python3 -m script_organizer.mcp_server
```

MCP 仅公开能力、项目上下文、搜索、证据读取、受限任务和提案提交工具，不提供审核应用、删除、导出改写或公网操作。

## 测试

```bash
python3 -m py_compile src/script_organizer/*.py
python3 -m pytest -q
```

当前基线：44 项测试通过。

## 主要目录

```text
src/script_organizer/       Python分析、分组、匹配、审核和Web服务
web/                        原生三栏核对工作台
workspace.toml              工作区入口
projects/registry.json      多项目注册表
projects/beef/project.toml  《在制项目》配置
projects/beef/cache/        ASR缓存
projects/beef/output/       分析结果、审核记录和原样FCPXML导出
output/playwright/          正式浏览器验收截图
macos-app/                  原生 macOS 应用源码与构建脚本
镜序.app                      已构建的双击启动应用
tests/                      核心回归测试
项目介绍.md                  产品、数据和架构说明
AGENTS.md                   后续开发必须遵守的工程约束
```

## 安全边界

- 不读取 CSV 或旧素材清单参与自动判断。
- 当前牛肉项目只使用 FCPXML、剧本、ASR缓存和人工审核结果。
- 不改变原始 FCPXML，不重建或破坏已有多机位同步关系。
- `organized.fcpxml` 是输入 FCPXML 的字节级原样副本。
- 系统不自动 Reject 素材；无对白素材只能给邻近集数建议。
- `review.json` 是人工结果的唯一持久化来源，修改前后都要验证人工记录未丢失。
- 智能体无权直接写审核、Reject 素材、修改原始文件或改变全局匹配阈值。

继续开发前先阅读 [项目介绍.md](项目介绍.md) 和 [AGENTS.md](AGENTS.md)。
