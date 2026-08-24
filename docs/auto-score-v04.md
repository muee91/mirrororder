# Auto Score V0.4 — Generated Music Fallback

V0.4 在 V0.3 的版权库检索、语义窗口检索、Beat/Downbeat Grounding 和全局连续性优化之上增加 AI 生成兜底。

核心原则：**library first, generation fallback**。

```text
MusicBrief
  ↓
合法版权库检索 + V0.3 hybrid score
  ↓
最高候选 >= generation_threshold ?
  ├─ yes → 不生成
  └─ no  → GeneratedMusicProvider
                ↓
          生成 1~4 个候选
                ↓
       同一套 audio analysis / semantic / grounding / score
                ↓
          rights confirmed ?
          ├─ no  → 仅 generated_alternatives
          └─ yes → 进入普通候选池 + Global DP
```

生成模型没有任何“特殊优先权”。生成结果必须重新经过镜序正常的候选评分器。

## Provider

### ACE-Step 1.5

镜序使用 ACE-Step 官方本机异步 HTTP API：

```text
POST /release_task
POST /query_result
GET  /v1/audio?path=...
```

默认地址：

```text
http://127.0.0.1:8001
```

也可设置：

```bash
export MIRRORORDER_ACESTEP_URL=http://127.0.0.1:8001
```

如果 ACE-Step 服务启用了 API Key，镜序只从进程环境读取：

```bash
export ACESTEP_API_KEY='...'
```

Key 不写入 workspace、project.toml、music_plan.json 或 provenance。

镜序请求：

- `task_type=text2music`
- `lyrics=[Instrumental]`
- 根据 MusicBrief 给出 duration / BPM
- `audio_format=wav`
- 默认 8 inference steps
- batch size 来自 `--generation-count`

### Stable Audio 3

Stable Audio 3 作为独立 CLI 运行，不进入镜序 Host Python 依赖图。

镜序调用官方 `stable-audio` CLI：

```text
stable-audio --model small-music -p <prompt> --duration <sec> -o <output.wav>
```

可以通过环境变量指定独立环境中的 CLI：

```bash
export MIRRORORDER_STABLE_AUDIO_BIN=/path/to/stable-audio
```

或命令行：

```bash
--stable-audio-bin /path/to/stable-audio
```

Stable Audio 3 Small Music 是 gated 模型。首次使用前由用户在 Hugging Face / Stability AI 侧完成相应条款接受与认证；镜序不接管、不保存 HF token。

## 自动 Provider 选择

```bash
--generate auto
```

顺序：

1. 检查 ACE-Step 本机 `/health`；
2. 可用则使用 ACE-Step；
3. 否则检查 `stable-audio` CLI；
4. 都不可用时 generation provider 为 `unavailable`，版权库链仍正常完成。

也可以强制：

```bash
--generate acestep
--generate stable-audio3
```

## 触发阈值

默认：

```text
generation_threshold = 0.64
```

只有当前 cue 的最高版权库候选低于阈值，或者没有合法候选，才调用生成模型。

```bash
--generation-threshold 0.70
--generation-count 3
```

V0.4 最多允许每个 cue 生成 4 个候选，避免无界生成成本。

## 生成版权 Gate

**AI generated 不等于 public domain / CC0 / “无版权”。**

因此 V0.4 默认 fail closed：

```text
commercial_use = false
sync_right = false
```

生成结果仍会被分析和打分，但只进入：

```text
cue.generated_alternatives
```

并明确记录：

```json
{
  "eligible": false,
  "rejection_reason": "generated_rights_unconfirmed"
}
```

只有用户显式运行：

```bash
--confirm-generated-rights
```

才表示用户确认其当前适用的 Provider / 模型 / 组织营收 / 使用场景条款允许这些输出用于商业同步。此时生成资产才会进入普通候选池和全局 DP。

这个 flag 是用户的 rights assertion，不是镜序提供的法律判断，也不会把生成音频标记成 CC0。

## Provenance

每次 plan 都会重建：

```text
output/music/provenance.jsonl
```

每个生成文件记录：

```text
cue_id
provider
model
prompt
duration
seed（Provider 可提供时）
rights_confirmed
provider metadata
generated_at
```

ACE-Step 还会保存 task_id、BPM、key、time signature 等返回元数据；不会保存 API Key。

生成 WAV 位于：

```text
output/music/generated/<cue_id>/
```

这是派生输出，不修改用户音乐库，不写 review.json / editorial.json / auto_decisions.json。

## 命令示例

### ACE-Step

```bash
mirrororder-auto-score plan workspace.toml beef /Volumes/Music/Approved \
  --episode 1 \
  --timeline-seconds 92 \
  --analysis auto \
  --semantic auto \
  --generate acestep \
  --generation-threshold 0.68 \
  --generation-count 2
```

此时生成音乐只供比较，不允许自动选择。

确认当前 Provider 条款适用于项目后：

```bash
mirrororder-auto-score plan workspace.toml beef /Volumes/Music/Approved \
  --episode 1 \
  --timeline-seconds 92 \
  --analysis auto \
  --semantic auto \
  --generate acestep \
  --confirm-generated-rights
```

### Stable Audio 3

```bash
mirrororder-auto-score plan workspace.toml beef /Volumes/Music/Approved \
  --episode 1 \
  --timeline-seconds 92 \
  --generate stable-audio3 \
  --stable-audio-bin /path/to/stable-audio
```

## music_plan.json V0.4

新增：

```text
policy.generation_mode
policy.generation_provider
policy.generation_threshold
policy.generated_rights_confirmed

summary.generation_cues
summary.generated_tracks
summary.generation_failures
summary.generated_selected

cue.generated_alternatives[]
cue.generation

generation.errors[]
generation.provenance_path
```

如果生成 Provider 出错，错误记录到 `generation.errors`，不会把整个版权库配乐计划伪装成失败；已有合法候选仍可正常产出。

## V1.0 前仍不做的事

V0.4 仍不直接改写用户原始 FCPXML，也不把生成音乐自动写入 Production timeline。

进入 V1.0 前还需要：

1. 使用真实粗剪 timeline boundaries 替换剧本文本时长估算；
2. Music Edit Model（duck / fade / continuation / loop / cadence）；
3. FCPXML 专用安全 exporter；
4. 原生试听、换曲、锁定和 rights/provenance UI。
