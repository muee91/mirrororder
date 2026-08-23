#!/usr/bin/env python3
"""Generate Premiere Pro importable FCP7 (xmeml v4) XML from audio-synced positions (generic).

Canonical FCP7 layout: every <clipitem> embeds a FULL inline <file id="..."> block
(pathurl, rate, duration, media characteristics) — this is exactly what Final Cut
Pro 7 exports and what Premiere's "File > Import > Final Cut Pro XML" parser accepts.
One video track + one audio track per camera, all aligned on the synced timeline
(offsets from audio cross-correlation, real gaps preserved). For multi-camera use:
select the imported sequence in the Project panel > right-click > Create Multi-Camera
Source Sequence.

格式/机位/天数信息全部来自 project_config（config.json manual 可覆盖）。
输出（可 manual.out_name 覆盖）：{OUT_DIR}/{PROJ_NAME}_音频同步多机位_Premiere.xml
"""
import os, sys
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import get_config

cfg = get_config()
WORK = cfg.WORK or "/tmp/syncwork"
BASE = cfg.BASE or "/"
FPS = cfg.fps
NTSC = cfg.ntsc
W, H = cfg.width, cfg.height
CAM_LIST = cfg.cam_list
DAY_DIRS = cfg.day_dirs
AUDIO_RATE = cfg.audio_rate
AUDIO_CH = cfg.audio_ch
PROJ_NAME = (cfg.manual.get("project_name")
             or f"{len(DAY_DIRS)}天合并")
OUT = os.path.join(cfg.OUT_DIR or ".",
                   cfg.manual.get("out_name")
                   or f"{PROJ_NAME}_音频同步多机位_Premiere.xml")


def fr(sec):
    return cfg.fr(sec)


def rate_xml():
    # Premiere 的 timebase 用整数帧率；NTSC（23.976/29.97/59.94）必须
    # ntsc="TRUE" 并写分数 timebase（如 30000/1001）。
    if NTSC:
        return (f'<rate><timebase>{cfg.fps_frac.numerator}/{cfg.fps_frac.denominator}'
                f'</timebase><ntsc>TRUE</ntsc></rate>')
    return f'<rate><timebase>{int(FPS)}</timebase><ntsc>FALSE</ntsc></rate>'


def url(path):
    # FCP7 pathurl: file://localhost + URL-encoded absolute path
    return "file://localhost" + cfg.url_abs(BASE, path).replace("file://", "")


def file_block(fid, name, path, dur_fr):
    return (
        f'<file id="{fid}">\n'
        f'  <name>{name}</name>\n'
        f'  <pathurl>{path}</pathurl>\n'
        f'  {rate_xml()}\n'
        f'  <duration>{dur_fr}</duration>\n'
        f'  <media>\n'
        f'    <video>\n'
        f'      <samplecharacteristics>\n'
        f'        <width>{W}</width><height>{H}</height>\n'
        f'        <anamorphic>FALSE</anamorphic>\n'
        f'      </samplecharacteristics>\n'
        f'    </video>\n'
        f'    <audio>\n'
        f'      <samplecharacteristics>\n'
        f'        <depth>16</depth><samplerate>{AUDIO_RATE}</samplerate><channelcount>{AUDIO_CH}</channelcount>\n'
        f'      </samplecharacteristics>\n'
        f'    </audio>\n'
        f'  </media>\n'
        f'</file>'
    )


def clipitem(cid, name, file_xml, start_fr, end_fr, in_fr, out_fr, is_audio=False):
    # start/end = timeline position on the track; in/out = source position (0..file duration)
    return (
        f'<clipitem id="{cid}">\n'
        f'  <name>{name}</name>\n'
        f'  <start>{start_fr}</start>\n'
        f'  <end>{end_fr}</end>\n'
        f'  <in>{in_fr}</in>\n'
        f'  <out>{out_fr}</out>\n'
        f'  {rate_xml()}\n'
        f'  <enabled>TRUE</enabled>\n'
        + "".join(f"  {l}\n" for l in file_xml.splitlines()) +
        f'</clipitem>'
    )


def sequence_block(seq_id, seq_name, daydf_list, day_totals):
    """daydf_list: list of per-day sorted df; day_totals: cumulative start offset per
    day (frames). Returns sequence_xml. File ids are globally unique across the
    whole document (names may collide across days, so suffix on collision)."""
    fid_map = {}
    def fid_for(name):
        n = fid_map.get(name, 0)
        fid_map[name] = n + 1
        return name if n == 0 else f"{name}_{n}"
    vids = {c: [] for c in CAM_LIST}
    auds = {c: [] for c in CAM_LIST}
    for di, df in enumerate(daydf_list):
        z = df.pos.min()
        for c in CAM_LIST:
            sub = df[df.cam == c].sort_values("pos")
            for _, r in sub.iterrows():
                name = os.path.splitext(r["file"])[0]
                fid = fid_for(name)
                fxml = file_block(fid, r["file"],
                                  url(os.path.join(r["dir"], r["file"])), fr(r["dur"]))
                off_fr = day_totals[di]
                start_fr = off_fr + fr(r.pos - z)
                end_fr = off_fr + fr(r.pos + r.dur - z)
                if end_fr <= start_fr:
                    end_fr = start_fr + 1
                cid = f"{seq_id}_v_{c}_{start_fr}_{end_fr}"
                vids[c].append(clipitem(cid, name, fxml, start_fr, end_fr, 0, fr(r["dur"])))
                aid = f"{seq_id}_a_{c}_{start_fr}_{end_fr}"
                auds[c].append(clipitem(aid, name, fxml, start_fr, end_fr, 0, fr(r["dur"]), is_audio=True))
    max_end = max(int(it.split("<end>")[1].split("</end>")[0])
                  for c in CAM_LIST for it in vids[c])
    L = []
    L.append(f'<sequence id="{seq_id}">')
    L.append(f'  <name>{seq_name}</name>')
    L.append(f'  <duration>{max_end}</duration>')
    L.append(f'  {rate_xml()}')
    L.append(f'  <media>')
    L.append(f'    <video>')
    L.append(f'      <format><samplecharacteristics><width>{W}</width><height>{H}</height></samplecharacteristics></format>')
    for c in CAM_LIST:
        L.append(f'      <track>')
        for it in vids[c]:
            L.append("        " + it.replace("\n", "\n        "))
        L.append(f'      </track>')
    L.append(f'    </video>')
    L.append(f'    <audio>')
    for c in CAM_LIST:
        L.append(f'      <track>')
        for it in auds[c]:
            L.append("        " + it.replace("\n", "\n        "))
        L.append(f'      </track>')
    L.append(f'    </audio>')
    L.append(f'  </media>')
    L.append(f'</sequence>')
    return "\n".join(L)


def main():
    days = [pd.read_csv(f"{WORK}/positions_{day}_compressed.tsv", sep="\t")
            for day, _ in DAY_DIRS]
    spans_fr = [fr((d.pos + d.dur).max() - d.pos.min()) for d in days]
    day_totals = []
    acc = 0
    for sp in spans_fr:
        day_totals.append(acc)
        acc += sp
    seq_name = f"{PROJ_NAME}｜{len(DAY_DIRS)}天合并｜音频同步多机位"
    s3 = sequence_block("seq_both", seq_name, days, day_totals)
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE xmeml>\n'
        '<xmeml version="4">\n'
        '<project id="project_sync">\n'
        f'  <name>{PROJ_NAME}｜{len(DAY_DIRS)}机位｜音频同步</name>\n'
        '  <children>\n'
        + s3 + "\n"
        '  </children>\n'
        '</project>\n'
        '</xmeml>\n'
    )
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(xml)
    print(f"written: {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
