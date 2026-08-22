from __future__ import annotations

import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable

from .config import ProjectConfig


class MulticamSyncUnavailable(RuntimeError):
    pass


_REQUIRED_SCRIPTS = (
    "project_config.py",
    "make_index.py",
    "extract_parallel.py",
    "sync.py",
    "compress_gaps.py",
    "build_fcpxml.py",
)
_MEDIA_SUFFIXES = {".mp4", ".mov", ".mxf", ".mts", ".3gp", ".mpg", ".mpeg"}
_CAMERA_DIR = re.compile(r"^(?:camera|cam)?[_-]?([A-Za-z])\d*", re.IGNORECASE)


def _engine_candidates() -> list[Path]:
    result: list[Path] = []
    env = os.environ.get("MIRRORORDER_MULTICAM_SYNC_ROOT", "").strip()
    if env:
        result.append(Path(env).expanduser())
    module = Path(__file__).resolve()
    for parent in module.parents:
        result.extend([
            parent / "multicam-audio-sync",
            parent / "vendor" / "multicam-audio-sync",
        ])
    result.append(Path.home() / ".agents" / "skills" / "multicam-audio-sync")
    seen: set[str] = set()
    unique = []
    for path in result:
        key = str(path)
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def _zip_candidates() -> list[Path]:
    result: list[Path] = []
    env = os.environ.get("MIRRORORDER_MULTICAM_SYNC_ZIP", "").strip()
    if env:
        result.append(Path(env).expanduser())
    module = Path(__file__).resolve()
    for parent in module.parents:
        result.extend([
            parent / "multicam-audio-sync-core.zip",
            parent / "vendor" / "multicam-audio-sync-core.zip",
        ])
    seen: set[str] = set()
    unique = []
    for path in result:
        key = str(path)
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def _valid_engine(path: Path) -> bool:
    scripts = path / "scripts"
    return all((scripts / name).is_file() for name in _REQUIRED_SCRIPTS)


def _materialize_engine(runtime: Path) -> tuple[Path, str]:
    if runtime.exists():
        shutil.rmtree(runtime)
    for candidate in _engine_candidates():
        if _valid_engine(candidate):
            shutil.copytree(candidate, runtime, ignore=shutil.ignore_patterns("__pycache__", "._*"))
            return runtime, str(candidate)
    archive = next((path for path in _zip_candidates() if path.is_file()), None)
    if archive is not None:
        scripts = runtime / "scripts"
        scripts.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as handle:
            for info in handle.infolist():
                name = Path(info.filename).name
                if not name or name.startswith("._") or name == "__MACOSX":
                    continue
                if name.endswith(".py") or name == "config.json":
                    (scripts / name).write_bytes(handle.read(info))
        if _valid_engine(runtime):
            return runtime, str(archive)
        shutil.rmtree(runtime, ignore_errors=True)
    raise MulticamSyncUnavailable(
        "未找到可运行的 multicam-audio-sync。镜序优先使用 App runtime / repo vendor 固定版本，"
        "其次接受 MIRRORORDER_MULTICAM_SYNC_ROOT 或 ~/.agents/skills/multicam-audio-sync。"
    )


def _run(
    script_dir: Path,
    script: str,
    args: list[str],
    log: Callable[[str], None] | None = None,
    timeout: int = 60 * 60 * 6,
) -> str:
    command = [sys.executable, str(script_dir / script), *args]
    process = subprocess.Popen(
        command,
        cwd=script_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
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


def _looks_like_camera_dir(path: Path) -> bool:
    return path.is_dir() and bool(_CAMERA_DIR.match(path.name)) and _has_media(path)


def _has_day_layout(source: Path) -> bool:
    try:
        for day in source.iterdir():
            if not day.is_dir() or day.name.startswith("."):
                continue
            try:
                if any(_looks_like_camera_dir(child) for child in day.iterdir() if child.is_dir()):
                    return True
            except OSError:
                continue
    except OSError:
        return False
    return False


def _prepare_media_base(source: Path, stage_root: Path) -> tuple[Path, str]:
    """Accept both `day/A1` and direct `A1` roots without copying media."""
    if _has_day_layout(source):
        return source, "day-folders"
    try:
        direct_cameras = [item for item in source.iterdir() if _looks_like_camera_dir(item)]
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


def _write_config(script_dir: Path, base: Path, work: Path, output: Path, project_name: str) -> None:
    payload = {
        "BASE": str(base),
        "WORK": str(work),
        "OUT_DIR": str(output),
        "manual": {
            "project_name": project_name,
            "out_name": "synchronized.fcpxml",
        },
    }
    (script_dir / "config.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _toml_string(value: Path) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def _promote_config(config_path: Path, fcpxml: Path) -> None:
    text = config_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    result = []
    in_input = False
    seen_kind = False
    seen_fcpxml = False
    inserted = False
    quoted = _toml_string(fcpxml)
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if in_input and not inserted:
                if not seen_kind:
                    result.append('kind = "fcpxml"')
                if not seen_fcpxml:
                    result.append(f'fcpxml = "{quoted}"')
                inserted = True
            in_input = stripped == "[input]"
        if in_input and stripped.startswith("kind") and "=" in stripped:
            result.append('kind = "fcpxml"')
            seen_kind = True
            continue
        if in_input and stripped.startswith("fcpxml") and "=" in stripped:
            result.append(f'fcpxml = "{quoted}"')
            seen_fcpxml = True
            continue
        result.append(line)
    if in_input and not inserted:
        if not seen_kind:
            result.append('kind = "fcpxml"')
        if not seen_fcpxml:
            result.append(f'fcpxml = "{quoted}"')
    fd, temporary = tempfile.mkstemp(prefix=config_path.name + ".", suffix=".tmp", dir=config_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(result) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, config_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run_multicam_sync(
    config: ProjectConfig,
    log: Callable[[str], None] | None = None,
    compress_gaps: bool = True,
) -> dict[str, Any]:
    if not config.is_media_directory or not config.media_root:
        if config.fcpxml and config.fcpxml.exists():
            return {"status": "skipped", "reason": "项目已有 FCPXML", "fcpxml": str(config.fcpxml)}
        raise ValueError("multicam_sync 只用于媒体目录项目")
    if not config.media_root.is_dir():
        raise FileNotFoundError(f"素材目录不存在: {config.media_root}")

    runtime = config.output_dir / ".multicam-sync" / "engine"
    work = config.output_dir / ".multicam-sync" / "work"
    stage = config.output_dir / ".multicam-sync" / "media-layout"
    delivery = config.output_dir / "sync"
    runtime.parent.mkdir(parents=True, exist_ok=True)
    engine, engine_source = _materialize_engine(runtime)
    script_dir = engine / "scripts"
    work.mkdir(parents=True, exist_ok=True)
    delivery.mkdir(parents=True, exist_ok=True)
    media_base, layout = _prepare_media_base(config.media_root, stage)
    _write_config(script_dir, media_base, work, delivery, config.name)

    def emit(text: str) -> None:
        if log:
            log(text)

    emit(f"同步引擎：{engine_source}")
    emit(f"素材布局：{layout}")
    emit("盘点素材与时间码")
    _run(script_dir, "make_index.py", [], emit)
    emit("提取同步音频缓存")
    workers = str(max(2, min(10, (os.cpu_count() or 4))))
    _run(script_dir, "extract_parallel.py", [workers], emit)
    days = _days_from_index(work)
    positions = []
    for day in days:
        emit(f"音频互相关同步 {day}")
        _run(script_dir, "sync.py", [day], emit)
        raw = work / f"positions_{day}.tsv"
        if not raw.exists():
            raise RuntimeError(f"同步结果缺失: {raw}")
        compressed = work / f"positions_{day}_compressed.tsv"
        if compress_gaps:
            emit(f"压缩全机停机间隙 {day}")
            _run(script_dir, "compress_gaps.py", [str(raw)], emit)
        else:
            shutil.copyfile(raw, compressed)
        if not compressed.exists():
            raise RuntimeError(f"压缩后位置表缺失: {compressed}")
        positions.append(compressed)

    emit("生成 FCPXML 1.8 多机位时间线")
    _run(script_dir, "build_fcpxml.py", [], emit)
    fcpxml = delivery / "synchronized.fcpxml"
    if not fcpxml.is_file():
        raise RuntimeError("同步完成但 synchronized.fcpxml 未生成")

    premiere = ""
    if (script_dir / "build_pr_xml.py").is_file():
        try:
            emit("生成 Premiere XML")
            _run(script_dir, "build_pr_xml.py", [], emit)
            xmls = sorted(delivery.glob("*.xml"), key=lambda path: path.stat().st_mtime_ns, reverse=True)
            premiere = str(xmls[0]) if xmls else ""
        except Exception as error:
            emit(f"Premiere XML 可选生成失败：{error}")

    _promote_config(config.config_path, fcpxml)
    report = {
        "status": "completed",
        "engine_source": engine_source,
        "media_root": str(config.media_root),
        "normalized_media_base": str(media_base),
        "layout": layout,
        "days": days,
        "positions": [str(path) for path in positions],
        "fcpxml": str(fcpxml),
        "premiere_xml": premiere,
        "project_promoted_to_fcpxml": True,
    }
    (delivery / "sync_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report
