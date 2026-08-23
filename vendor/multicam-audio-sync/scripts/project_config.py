#!/usr/bin/env python3
"""项目参数模块 —— 把格式/目录等"项目参数"与算法核心分离。

用法：
    from project_config import C

    C.BASE         素材根目录（含所有天/组的文件夹）
    C.WORK         工作目录（index/durations/tc/positions 等中间文件）
    C.OUT_DIR      交付输出目录

格式参数（自动探测，见 detect_format()；也可手动覆盖）：
    C.FPS          视频帧率（float）
    C.W / C.H      视频分辨率（int）
    C.FRAME_TICKS  FCPXML 一帧的 tick 数 = round(FRAME / fps)
    C.FORMAT_NAME  FCPXML format 资源名（如 FFVideoFormat1920x1080p25）
    C.AUDIO_RATE   音频采样率（Hz，默认 48000）
    C.AUDIO_CH     音频声道数（默认 2）
    C.CAM_LIST     相机标识（列表，如 ["A","B","C"]；自动探测目录）
    C.DAY_DIRS     [{day: "20240501", dir: "2024-05-01"}, ...]（自动探测）
    C.DAY_CAM_DIR  {day: {"A": "A1", "B": "B1", "C": "C1"}}（自动探测）

探测失败时给出明确报错，不靠猜。
"""
import os
import re
import glob
import json
import subprocess
from fractions import Fraction

FRAME = 50000  # FCPXML 时间基准：每秒 50000 tick（FCP 固定，勿改）
_CONVENTIONAL_CAMERAS = ("A", "B", "C")
_MEDIA_PATTERNS = ("*.mp4", "*.MP4", "*.mov", "*.MOV", "*.mxf", "*.MXF", "*.mts", "*.MTS", "*.3gp", "*.MPG", "*.mpg")


def _run_ffprobe(path, args):
    """Run ffprobe on a file, return parsed output or None."""
    cmd = ["ffprobe", "-v", "error"] + args + [path]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return out.stdout


def detect_video_format(path):
    """Probe one video file, return (fps, width, height) or raise."""
    if not path or not os.path.exists(path):
        raise FileNotFoundError(f"探测素材不存在: {path}")
    out = _run_ffprobe(path, ["-select_streams", "v:0", "-show_streams",
                              "-show_format", "-of", "json"])
    if out:
        try:
            info = json.loads(out)
            v = next((s for s in info.get("streams", [])
                      if s.get("codec_type") == "video"), None)
            if v:
                w = int(v.get("width") or 0)
                h = int(v.get("height") or 0)
                fr = None
                for key in ("r_frame_rate", "avg_frame_rate"):
                    rate = v.get(key) or ""
                    try:
                        fr = float(Fraction(rate))
                        if fr > 0:
                            break
                    except (ValueError, ZeroDivisionError):
                        continue
                rot = 0
                for sd in v.get("side_data_list", []) or []:
                    if sd.get("side_data_type") == "Display Matrix" and sd.get("rotation"):
                        rot = int(sd["rotation"])
                if rot in (90, -90, 270, -270):
                    w, h = h, w
                if w and h and fr:
                    return float(fr), w, h
        except (ValueError, KeyError):
            pass
    out = _run_ffprobe(path, ["-show_streams", "-show_format"])
    if out:
        fr = w = h = rot = None
        in_video = False
        for line in out.splitlines():
            line = line.strip()
            if line == "[/STREAM]" or line == "[/FORMAT]":
                in_video = False
            if line == "[STREAM]":
                in_video = True
            if not in_video:
                continue
            m = re.match(r"width=(\d+)", line)
            if m:
                w = int(m.group(1))
            m = re.match(r"height=(\d+)", line)
            if m:
                h = int(m.group(1))
            m = re.match(r"(r|avg)_frame_rate=(\d+)/(\d+)", line)
            if m and not fr:
                num, den = int(m.group(2)), int(m.group(3))
                if den:
                    fr = num / den
            m = re.match(r"rotation=(-?\d+)", line)
            if m:
                rot = int(m.group(1))
        if rot in (90, -90, 270, -270) and w and h:
            w, h = h, w
        if w and h and fr:
            return float(fr), w, h
    raise RuntimeError(f"无法用 ffprobe 探测视频格式: {path}（确认 ffprobe 已安装）")


def detect_fps_frac(path):
    out = _run_ffprobe(path, ["-select_streams", "v:0", "-show_streams", "-of", "json"])
    if not out:
        return None
    try:
        info = json.loads(out)
        v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
        if not v:
            return None
        for key in ("r_frame_rate", "avg_frame_rate"):
            rate = v.get(key) or ""
            try:
                fr = Fraction(rate)
                if fr > 0:
                    return fr
            except (ValueError, ZeroDivisionError):
                continue
    except (ValueError, KeyError):
        pass
    return None


def detect_audio_rate(path):
    out = _run_ffprobe(path, ["-select_streams", "a:0", "-show_streams", "-of", "json"])
    if out:
        try:
            info = json.loads(out)
            a = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
            if a and a.get("sample_rate"):
                return int(a["sample_rate"])
        except (ValueError, KeyError):
            pass
    return 48000


def infer_camera_label(value, patterns=None):
    """Infer a camera label from an industry-style folder or filename token.

    Explicit project regex patterns win. Defaults intentionally recognize strong
    A/B/C conventions only: A, A机, A1/A001, CAM_A/CAMERA-B and equivalent B/C.
    Arbitrary letters inside ordinary words are not treated as camera metadata.
    """
    text = str(value or "").strip()
    if not text:
        return ""
    configured = patterns if isinstance(patterns, dict) else {}
    for camera, pattern in configured.items():
        try:
            if re.search(str(pattern), text, re.IGNORECASE):
                return str(camera).upper()
        except re.error:
            continue
    upper = text.upper()
    stem = os.path.splitext(os.path.basename(upper))[0]
    for camera in _CONVENTIONAL_CAMERAS:
        if re.match(rf"^{camera}(?:机)?$", stem, re.IGNORECASE):
            return camera
        if re.match(rf"^{camera}\d+$", stem, re.IGNORECASE):
            return camera
        if re.match(rf"^(?:CAMERA|CAM)[_\-\s]*{camera}(?:\d+)?$", stem, re.IGNORECASE):
            return camera
        if re.search(rf"(?:^|[_\-\s]){camera}(?=\d|[_\-\s]|机|$)", stem, re.IGNORECASE):
            return camera
    return ""


def _media_files(folder):
    result = []
    for pattern in _MEDIA_PATTERNS:
        result.extend(glob.glob(os.path.join(folder, pattern)))
    return sorted(set(result))


def _scan_days(base, camera_patterns=None):
    if not base or not os.path.isdir(base):
        raise FileNotFoundError(f"素材根目录不存在: {base}")
    skip_kw = ("输出", "交付", "结果", "同步", "导出", "out", "output",
               "deliver", "sync", "export", "参考", "reference", "工程",
               "项目", "project", "backup", "备份")
    days = []
    for d in sorted(glob.glob(os.path.join(base, "*"))):
        if not os.path.isdir(d):
            continue
        name = os.path.basename(d)
        if name.startswith("."):
            continue
        low = name.lower()
        if any(k in low for k in skip_kw):
            continue
        try:
            _detect_cam_dirs(d, camera_patterns)
        except RuntimeError:
            continue
        m = re.match(r"(\d+)\.(\d+)", name)
        if m:
            day = m.group(1) + m.group(2)
        else:
            m = re.match(r"(\d{4})[-_]?(\d{1,2})[-_]?(\d{1,2})", name)
            day = f"{m.group(1)}{int(m.group(2)):02d}{int(m.group(3)):02d}" if m else name
        days.append((day, name))
    seen = {}
    for i, (day, name) in enumerate(days):
        if day not in seen:
            seen[day] = 1
        else:
            seen[day] += 1
            days[i] = (f"{day}_{seen[day]}", name)
    if not days:
        raise RuntimeError(f"素材根目录下没有找到任何天/组文件夹: {base}")
    return days


def _detect_cam_dirs(day_dir, camera_patterns=None):
    """Scan one day folder, returning {camera: [directories]}.

    Defaults accept A/B/C, A机/B机/C机, A1/B2/C3, CAM_A and CAMERA-B.
    Project camera_patterns are evaluated first and may map unconventional team
    folder names to any configured camera label.

    A flat folder with filenames carrying conventional/configured A/B/C tokens is
    represented as multiple cameras sharing `.`. make_index.py filters those
    files per camera so they are not duplicated.
    """
    camdirs = {}
    for d in sorted(glob.glob(os.path.join(day_dir, "*"))):
        if not os.path.isdir(d):
            continue
        name = os.path.basename(d)
        camera = infer_camera_label(name, camera_patterns)
        if camera:
            camdirs.setdefault(camera, []).append(name)
    if camdirs:
        return camdirs

    media = _media_files(day_dir)
    if media:
        cameras = []
        for path in media:
            camera = infer_camera_label(os.path.basename(path), camera_patterns)
            if camera and camera not in cameras:
                cameras.append(camera)
        if cameras:
            return {camera: ["."] for camera in sorted(cameras)}
        return {"A": ["."]}
    raise RuntimeError(
        f"无法识别相机子目录（期望 A/B/C、A机/B机/C机、A1/B1/C1、CAM_A，或项目 camera_patterns）: {day_dir}")


def _first_video(day_dir, camdir):
    base = os.path.join(day_dir, camdir) if camdir != "." else day_dir
    for pat in _MEDIA_PATTERNS:
        hits = glob.glob(os.path.join(base, pat))
        if hits:
            return hits[0]
    return None


class Config:
    """项目配置。构造时自动探测 BASE 下所有天的格式与相机目录。"""

    def __init__(self, base=None, work=None, out_dir=None, manual=None):
        self.BASE = base
        self.WORK = work
        self.OUT_DIR = out_dir or (os.path.join(base, "交付") if base else None)
        self.manual = manual or {}
        raw_patterns = self.manual.get("camera_patterns", {})
        self.camera_patterns = {
            str(camera).upper(): str(pattern)
            for camera, pattern in raw_patterns.items()
        } if isinstance(raw_patterns, dict) else {}

        self.fps = None
        self.width = None
        self.height = None
        self.frame_ticks = None
        self.format_name = None
        self.audio_rate = 48000
        self.audio_ch = 2
        self.day_dirs = []
        self.day_cam_dirs = {}
        self.cam_list = []

        self._probe()
        self._check_delivery_location()

    def _check_delivery_location(self):
        if not (self.BASE and self.OUT_DIR):
            return
        base_abs = os.path.abspath(self.BASE)
        out_abs = os.path.abspath(self.OUT_DIR)
        try:
            inside = os.path.commonpath([base_abs, out_abs]) == base_abs
        except ValueError:
            inside = False
        if inside:
            def _same_path(a, b):
                return os.path.normpath(a) == os.path.normpath(b)
            derived = os.path.join(base_abs, "交付")
            if not _same_path(out_abs, derived):
                print(f"[预检] 注意：OUT_DIR 位于素材根目录内部 ({self.OUT_DIR})，交付产物会写进素材区。若目标其实是新项目请确认无误。")

    def _probe(self):
        self.day_dirs = _scan_days(self.BASE, self.camera_patterns)
        all_cams = []
        for day, dname in self.day_dirs:
            day_path = os.path.join(self.BASE, dname)
            camdirs = _detect_cam_dirs(day_path, self.camera_patterns)
            self.day_cam_dirs[day] = camdirs
            for c in camdirs:
                if c not in all_cams:
                    all_cams.append(c)
        self.cam_list = sorted(all_cams)

        probe_path = None
        for day, dname in self.day_dirs:
            camdirs = self.day_cam_dirs[day]
            for c in sorted(camdirs):
                for cd in camdirs[c]:
                    p = _first_video(os.path.join(self.BASE, dname), cd)
                    if p:
                        probe_path = p
                        break
                if probe_path:
                    break
            if probe_path:
                break

        if probe_path:
            fps, w, h = detect_video_format(probe_path)
            self.fps = self.manual.get("fps", fps)
            self.width = self.manual.get("width", w)
            self.height = self.manual.get("height", h)
            self.audio_rate = self.manual.get("audio_rate", detect_audio_rate(probe_path))
            self.audio_ch = self.manual.get("audio_ch", 2)
        else:
            self.fps = self.manual.get("fps")
            self.width = self.manual.get("width")
            self.height = self.manual.get("height")
            self.audio_rate = self.manual.get("audio_rate", 48000)
            self.audio_ch = self.manual.get("audio_ch", 2)
            if not (self.fps and self.width and self.height):
                raise RuntimeError("素材中没有任何可探测的视频文件，且未通过 manual 指定 fps/width/height")

        if "fps" in self.manual:
            self.fps_frac = Fraction(str(self.fps)).limit_denominator(100000)
        else:
            self.fps_frac = detect_fps_frac(probe_path) or Fraction(str(self.fps)).limit_denominator(100000)
        self.ntsc = self.fps_frac.denominator == 1001
        self.frame_num = 1000
        self.frame_den = self.fps_frac.numerator * 1000
        if self.ntsc:
            self.frame_num = self.fps_frac.denominator
            self.frame_den = self.fps_frac.numerator
        self.frame_duration = f"{self.frame_num}/{self.frame_den}s"
        self.frame_ticks = self.frame_num
        if self.fps_frac.denominator == 1:
            fps_label = str(self.fps_frac.numerator)
        else:
            fps_label = str(float(self.fps_frac)).replace(".", "-")
        self.format_name = f"FFVideoFormat{self.width}x{self.height}p{fps_label}"

    def sec_to_ticks(self, s):
        return int(round(s * self.fps_frac)) * self.frame_num

    def fr(self, sec):
        return int(round(sec * self.fps_frac))

    def url_abs(self, base, path):
        from urllib.parse import quote
        return "file://" + quote(os.path.join(base, path))

    def fmt_hhmm(self, sec):
        h = sec / 3600
        return f"{h:.2f} h"


def get_config():
    import json as _json
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    data = {}
    if os.path.exists(cfg_path):
        with open(cfg_path, encoding="utf-8") as f:
            data = _json.load(f)
    return Config(
        base=data.get("BASE"),
        work=data.get("WORK"),
        out_dir=data.get("OUT_DIR"),
        manual=data.get("manual", {}),
    )


if __name__ == "__main__":
    import sys
    base = sys.argv[1] if len(sys.argv) > 1 else None
    work = sys.argv[2] if len(sys.argv) > 2 else None
    out = sys.argv[3] if len(sys.argv) > 3 else None
    c = Config(base=base, work=work, out_dir=out)
    print(f"BASE={c.BASE}")
    print(f"day_dirs={c.day_dirs}")
    print(f"day_cam_dirs={c.day_cam_dirs}")
    print(f"cam_list={c.cam_list}")
    print(f"fps={c.fps}  {c.width}x{c.height}")
    print(f"frame_ticks={c.frame_ticks}  format_name={c.format_name}")
    print(f"audio_rate={c.audio_rate}  audio_ch={c.audio_ch}")
    print(f"sec_to_ticks(1.5)={c.sec_to_ticks(1.5)}  fr(1.5)={c.fr(1.5)}")
