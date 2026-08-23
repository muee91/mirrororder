#!/usr/bin/env python3
"""Generate a JianyingPro (CapCut) importable FCPXML 1.8 from audio-synced positions.

剪映的 FCPXML 解析器（libVECreator.dylib 反汇编实证）只支持 `asset-clip` 作为
时间线片段：`FCPXMLEnumTransfer::transferStoryItemTypeFromString` 只把
asset-clip/video/audio/spine 映射到 StoryItemType，**不认 mc-clip / clip / gap /
title / ref-clip / sync-clip**。因此剪映版必须：
  - spine 里直接放 asset-clip（每条带 lane=机位序号、offset=绝对时间轴位置）
  - 不用 resources/media/multicam/mc-clip（剪映不认，会导致时间线为空）
  - 不用 gap（剪映不认；间隙靠 asset-clip 的 offset 直接定位）
  - 版本固定 1.8（剪映硬门槛 ≥1.8）

输出（可 manual.out_name 覆盖）：
  {OUT_DIR}/{PROJ_NAME}_音频同步多机位_capcut.fcpxml

局限：单项目单格式；剪映导入后是多轨普通片段（无角度切换），要角度切换需
在剪映内"新建多机位片段"重建。
"""
import os, sys
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import get_config

cfg = get_config()
WORK = cfg.WORK or "/tmp/syncwork"
BASE = cfg.BASE or "/"
FRAME_DEN = cfg.frame_den          # 时间值分母（整数 fps=50000，NTSC=24000）
FRAME_TICKS = cfg.frame_ticks      # 每帧 tick 数（整数 fps=1000，NTSC=1001）
FPS = cfg.fps
W, H = cfg.width, cfg.height
CAM_LIST = cfg.cam_list
DAY_DIRS = cfg.day_dirs        # [(day_key, dirname), ...] 按时间顺序
AUDIO_RATE = cfg.audio_rate
AUDIO_CH = cfg.audio_ch
CAMERA_NAME = cfg.manual.get("camera_name") or ""
PROJ_NAME = (cfg.manual.get("project_name")
             or f"{len(DAY_DIRS)}天合并")
OUT = os.path.join(cfg.OUT_DIR or ".",
                   cfg.manual.get("out_name")
                   or f"{PROJ_NAME}_音频同步多机位_final.fcpxml")
# 剪映版固定后缀，避免与 FCP 版同名覆盖
OUT = OUT.replace("_final.fcpxml", "_capcut.fcpxml")

NDAYS = len(DAY_DIRS)
DISPLAY_FPS = f"{FPS:g}"


def sec_to_ticks(s):
    # 与 build_fcpxml.py 一致：整帧吸附（cfg.sec_to_ticks 保证）
    return cfg.sec_to_ticks(s)


def url_abs(path):
    return cfg.url_abs(BASE, path)


def asset_block(aid, name, src, dur_ticks, fmt):
    meta = ""
    if CAMERA_NAME:
        meta = (f'\n      <metadata>\n'
                f'        <md key="com.apple.proapps.mio.cameraName" value="{CAMERA_NAME}" />\n'
                f'      </metadata>')
    return (
        f'    <asset id="{aid}" name="{name}" src="{src}" format="{fmt}" '
        f'duration="{dur_ticks}/{FRAME_DEN}s" start="0/{FRAME_DEN}s" hasVideo="1" hasAudio="1" '
        f'audioSources="1" audioChannels="{AUDIO_CH}" audioRate="{AUDIO_RATE}">' + meta +
        f'\n    </asset>'
    )


def spine_asset_clip(name, ref, lane, offset_ticks, dur_ticks):
    """剪映版 asset-clip：lane=机位轨道号，offset=绝对时间轴位置（保留间隙）。"""
    return (
        f'          <asset-clip name="{name}" ref="{ref}" lane="{lane}" '
        f'offset="{offset_ticks}/{FRAME_DEN}s" duration="{dur_ticks}/{FRAME_DEN}s" '
        f'start="0/{FRAME_DEN}s" tcFormat="NDF" />'
    )


def load_day(day):
    return pd.read_csv(f"{WORK}/positions_{day}_compressed.tsv", sep="\t")


def main():
    days = [load_day(day) for day, _ in DAY_DIRS]
    # 每天的跨度（帧对齐），用于"后一天平移 = 前一天总长"
    spans_ticks = [sec_to_ticks((d.pos + d.dur).max() - d.pos.min()) for d in days]
    total_ticks = sum(spans_ticks)
    fmt = "format_0"
    dims = f"{W}x{H} {DISPLAY_FPS}p"

    # ---------- resources ----------
    res = []
    res.append(f'    <format id="format_0" name="{cfg.format_name}" frameDuration="{FRAME_TICKS}/{FRAME_DEN}s" width="{W}" height="{H}" colorSpace="1-1-1 (Rec. 709)" />')

    asset_parts = []
    # 每条时间线：按 (offset, lane) 排序的 asset-clip
    spine_clips = []
    shift_s = 0.0
    for di, ((day, dname), df) in enumerate(zip(DAY_DIRS, days)):
        df = df.sort_values(["cam", "pos"]).reset_index(drop=True)
        z = df.pos.min()
        aid = [f"day_{day}_asset_{i}" for i in range(len(df))]
        for k, r in df.iterrows():
            name = os.path.splitext(r["file"])[0]
            src = url_abs(os.path.join(r["dir"], r["file"]))
            asset_parts.append(asset_block(aid[k], name, src, sec_to_ticks(r["dur"]), fmt))
        # 机位 -> lane 号（CAM_LIST 顺序：A=1, B=2, C=3...）
        lane = {c: i + 1 for i, c in enumerate(CAM_LIST)}
        for k, r in df.iterrows():
            name = os.path.splitext(r["file"])[0]
            offset_t = sec_to_ticks(r["pos"] - z + shift_s)
            dur_t = sec_to_ticks(r["dur"])
            spine_clips.append((offset_t, lane[r["cam"]], name, aid[k], dur_t))
        if di < NDAYS - 1:
            shift_s += spans_ticks[di] / FRAME_DEN

    res.extend(asset_parts)

    # spine：按 offset 排序（时间顺序），每条 asset-clip 带 lane
    spine_clips.sort(key=lambda x: (x[0], x[1]))
    spine_block = "\n".join(
        spine_asset_clip(name, aid, ln, off, dur)
        for off, ln, name, aid, dur in spine_clips)

    # 一个 project，spine 直接放 asset-clip（剪映唯一认的片段类型）
    proj_name = f"{PROJ_NAME}｜{NDAYS}天合并｜音频同步多机位粗剪｜{dims}"
    audio_rate_seq = f"{AUDIO_RATE // 1000}k" if AUDIO_RATE % 1000 == 0 else str(AUDIO_RATE)
    project_block = (
        f'      <project name="{proj_name}">\n'
        f'        <sequence duration="{total_ticks}/{FRAME_DEN}s" format="{fmt}" tcStart="0/{FRAME_DEN}s" tcFormat="NDF" audioLayout="stereo" audioRate="{audio_rate_seq}">\n'
        f'          <spine>\n'
        + spine_block +
        f'\n          </spine>\n'
        f'        </sequence>\n'
        f'      </project>'
    )

    # 事件浏览器里的 asset-clip（带 天/机位 关键词，便于筛选）
    event_clips = []
    for di, ((day, dname), df) in enumerate(zip(DAY_DIRS, days)):
        df = df.sort_values(["cam", "pos"]).reset_index(drop=True)
        aid = [f"day_{day}_asset_{i}" for i in range(len(df))]
        for k, r in df.iterrows():
            name = os.path.splitext(r["file"])[0]
            d = sec_to_ticks(r["dur"])
            event_clips.append(
                f'      <asset-clip name="{name}" ref="{aid[k]}" duration="{d}/{FRAME_DEN}s" start="0/{FRAME_DEN}s" tcFormat="NDF">\n'
                f'        <keyword start="0/{FRAME_DEN}s" duration="{d}/{FRAME_DEN}s" value="{dname}" />\n'
                f'        <keyword start="0/{FRAME_DEN}s" duration="{d}/{FRAME_DEN}s" value="CAM_{r["cam"]}" />\n'
                f'      </asset-clip>'
            )

    # keyword collections：天目录名 + 机位名（去重保序）
    collections = []
    for _, dname in DAY_DIRS:
        if dname not in collections:
            collections.append(dname)
    for c in CAM_LIST:
        collections.append(f"CAM_{c}")
    kw_blocks = "\n".join(
        f'      <keyword-collection name="{name}" />' for name in collections)

    xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<fcpxml version="1.8">\n'
        '  <resources>\n'
        + "\n".join(res) + "\n"
        '  </resources>\n'
        '  <library>\n'
        f'    <event name="{PROJ_NAME}｜{NDAYS}天合并｜音频同步多机位">\n'
        + kw_blocks + "\n"
        + project_block + "\n"
        + "\n".join(event_clips) + "\n"
        '    </event>\n'
        '  </library>\n'
        '</fcpxml>\n'
    )

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(xml)
    print(f"written: {OUT}  ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
