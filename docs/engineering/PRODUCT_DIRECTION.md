# 镜序产品方向：短剧多机位剪辑前决策台

## 产品边界

镜序的交付物是可信的剪辑前决策底稿，不是完整 NLE。主链固定为：

```text
素材入库 → 镜头/Take/多机位候选 → 拍摄事实 → 剧本位置
→ 人工看片决定 → 粗剪组接底稿
```

完整时间线剪辑、复杂团队协作和 FCP 打开不作为当前主线阻塞项。

## 事实与权限

- Provider 只能产生 evidence sidecar、候选和置信度。
- Review placement 是人工剧本映射权威。
- Editorial Decision 是人工剪辑判断权威。
- Timeline Core 只负责已确认组接状态。
- Provider、AI、语义检索和场记不能自动覆盖上述权威。

## 技术替换原则

优先复用成熟基础层：FFmpeg/ffprobe、MediaInfo、PySceneDetect、OpenTimelineIO。
模型通过 provider 接口接入：Mac 优先轻量本地路径，Ubuntu/NVIDIA 提供高质量异步路径。
镜头切分不等于 Take/多机位识别，后者仍需时间码、音频证据和人工确认共同决定。

所有新能力都必须写入稳定的 `mirrororder.evidence.v1` sidecar，记录资产身份、时间范围、模型版本、置信度和来源，保证可重跑、可审计、可替换。
