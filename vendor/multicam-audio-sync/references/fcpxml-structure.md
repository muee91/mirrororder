# FCPXML 1.8 结构参考（DTD 验证通过的实际骨架）

以 `FCPXMLv1_8.dtd`（FCP 应用包 Interchange.framework）为准。**build_fcpxml.py 输出 1.8**（剪映硬门槛 ≥1.8，见 capcut-jianying-adapter.md）。关键内容模型：

```
fcpxml      (import-options?, resources?, (library | event* | event_item*))
library     (event | smart-collection)*                 ← 只能有 event
event       (%event_item;)*                              ← 任意顺序任意数量
event_item  clip | audition | mc-clip | ref-clip | sync-clip | asset-clip | collection_item | project
resources   (asset | effect | format | media)*           ← media 只允许在这里
media       (multicam | sequence)?
multicam    (mc-angle*, metadata?)
mc-clip     (..., mc-source*, ...)   attrs: name, duration(#REQUIRED), start, ref(→media id)
mc-source   EMPTY  attrs: angleID(#REQUIRED), srcEnable(all|audio|video|none)
gap         EMPTY-ish  attrs: name, offset, duration(#REQUIRED), start, enabled
clip        (..., (spine | clip_item)*, ...)  attrs: name, offset, duration, start, tcFormat
asset       attrs: id, name, src, format, duration, start, hasVideo, hasAudio,
                   audioSources, audioChannels, audioRate
```

## 完整骨架

```xml
<?xml version="1.0" encoding="utf-8"?>
<fcpxml version="1.8">
  <resources>
    <format id="format_0" name="FFVideoFormat1080x1920p50"
            frameDuration="1000/50000s" width="1080" height="1920"
            colorSpace="1-1-1 (Rec. 709)" />
    <asset id="day1_asset_0" name="A001C001_260813HH"
           src="file:///path/to/media/day/A1/A001C001_260813HH.MP4"
           format="format_0" duration="1224000/50000s" start="0/50000s"
           hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000">
      <metadata><md key="com.apple.proapps.mio.cameraName" value="Sony ILME-FX3" /></metadata>
    </asset>
    <media id="day1_media" name="示例项目｜第1天｜音频同步多机位｜1080x1920 50p">
      <multicam format="format_0" tcStart="0/50000s" tcFormat="NDF">
        <mc-angle name="A" angleID="angle_A">
          <gap name="Pause" offset="0/50000s" duration="116000/50000s" start="0/50000s" />
          <clip name="A001C001_260813HH" offset="116000/50000s" duration="1224000/50000s"
                start="0/50000s" tcFormat="NDF">
            <video offset="0/50000s" duration="1224000/50000s" start="0/50000s" ref="day1_asset_0">
              <audio offset="0/50000s" duration="1224000/50000s" start="0/50000s"
                     ref="day1_asset_0" srcCh="1" lane="-1" />
              <audio offset="0/50000s" duration="1224000/50000s" start="0/50000s"
                     ref="day1_asset_0" srcCh="2" lane="-2" />
            </video>
            <audio-channel-source role="dialogue.Camera" active="1" srcCh="1, 2" />
          </clip>
        </mc-angle>
        <!-- mc-angle B, C 同构；同一时间轴零点，真实 gap 用 <gap> 表示 -->
      </multicam>
    </media>
  </resources>
  <library>
    <event name="示例项目｜两天音频同步多机位">
      <keyword-collection name="第1天" />
      <project name="示例项目｜第1天｜音频同步多机位粗剪｜1080x1920 50p">
        <sequence duration="2813999000/50000s" format="format_0"
                  tcStart="0/50000s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <mc-clip name="示例项目｜第1天｜..." offset="0/50000s" duration="2813999000/50000s"
                     start="0/50000s" ref="day1_media">
              <mc-source angleID="angle_A" srcEnable="all" />
            </mc-clip>
          </spine>
        </sequence>
      </project>
      <mc-clip name="示例项目｜第1天｜音频同步多机位｜1080x1920 50p"
               duration="2813999000/50000s" ref="day1_media">
        <mc-source angleID="angle_A" srcEnable="video" />
      </mc-clip>
      <asset-clip name="A001C001_260813HH" ref="day1_asset_0"
                  duration="1224000/50000s" start="0/50000s" tcFormat="NDF">
        <keyword start="0/50000s" duration="1224000/50000s" value="第1天" />
        <keyword start="0/50000s" duration="1224000/50000s" value="CAM_A" />
      </asset-clip>
    </event>
  </library>
</fcpxml>
```

## 规则速记

- 多机位 = `resources/media/multicam` + 每个机位一个 `mc-angle`；三角度共用同一时间轴（offset 相对同一零点）。
- **多日素材默认合并成一条时间轴**：不做每日单独合成。所有天的 clip 按时间顺序放进同一个 `mc-angle`，第 N 天整体平移（第 N-1 天总时长）后紧接其后（用户实测确认：`day2 pos + shift`，shift = sec_to_ticks(day1_total)/FRAME）。这样只有一个 media、一个 project、一个 event 级 mc-clip；asset-clip 仍按天打关键词（第1天/第2天）便于筛选。若用户明确要求按天拆，再退回每 media/每 project 的形态（本例旧版：`day1_media`+`day2_media` 两个 media、3 个 project）。
- 事件浏览器里出现多机位片段 = event 级 `mc-clip`（ref 指向 media）；出现在时间线 = project/sequence/spine 里的 `mc-clip`。
- **剪映专用变体（build_capcut_fcpxml.py）**：剪映只认 `asset-clip` 作为时间线片段（反汇编实证 `transferStoryItemTypeFromString`），不认 mc-clip/multicam/gap。剪映版 spine 直接放 asset-clip（lane=机位序号 1/2/3、offset=绝对时间轴位置、间隙靠 offset 定位），不用 media/multicam/mc-clip/gap。FCPXMLv1_8.dtd 的 spine 内容模型 `(%clip_item; | transition)*` 包含 asset-clip，所以这在 DTD 层面同样合法。
- 竖屏格式名：`FFVideoFormat1080x1920p50`（宽高与显示名匹配）。
- URL 编码：路径含中文/空格必须百分号编码（`示例拍摄日` → `8.13%20%E7%89%9B%E8%82%89`）。
- 同格式素材共用一个 format 资源；asset id 全局唯一（多日可 `day1_asset_0` / `day2_asset_0` 保证跨日唯一）。
- 全部时间值整帧倍数（见 pitfalls 4）。
