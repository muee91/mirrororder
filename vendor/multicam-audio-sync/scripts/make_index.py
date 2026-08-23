#!/usr/bin/env python3
"""素材盘点：扫描素材根目录，为每个媒体文件提取时长/尺寸/TC/创建时间。

输出三个 TSV（供 sync.py / extract_parallel.py 使用）：
  {WORK}/index.tsv         id \t day \t cam \t dir \t file
  {WORK}/durations.tsv     dir \t file \t dur \t size
  {WORK}/tc.tsv            dir \t file \t tc \t creation
day/cam 是显式列（由 project_config 的目录识别给出），下游无需猜。

用法：
  python3 make_index.py [BASE] [WORK]
  BASE 缺省用 project_config.get_config()（config.json 或环境变量）

兼容格式：mp4/mov/mxf/mts/mp3/wav 等任意 ffprobe 能读的媒体；
目录结构：{BASE}/{天}/{相机子目录}/{文件}，天/相机识别见 project_config。
TC：优先视频流 timecode 标签（SMPTE "HH:MM:SS:FF"）；无 TC 则留空
（sync.py 会对无 TC 素材退化为纯音频互相关锚点）。
"""
import os
import re
import sys
import glob
import subprocess
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import Config, get_config

# 支持的媒体扩展名（覆盖主流相机/手机/录音格式）
EXT = (".mp4", ".mov", ".mxf", ".mts", ".m2ts", ".avi", ".mkv", ".mpg",
       ".mpeg", ".3gp", ".wmv", ".flv", ".webm", ".mp3", ".wav", ".aac",
       ".m4a", ".flac", ".wma", ".ogg", ".bmp", ".jpg", ".jpeg", ".png",
       ".gif", ".tif", ".heic", ".cr3", ".arw", ".dng")


def probe_file(path):
    """Return dict(dur, width, height, tc, creation) or None."""
    out = subprocess.run(
        ["ffprobe", "-v", "error",
         "-show_entries", "format=duration,size:format_tags=creation_time",
         "-show_entries", "stream=codec_type,width,height:stream_tags=timecode",
         "-of", "json", path],
        capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        return None
    try:
        import json
        info = json.loads(out.stdout)
    except ValueError:
        return None
    dur = None
    size = None
    creation = None
    fmt = info.get("format", {})
    if fmt.get("duration"):
        try:
            dur = float(fmt["duration"])
        except ValueError:
            pass
    if fmt.get("size"):
        try:
            size = int(fmt["size"])
        except ValueError:
            pass
    if fmt.get("tags", {}).get("creation_time"):
        creation = fmt["tags"]["creation_time"]
    # TC：遍历所有 stream（video/audio/**data**——Sony XAVC 的 timecode
    # 在 timed-metadata data stream 里），取第一个非空 SMPTE timecode
    tc = ""
    w = h = None
    for s in info.get("streams", []):
        t = s.get("tags", {}).get("timecode")
        if t and not tc:
            tc = t
        if s.get("codec_type") == "video":
            if w is None:
                w = s.get("width")
            if h is None:
                h = s.get("height")
    if dur is None:
        return None
    return {"dur": dur, "size": size, "w": w, "h": h,
            "tc": tc, "creation": creation}


def build():
    cfg = get_config()
    WORK = cfg.WORK or "/tmp/syncwork"
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(f"{WORK}/audio", exist_ok=True)

    rows_index = []
    rows_dur = []
    rows_tc = []
    n = 0
    nfail = 0
    for day, dname in cfg.day_dirs:
        camdirs = cfg.day_cam_dirs[day]
        for cam in sorted(camdirs):
            for cdir in camdirs[cam]:
                base = os.path.join(cfg.BASE, dname, cdir) if cdir != "." \
                    else os.path.join(cfg.BASE, dname)
                # 大小写不敏感扫描：扩展名统一转小写判断
                files = []
                if os.path.isdir(base):
                    for fname in os.listdir(base):
                        # macOS AppleDouble metadata is not media. It often
                        # carries the original extension (for example
                        # `._A001.MP4`) and must not reach ffprobe.
                        if fname.startswith("._"):
                            continue
                        if os.path.splitext(fname)[1].lower() in EXT:
                            files.append(os.path.join(base, fname))
                files = sorted(set(files))
                for p in files:
                    fname = os.path.basename(p)
                    rel = os.path.relpath(p, cfg.BASE)
                    rel_dir = os.path.dirname(rel)
                    info = probe_file(p)
                    if info is None:
                        nfail += 1
                        print(f"  探测失败: {rel}", flush=True)
                        continue
                    # id 全局唯一：天_相机_序号
                    seq = f"{day}_{cam}_{n:05d}"
                    rows_index.append((seq, day, cam, rel_dir, fname))
                    rows_dur.append((rel_dir, fname, info["dur"], info["size"] or 0))
                    rows_tc.append((rel_dir, fname, info["tc"], info["creation"] or ""))
                    n += 1
    if n == 0:
        raise RuntimeError(f"素材根目录下没有发现任何媒体文件: {cfg.BASE}")

    with open(f"{WORK}/index.tsv", "w") as f:
        for r in rows_index:
            f.write("\t".join(map(str, r)) + "\n")
    with open(f"{WORK}/durations.tsv", "w") as f:
        for r in rows_dur:
            f.write("\t".join(map(str, r)) + "\n")
    with open(f"{WORK}/tc.tsv", "w") as f:
        for r in rows_tc:
            f.write("\t".join(map(str, r)) + "\n")

    print(f"盘点完成: {n} 个媒体文件, 失败 {nfail}")
    print(f"  index.tsv / durations.tsv / tc.tsv -> {WORK}")
    # 摘要
    n_tc = sum(1 for r in rows_tc if r[2])
    print(f"  带 TC 的素材: {n_tc}/{n}")
    return n, nfail


if __name__ == "__main__":
    build()
