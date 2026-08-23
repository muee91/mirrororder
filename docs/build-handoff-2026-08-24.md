# 镜序构建交接 — 2026-08-24

这份文档定义当前 `main` 到什么程度可以停止继续堆功能、交给真实 Mac 构建和素材验收。

## 1. 本次交接范围

当前版本已经形成一条可以真机验证的主链：

```text
项目创建
→ 原始多机位同步 / 已有 FCPXML
→ ASR / 剧本候选 / 自动归集
→ 人工 Mapping
→ Team Opinion / Editorial Decision
→ 场记 / 人物 / 景别 / Audit evidence
→ Coverage
→ Rough Cut
→ Assembly Preview
→ Delivery Semantics / selection manifest
```

同时具备：

- App Production / Team Web Review 分层；
- 当前设备 `media_id → resolved path`；
- AppKit 文件拖拽；
- App `剪辑 → 时间线` 只读 FCPXML 预览；
- 镜序助理主动异常沟通；
- visual / speech / slate 统一检索；
- ASR segment 精确对白定位；
- CLI `semantic-search`；
- MCP `semantic_search`；
- Agent allowlist / scope / proposal / revision 安全边界。

## 2. 为什么现在适合停止编码去构建

从这里继续加模型或功能，边际收益已经低于真机反馈价值。

当前剩余的大项都需要真实运行数据才能做正确选择：

1. 本地固定 embedding 模型需要中文素材 recall / latency / 内存 benchmark；
2. visual segment layer 需要观察现有 Take-level 画面检索究竟在哪些素材上不够精确；
3. image-to-image / fast visual lane 是否值得做，需要真实剪辑找素材场景验证；
4. 正式 Final Cut / Premiere / Resolve Delivery Adapter 需要剪辑软件真机往返验收；
5. 4B 本地模型的 Agent 自主度需要 tool-use benchmark，而不是继续凭感觉增加工具。

这些都不应在第一次完整构建之前猜测实现。

## 3. 一键构建门禁

在仓库根目录运行：

```bash
zsh macos-app/build_ready.sh
```

它按顺序执行：

```text
macos-app/prebuild_check.py
  ↓
PYTHONPATH=src python3 -m pytest -q tests
  ↓
macos-app/build_app.sh
```

静态 prebuild 会检查：

- `src/script_organizer/*.py` 都能被 Python AST 解析；
- Production 层仍由 WKWebView bridge 门控；
- Team Web 不会激活 XML Production 时间线；
- `剪辑 → 时间线` 入口仍存在；
- 旧 `automation.js` 不再被 timeline loader 激活；
- Semantic Search 精确定位逻辑仍使用 `member.source_start + result.start`；
- CLI / MCP semantic search 都存在；
- MCP 没有通用 shell/exec；
- 第一方多机位同步和 macOS 打包关键输入存在。

pytest 或 build 任何一步失败，脚本立即停止。

## 4. 第一轮真机 Smoke Test

构建完成后：

```bash
open "镜序.app"
```

按这个顺序验收，先不要急着跑完整长项目。

### A. App / Web 产品边界

- App 能看到 Production 导航：素材 / 剧本 / 剪辑 / 审阅。
- 剪辑下能看到：粗剪 / 组接 / 时间线。
- 从 App 打开的 Team Web 不出现 Production 导航、项目创建、本机路径和 XML 时间线。
- Team Web 仍能看片、审核、提交个人意见。

### B. 媒体与播放

- 当前项目媒体覆盖率正确。
- A/B/C 素材可正常播放。
- 更换为另一块盘的同一素材副本后，`media_id` 仍能解析。
- 从素材卡拖到 Finder，得到当前 Mac 的真实媒体文件。
- 从素材卡拖到 FCP Browser/Event，按普通媒体文件接收。

### C. 时间线

- App `剪辑 → 时间线` 能显示当前项目时间关系。
- 加载一份 FCPXML 1.9+，`media-rep` 能关联当前项目素材。
- 点击时间线片段可回到正确 Take / 机位。
- 人工改过剧本范围的 Take 不被自动 candidate 覆盖。
- 原始 XML 和原始媒体没有被修改。

### D. 自动归集与人工权威

- 高可信结果能自动归集。
- 低可信结果进入待处理，不自动猜结论。
- 人工 placement 后重跑自动流程，人工结果仍保留。
- 系统不自动产生 Reject。

### E. 镜序助理

- 有低置信 / 冲突时出现自然语言提醒。
- “看片”能定位对应 Take。
- “判断归集”进入既有人工归集 UI，而不是助理直接写结果。
- 已处理问题不持续重复打断。

### F. 找素材

先不用配置 embedding：

- 搜一段已有台词，能返回“对白”结果。
- 点击“定位对白”，播放器应落到实际说话位置附近，而不是只打开 Take 开头。
- 搜场记备注能返回场记证据。
- 搜已有 visual semantic 描述能返回画面证据。

然后如已有 OpenAI-compatible embedding endpoint，再测试 hybrid 模式；没有 endpoint 不影响本轮验收。

### G. Coverage / Rough Cut / Assembly

- Coverage 不把 Team Opinion 当 Final Decision。
- 没有明确 Best 的剧本段保持待选择。
- Rough Cut / Assembly 不偷偷挑一个 Take。
- 场记 NG / usable range 能作为证据或约束出现。
- Assembly 仍明确是 preview-only，不修改 FCPXML。

## 5. 本轮故意不做的功能

下面不是“漏实现”，而是明确延期到真机反馈之后：

### 本地固定 embedding runtime

当前完全离线仍有 FTS / trigram / keyword 搜索；向量语义搜索通过可选 OpenAI-compatible embedding endpoint。

不在本轮随便选一个 embedding 模型打包，因为需要先验证：

- 中文短剧台词 / 场记 / 视觉描述 recall；
- Apple Silicon 内存与首载；
- 模型许可证；
- tokenizer/version fingerprint；
- 和 4B VLM 并发时的资源占用。

### visual segment precision

当前 speech 已经是 ASR segment 级；visual 仍以 bounded Take semantic 为主。

后续只在真实搜索结果证明 Take-level 不够时增加 visual segment layer，不能退回全项目无差别 VLM 扫描。

### image-to-image / fast visual lane

参考素材库产品通常会提供 CLIP 类快速视觉向量，但镜序是否需要它应由剪辑使用场景决定，不为了功能对齐而增加一条模型运行时。

### 正式 NLE Delivery Adapter

当前已有：

- AppKit 原生文件拖拽；
- FCPXML read-only inspector；
- `delivery.v1` / `selection_manifest.v3`；
- Rough Cut / Assembly edit model。

还没有把 `selection_manifest` 自动写进打开中的 Final Cut / Premiere / Resolve 工程。该能力必须做真实 NLE round-trip 后再声明完成。

## 6. 构建失败时优先看哪里

### prebuild 失败

说明仓库结构或产品边界发生静态漂移；按报错文件修，不要跳过。

### pytest 失败

先区分：

- 本轮新 regression；
- 旧测试仍要求已经废弃的产品行为；
- 环境缺依赖。

不要为了“全绿”删除人工权威、App/Web 边界或 native drag 的安全断言。

### Swift build 失败

重点检查：

- Xcode / macOS SDK；
- `swiftc`；
- arm64 target；
- `llama-runtime.lock` 与本机 Homebrew runtime 是否一致。

本地 VLM runtime 缺失时，构建脚本允许 App 在无视觉模型状态下构建；但如果明确发现一个已安装的 `llama-server` 与 lock 不一致，会按设计拒绝打包错误 runtime。

### 多机位 prepare 失败

运行：

```bash
PYTHONPATH=src python3 -m script_organizer.cli doctor workspace.toml
```

重点检查 `ffmpeg` / `ffprobe` / numpy / pandas / scipy 和第一方 `vendor/multicam-audio-sync`。

## 7. 本轮完成定义

这次交接的完成条件不是“所有未来功能都写完”，而是：

> 当前产品语义已经闭环到可以让真实剪辑素材暴露下一批问题；继续在没有真机反馈的情况下加模型、加按钮或加自主 Agent，会降低而不是提高工程确定性。

因此只要 `build_ready.sh` 在你的 Mac 上通过，并完成上面的 Smoke Test，这一阶段就应该正式结束，下一阶段按实际失败项和剪辑反馈排序。
