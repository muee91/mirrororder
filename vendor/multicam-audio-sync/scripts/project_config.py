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
    """Probe one video file, return (fps, width, height) or raise.

    - fps 优先取视频流 r_frame_rate（实际帧率），失败回退 avg_frame_rate。
      返回 float（如 29.97）；原始分数（如 30000/1001）由调用方通过
      detect_fps_frac 保留，用于 NTSC 判定。
    - 分辨率考虑 rotation 元数据（Display Matrix）：±90° 时交换宽高，
      返回**显示方向**的尺寸（竖拍素材存储为 1920x1080 + rot=-90 时
      返回 1080x1920，与 NLE 时间线一致）。
    """
    if not path or not os.path.exists(path):
        raise FileNotFoundError(f"探测素材不存在: {path}")
    # 优先用 ffprobe 的 JSON 输出
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
                # rotation: ±90 → 交换宽高
                rot = 0
                for sd in v.get("side_data_list", []) or []:
                    if sd.get("side_data_type") == "Display Matrix" and \
                            sd.get("rotation"):
                        rot = int(sd["rotation"])
                if rot in (90, -90, 270, -270):
                    w, h = h, w
                if w and h and fr:
                    return float(fr), w, h
        except (ValueError, KeyError):
            pass
    # 兜底：ffprobe 文本模式
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
    """Probe a video's r_frame_rate as an exact Fraction (e.g. 30000/1001).

    Returns Fraction or None. 用于 NTSC 判定：23.976/29.97/59.94 的原始
    分数分母为 1001，float 表示会丢失该信息。
    """
    out = _run_ffprobe(path, ["-select_streams", "v:0", "-show_streams",
                              "-of", "json"])
    if not out:
        return None
    try:
        info = json.loads(out)
        v = next((s for s in info.get("streams", [])
                  if s.get("codec_type") == "video"), None)
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
    """Probe one video's audio stream sample rate (Hz). Default 48000."""
    out = _run_ffprobe(path, ["-select_streams", "a:0", "-show_streams",
                              "-of", "json"])
    if out:
        try:
            info = json.loads(out)
            a = next((s for s in info.get("streams", [])
                      if s.get("codec_type") == "audio"), None)
            if a and a.get("sample_rate"):
                return int(a["sample_rate"])
        except (ValueError, KeyError):
            pass
    return 48000


def _scan_days(base):
    """Scan BASE for day/group folders (top-level dirs containing camera dirs).

    day 名：优先从目录名提取日期（如 "5.01 拍摄" -> "501"），
    否则用目录名本身。返回 [(day, dirname), ...] 按名称排序。

    宽容探测：只保留能识别出相机子目录或直接含媒体文件的顶层目录；
    隐藏目录、明显非素材目录（含 输出/交付/结果/同步 等关键词）跳过。
    """
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
        # 该目录必须能识别出相机子目录或直接含媒体文件，否则跳过
        try:
            _detect_cam_dirs(d)
        except RuntimeError:
            continue
        # day 名：优先从目录名提取日期标识。
        #   支持 "2024-05-01" -> "20240501"、"20240501" -> "20240501"、
        #   "20240501" -> "20240501"；否则用目录名本身。
        m = re.match(r"(\d+)\.(\d+)", name)
        if m:
            day = m.group(1) + m.group(2)
        else:
            m = re.match(r"(\d{4})[-_]?(\d{1,2})[-_]?(\d{1,2})", name)
            day = f"{m.group(1)}{int(m.group(2)):02d}{int(m.group(3)):02d}" if m else name
        days.append((day, name))

    # 去重：同名 date 键（如 "8.16 人" 与 "8.16 人 结局" 都得到 "816"）必须唯一，
    # 否则 project_config 的 day_cam_dirs/positions 键会被后一天覆盖、导致素材静默丢失。
    # 首个保留原名，后续追加 "_2"/"_3"…（保留目录时间顺序）。
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


def _detect_cam_dirs(day_dir):
    """Scan one day folder, return {cam: [camdir, ...]} mapping.

    相机命名规则（自动识别）：
      1. 子目录名匹配 ^([A-Za-z])\\d —— "A1"/"B2"/"C3"（字母+数字）
      2. 匹配 "CAM_A"/"cam-b" 等含字母的模式
    相机标识统一为大写字母。同一相机可能有多张卡/多个子目录
    （如 A1 + A2 都是 A 机），合并为列表。无子目录时（单机位
    素材直接放天目录）返回 {"A": ["."]}。
    """
    camdirs = {}
    for d in sorted(glob.glob(os.path.join(day_dir, "*"))):
        if not os.path.isdir(d):
            continue
        name = os.path.basename(d)
        m = re.match(r"^([A-Za-z])\d", name)
        if m:
            camdirs.setdefault(m.group(1).upper(), []).append(name)
            continue
        m = re.match(r"^camera[_-]?([A-Za-z])", name, re.IGNORECASE)
        if m:
            camdirs.setdefault(m.group(1).upper(), []).append(name)
            continue
        # "CAM_A"/"cam-b"/"CAM-A" 等（camera 缩写 + 分隔符 + 字母）
        m = re.match(r"^cam[_-]?([A-Za-z])", name, re.IGNORECASE)
        if m:
            camdirs.setdefault(m.group(1).upper(), []).append(name)
    # 无子目录：可能是单机位直接放素材
    if not camdirs:
        has_media = glob.glob(os.path.join(day_dir, "*.mp4")) + \
            glob.glob(os.path.join(day_dir, "*.MP4")) + \
            glob.glob(os.path.join(day_dir, "*.mov")) + \
            glob.glob(os.path.join(day_dir, "*.MOV"))
        if has_media:
            return {"A": ["."]}
        raise RuntimeError(
            f"无法识别相机子目录（期望 A1/B1/C1 或 CAM_A 等命名）: {day_dir}")
    return camdirs


def _first_video(day_dir, camdir):
    """Return first video file path in a camera dir, or None."""
    base = os.path.join(day_dir, camdir) if camdir != "." else day_dir
    for pat in ("*.mp4", "*.MP4", "*.mov", "*.MOV", "*.mxf", "*.MXF",
                "*.mts", "*.MTS", "*.3gp", "*.MPG", "*.mpg"):
        hits = glob.glob(os.path.join(base, pat))
        if hits:
            return hits[0]
    return None


class Config:
    """项目配置。构造时自动探测 BASE 下所有天的格式与相机目录。"""

    def __init__(self, base=None, work=None, out_dir=None,
                 manual=None):
        self.BASE = base
        self.WORK = work
        # OUT_DIR 未指定时默认放到素材根下的"交付"目录（通用化：不再有某个
        # 固定工程/机器路径）；BASE 也未给时留 None，由下游各自回退。
        self.OUT_DIR = out_dir or (
            os.path.join(base, "交付") if base else None)
        self.manual = manual or {}   # 手动覆盖项 {"fps": 25, ...}

        # 自动探测（全部可被 manual 覆盖）
        self.fps = None
        self.width = None
        self.height = None
        self.frame_ticks = None
        self.format_name = None
        self.audio_rate = 48000
        self.audio_ch = 2
        self.day_dirs = []           # [(day, dirname), ...]
        self.day_cam_dirs = {}       # {day: {cam: [camdir, ...]}}
        self.cam_list = []

        self._probe()
        self._check_delivery_location()

    # ---- 交付位置预检 ----
    def _check_delivery_location(self):
        """"混入既有项目"预检：交付目录不能写进素材根（会污染素材盘）。

        通用化保护：OUT_DIR 默认派生自 BASE；若用户显式把它设成 BASE 内部
        （或正好等于某个已交付项目的 交付/工程 目录），这里给出显式警告，
        避免本次产物混进上一个项目/素材里。
        """
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
            # 默认派生 {BASE}/交付 也是 inside，但那是有意为之，不警告；
            # 仅当 OUT_DIR 显式存在于 BASE 内部时才提示。
            derived = os.path.join(base_abs, "交付")
            if not _same_path(out_abs, derived):
                print(f"[预检] 注意：OUT_DIR 位于素材根目录内部 "
                      f"({self.OUT_DIR})，交付产物会写进素材区。"
                      f"若目标其实是新项目请确认无误。")
    def _probe(self):
        self.day_dirs = _scan_days(self.BASE)
        # 每个天探测相机目录
        all_cams = []
        for day, dname in self.day_dirs:
            day_path = os.path.join(self.BASE, dname)
            camdirs = _detect_cam_dirs(day_path)
            self.day_cam_dirs[day] = camdirs
            for c in camdirs:
                if c not in all_cams:
                    all_cams.append(c)
        self.cam_list = sorted(all_cams)

        # 找第一个视频做格式探测
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
            self.audio_rate = self.manual.get("audio_rate",
                                              detect_audio_rate(probe_path))
            self.audio_ch = self.manual.get("audio_ch", 2)
        else:
            self.fps = self.manual.get("fps")
            self.width = self.manual.get("width")
            self.height = self.manual.get("height")
            self.audio_rate = self.manual.get("audio_rate", 48000)
            self.audio_ch = self.manual.get("audio_ch", 2)
            if not (self.fps and self.width and self.height):
                raise RuntimeError(
                    "素材中没有任何可探测的视频文件，且未通过 manual 指定 fps/width/height")

        # ---- 帧率精确表示 ----
        # fps 可能是分数（23.976=24000/1001 等）。优先用探测到的原始分数
        # （ffprobe 的 r_frame_rate，如 30000/1001），保留 NTSC 分母 1001；
        # 手动覆盖时从 float 反推（Fraction(str(fps))）。
        if "fps" in self.manual:
            self.fps_frac = Fraction(str(self.fps)).limit_denominator(100000)
        else:
            self.fps_frac = detect_fps_frac(probe_path) or \
                Fraction(str(self.fps)).limit_denominator(100000)
        self.ntsc = self.fps_frac.denominator == 1001
        # FCPXML 帧时长分数 frame_num/frame_den 秒：
        #   整数 fps（24/25/30/50/60…）：1000/(fps*1000)，每帧 1000 tick，精确。
        #   NTSC（23.976/29.97/59.94…）：1001/24000 等原始分数，每帧 1001 tick。
        # 两者 frame_num 都是整数，因此 tick 数 = 帧数 * frame_num 恒为整数，
        # 帧边界精确，且时间值统一写成 {tick}/{frame_den}s。
        self.frame_num = 1000
        self.frame_den = self.fps_frac.numerator * 1000
        if self.ntsc:
            self.frame_num = self.fps_frac.denominator      # 1001
            self.frame_den = self.fps_frac.numerator        # 24000
        self.frame_duration = f"{self.frame_num}/{self.frame_den}s"
        self.frame_ticks = self.frame_num   # 每帧 tick 数（整数 fps=1000，NTSC=1001）
        if self.fps_frac.denominator == 1:
            fps_label = str(self.fps_frac.numerator)
        else:
            fps_label = str(float(self.fps_frac)).replace(".", "-")
        self.format_name = f"FFVideoFormat{self.width}x{self.height}p{fps_label}"

    # ---- 常用换算 ----
    def sec_to_ticks(self, s):
        """秒 -> FCPXML tick（整帧吸附）。

        统一公式：tick = round(帧数) * frame_num，其中帧数 = s * fps。
        整数 fps 下 frame_num=1000（每帧 1000 tick，精确）；
        NTSC 下 frame_num=1001（每帧 1001 tick，精确）。
        返回的 tick 恒为 frame_num 的整数倍 → 必在帧边界上。
        """
        return int(round(s * self.fps_frac)) * self.frame_num

    def fr(self, sec):
        """秒 -> Premiere 帧（四舍五入）。"""
        return int(round(sec * self.fps_frac))

    def url_abs(self, base, path):
        """素材绝对路径 -> file:// URL（percent-encoded）。"""
        from urllib.parse import quote
        return "file://" + quote(os.path.join(base, path))

    def fmt_hhmm(self, sec):
        """秒 -> "9.09 h" 展示用。"""
        h = sec / 3600
        return f"{h:.2f} h"


def get_config():
    """便捷入口：读取 config.json（若存在），否则全部手动参数。

    config.json 示例（BASE 必填；WORK/OUT_DIR/manual 均可省略）：
    {
      "BASE": "/abs/path/to/source_footage_root",
      "WORK": "/tmp/syncwork",
      "OUT_DIR": "/abs/path/to/delivery",
      "manual": {"fps": 50}
    }
    未指定 OUT_DIR 时默认生成到 {BASE}/交付。
    """
    import json as _json
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "config.json")
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
    # 命令行测试：python3 project_config.py <BASE> [WORK] [OUT_DIR]
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
