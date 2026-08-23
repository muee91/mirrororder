#!/usr/bin/env python3
"""Generate FCPXML 1.8 multicam timeline from audio-synced positions (generic).

多日素材按时间顺序合并进一个多机位片段（不是每天一个）。所有格式/机位/
天数信息来自 project_config（可用 config.json 的 manual 覆盖），因此同一脚本
适用于任意帧率/分辨率/机位数/目录命名，无需改代码。

约定（与 sync.py / make_index.py 一致）：
  {WORK}/positions_{day}_compressed.tsv   每行一个片段（含 cam/pos/dur/file/dir）
输出（可 manual.out_name 覆盖）：
  {OUT_DIR}/{PROJ_NAME}_音频同步多机位_final.fcpxml

局限：单项目单格式（从第一个视频探测）；混格式素材暂不支持。
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

NDAYS = len(DAY_DIRS)
DISPLAY_FPS = f"{FPS:g}"


def sec_to_ticks(s):
    # FCP 要求每个剪辑点都落在帧边界上：offset/duration/start
    # 必须是 FRAME_TICKS 的整数倍（cfg.sec_to_ticks 保证）。
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


def clip_block(name, ref, offset_ticks, dur_ticks):
    auds = "".join(
        f'\n              <audio offset="0/{FRAME_DEN}s" duration="{dur_ticks}/{FRAME_DEN}s" '
        f'start="0/{FRAME_DEN}s" ref="{ref}" srcCh="{ch}" lane="-{ch}" />'
        for ch in range(1, AUDIO_CH + 1))
    src_ch = ", ".join(str(i) for i in range(1, AUDIO_CH + 1))
    return (
        f'          <clip name="{name}" offset="{offset_ticks}/{FRAME_DEN}s" duration="{dur_ticks}/{FRAME_DEN}s" start="0/{FRAME_DEN}s" tcFormat="NDF">\n'
        f'            <video offset="0/{FRAME_DEN}s" duration="{dur_ticks}/{FRAME_DEN}s" start="0/{FRAME_DEN}s" ref="{ref}">' + auds +
        f'\n            </video>\n'
        f'            <audio-channel-source role="dialogue.Camera" active="1" srcCh="{src_ch}" />\n'
        f'          </clip>'
    )


def gap_block(offset_ticks, dur_ticks):
    return f'          <gap name="Pause" offset="{offset_ticks}/{FRAME_DEN}s" duration="{dur_ticks}/{FRAME_DEN}s" start="0/{FRAME_DEN}s" />'


def angle_block(cam, clips, zero_s):
    """clips: list of (pos_s, dur_s, name, asset_id) sorted by pos, in the
    combined timeline's own coordinate (zero_s = combined origin).
    Timeline origin = zero_s; offsets are relative."""
    parts = []
    cur = 0  # timeline position (relative) of previous clip end / gap end
    for pos_s, dur_s, name, aid in clips:
        start_t = sec_to_ticks(pos_s - zero_s)
        end_t = sec_to_ticks(pos_s + dur_s - zero_s)
        if start_t > cur:
            parts.append(gap_block(cur, start_t - cur))
        # guard: rounding may make start_t 1 tick before prev end; clamp
        if start_t < cur:
            start_t = cur
        if end_t <= start_t:
            end_t = start_t + FRAME_TICKS
        parts.append(clip_block(name, aid, start_t, end_t - start_t))
        cur = max(cur, end_t)
    return f'        <mc-angle name="{cam}" angleID="angle_{cam}">\n' + "\n".join(parts) + "\n        </mc-angle>"


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
    event_clips = []
    cams_abs = {c: [] for c in CAM_LIST}   # combined-timeline clips per camera
    shift_s = 0.0
    for di, ((day, dname), df) in enumerate(zip(DAY_DIRS, days)):
        df = df.sort_values(["cam", "pos"]).reset_index(drop=True)
        z = df.pos.min()
        aid = [f"day_{day}_asset_{i}" for i in range(len(df))]
        for k, r in df.iterrows():
            name = os.path.splitext(r["file"])[0]
            src = url_abs(os.path.join(r["dir"], r["file"]))
            asset_parts.append(asset_block(aid[k], name, src, sec_to_ticks(r["dur"]), fmt))
        for k, r in df.iterrows():
            name = os.path.splitext(r["file"])[0]
            cams_abs[r["cam"]].append((r["pos"] - z + shift_s, r["dur"], name, aid[k]))
            d = sec_to_ticks(r["dur"])
            event_clips.append(
                f'      <asset-clip name="{name}" ref="{aid[k]}" duration="{d}/{FRAME_DEN}s" start="0/{FRAME_DEN}s" tcFormat="NDF">\n'
                f'        <keyword start="0/{FRAME_DEN}s" duration="{d}/{FRAME_DEN}s" value="{dname}" />\n'
                f'        <keyword start="0/{FRAME_DEN}s" duration="{d}/{FRAME_DEN}s" value="CAM_{r["cam"]}" />\n'
                f'      </asset-clip>'
            )
        if di < NDAYS - 1:
            shift_s += spans_ticks[di] / FRAME_DEN
    res.extend(asset_parts)

    # one multicam: each angle = all days' clips chronologically
    angles = [angle_block(c, sorted(cams_abs[c]), 0.0) for c in CAM_LIST]
    media_name = f"{PROJ_NAME}｜{NDAYS}天合并｜音频同步多机位｜{dims}"
    media_block = (
        f'    <media id="days_media" name="{media_name}">\n'
        f'      <multicam format="{fmt}" tcStart="0/{FRAME_DEN}s" tcFormat="NDF">\n'
        + "\n".join(angles) +
        f'\n      </multicam>\n    </media>'
    )

    # one project referencing the single multicam
    proj_name = f"{PROJ_NAME}｜{NDAYS}天合并｜音频同步多机位粗剪｜{dims}"
    audio_rate_seq = f"{AUDIO_RATE // 1000}k" if AUDIO_RATE % 1000 == 0 else str(AUDIO_RATE)
    project_block = (
        f'      <project name="{proj_name}">\n'
        f'        <sequence duration="{total_ticks}/{FRAME_DEN}s" format="{fmt}" tcStart="0/{FRAME_DEN}s" tcFormat="NDF" audioLayout="stereo" audioRate="{audio_rate_seq}">\n'
        f'          <spine>\n'
        f'            <mc-clip name="{proj_name}" offset="0/{FRAME_DEN}s" duration="{total_ticks}/{FRAME_DEN}s" start="0/{FRAME_DEN}s" ref="days_media">\n'
        f'              <mc-source angleID="angle_{CAM_LIST[0]}" srcEnable="all" />\n'
        f'            </mc-clip>\n'
        f'          </spine>\n'
        f'        </sequence>\n'
        f'      </project>'
    )

    # event-level mc-clip so the multicam appears in the event browser (FCP-native pattern)
    event_mc = (
        f'      <mc-clip name="{proj_name}" duration="{total_ticks}/{FRAME_DEN}s" ref="days_media">\n'
        f'        <mc-source angleID="angle_{CAM_LIST[0]}" srcEnable="video" />\n'
        f'      </mc-clip>'
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
        + media_block + "\n"
        '  </resources>\n'
        '  <library>\n'
        f'    <event name="{PROJ_NAME}｜{NDAYS}天合并｜音频同步多机位">\n'
        + kw_blocks + "\n"
        + project_block + "\n"
        + event_mc + "\n"
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
