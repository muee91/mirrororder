# Auto Score V0.3

V0.3 在 V0.2 的授权 gate、能量/section、Beat This 节拍 grounding 和全局连续性优化上增加可选的音频-文本 embedding 检索。

## 设计

```text
MusicBrief
  -> V0.2 broad candidate pool (max 40)
  -> CLAP text embedding
  -> each candidate track: 20s audio windows / 8s hop
  -> cosine similarity
  -> hybrid rerank (70% V0.2 + 30% embedding)
  -> beat/downbeat boundaries remain authoritative for edit cut points
  -> global continuity DP
```

语义检索负责回答“哪首歌的哪一段在剧情语义上更像”，Beat This/section grounding 负责回答“音乐学上从哪里切更自然”。V0.3 不让 embedding 绕过授权 gate，也不直接写 review/editorial/FCPXML。

## Backend

`--semantic off`：关闭 embedding，完全使用 V0.2。

`--semantic auto`：默认。若 CLAP optional dependencies / model 不可用则自动降级为 off。

`--semantic clap`：强制 CLAP；初始化失败则显式报错。

首个 backend 使用 Hugging Face Transformers 的 `laion/clap-htsat-fused`。查询文本包含英文结构化 purpose/tags/energy/dialogue 描述，并保留原始中文场景上下文。

安装：

```bash
python3 -m pip install -e '.[auto-score-semantic]'
```

完整 Beat This + CLAP：

```bash
python3 -m pip install -e '.[auto-score-full]'
```

运行：

```bash
mirrororder-auto-score plan workspace.toml beef /Volumes/Music/Approved \
  --episode 1 \
  --timeline-seconds 92 \
  --analysis auto \
  --semantic auto
```

强制重建 embedding：

```bash
--force-semantic
```

## 缓存

音频窗口向量是设备本地派生缓存：

```text
~/Library/Application Support/MirrorOrder/music-semantic-v1/
```

workspace 产物只保存 asset_id、相对曲库路径、评分和选段，不保存设备绝对音乐路径，也不保存完整 embedding 向量。

## 当前限制

- V0.3 使用滑窗 rerank，而不是训练一个镜序专属的跨模态模型。
- CLAP 的中文能力不作为硬保证；结构化英文标签用于增强稳定性。
- CLaMP 3 明确支持多语言且代码为 MIT，但其官方快速环境当前以 Python 3.10/独立环境为主，因此不直接塞进镜序 Python 3.11 主环境。后续可做 external provider/sidecar benchmark。
- embedding 不能证明音乐版权；授权仍由 `LicenseRecord` hard gate 单独决定。
