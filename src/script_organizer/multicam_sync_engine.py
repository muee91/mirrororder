from __future__ import annotations

import csv
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from .config import ProjectConfig
from .media_reader import infer_camera_label


class MulticamSyncUnavailable(RuntimeError):
    pass


_REQUIRED_SCRIPTS = (
    "project_config.py",
    "make_index.py",
    "extract_parallel.py",
    "sync.py",
    "compress_gaps.py",
    "build_fcpxml.py",
    "build_capcut_fcpxml.py",
    "build_capcut_draft_31.py",
    "build_pr_xml.py",
    "validate_fcpxml.py",
)
_REQUIRED_FILES = _REQUIRED_SCRIPTS + ("capcut_draft_schema.json",)
_MEDIA_SUFFIXES = {".mp4", ".mov", ".mxf", ".mts", ".3gp", ".mpg", ".mpeg"}


def _engine_candidates() -> list[Path]:
    result: list[Path] = []
    env = os.environ.get("MIRRORORDER_MULTICAM_SYNC_ROOT", "").strip()
    if env:
        result.append(Path(env).expanduser())
    module = Path(__file__).resolve()
    for parent in module.parents:
        result.extend([parent / "multicam-audio-sync", parent / "vendor" / "multicam-audio-sync"])
    seen: set[str] = set()
    unique = []
    for path in result:
        key = str(path)
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def _valid_engine(path: Path) -> bool:
    root = path / "scripts"
    return all((root / name).is_file() for name in _REQUIRED_FILES)


def _check_prerequisites() -> None:
    missing_commands = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    missing_modules = [name for name in ("numpy", "pandas", "scipy") if importlib.util.find_spec(name) is None]
    if not missing_commands and not missing_modules:
        return
    details = []
    if missing_commands:
        details.append("缺少命令: " + ", ".join(missing_commands))
    if missing_modules:
        details.append("缺少 Python 模块: " + ", ".join(missing_modules))
    raise MulticamSyncUnavailable(
        "多机位同步环境未就绪（" + "；".join(details) + "）。"
        "请安装 FFmpeg，并按 vendor/multicam-audio-sync/requirements.txt 安装第一方同步引擎依赖。"
    )


def _materialize_engine(runtime: Path) -> tuple[Path, str]:
    if runtime.exists():
        shutil.rmtree(runtime)
    for candidate in _engine_candidates():
        if _valid_engine(candidate):
            shutil.copytree(candidate, runtime, ignore=shutil.ignore_patterns("__pycache__", "._*"))
            return runtime, str(candidate)
    raise MulticamSyncUnavailable(
        "未找到镜序内置的第一方 multicam-audio-sync。请检查 App runtime 或 "
        "repo vendor/multicam-audio-sync；开发时可显式设置 MIRRORORDER_MULTICAM_SYNC_ROOT。"
    )


def _run(script_dir: Path, script: str, args: list[str], log: Callable[[str], None] | None = None, timeout: int = 60 * 60 * 6) -> str:
    command = [sys.executable, str(script_dir / script), *args]
    process = subprocess.Popen(command, cwd=script_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    lines = []
    try:
        assert process.stdout is not None
        for line in process.stdout:
            text = line.rstrip()
            lines.append(text)
            if log and text:
                log(text[-500:])
        return_code = process.wait(timeout=timeout)
    except Exception:
        process.kill()
        process.wait()
        raise
    if return_code != 0:
        tail = "\n".join(lines[-20:])
        raise RuntimeError(f"{script} 失败 (exit {return_code})\n{tail}")
    return "\n".join(lines)


def _days_from_index(work: Path) -> list[str]:
    index_path = work / "index.tsv"
    days = []
    with index_path.open(encoding="utf-8") as handle:
        for row in csv.reader(handle, delimiter="\t"):
            if len(row) >= 2 and row[1] not in days:
                days.append(row[1])
    if not days:
        raise RuntimeError("同步索引没有发现拍摄天/素材组")
    return days


def _has_media(path: Path) -> bool:
    try:
        return any(item.is_file() and item.suffix.lower() in _MEDIA_SUFFIXES for item in path.iterdir())
    except OSError:
        return False


def _looks_like_camera_dir(path: Path, patterns: dict[str, str] | None = None) -> bool:
    return path.is_dir() and infer_camera_label(path.name, patterns) != "?" and _has_media(path)


def _has_day_layout(source: Path, patterns: dict[str, str] | None = None) -> bool:
    try:
        for day in source.iterdir():
            if not day.is_dir() or day.name.startswith("."):
                continue
            try:
                if any(_looks_like_camera_dir(child, patterns) for child in day.iterdir() if child.is_dir()):
                    return True
            except OSError:
                continue
    except OSError:
        return False
    return False


def _prepare_media_base(
    source: Path,
    stage_root: Path,
    camera_patterns: dict[str, str] | None = None,
) -> tuple[Path, str]:
    """Accept day/camera and direct camera roots without copying media.

    Industry conventions A/B/C, A机/B机/C机 are defaults. Project
    camera_patterns can recognize unconventional direct camera folders before
    the vendor engine receives the normalized symlink view.
    """
    if _has_day_layout(source, camera_patterns):
        return source, "day-folders"
    try:
        direct_cameras = [
            item for item in source.iterdir()
            if _looks_like_camera_dir(item, camera_patterns)
        ]
        direct_media = [item for item in source.iterdir() if item.is_file() and item.suffix.lower() in _MEDIA_SUFFIXES]
    except OSError:
        direct_cameras = []
        direct_media = []
    if not direct_cameras and not direct_media:
        return source, "engine-detect"
    if stage_root.exists():
        shutil.rmtree(stage_root)
    day = stage_root / "day1"
    day.mkdir(parents=True, exist_ok=True)
    for camera_dir in direct_cameras:
        (day / camera_dir.name).symlink_to(camera_dir, target_is_directory=True)
    for media in direct_media:
        (day / media.name).symlink_to(media)
    return stage_root, "normalized-single-day"


def _prepare_multiple_media_roots(
    roots: tuple[Path, ...],
    stage_root: Path,
    camera_patterns: dict[str, str] | None = None,
) -> tuple[Path, str, Path]:
    """Build a symlink-only engine view for several device-local roots."""
    if not roots:
        raise ValueError("媒体目录项目缺少本机素材根目录")
    if len(roots) == 1:
        base, layout = _prepare_media_base(roots[0], stage_root, camera_patterns)
        return base, layout, roots[0]
    if stage_root.exists():
        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True, exist_ok=True)
    used_names: set[str] = set()
    day_index = 1
    for root in roots:
        if not root.is_dir():
            continue
        children = [
            child for child in root.iterdir()
            if child.is_dir() and not child.name.startswith(".")
        ]
        has_days = any(
            any(_looks_like_camera_dir(grandchild, camera_patterns) for grandchild in child.iterdir() if grandchild.is_dir())
            for child in children
            if child.is_dir()
        )
        if has_days:
            candidates = children
        else:
            candidates = [root]
        for candidate in candidates:
            name = candidate.name or f"day{day_index}"
            while name in used_names:
                name = f"{candidate.name}-{day_index}"
                day_index += 1
            used_names.add(name)
            target = stage_root / name
            if candidate == root:
                target = stage_root / f"day{day_index}"
                day_index += 1
            target.symlink_to(candidate, target_is_directory=True)
    if not any(path.is_symlink() for path in stage_root.iterdir()):
        raise ValueError("选中的素材根目录没有可用于同步的内容")
    try:
        export_base = Path(os.path.commonpath([str(root) for root in roots]))
    except ValueError:
        export_base = Path("/")
    return stage_root, "normalized-multiple-roots", export_base


def _write_config(
    script_dir: Path,
    base: Path,
    export_base: Path,
    work: Path,
    output: Path,
    project_name: str,
    out_name: str,
    camera_patterns: dict[str, str] | None = None,
) -> None:
    payload = {
        "BASE": str(base),
        "WORK": str(work),
        "OUT_DIR": str(output),
        "manual": {
            "project_name": project_name,
            "out_name": out_name,
            "export_base": str(export_base),
            "camera_patterns": dict(camera_patterns or {}),
        },
    }
    (script_dir / "config.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _refresh_analysis_link(link: Path, target: Path) -> None:
    """Keep one internal symlink for old analysis paths without duplicating XML."""
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(target.resolve())
    except OSError as error:
        raise RuntimeError(
            "无法创建项目内部 synchronized.fcpxml 链接；为避免相对素材路径基准错误，"
            "镜序不会复制一份到其他目录。请确认项目磁盘支持符号链接。"
        ) from error


def run_multicam_sync(
    config: ProjectConfig,
    log: Callable[[str], None] | None = None,
    compress_gaps: bool = True,
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    roots = tuple(config.media_roots or ((config.media_root,) if config.media_root else ()))
    if not config.is_media_directory or not roots:
        if config.fcpxml and config.fcpxml.exists():
            return {"status": "skipped", "reason": "项目已有 FCPXML", "fcpxml": str(config.fcpxml)}
        raise ValueError("multicam_sync 只用于媒体目录项目")
    missing = [root for root in roots if not root.is_dir()]
    if missing:
        raise FileNotFoundError("素材目录不存在: " + "、".join(str(root) for root in missing))

    _check_prerequisites()
    runtime = config.output_dir / ".multicam-sync" / "engine"
    work = config.output_dir / ".multicam-sync" / "work"
    stage = config.output_dir / ".multicam-sync" / "media-layout"
    report_dir = config.output_dir / "sync"
    xml_delivery = config.media_root / "交付" if len(roots) == 1 and config.media_root else roots[0] / "交付"
    runtime.parent.mkdir(parents=True, exist_ok=True)
    engine, engine_source = _materialize_engine(runtime)
    script_dir = engine / "scripts"
    work.mkdir(parents=True, exist_ok=True)
    report_dir.mkdir(parents=True, exist_ok=True)
    xml_delivery.mkdir(parents=True, exist_ok=True)
    media_base, layout, export_base = _prepare_multiple_media_roots(
        roots,
        stage,
        config.camera_patterns,
    )

    def write_builder_config(out_name: str, output: Path = xml_delivery) -> None:
        _write_config(
            script_dir,
            media_base,
            export_base,
            work,
            output,
            config.name,
            out_name,
            config.camera_patterns,
        )

    def emit(text: str) -> None:
        if log:
            log(text)

    def update_progress(done: int, total: int) -> None:
        if progress:
            progress(done, total)

    write_builder_config("synchronized.fcpxml")
    emit(f"同步引擎：{engine_source}")
    emit(f"素材布局：{layout}")
    emit("盘点素材与时间码")
    update_progress(0, 1)
    _run(script_dir, "make_index.py", [], emit)
    update_progress(1, 1)
    emit("提取同步音频缓存")
    workers = str(max(2, min(10, (os.cpu_count() or 4))))
    _run(script_dir, "extract_parallel.py", [workers], emit)
    update_progress(2, 2)
    days = _days_from_index(work)
    total_steps = 2 + len(days) * 3 + 3
    update_progress(2, total_steps)
    positions = []
    for index, day in enumerate(days, start=1):
        emit(f"音频互相关同步 {day}")
        _run(script_dir, "sync.py", [day], emit)
        update_progress(2 + (index - 1) * 3 + 1, total_steps)
        raw = work / f"positions_{day}.tsv"
        if not raw.exists():
            raise RuntimeError(f"同步结果缺失: {raw}")
        compressed = work / f"positions_{day}_compressed.tsv"
        if compress_gaps:
            emit(f"压缩全机停机间隙 {day}")
            _run(script_dir, "compress_gaps.py", [str(raw)], emit)
        else:
            shutil.copyfile(raw, compressed)
        update_progress(2 + (index - 1) * 3 + 2, total_steps)
        if not compressed.exists():
            raise RuntimeError(f"压缩后位置表缺失: {compressed}")
        positions.append(compressed)

    emit("生成标准 FCPXML 1.8 多机位时间线（相对素材路径）")
    write_builder_config("synchronized.fcpxml")
    _run(script_dir, "build_fcpxml.py", [], emit)
    update_progress(total_steps - 2, total_steps)
    fcpxml = xml_delivery / "synchronized.fcpxml"
    if not fcpxml.is_file():
        raise RuntimeError("同步完成但 synchronized.fcpxml 未生成")
    emit("校验 FCPXML 帧边界、素材引用与结构")
    _run(script_dir, "validate_fcpxml.py", [str(fcpxml), str(fcpxml.parent)], emit)
    update_progress(total_steps - 1, total_steps)
    analysis_link = report_dir / "synchronized.fcpxml"
    _refresh_analysis_link(analysis_link, fcpxml)

    capcut = ""
    if (script_dir / "build_capcut_fcpxml.py").is_file():
        try:
            emit("生成标准 FCPXML 1.8 剪映兼容时间线（相对素材路径）")
            write_builder_config("synchronized_final.fcpxml")
            _run(script_dir, "build_capcut_fcpxml.py", [], emit)
            capcut_path = xml_delivery / "synchronized_capcut.fcpxml"
            if capcut_path.is_file():
                _run(script_dir, "validate_fcpxml.py", [str(capcut_path), str(capcut_path.parent)], emit)
                capcut = str(capcut_path)
        except Exception as error:
            emit(f"剪映 / CapCut FCPXML 可选生成失败：{error}")

    report = {
        "status": "completed",
        "engine_source": engine_source,
        "media_root": str(roots[0]),
        "media_roots": [str(root) for root in roots],
        "xml_delivery": str(xml_delivery),
        "normalized_media_base": str(media_base),
        "layout": layout,
        "days": days,
        "positions": [str(path) for path in positions],
        "fcpxml": str(fcpxml),
        "analysis_fcpxml": str(analysis_link),
        "capcut_fcpxml": capcut,
        "media_reference_mode": "relative-to-xml",
        "source_kind": "media-directory",
        "camera_detection": {
            "conventional": ["A", "B", "C", "A机", "B机", "C机"],
            "configured_patterns": sorted(config.camera_patterns),
        },
        "project_promoted_to_fcpxml": False,
    }
    (report_dir / "sync_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    update_progress(total_steps, total_steps)
    return report
