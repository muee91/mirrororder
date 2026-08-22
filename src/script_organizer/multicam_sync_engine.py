from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

from .config import ProjectConfig


class MulticamSyncUnavailable(RuntimeError):
    pass


def _engine_candidates() -> list[Path]:
    result = []
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
    seen = set()
    unique = []
    for path in result:
        resolved = str(path)
        if resolved not in seen:
            seen.add(resolved)
            unique.append(path)
    return unique


def find_engine_root() -> Path:
    for candidate in _engine_candidates():
        scripts = candidate / "scripts"
        if all((scripts / name).is_file() for name in (
            "project_config.py",
            "make_index.py",
            "extract_parallel.py",
            "sync.py",
            "compress_gaps.py",
            "build_fcpxml.py",
        )):
            return candidate
    raise MulticamSyncUnavailable(
        "未找到 multicam-audio-sync 引擎。构建镜序.app 时会优先打包 "
        "vendor/multicam-audio-sync 或 ~/.agents/skills/multicam-audio-sync；"
        "也可设置 MIRRORORDER_MULTICAM_SYNC_ROOT。"
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

    engine = find_engine_root()
    runtime = config.output_dir / ".multicam-sync" / "engine"
    work = config.output_dir / ".multicam-sync" / "work"
    delivery = config.output_dir / "sync"
    runtime.parent.mkdir(parents=True, exist_ok=True)
    if runtime.exists():
        shutil.rmtree(runtime)
    shutil.copytree(engine, runtime, ignore=shutil.ignore_patterns("__pycache__", "._*"))
    script_dir = runtime / "scripts"
    work.mkdir(parents=True, exist_ok=True)
    delivery.mkdir(parents=True, exist_ok=True)
    _write_config(script_dir, config.media_root, work, delivery, config.name)

    def emit(text: str) -> None:
        if log:
            log(text)

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
        if compress_gaps:
            emit(f"压缩全机停机间隙 {day}")
            _run(script_dir, "compress_gaps.py", [str(raw)], emit)
            positions.append(work / f"positions_{day}_compressed.tsv")
        else:
            compressed = work / f"positions_{day}_compressed.tsv"
            shutil.copyfile(raw, compressed)
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
        "engine_root": str(engine),
        "media_root": str(config.media_root),
        "days": days,
        "positions": [str(path) for path in positions],
        "fcpxml": str(fcpxml),
        "premiere_xml": premiere,
        "project_promoted_to_fcpxml": True,
    }
    (delivery / "sync_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report
