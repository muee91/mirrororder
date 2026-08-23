#!/usr/bin/env python3
"""Generate a JianyingPro (CapCut) importable FCPXML 1.8 from audio-synced positions.

剪映版仍是标准 FCPXML 1.8，只使用剪映当前能识别的 asset-clip 结构。
素材 src 使用标准相对 URL，不写本机绝对路径。
"""
import os, sys
from urllib.parse import quote
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import get_config

cfg = get_config()
WORK = cfg.WORK or "/tmp/syncwork"
BASE = cfg.BASE or "/"
EXPORT_BASE = os.path.realpath(cfg.manual.get("export_base") or BASE)
FRAME_DEN = cfg.frame_den
FRAME_TICKS = cfg.frame_ticks
FPS = cfg.fps
W, H = cfg.width, cfg.height
CAM_LIST = cfg.cam_list
DAY_DIRS = cfg.day_dirs
AUDIO_RATE = cfg.audio_rate
AUDIO_CH = cfg.audio_ch
CAMERA_NAME = cfg.manual.get("camera_name") or ""
PROJ_NAME = (cfg.manual.get("project_name") or f"{len(DAY_DIRS)}天合并")
OUT = os.path.join(cfg.OUT_DIR or ".", cfg.manual.get("out_name") or f"{PROJ_NAME}_音频同步多机位_final.fcpxml")
OUT = OUT.replace("_final.fcpxml", "_capcut.fcpxml")
NDAYS = len(DAY_DIRS)
DISPLAY_FPS = f"{FPS:g}"


def sec_to_ticks(s):
    return cfg.sec_to_ticks(s)


def url_export(path):
    physical = os.path.realpath(os.path.join(BASE, path))
    rel = os.path.relpath(physical, EXPORT_BASE)
    if rel == os.pardir or rel.startswith(os.pardir + os.sep):
        raise RuntimeError(f"素材不在 export_base 内，无法生成通用相对引用: {physical}")
    return quote("./" + rel.replace(os.sep, "/"), safe="/:@-._~")


def asset_block(aid, name, src, dur_ticks, fmt):
    meta = ""
    if CAMERA_NAME:
        meta = (f'\n      <metadata>\n'
                f'        <md key="com.apple.proapps.mio.cameraName" value="{CAMERA_NAME}" />\n'
                f'      </metadata>')
    return (f'    <asset id="{aid}" name="{name}" src="{src}" format="{fmt}" '
            f'duration="{dur_ticks}/{FRAME_DEN}s" start="0/{FRAME_DEN}s" hasVideo="1" hasAudio="1" '
            f'audioSources="1" audioChannels="{AUDIO_CH}" audioRate="{AUDIO_RATE}">' + meta + f'\n    </asset>')


def spine_asset_clip(name, ref, lane, offset_ticks, dur_ticks):
    return (f'          <asset-clip name="{name}" ref="{ref}" lane="{lane}" '
            f'offset="{offset_ticks}/{FRAME_DEN}s" duration="{dur_ticks}/{FRAME_DEN}s" '
            f'start="0/{FRAME_DEN}s" tcFormat="NDF" />')


def load_day(day):
    return pd.read_csv(f"{WORK}/positions_{day}_compressed.tsv", sep="\t")


def main():
    days = [load_day(day) for day, _ in DAY_DIRS]
    spans_ticks = [sec_to_ticks((d.pos + d.dur).max() - d.pos.min()) for d in days]
    total_ticks = sum(spans_ticks)
    fmt = "format_0"
    dims = f"{W}x{H} {DISPLAY_FPS}p"
    res = [f'    <format id="format_0" name="{cfg.format_name}" frameDuration="{FRAME_TICKS}/{FRAME_DEN}s" width="{W}" height="{H}" colorSpace="1-1-1 (Rec. 709)" />']
    asset_parts = []
    spine_clips = []
    shift_s = 0.0
    for di, ((day, dname), df) in enumerate(zip(DAY_DIRS, days)):
        df = df.sort_values(["cam", "pos"]).reset_index(drop=True)
        z = df.pos.min()
        aid = [f"day_{day}_asset_{i}" for i in range(len(df))]
        for k, r in df.iterrows():
            name = os.path.splitext(r["file"])[0]
            src = url_export(os.path.join(r["dir"], r["file"]))
            asset_parts.append(asset_block(aid[k], name, src, sec_to_ticks(r["dur"]), fmt))
        lane = {c: i + 1 for i, c in enumerate(CAM_LIST)}
        for k, r in df.iterrows():
            name = os.path.splitext(r["file"])[0]
            offset_t = sec_to_ticks(r["pos"] - z + shift_s)
            dur_t = sec_to_ticks(r["dur"])
            spine_clips.append((offset_t, lane[r["cam"]], name, aid[k], dur_t))
        if di < NDAYS - 1:
            shift_s += spans_ticks[di] / FRAME_DEN
    res.extend(asset_parts)
    spine_clips.sort(key=lambda x: (x[0], x[1]))
    spine_block = "\n".join(spine_asset_clip(name, aid, ln, off, dur) for off, ln, name, aid, dur in spine_clips)
    proj_name = f"{PROJ_NAME}｜{NDAYS}天合并｜音频同步多机位粗剪｜{dims}"
    audio_rate_seq = f"{AUDIO_RATE // 1000}k" if AUDIO_RATE % 1000 == 0 else str(AUDIO_RATE)
    project_block = (f'      <project name="{proj_name}">\n'
                     f'        <sequence duration="{total_ticks}/{FRAME_DEN}s" format="{fmt}" tcStart="0/{FRAME_DEN}s" tcFormat="NDF" audioLayout="stereo" audioRate="{audio_rate_seq}">\n'
                     f'          <spine>\n' + spine_block + f'\n          </spine>\n'
                     f'        </sequence>\n'
                     f'      </project>')
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
                f'      </asset-clip>')
    collections = []
    for _, dname in DAY_DIRS:
        if dname not in collections:
            collections.append(dname)
    for c in CAM_LIST:
        collections.append(f"CAM_{c}")
    kw_blocks = "\n".join(f'      <keyword-collection name="{name}" />' for name in collections)
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<fcpxml version="1.8">\n'
           '  <resources>\n' + "\n".join(res) + "\n"
           '  </resources>\n'
           '  <library>\n'
           f'    <event name="{PROJ_NAME}｜{NDAYS}天合并｜音频同步多机位">\n'
           + kw_blocks + "\n" + project_block + "\n" + "\n".join(event_clips) + "\n"
           '    </event>\n'
           '  </library>\n'
           '</fcpxml>\n')
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(xml)
    print(f"written: {OUT}  ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
