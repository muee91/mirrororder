"""Resolve's local scripting adapter. Runs in the delivery worker subprocess."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import zipfile
from collections import defaultdict
from fractions import Fraction
from pathlib import Path
from typing import Any


def connect_resolve() -> Any:
    if sys.platform == "darwin":
        base = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve")
    elif os.name == "nt":
        base = Path(os.environ.get("PROGRAMDATA", "C:/ProgramData")) / "Blackmagic Design" / "DaVinci Resolve" / "Support"
    else:
        raise RuntimeError("本机 Resolve 导出支持 macOS 和 Windows")
    module_path = base / "Developer" / "Scripting" / "Modules" / "DaVinciResolveScript.py"
    if not module_path.is_file():
        raise RuntimeError("找不到 Resolve 官方脚本组件")
    spec = importlib.util.spec_from_file_location("DaVinciResolveScript", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法载入 Resolve 官方脚本组件")
    module = importlib.util.module_from_spec(spec)
    # Resolve's loader replaces sys.modules[__name__] with fusionscript.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    resolve = sys.modules[spec.name].scriptapp("Resolve")
    if not resolve:
        raise RuntimeError("请打开 DaVinci Resolve Studio 并允许本机脚本连接")
    return resolve


def _require(value: Any, message: str) -> Any:
    if not value:
        raise RuntimeError(message)
    return value


def _path(value: str) -> str:
    return os.path.normcase(os.path.realpath(value)) if value else ""


def _rate(value: Any) -> Fraction:
    options = {"23.976": Fraction(24000, 1001), "29.97": Fraction(30000, 1001),
               "47.952": Fraction(48000, 1001), "59.94": Fraction(60000, 1001),
               "119.88": Fraction(120000, 1001)}
    value = str(value)
    return options[value] if value in options else Fraction(value)


def _timecode(frame: int, nominal: int) -> str:
    seconds, frames = divmod(frame, nominal)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours % 24:02d}:{minutes:02d}:{seconds:02d}:{frames:02d}"


def _single_audio_track(item: Any) -> str:
    try:
        mapping = json.loads(item.GetAudioMapping()).get("track_mapping", {})
        if len(mapping) == 1:
            track_type = next(iter(mapping.values())).get("type", "")
            if track_type in {"mono", "stereo"}:
                return track_type
    except (AttributeError, TypeError, ValueError):
        pass
    return ""


def export_native(resolve: Any, plan: dict[str, Any], destination: Path) -> dict[str, Any]:
    if plan.get("contract_version") != "resolve_sync_originals.v1":
        raise RuntimeError("Resolve 交付计划未证明原片来源，请重新生成")
    dependencies = []
    for track in plan["tracks"]:
        for row in track["clips"]:
            if row.get("source_kind") != "original" or not row.get("media_id"):
                raise RuntimeError("视频交付仅接受已验证原片，不接受时间线或复合片段")
            dependencies.append({"path": row["path"], "media_id": row["media_id"], "source_kind": "original", "camera": track["camera"]})
    for row in plan["recordings"]:
        if (row.get("source_kind") != "original" or row.get("timing_basis") != "original_unretimed"
                or row.get("source_rate_ratio") != [1, 1]):
            raise RuntimeError("录音尚未证明原 WAV 的未变速坐标；不能替换校正文件或重复施加漂移")
        dependencies.append({"path": row["path"], "media_id": row["media_id"], "source_kind": "original", "track": row["track"]})
    name = plan["project_name"]
    rate = Fraction(*plan["rate"])
    pm = resolve.GetProjectManager()
    if (pm.GetCurrentDatabase() or {}).get("DbType") != "Disk":
        raise RuntimeError("请切换到 Resolve 的本机项目库后再生成工程")
    previous_project = pm.GetCurrentProject()
    previous_name = previous_project.GetName() if previous_project else ""
    if name in (pm.GetProjectListInCurrentFolder() or []):
        raise RuntimeError("Resolve 已有同名导出项目，请重新发起一次交付")
    project = _require(pm.CreateProject(name), "Resolve 无法创建新交付项目")
    pool = project.GetMediaPool()
    root = pool.GetRootFolder()

    def active() -> None:
        current = pm.GetCurrentProject()
        if not current or current.GetName() != name:
            raise RuntimeError("Resolve 已切换项目，交付任务停止")

    def make_timeline(label: str) -> Any:
        active()
        timeline = _require(pool.CreateEmptyTimeline(label), f"Resolve 无法创建时间线：{label}")
        _require(project.SetCurrentTimeline(timeline), f"Resolve 无法激活时间线：{label}")
        _require(timeline.SetStartTimecode("01:00:00:00"), "Resolve 无法设置时间线起始时间码")
        if abs(float(timeline.GetSetting("timelineFrameRate")) - float(rate)) > 0.005:
            raise RuntimeError("Resolve 时间线帧率与镜序母版不符")
        return timeline

    short_audio_tails = 0

    def place(timeline: Any, kind: str, index: int, rows: list[dict[str, Any]]) -> None:
        nonlocal short_audio_tails
        active()
        _require(project.SetCurrentTimeline(timeline), "Resolve 无法切换交付时间线")
        origin = timeline.GetStartFrame()
        for offset in range(0, len(rows), 100):
            active()
            batch = rows[offset:offset + 100]
            specs = []
            for row in batch:
                obj, source_rate = sources[_path(row["path"])]
                scale = source_rate / rate
                begin, end = row["source"], row["source"] + row["frames"]
                specs.append({"mediaPoolItem": obj, "mediaType": 1 if kind == "video" else 2, "trackIndex": index,
                              "recordFrame": origin + row["at"], "startFrame": float(begin * scale), "endFrame": float(end * scale)})
            items = pool.AppendToTimeline(specs) or []
            # Read the actual destination track once per batch, not wrapper identity
            # or only AppendToTimeline responses (which can be routed elsewhere).
            by_start = {item.GetStart(True): item for item in (timeline.GetItemListInTrack(kind, index) or [])}
            missing = next((row for row in batch if origin + row["at"] not in by_start), None)
            if missing or len(items) != len(batch):
                raise RuntimeError(f"Resolve {kind} 轨放置片段数量不符：{(missing or batch[0])['name']}")
            for row in batch:
                item = by_start.get(origin + row["at"])
                source = item.GetMediaPoolItem() if item else None
                if not source or _path(source.GetClipProperty("File Path")) != _path(row["path"]):
                    raise RuntimeError(f"Resolve 读回的素材或落点不符：{row['name']}")
                if abs(item.GetLeftOffset(True) - row["source"]) > 0.001:
                    raise RuntimeError(f"Resolve 读回的源入点不符：{row['name']}")
                difference = row["frames"] - item.GetDuration(True)
                if abs(difference) > 0.001:
                    if kind != "audio" or not 0 < difference <= 0.501:
                        raise RuntimeError(f"Resolve 读回的时长不符：{row['name']}")
                    short_audio_tails += 1

    try:
        frame_rate = f"{float(rate):.3f}".rstrip("0").rstrip(".")
        _require(project.SetSetting("timelineFrameRate", frame_rate), f"Resolve 无法设置母版帧率 {frame_rate}")
        width, height = plan["size"]
        if width > 0 and height > 0:
            _require(project.SetSetting("timelineResolutionWidth", str(width)), "Resolve 无法设置母版宽度")
            _require(project.SetSetting("timelineResolutionHeight", str(height)), "Resolve 无法设置母版高度")

        paths = {row["path"] for track in plan["tracks"] for row in track["clips"]}
        paths.update(row["path"] for row in plan["recordings"])
        paths = sorted(paths)
        sources = {}
        for offset in range(0, len(paths), 100):
            active()
            batch = paths[offset:offset + 100]
            print(f"Resolve 正在读取素材 {offset + 1}–{offset + len(batch)} / {len(paths)}", flush=True)
            for item in pool.ImportMedia(batch) or []:
                source_path = _path(item.GetClipProperty("File Path"))
                kind = str(item.GetClipProperty("Type") or "").lower()
                if any(label in kind for label in ("timeline", "compound", "multicam", "时间线", "复合", "多机")):
                    raise RuntimeError("Resolve 导入结果不是直接原片，拒绝嵌套媒体")
                fps = item.GetClipProperty("FPS")
                if source_path and fps:
                    source_rate = _rate(fps)
                    if source_rate > 0:
                        sources[source_path] = (item, source_rate)
        missing = next((path for path in paths if _path(path) not in sources), None)
        if missing is not None:
            raise RuntimeError(f"Resolve 无法读取素材及其源时基：{Path(missing).name}")

        master = make_timeline("同步母版（原片直连）")
        for index, track in enumerate(plan["tracks"], start=1):
            print(f"Resolve 正在核对 {track['camera']} 机位画面", flush=True)
            if index > master.GetTrackCount("video"):
                _require(master.AddTrack("video"), "Resolve 无法新增机位轨")
            _require(master.SetTrackName("video", index, f"机位 {track['camera']}"), "Resolve 无法命名机位轨")
            place(master, "video", index, track["clips"])

        # Public scripting cannot preserve exact edit placements while converting a
        # timeline to a direct-source multicam. Never use per-angle timelines as clips.
        conversion = make_timeline("待转换多机位（原片直连）")
        for index, track in enumerate(plan["tracks"], start=1):
            if index > conversion.GetTrackCount("video"):
                _require(conversion.AddTrack("video"), "Resolve 无法新增机位轨")
            _require(conversion.SetTrackName("video", index, f"机位 {track['camera']}"), "Resolve 无法命名机位轨")
            place(conversion, "video", index, track["clips"])

        recordings: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in plan["recordings"]:
            recordings[row["track"]].append(row)

        audio_tracks = []
        for label, rows in recordings.items():
            layouts = {_single_audio_track(sources[_path(row["path"])][0]) for row in rows}
            if len(layouts) != 1 or not next(iter(layouts)):
                raise RuntimeError(f"录音轨 {label} 的声道映射未确认或不一致，禁止默认转为 stereo")
            audio_tracks.append((label, rows, layouts.pop(), True))
        # Add one listening reference with a consistent native channel layout.
        # The other camera originals remain in the media pool with their own channels.
        reference = None
        for track in plan["tracks"]:
            layouts: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in track["clips"]:
                layout = _single_audio_track(sources[_path(row["path"])][0])
                if layout:
                    layouts[layout].append(row)
            if layouts:
                layout, rows = max(layouts.items(), key=lambda entry: sum(row["frames"] for row in entry[1]))
                reference = f"{track['camera']} 机内声", rows, layout, not recordings
                audio_tracks.append(reference)
                break
        print("Resolve 正在放置并核对音轨", flush=True)
        for timeline in (master,):
            _require(project.SetCurrentTimeline(timeline), "Resolve 无法切换音轨目标")
            existing_tracks = timeline.GetTrackCount("audio")
            for _, _, layout, _ in audio_tracks:
                _require(timeline.AddTrack("audio", layout), "Resolve 无法新增音轨")
            if audio_tracks:
                for index in range(existing_tracks, 0, -1):
                    _require(not timeline.GetItemListInTrack("audio", index) and timeline.DeleteTrack("audio", index),
                             "Resolve 无法移除多余空音轨")
            for index, (label, rows, _, enabled) in enumerate(audio_tracks, start=1):
                _require(timeline.SetTrackName("audio", index, label), "Resolve 无法命名音轨")
                place(timeline, "audio", index, rows)
                _require(timeline.SetTrackEnable("audio", index, enabled), "Resolve 无法设置独立监听")
                if timeline.GetTrackName("audio", index) != label or timeline.GetIsTrackEnabled("audio", index) != enabled:
                    raise RuntimeError("Resolve 读回的音轨名称或监听路由不符")

        active()
        for timeline in (master, conversion):
            for index, track in enumerate(plan["tracks"], start=1):
                if (timeline.GetTrackName("video", index) != f"机位 {track['camera']}"
                        or len(timeline.GetItemListInTrack("video", index) or []) != len(track["clips"])):
                    raise RuntimeError("Resolve 机位轨完整读回不符")
        _require(project.SetCurrentTimeline(master), "Resolve 无法打开原片同步母版")
        master.SetCurrentTimecode(_timecode(master.GetStartFrame() + plan["opening_frame"], round(rate)))
        resolve.OpenPage("edit")
        _require(pm.SaveProject(), "Resolve 无法保存交付项目")
        _require(pm.ExportProject(name, str(destination), False), "Resolve 无法导出 DRP")
        with zipfile.ZipFile(destination) as archive:
            if archive.testzip() is not None:
                raise RuntimeError("Resolve 导出的 DRP 文件不完整")
        return {"delivery_kind": "direct_sync_timeline", "native_multicam": False,
                "conversion_required": True, "media_embedded": False,
                "conversion_instruction": "在 Resolve 媒体池右键‘待转换多机位（原片直连）’，选择 Convert Timeline to Multicam Clip（将时间线转换为多机位片段）。转换后须检查 Open in Timeline 第一层直接显示原片。独立录音保留在同步母版，不混为机位；剪辑与音频路由仍需验收。",
                "relocation_instruction": "DRP 不含媒体。另一台电脑须提供原视频和原 WAV，并按原片身份重新链接；不得替换为 Corrected Audio。",
                "media_dependencies": dependencies, "diagnostics": plan.get("diagnostics", []),
                "version": resolve.GetVersionString(), "video_clip_count": sum(len(t["clips"]) for t in plan["tracks"]),
                "cameras": [t["camera"] for t in plan["tracks"]], "audio_segments": len(plan["recordings"]),
                "camera_audio_tracks": int(reference is not None),
                "audio_tail_trims": short_audio_tails, "frames": plan["frames"], "gaps": plan["gaps"]}
    except BaseException:
        current = pm.GetCurrentProject()
        if previous_name and current and current.GetName() == name:
            pm.LoadProject(previous_name)
        raise


if __name__ == "__main__":
    manifest = Path(sys.argv[1])
    try:
        result = export_native(connect_resolve(), json.loads(manifest.read_text(encoding="utf-8")), Path(sys.argv[2]))
    except Exception as error:
        print(f"Resolve 交付失败：{error}", flush=True)
        raise SystemExit(1) from error
    Path(sys.argv[3]).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
