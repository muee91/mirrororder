# Auto Score / Music 模块工程约束

本文件作用域为 `src/script_organizer/music/` 及其子目录。进入本模块前仍必须遵守仓库根 `AGENTS.md`。

## 权威边界

- Auto Score 是派生创意链，不是审核、Editorial Decision、自动归集或 Delivery 权威。
- 禁止写 `review.json`、`editorial.json`、`auto_decisions.json`、`audit.json`。
- 禁止修改用户原始 FCPXML、原始媒体或已有同步关系。
- `music_plan.json` 和 `music_edit_plan.json` 必须可重建、可忽略。
- 未经专用安全 exporter 和结构验证，不得新增“直接改写用户 FCPXML”的快捷实现。

## 当前合同

- `auto-score.v1`：选曲/生成候选/授权/provenance/语义与节拍评分。
- `music-library.v2`：设备音乐库索引；资产路径必须保持相对音乐库根目录，不保存本机绝对音乐根路径。
- `music_edit_plan.v1`：exporter-neutral 音乐编辑指令；当前 `writes_fcpxml=false`。
- 真实时间只消费 `assembly_timeline.v1`；不得重新发明另一套粗剪时间线。

## 授权与生成版权

- 版权库默认 hard gate：只有 JSON 真布尔值 `commercial_use=true` 且 `sync_right=true` 才可自动选择。
- AI 生成默认 fail closed；“用户点了确认”本身不是跨 Provider 的通用商用授权证明。
- Provider 必须各自定义可验证的 rights/provenance 条件；未知 Provider 永远不能仅凭一个布尔值进入自动选择池。
- ACE-Step 输出必须按其当前 Provider 条款单独验证商业输出资格；缺少所需的人类创作证明或官方授权证据时保持 `commercial_use=false`、`sync_right=false`。
- Stable Audio 输出也必须记录适用的 Stability AI license/账户或企业授权条件；不得把“AI 生成”描述为“无版权/CC0”。
- Provider 条款可能变化。正式产品化前必须重新核验当前官方条款，并把核验依据作为 provenance，而不是把许可证结论硬编码成永久事实。
- Token/API key 不得进入 workspace、project.toml、music plan、provenance 或提交历史。

## 本机运行时与缓存

- Beat This、Transformers/CLAP、Stable Audio、ACE-Step 都不得成为镜序核心 Host 的强依赖。
- 缺失增强依赖时必须可降级到较低 feature level。
- 重模型优先通过受控本机 runtime、CLI 或 HTTP sidecar 隔离。
- 不得在普通“生成计划 / 搜索 / 打开页面”请求中隐式 `from_pretrained()` 下载多 GB 模型。
- 模型准备/下载必须由用户显式触发，并作为可见、可取消/重试的后台工作进入 Status Center。
- 分析、embedding、模型缓存必须复用 MirrorOrder 当前跨平台 Application Support/data-root 规则；不得把 macOS `~/Library/Application Support/...` 直接硬编码成唯一默认路径。
- packaged App 不得依赖用户 shell PATH 或运行时 `pip install` 才能获得必需工具。

## 后台执行

- 音乐分析、语义编码、大批量库扫描和 AI 生成均属于昂贵工作，产品集成时必须走 durable task，而不是 UI/GET 请求里的同步长任务或隐藏 daemon thread。
- Status Center 必须能够显示等待资源、运行进度、取消、失败、重试与完成状态。
- 普通读请求只能读取已有 `music-library` / `music-plan` / `music-edit-plan` 派生结果，不得顺带重建整库或启动生成模型。

## App 集成

当前 Desktop 基线是 React/TypeScript + Tauri 2 + Rust Host 生命周期 + Python Core。

- App 只通过 Host/API 使用 Auto Score，不让前端直接启动模型、扫描音乐库或写项目文件。
- Auto Score 应归入现有 Production IA 的“剪辑”工作流，不新增算法名一级导航。
- 生成、分析与索引状态统一进入全局 Status Center。
- 模型/provider/API key 配置统一进入全局设置，不塞进小镜 Drawer。
- 小镜可以解释音乐建议，但不能把建议升级成 Editorial Best/Reject 或 Timeline authority。

## V1 迁移策略

从旧 `work/auto-score` 回收到当前 `main` 时，不做整分支 rebase。按能力层迁移：

1. **可优先迁移的纯/近纯核心**：`models.py`、`planner.py`、`timeline.py`、`scoring.py`、`edit_model.py`；保持 read-only/exporter-neutral authority。
2. **需要适配后迁移**：`library.py`、`analysis.py`、`semantic_rerank.py`、`semantic_retriever.py`；先统一跨平台缓存、packaged ffmpeg/ffprobe provenance 和显式模型准备策略。
3. **不得原样迁移**：`generation.py`、`semantic.py`、`runtime.py`、`cli.py`；先重做 Provider rights gate、durable task、模型下载/缓存和 Status Center 集成。
4. `music/semantic` 的 CLAP text/audio embedding 与项目 Qwen multimodal semantic embedding 是不同数据空间；不得混库、混 identity 或混 ranking confidence。
5. 只有在安全 exporter、测试和结构验证完成后才允许生成新的 scored FCPXML；不得覆盖用户输入。

## 每次修改至少验证

```bash
pytest -q \
  tests/test_auto_score_v0.py \
  tests/test_auto_score_v02.py \
  tests/test_auto_score_v03.py \
  tests/test_auto_score_v04.py \
  tests/test_auto_score_v1.py
```

涉及 Host/API/Desktop 集成时，再运行完整 `pytest -q`、Desktop `verify:rc` 和 macOS packaged App smoke。
