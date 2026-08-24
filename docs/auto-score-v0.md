# Auto Score V0.2

`feat/auto-score` 现在已经从“合法音乐库 + 元数据 section 选曲”升级到可选的真实音频分析：**能量曲线、自动 section、Beat This beat/downbeat 和节拍吸附式 moment grounding**。

目标仍然是先证明“镜序能安全地从合法音乐库自动挑选具体音乐片段”，不把生成模型、重型 embedding 或 FCPXML 改写变成主链硬依赖。

## 边界

Auto Score 是派生创意链，只写：

```text
output/music/library_index.json
output/music/music_plan.json
```

它不得写 `review.json`、`editorial.json`、`auto_decisions.json`，也不修改用户原始 FCPXML。`music_plan.json` 不是 Editorial Decision；编辑可以完全忽略或重建它。

音乐音频分析缓存属于当前设备，默认保存到：

```text
~/Library/Application Support/MirrorOrder/music-analysis-v2/
```

可继续用 `MIRRORORDER_DEVICE_STATE_DIR` 覆盖。缓存键使用音乐内容 `asset_id`，不会把本机 `/Volumes/...` 路径写进共享项目产物。

## 音乐库

扫描格式：

```text
wav mp3 m4a aac flac aif aiff ogg
```

WAV 时长用 Python 标准库读取；其它格式优先调用系统 `ffprobe`。

音乐目录根部可放 `music_library.json`：

```json
{
  "version": 1,
  "tracks": [
    {
      "path": "cinematic/dark_01.wav",
      "title": "Dark 01",
      "tags": ["suspense", "mystery", "cinematic"],
      "moods": ["dark", "tense"],
      "styles": ["underscore"],
      "bpm": 88,
      "key": "Dm",
      "energy": 0.52,
      "vocal_probability": 0.0,
      "sections": [
        {"start": 0, "end": 18, "kind": "intro", "tags": ["mystery"]},
        {"start": 18, "end": 42, "kind": "build", "tags": ["danger", "reveal"]}
      ],
      "license": {
        "source": "owned",
        "license_id": "owned-sync",
        "source_url": "",
        "creator": "",
        "commercial_use": true,
        "sync_right": true,
        "attribution_required": false,
        "attribution_text": ""
      }
    }
  ]
}
```

单曲也可以用同名 sidecar：

```text
dark_01.wav
dark_01.wav.music.json
```

sidecar 字段会覆盖根 manifest 中该曲的字段。人工提供的 `sections` 优先于自动分段。

## 授权 Gate

正式默认只有同时满足以下条件的音乐才进入候选：

```text
commercial_use = true
sync_right = true
```

字段必须是真正的 JSON boolean `true`；字符串 `"true"` 不会被宽松转换成授权。未验证、NC 或缺少同步权的音乐仍可进入索引，但不会被自动选择。

`--allow-unverified` 只用于开发测试，计划文件会明确记录该开关。

## V0.2 音频分析

### `--analysis off`

只使用已有 metadata/sidecar；完全保持 V0 行为。

### `--analysis basic`

只需要系统 `ffmpeg`：

```text
音频
↓
8 kHz mono PCM
↓
0.5 s RMS windows
↓
robust normalized energy curve
↓
energy change-point detection
↓
auto section boundaries
```

如果有 downbeat 数据，自动 section boundary 会向附近 downbeat 吸附。

### `--analysis auto`（默认）

执行 `basic`，并在本机安装 Beat This 时增加：

```text
Beat This
↓
beats + downbeats
↓
BPM estimate
↓
section boundary snapping
↓
cue moment grounding
```

Beat This 不是主程序硬依赖。未安装、模型加载失败或当前设备不支持时，只留下 warning 并退回 `basic`；不会阻断 Auto Score。

安装可选增强：

```bash
python3 -m pip install -e '.[auto-score-beats]'
```

该 extra 当前锁定 `beat-this>=1.1,<2`。Beat This 1.1 的代码和发布模型权重为 MIT；其项目同时提醒训练数据来自多种版权/CC 条件，商业产品仍应自行评估训练数据相关风险。

设备自动选择顺序：

```text
Apple Silicon MPS
→ CUDA
→ CPU
```

可覆盖：

```bash
export MIRRORORDER_BEAT_THIS_DEVICE=cpu
export MIRRORORDER_BEAT_THIS_CHECKPOINT=/path/to/local.ckpt
```

如果 checkpoint 不指定本地文件，Beat This 自身可能在首次运行时下载官方 checkpoint。

## V0.2 moment grounding

每个 cue 对每个合法音乐资产执行：

```text
scene MusicBrief
        ↓
track sections
        ↓
candidate starts
  downbeat > beat > section start
        ↓
target cue duration
        ↓
end snap
  downbeat > beat > section boundary
        ↓
window energy fit
        ↓
score
```

当前候选评分：

```text
semantic   0.34
length     0.14
dialogue   0.18
energy     0.18
boundary   0.16
```

`music_plan.json` 对每个候选新增：

```text
boundary_source
beat_aligned
alignment_error
scores.boundary
```

其中 `boundary_source` 例如：

```text
downbeat->downbeat
beat->beat
energy->energy
metadata->beat
```

这使 UI 后续可以解释“为什么从这里起音乐”。

## 全集连续性

逐场局部 Top-K 之后仍运行轻量动态规划。TransitionScore 奖励：

- 同一 track continuation；
- 当前片段紧接上一片段；
- 相似 tags / moods / styles；
- 相近 BPM。

避免逐场独立选出完全不同风格，形成“歌单感”。

## 命令

普通安装：

```bash
python3 -m pip install -e .
```

带 Beat This：

```bash
python3 -m pip install -e '.[auto-score-beats]'
```

分析音乐库：

```bash
mirrororder-auto-score index "/Volumes/Music/Approved" --analysis auto
```

只跑轻量分析：

```bash
mirrororder-auto-score index "/Volumes/Music/Approved" --analysis basic
```

强制重建设备本地分析缓存：

```bash
mirrororder-auto-score index "/Volumes/Music/Approved" --analysis auto --force-analysis
```

生成某项目第 1 集配乐计划：

```bash
mirrororder-auto-score plan workspace.toml beef "/Volumes/Music/Approved" \
  --episode 1 \
  --timeline-seconds 92 \
  --top-k 5 \
  --analysis auto
```

结果：

```text
projects/<project>/output/music/library_index.json
projects/<project>/output/music/music_plan.json
```

`--timeline-seconds` 目前仍只用于按剧本文本权重估算 cue 时间范围；当镜序原生 Production 时间线/粗剪 edit model 提供真实 boundaries 后，应替换这个估算，不应把估算伪装成剪辑事实。

## 仍未做

V0.2 没有声称完成以下内容：

- CLaMP 3 / CLAP semantic embedding；
- 自监督音乐结构模型；
- 人声 stem / dialogue-frequency occupancy 精细分析；
- Stable Audio 3 / ACE-Step 生成；
- 自动改写用户 FCPXML。

## 下一阶段

### V0.3

- CLaMP 3 / CLAP embedding 检索；
- 中文 MusicBrief embedding；
- 缓存音频窗口 embedding；
- semantic + beat + energy 三路融合的真正大曲库 moment retrieval。

### V0.4

- Stable Audio 3 / ACE-Step 作为 `GeneratedMusicProvider`；
- 仅当版权库最高分低于阈值时生成候选；
- 生成结果仍回到相同 scorer、授权 provenance 和全局 optimizer。
