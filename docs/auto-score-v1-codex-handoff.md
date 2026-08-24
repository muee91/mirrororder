# Auto Score V1 / Codex Handoff

## 分支与工作树

研发分支：

```text
feat/auto-score
```

推荐独立工作树：

```bash
git fetch origin
git worktree add ../mirrororder-auto-score feat/auto-score
cd ../mirrororder-auto-score
```

如果本地尚无分支：

```bash
git worktree add -b feat/auto-score ../mirrororder-auto-score origin/feat/auto-score
```

不要在 `main` 工作树直接开发 Auto Score。

## 开始工作前必读

```text
AGENTS.md
AUTOMATION_PIPELINE.md
src/script_organizer/music/AGENTS.md
docs/auto-score-v0.md
docs/auto-score-v03.md
docs/auto-score-v04.md
本文件
```

真实粗剪时间线还要读：

```text
src/script_organizer/assembly_timeline.py
src/script_organizer/assembly_runtime.py
src/script_organizer/rough_cut_plan.py
```

## 当前已经完成

### V0

- 合法本地音乐库索引；
- License hard gate；
- 剧本 scene → MusicBrief；
- section moment selection；
- dialogue / energy / semantic 规则评分；
- Top-K + 全集连续性 DP。

### V0.2

- ffmpeg 能量曲线；
- 自动 section；
- 可选 Beat This；
- beat/downbeat grounding；
- 本机分析缓存。

### V0.3

- 可选 CLAP；
- 音频 sliding-window embedding；
- MusicBrief ↔ 音频窗口语义重排；
- 语义检索和节拍剪点分离。

### V0.4

- ACE-Step HTTP Provider；
- Stable Audio 3 CLI Provider；
- 版权库优先、低分才生成；
- AI 生成 fail-closed rights gate；
- `provenance.jsonl`。

### V1.0-alpha 当前切入

- `music/timeline.py` 消费 `assembly_timeline.v1`；
- 把 assembly 每场局部时间累加成 episode-global music clock；
- `planner.py` 在提供 assembly timing 时直接用真实 scene duration 重新选曲；
- `music/edit_model.py` 生成 `music_edit_plan.v1`；
- readiness 非 `ready` 的场景不得标记 exportable；
- 音乐源片段短于真实场景时标记 `extend_required`；
- 当前仍明确 `writes_fcpxml=false`。

## 主要输出

```text
output/music/library_index.json
output/music/music_plan.json
output/music/music_edit_plan.json   # V1 assembly mode
output/music/provenance.jsonl
output/music/generated/...
```

## V1 接下来优先级

### P0：Host 内存直连 assembly

现在 CLI 已支持外部 `--assembly-json`，下一步应在 Host 内直接：

```python
assembly = build_assembly_timeline(project, episode=episode)
plan = build_music_plan(
    project.config,
    music_root,
    episode=episode,
    assembly_timeline=assembly,
    ...,
)
```

不要先写临时 JSON 再读回来。

### P0：设备本地 Music Library Binding

参考媒体的 device-local binding 思路，为音乐库根目录建立设备本地配置。要求：

- 不进 `project.toml`；
- 不进 repo；
- 不进共享 `music_plan.json`；
- Host/API 能解析当前设备的 music root；
- App 可以选择/替换音乐库。

建议合同：

```text
music-bindings.json
workspace_id + project_id -> approved music roots / provider preferences
```

### P0：Host API

建议最终暴露：

```text
GET  /api/v1/projects/{id}/music/state
POST /api/v1/projects/{id}/music/plan
GET  /api/v1/projects/{id}/music/edit-plan
POST /api/v1/projects/{id}/music/cues/{cue_id}/select
POST /api/v1/projects/{id}/music/cues/{cue_id}/regenerate
POST /api/v1/projects/{id}/music/cues/{cue_id}/lock
```

其中 `select/lock` 需要独立的人类音乐编辑状态，不得复用 `editorial.json`。

### P1：Music Edit Model 精化

当前 mix 只有 scene-level dialogue density，下一步要从真实组接块/ASR 时间映射得到 dialogue intervals，再生成：

```text
volume envelope
attack/release
fade in/out
beat-aware trim
continuation
loop/extend request
```

不要伪造 sample-accurate ducking。

### P1：安全 exporter

先创建专用 exporter contract，不要修改 source FCPXML：

```text
source timeline
+ music_edit_plan.v1
-> output/music/scored.fcpxml
-> structural validator
```

要求：

- 原文件永不覆盖；
- source refs 保持；
- frame boundary 校验；
- resource IDs 无冲突；
- 音乐资产缺失时失败而不是生成坏 XML；
- blocked cue 不导出；
- 失败不伪装成功。

### P2：macOS 原生 UI

UI 第一版只需要：

```text
Auto Score 状态
Cue 列表
试听选中音乐片段
Top-K 换一个
生成替代
锁定
授权/provenance
重新规划
```

SwiftUI 不直接加载 Beat This/CLAP/Stable Audio/ACE-Step；全部经 Host。

## Codex 建议首个任务

打开 `mirrororder-auto-score` 工作树后直接给 Codex：

```text
继续 Auto Score V1.0。先读根 AGENTS.md、src/script_organizer/music/AGENTS.md、docs/auto-score-v1-codex-handoff.md，以及 assembly_timeline.py / assembly_runtime.py。不要修改 main，不要写 review.json/editorial.json/auto_decisions.json，不要覆盖任何 FCPXML。

当前第一任务：把 Auto Score 与现有 assembly runtime 在 Host 内存中连接起来，并设计 device-local music library binding。先补测试，再实现 API；保持现有 CLI 和 V0-V0.4 回归兼容。完成后运行 Auto Score 全组 pytest，再运行相关 Host/API 测试。不要创建 PR，除非我明确要求。
```

## 本地测试

基础：

```bash
python3 -m pip install -e .
pytest -q \
  tests/test_auto_score_v0.py \
  tests/test_auto_score_v02.py \
  tests/test_auto_score_v03.py \
  tests/test_auto_score_v04.py \
  tests/test_auto_score_v1.py
```

完整增强环境：

```bash
python3 -m pip install -e '.[auto-score-full]'
```

V1 临时 CLI 验证：

```bash
mirrororder-auto-score plan \
  workspace.toml PROJECT_ID /path/to/ApprovedMusic \
  --episode 1 \
  --assembly-json /path/to/assembly_timeline.json \
  --analysis auto \
  --semantic auto
```

预期额外产生：

```text
output/music/music_edit_plan.json
```

## 禁止捷径

- 不得为了“端到端”直接拼字符串生成 FCPXML；
- 不得把 `assembly_timeline.v1` readiness 忽略掉；
- 不得把生成 AI 音乐默认为商用授权；
- 不得把本机音乐根路径写进共享项目状态；
- 不得让 Swift App 直接依赖 Torch/Transformers；
- 不得把 Auto Score 结果升级成镜序审核/Editorial 权威。
