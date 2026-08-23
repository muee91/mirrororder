# 参考仓库研究笔记（踩坑启发）

2026-08 实测研究三个参考仓库后整理。每个仓库的结论都对应到本 skill
实际遇到过的问题，不是泛泛介绍。

仓库位置：`参考仓库/AudioAlign`、`参考仓库/syncdrop`、`参考仓库/Zelqivo-Video-Program`。

---

## syncdrop —— 与我们最接近的算法（最高参考价值）

源文件：`src/syncdrop/correlate.py`、`src/syncdrop/pipeline.py`
（自称 Ported from the Yaleo sync_work/correlate.py）。

### 包络互相关（本 skill 最值得借鉴的增强）

```python
arr = np.diff(arr, prepend=arr[0])   # 预加重：突变更突出
env = np.abs(arr)                    # 取绝对值
win = max(1, target_sr // 20)        # 50ms 平滑窗
env = np.convolve(env, kernel, mode="same")
env = (env - env.mean()) / env.std() # 零均值、单位方差
corr = correlate(env_clip, env_ref, mode="full", method="fft")
```

- 预加重 + 绝对值 + 50ms 平滑 → **打击类瞬态主导互相关**，混合来源
  （不同相机、不同话筒距离、增益差异）下比直接对原始波形相关更鲁棒。
- 本 skill 的 `sync.py` 当前对原始 8kHz 波形做互相关，在本项目素材上
  置信度很高（强相关），但遇到低置信度配对（conf < 10）时，优先尝试
  包络互相关再下结论，而不是直接判定失败。
- 降采样到 4kHz（syncdrop）或 8kHz（本 skill）都可行；整除用 block-mean，
  否则 `resample_poly`。

### 与我们的约定完全一致（验证过，可放心）

- `offset = -lag / sr`，注释原话：`where clip[0] sits on ref's timeline.
  Negative = clip started rolling before ref did.` —— 与本 skill
  `corr_offset` 修复后的语义一致（pos_a − pos_b）。符号一致性已在
  pitfalls.md 里列为强制前置测试。
- `confidence = peak / median(|corr|)`：>10 可靠、5–10 勉强、<5 噪声。
  本 skill 同构（pre-clean 用 ≥30、配对门槛 ≥5），只是本项目信号更强。

### 参考选择：最长片段 vs 我们的刚体模型

- syncdrop 选**最长片段**作唯一参考，所有 clip 相对它对齐，然后
  `shift = -min_offset` 归一化到 t=0；每个 clip 放独立 track，不做重叠解析。
- 局限：要求"参考片段"覆盖整个时间线。本项目 15h 素材拆成 1502 个片段、
  无任何单片段覆盖全程，所以我们必须用 **TC 先验 + 三相机刚体模型 +
  联合加权最小二乘**（见 pipeline.md 步骤 6–8）。单参考法在这种情况下
  会直接失效——这正是我们算法更复杂的原因，不是过度设计。
- 它把每个 clip 放**独立 track**：只在单机位多片段、无跨机位时间轴概念的
  场景下成立；我们的多机位场景必须用共享时间轴 + 真实 gap（见
  pitfalls.md 的 gap 决策）。

### 其他小点

- 帧率从参考片段 ffprobe 自动检测（`Fraction(*rate)`），同我们的做法。
- 输出 AAF 给 Premiere；我们输出 FCPXML + xmeml，覆盖 FCP 和 Premiere
  两个生态，更完整。

---

## AudioAlign —— 窗口化互相关 + 音频指纹（备选方案来源）

源文件：`AudioAlign/AudioAlign/MatchingWindow.xaml.cs`、`Models/*.cs`
（算法本体在 Aurio NuGet 库，仓库只暴露调用方式）。

### 窗口化互相关（drift 诊断手段）

- 默认参数：`CorrelationWindowSize = 5s`，`CorrelationIntervalSize = 5min`。
  沿时间轴每隔一段窗口做一次互相关，得到一系列 offset，再**取中位数**
  聚合为最终偏移（`(offsets[middle-1]+offsets[middle]).Ticks/2`）。
- 价值：窗口化 offset 序列能暴露**时钟漂移**（offset 随时间缓慢变化）。
- 对我们的意义：刚体模型假设相机间偏移恒定（斜率 ≈ 0）。如果鲁棒拟合后
  某机位残差呈系统性倾斜，用窗口化互相关重测该机位在一天内多个时段的对齐
  点，即可确认是漂移还是个别坏点。本项目实测斜率 ≈ 0（相机内 TC 斜率
  1.000、相机间偏移恒定），无需此步，但它是疑难场景的标准诊断工具。

### 音频指纹（波形互相关失败时的备选）

- 仓库集成 Chromaprint、Echoprint、Wang、HaitsmaKalker 四种指纹算法。
- 何时用：素材经过转码/混音/不同话筒间距导致**波形层面**相似度低，但
  内容相同——指纹匹配跨格式仍能命中。波形互相关置信度不足（conf < 5）
  且疑似内容一致时，指纹匹配是合理后备；不要一失败就放弃。

### 可视化调试

- 仓库有 AlignmentGraphWindow / CrossCorrelationResult 窗口展示互相关曲线。
  遇到难缠配对时，把互相关曲线存成图再判断峰值是真实对齐还是噪声尖峰，
  比只看数字可靠。

---

## Zelqivo-Video-Program —— 工程化习惯（简单但值得抄）

源文件：`src/multicam_editor/logic/audio_sync.py`、`logic/fcpxml_export.py`。

### 首 30 秒截断加速（大素材粗对齐）

```python
sample_window_sec = 30.0
ref_seg = ref[:int(sr * sample_window_sec)]
ext_seg = ext[:int(sr * sample_window_sec)]
```

- 只取前 30s 做全相关，速度快。局限：要求两段素材开头 30s 内就存在
  重叠内容，且只有一个对齐峰（否则前 30s 无内容时峰值随机）。
- 本 skill 不用它（有 TC 先验窗口 + 全量相关），但超大素材（单片段
  数小时）可先截断粗对齐定位，再全量精修，省时。

### 质量门 + 状态机（不静默失败）

- `correlation_score = peak / len(ref_seg)` 归一化到 0–1，
  `MIN_CORRELATION_SCORE = 0.05` 以下标 `low_correlation` 并 fallback
  offset=0，但**保留 status/message 字段**（no_audio / low_correlation /
  failed / ok），可审计。
- 对齐结果永远带状态和原因，绝不在低置信度时静默产出数字。本 skill 的
  positions TSV 里记录 conf/status 与之同理；交付校验（validation.md
  第 3 条）要求所有配对 conf ≥ 门槛且链条闭合，杜绝静默坏数据。

### 无音频降级

- 相机无音轨时降级为 offset=0 + `no_audio` 标记，不中断流程。本 skill
  场景（所有相机都有音轨）未触发，但同样保留该路径：提取失败或无声轨的
  相机在 positions 表里标 status，而不是从交付中消失。

### 它的 FCPXML 与我们的差异（反向佐证）

- Zelqivo 的 fcpxml_export.py 用 `asset-clip` 顺序排列成单轨时间线
  （`current_offset += clip_duration_ms`），没有 multicam/mc-clip 结构，
  **不做同步语义**——它是自动剪辑工具，不是多机位交付工具。
- 反面确认：要做 FCP 原生多机位（角度切换），必须用我们验证过的
  `media > multicam > mc-angle` + `project > sequence > spine > mc-clip`
  结构（fcpxml-structure.md），asset-clip 顺序排列只能表示"依次播放"。

---

## 结论：本次踩坑点与仓库的相互印证

| 本 skill 踩过的坑 | 仓库佐证 |
|---|---|
| corr_offset 符号（pos_a − pos_b） | syncdrop 同语义，注释明确 "where clip[0] sits on ref's timeline" |
| 长时间线单参考失效 → 刚体模型 | syncdrop 最长片段参考法在无覆盖片段时直接不可用 |
| 低置信度处理 | syncdrop 5/10 阈值 + Zelqivo score<0.05 降级且保留状态 |
| 时钟漂移诊断 | AudioAlign 窗口化互相关 + 中位数聚合 |
| FCP 多机位结构 | Zelqivo 无 multicam 结构 → 反向证明必须用 mc-clip |
