#!/usr/bin/env python3
"""素材盘点：扫描素材根目录，为每个媒体文件提取时长/尺寸/TC/创建时间。

输出三个 TSV（供 sync.py / extract_parallel.py 使用）：
  {WORK}/index.tsv         id \t day \t cam \t dir \t file
  {WORK}/durations.tsv     dir \t file \t dur \t size
  {WORK}/tc.tsv            dir \t file \t tc \t creation
day/cam 是显式列（由 project_config 的目录/文件名识别给出），下游无需猜。

默认接受行业常见 A/B/C、A机/B机/C机、A1/B1/C1、CAM_A 等机位命名；
项目 camera_patterns 可覆盖不规范团队的命名。平铺目录中若文件名能明确识别
A/B/C，会按文件名分机位而不是把全部素材默认成 A。

TC：优先视频流 timecode 标签（SMPTE "HH:MM:SS:FF"）；无 TC 则留空。
没有音频/TC 的素材不是错误，但不能作为确定性同步证据，应在镜序素材角色层
标为航拍/空镜/GoPro等辅助素材并由人工归场景。
"""
import os
import sys
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import get_config, infer_camera_label

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
    seen_paths = set()
    n = 0
    nfail = 0
    n_unclassified = 0
    for day, dname in cfg.day_dirs:
        camdirs = cfg.day_cam_dirs[day]
        flat_multi_camera = sum(1 for dirs in camdirs.values() if "." in dirs) > 1
        for cam in sorted(camdirs):
            for cdir in camdirs[cam]:
                base = os.path.join(cfg.BASE, dname, cdir) if cdir != "." else os.path.join(cfg.BASE, dname)
                files = []
                if os.path.isdir(base):
                    for fname in os.listdir(base):
                        if fname.startswith("._"):
                            continue
                        if os.path.splitext(fname)[1].lower() in EXT:
                            files.append(os.path.join(base, fname))
                for p in sorted(set(files)):
                    if cdir == "." and flat_multi_camera:
                        inferred = infer_camera_label(os.path.basename(p), cfg.camera_patterns)
                        if not inferred:
                            # In a mixed flat folder, guessing unknown files as
                            # A would silently mislabel footage. Require project
                            # camera_patterns or a conventional filename instead.
                            if p not in seen_paths:
                                n_unclassified += 1
                                print(f"  机位未识别，跳过同步索引: {os.path.relpath(p, cfg.BASE)}", flush=True)
                                seen_paths.add(p)
                            continue
                        if inferred != cam:
                            continue
                    if p in seen_paths:
                        continue
                    seen_paths.add(p)
                    fname = os.path.basename(p)
                    rel = os.path.relpath(p, cfg.BASE)
                    rel_dir = os.path.dirname(rel)
                    info = probe_file(p)
                    if info is None:
                        nfail += 1
                        print(f"  探测失败: {rel}", flush=True)
                        continue
                    seq = f"{day}_{cam}_{n:05d}"
                    rows_index.append((seq, day, cam, rel_dir, fname))
                    rows_dur.append((rel_dir, fname, info["dur"], info["size"] or 0))
                    rows_tc.append((rel_dir, fname, info["tc"], info["creation"] or ""))
                    n += 1
    if n == 0:
        raise RuntimeError(f"素材根目录下没有发现任何可归类同步媒体: {cfg.BASE}")

    with open(f"{WORK}/index.tsv", "w") as f:
        for r in rows_index:
            f.write("\t".join(map(str, r)) + "\n")
    with open(f"{WORK}/durations.tsv", "w") as f:
        for r in rows_dur:
            f.write("\t".join(map(str, r)) + "\n")
    with open(f"{WORK}/tc.tsv", "w") as f:
        for r in rows_tc:
            f.write("\t".join(map(str, r)) + "\n")

    print(f"盘点完成: {n} 个媒体文件, 探测失败 {nfail}, 机位未分类 {n_unclassified}")
    print(f"  index.tsv / durations.tsv / tc.tsv -> {WORK}")
    n_tc = sum(1 for r in rows_tc if r[2])
    print(f"  带 TC 的素材: {n_tc}/{n}")
    return n, nfail


if __name__ == "__main__":
    build()
