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
- `music-library.v1`：设备音乐库的可共享相对索引，不保存本机绝对音乐根路径。
- `music_edit_plan.v1`：V1 exporter-neutral 音乐编辑指令；当前 `writes_fcpxml=false`。
- V1 真实时间以 `assembly_timeline.v1` 为来源。不得重新发明另一套粗剪时间线。

## 授权

- 版权库默认 hard gate：只有 JSON 真布尔值 `commercial_use=true` 且 `sync_right=true` 才可自动选择。
- AI 生成默认 fail closed；用户未明确确认当前 Provider/模型条款时，生成结果可以评分/试听，但不得进入自动选择池。
- 不把“AI 生成”描述为“无版权/CC0”。
- Token/API key 不得进入 workspace、project.toml、music_plan、provenance 或提交历史。

## 可选依赖

- Beat This、Transformers/CLAP、Stable Audio、ACE-Step 都不得成为镜序核心 Host 的强依赖。
- 缺失增强依赖时必须可降级到较低 feature level。
- 重模型优先通过本机独立环境、CLI 或 HTTP sidecar 隔离。

## V1 当前方向

1. 消费 `assembly_timeline.v1` 的真实场景时长。
2. 输出 `output/music/music_edit_plan.json`，先保持 exporter-neutral。
3. 逐步加入可验证的 beat-aware trim、fade、ducking、continuation、loop/extend。
4. 只有在安全 exporter、测试和结构验证完成后才允许生成新的 scored FCPXML；不得覆盖用户输入。
5. App 集成应通过 Host/API 暴露 music state/actions，而不是让 Swift 直接调用模型。

## 每次修改至少验证

```bash
pytest -q \
  tests/test_auto_score_v0.py \
  tests/test_auto_score_v02.py \
  tests/test_auto_score_v03.py \
  tests/test_auto_score_v04.py \
  tests/test_auto_score_v1.py
```

涉及主 Host/API/App 集成时再运行完整 `pytest -q` 和 macOS build smoke。
