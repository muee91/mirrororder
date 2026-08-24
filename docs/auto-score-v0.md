# Auto Score V0

`feat/auto-score` 的第一版目标是先证明“镜序能安全地从合法音乐库自动挑选具体音乐片段”，不把生成模型、重型 embedding 或 FCPXML 改写变成主链硬依赖。

## 边界

Auto Score 是派生创意链，只写：

```text
output/music/library_index.json
output/music/music_plan.json
```

它不得写 `review.json`、`editorial.json`、`auto_decisions.json`，也不修改用户原始 FCPXML。`music_plan.json` 不是 Editorial Decision；编辑可以完全忽略或重建它。

## 音乐库

V0 扫描：

```text
wav mp3 m4a aac flac aif aiff ogg
```

WAV 时长用 Python 标准库读取；其它格式优先调用系统 `ffprobe`。没有时长仍可索引，但片段定位质量会下降。

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

单曲也可以用同名 sidecar，例如：

```text
dark_01.wav
dark_01.wav.music.json
```

sidecar 字段会覆盖根 manifest 中该曲的字段。

## 授权 Gate

正式默认只有同时满足以下条件的音乐才进入候选：

```text
commercial_use = true
sync_right = true
```

未验证、NC 或缺少同步权的音乐仍会出现在 `library_index.json`，但不会被自动选择。

`--allow-unverified` 只用于开发测试，计划文件会明确记录该开关。

## V0 算法

1. 剧本按 `episode + scene_id` 聚合成 cue。
2. 中文剧情关键词生成 `suspense / danger / romance / sad / comic / reveal` 等可解释标签。
3. 对白密度高时限制目标能量，并惩罚高人声概率音乐。
4. 每首曲的 section 与 cue 分别计算 `semantic / duration / dialogue fit / energy fit`。
5. 先做授权 hard gate，再做本地加权排名。
6. 对全集 Top-K 候选运行轻量动态规划，奖励同曲 continuation、相似标签和接近 BPM，避免逐场独立选歌导致“歌单感”。
7. 输出每个 cue 的 Top-K、具体 `source_start/source_end` 与全局选中项。

V0 不声称已完成真实音乐 beat/downbeat grounding；section 元数据是当前主要的 moment boundary。Beat This、CLaMP/CLAP、Stable Audio 3/ACE-Step 都应作为后续 provider/enhancer，而不是改写本合同。

## 命令

安装当前 worktree 后：

```bash
mirrororder-auto-score index "/Volumes/Music/Approved"
```

生成某项目第 1 集配乐计划：

```bash
mirrororder-auto-score plan workspace.toml beef "/Volumes/Music/Approved" \
  --episode 1 \
  --timeline-seconds 92 \
  --top-k 5
```

结果：

```text
projects/<project>/output/music/library_index.json
projects/<project>/output/music/music_plan.json
```

`--timeline-seconds` 在 V0 仅用于按剧本文本权重估算 cue 时间范围；当镜序原生 Production 时间线/粗剪 edit model 完成后，应由真实 timeline boundaries 替换这个估算，不应把估算伪装成剪辑事实。

## 下一阶段

V0.2：
- Beat This：beat/downbeat 吸附；
- librosa/自有轻量特征：能量曲线；
- section boundary 自动分析。

V0.3：
- CLaMP 3 / CLAP embedding 检索；
- 中文 MusicBrief embedding；
- 缓存音频窗口 embedding，做真正 moment grounding。

V0.4：
- Stable Audio 3 / ACE-Step 作为 `GeneratedMusicProvider`；
- 仅当版权库最高分低于阈值时生成候选；
- 生成结果仍必须回到同一评分器和 provenance 合同。
