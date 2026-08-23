# Premiere 可导入 XML（FCP7 / xmeml v4）结构参考

Premiere Pro 用 "文件 → 导入 → Final Cut Pro XML" 导入。这是 Final Cut Pro 7 的导出格式（xmeml v4），不是 FCPX 的 fcpxml。Premiere 对 xmeml 的解析比 FCP 宽容，但仍用标准结构最稳。

## 骨架

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <project id="project_sync">
    <name>示例项目｜两天三机位｜音频同步</name>
    <children>
      <sequence id="seq_day1">
        <name>第1天｜8.13｜音频同步多机位</name>
        <duration>919920</duration>
        <rate><timebase>50</timebase><ntsc>FALSE</ntsc></rate>
        <media>
          <video>
            <format><samplecharacteristics><width>1080</width><height>1920</height></samplecharacteristics></format>
            <track>
              <clipitem id="seq_day1_v_A_116_1340">
                <name>A001C001_260813HH</name>
                <start>116</start><end>1340</end>
                <in>0</in><out>1224</out>
                <rate><timebase>50</timebase><ntsc>FALSE</ntsc></rate>
                <enabled>TRUE</enabled>
                <file id="A001C001_260813HH">
                  <name>A001C001_260813HH.MP4</name>
                  <pathurl>/path/to/media/day/A1/A001C001_260813HH.MP4</pathurl>
                  <rate><timebase>50</timebase><ntsc>FALSE</ntsc></rate>
                  <duration>1224</duration>
                  <media>
                    <video><samplecharacteristics><width>1080</width><height>1920</height><anamorphic>FALSE</anamorphic></samplecharacteristics></video>
                    <audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate><channelcount>2</channelcount></samplecharacteristics></audio>
                  </media>
                </file>
              </clipitem>
              <!-- 同轨更多 clipitem -->
            </track>
            <!-- 第 2、3 条视频轨（B、C 机） -->
          </video>
          <audio>
            <track><!-- 音频轨，clipitem 同构，in/out 同源区间 --></track>
            <track><track>
            <track>
          </audio>
        </media>
      </sequence>
      <!-- seq_day2、seq_both（两天合并：第2天素材整体平移 span813 帧） -->
    </children>
  </project>
</xmeml>
```

## 语义要点

- `start`/`end` = 片段在时间线上的位置（帧）；`in`/`out` = 源素材内区间。整段未裁剪时 in=0、out=文件时长（帧）。
- 所有帧值 = round(秒 × 帧率)，天然整帧，不存在 FCPX 的 tick 帧边界问题。
- `<file>` 块**内联在 clipitem 里**（FCP7 原版风格），不要用文本引用 + 外部文件表。
- `file id` 跨序列全局唯一（三个序列共享素材时，局部计数会导致后写的覆盖先写的）。
- 单日序列 `<duration>` = 该序列所有 clipitem 的 max(end)，不能是 0 或跨天和。
- 合并两天时：第 2 天所有 start/end 平移 +span_day1（帧）。
- 三视频轨 = 多机位源；Premiere 用法：导入后选中序列 → 右键 → 创建多机位源序列，V1/V2/V3 变角度 1/2/3。
