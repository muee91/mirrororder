from __future__ import annotations

import csv
import importlib.util
import json
import os
from queue import Empty, Queue
import signal
import shutil
import subprocess
import sys
from pathlib import Path
from threading import Thread
from time import monotonic
from typing import Any, Callable

from .config import ProjectConfig
from .media_reader import infer_camera_label
from .media_role_store import MediaRoleStore
from .resource_scheduler import ResourceCancelled


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
    "validate_capcut_draft.py",
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


def _resolve_engine() -> tuple[Path, str]:
    for candidate in _engine_candidates():
        if _valid_engine(candidate):
            resolved = candidate.resolve()
            return resolved, str(resolved)
    raise MulticamSyncUnavailable(
        "未找到镜序内置的第一方 multicam-audio-sync。请检查 App runtime 或 "
        "repo vendor/multicam-audio-sync；开发时可显式设置 MIRRORORDER_MULTICAM_SYNC_ROOT。"
    )


def _engine_origin(path: Path) -> str:
    override = os.environ.get("MIRRORORDER_MULTICAM_SYNC_ROOT", "").strip()
    if override and path == Path(override).expanduser().resolve():
        return "development-override"
    normalized = str(path)
    if "/Contents/Resources/runtime/" in normalized:
        return "app-bundled"
    return "workspace-first-party"


def _terminate_process_tree(process: subprocess.Popen[str], grace_seconds: float = 2.0) -> None:
    """Stop only the subprocess tree created for one vendor stage.

    Vendor scripts may spawn ffmpeg/ffprobe descendants. Killing only the Python
    wrapper leaves those children consuming CPU and disk after the user presses
    Cancel. Each stage is therefore started in its own process group/session and
    cancellation targets that group, never a process name shared with unrelated
    applications.
    """
    if process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                text=True,
                timeout=max(1.0, grace_seconds),
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            try:
                process.kill()
            except OSError:
                pass
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                process.terminate()
            except OSError:
                pass

    try:
        process.wait(timeout=max(0.25, grace_seconds))
        return
    except subprocess.TimeoutExpired:
        pass

    if os.name == "nt":
        try:
            process.kill()
        except OSError:
            pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            try:
                process.kill()
            except OSError:
                pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass


def _run(
    script_dir: Path,
    script: str,
    args: list[str],
    log: Callable[[str], None] | None = None,
    timeout: int = 60 * 60 * 6,
    config_path: Path | None = None,
    cancel_requested: Callable[[], bool] | None = None,
) -> str:
    command = [sys.executable, str(script_dir / script), *args]
    environment = os.environ.copy()
    if config_path is not None:
        environment["MIRRORORDER_MULTICAM_CONFIG"] = str(config_path)
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
    process = subprocess.Popen(
        command,
        cwd=script_dir,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=os.name != "nt",
        creationflags=creationflags,
    )
    output: Queue[str | None] = Queue()
    lines: list[str] = []

    def read_output() -> None:
        try:
            assert process.stdout is not None
            for raw in process.stdout:
                output.put(raw.rstrip())
        finally:
            output.put(None)

    reader = Thread(target=read_output, daemon=True, name=f"multicam-output-{process.pid}")
    reader.start()
    deadline = monotonic() + max(0.1, float(timeout))
    reader_done = False
    try:
        while True:
            if cancel_requested is not None and cancel_requested():
                _terminate_process_tree(process)
                raise ResourceCancelled(f"多机位同步已取消 · {script}")
            remaining = deadline - monotonic()
            if remaining <= 0:
                _terminate_process_tree(process)
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                item = output.get(timeout=min(0.1, remaining))
            except Empty:
                item = ""
            if item is None:
                reader_done = True
            elif item:
                lines.append(item)
                if log:
                    log(item[-500:])
            if process.poll() is not None and reader_done:
                break
        return_code = process.wait(timeout=1)
    except BaseException:
        if process.poll() is None:
            _terminate_process_tree(process)
        raise
    finally:
        reader.join(timeout=1)
        if process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass
    if cancel_requested is not None and cancel_requested():
        raise ResourceCancelled(f"多机位同步已取消 · {script}")
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


def _clear_link_target(path: Path) -> None:
    """Remove a staging entry without ever deleting the linked source tree."""
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    if not path.exists():
        return
    # On Python 3.11+ Windows, rmtree removes a directory junction itself and
    # does not recurse into the junction target. On POSIX this branch is only
    # used for a real staging directory created by MirrorOrder.
    shutil.rmtree(path)


def _link_directory(link: Path, target: Path) -> str:
    """Create an unprivileged directory link for the normalized sync view.

    POSIX uses a normal symlink. Windows uses an NTFS directory junction, which
    does not require Developer Mode or Administrator elevation and can point to
    another local volume. No media bytes are copied.
    """
    target = target.expanduser().resolve()
    if not target.is_dir():
        raise FileNotFoundError(f"同步目录不存在: {target}")
    link.parent.mkdir(parents=True, exist_ok=True)
    _clear_link_target(link)
    if os.name != "nt":
        link.symlink_to(target, target_is_directory=True)
        return "symlink"

    result = subprocess.run(
        ["cmd", "/d", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0 or not link.exists():
        detail = (result.stderr or result.stdout or "mklink /J failed").strip()
        raise MulticamSyncUnavailable(
            "Windows 无法创建多机位同步目录 junction。镜序不会复制媒体作为降级方案。"
            f"请确认素材与项目位于本机可读文件系统。详情: {detail}"
        )
    return "junction"


def _prepare_media_base(
    source: Path,
    stage_root: Path,
    camera_patterns: dict[str, str] | None = None,
) -> tuple[Path, str]:
    """Accept day/camera and direct camera roots without copying media."""
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
    if stage_root.exists() or stage_root.is_symlink():
        _clear_link_target(stage_root)
    stage_root.mkdir(parents=True, exist_ok=True)
    # The engine wants a day directory. Link the whole source root as day1
    # instead of linking every camera/media item. This is both cheaper and avoids
    # Windows per-file symlink privileges while preserving the original layout.
    link_kind = _link_directory(stage_root / "day1", source)
    return stage_root, f"normalized-single-day-{link_kind}"


def _prepare_multiple_media_roots(
    roots: tuple[Path, ...],
    stage_root: Path,
    camera_patterns: dict[str, str] | None = None,
) -> tuple[Path, str, Path]:
    """Build a link-only engine view for several device-local roots."""
    if not roots:
        raise ValueError("媒体目录项目缺少本机素材根目录")
    if len(roots) == 1:
        base, layout = _prepare_media_base(roots[0], stage_root, camera_patterns)
        return base, layout, roots[0]
    if stage_root.exists() or stage_root.is_symlink():
        _clear_link_target(stage_root)
    stage_root.mkdir(parents=True, exist_ok=True)
    used_names: set[str] = set()
    day_index = 1
    link_kinds: set[str] = set()
    linked = 0
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
            link_kinds.add(_link_directory(target, candidate))
            linked += 1
    if not linked:
        raise ValueError("选中的素材根目录没有可用于同步的内容")
    try:
        export_base = Path(os.path.commonpath([str(root.resolve()) for root in roots]))
    except ValueError as error:
        # Relative FCPXML media URLs cannot cross Windows drive letters. Do not
        # silently emit paths relative to an unrelated drive/root.
        raise MulticamSyncUnavailable(
            "多个素材根目录没有共同的本机路径基准（常见于 Windows 跨盘符）。"
            "当前相对路径 FCPXML 导出无法安全表示这种布局；请先将本次同步素材放到同一盘符/共同根目录。"
        ) from error
    layout_kind = "+".join(sorted(link_kinds)) or "link"
    return stage_root, f"normalized-multiple-roots-{layout_kind}", export_base


def _sync_media_roles(config: ProjectConfig) -> tuple[dict[str, dict[str, str]], list[str], dict[str, int]]:
    """Return path-free media-role facts needed only by the sync task.

    The vendor engine receives media_id -> {camera_override, source_role,
    sync_policy}; no device path, scene assignment, note, actor or review data is
    projected into its temporary config.
    """
    payload = MediaRoleStore(config.output_dir).load()
    rows = payload.get("media", {}) if isinstance(payload.get("media"), dict) else {}
    projected: dict[str, dict[str, str]] = {}
    camera_labels: set[str] = set()
    excluded = 0
    overridden = 0
    for media_id, raw in rows.items():
        if not isinstance(raw, dict) or not str(media_id).startswith("M_"):
            continue
        sync_policy = str(raw.get("sync_policy", "auto") or "auto")
        camera = str(raw.get("camera_override", "") or "").strip().upper()
        source_role = str(raw.get("source_role", "sync_camera") or "sync_camera")
        if sync_policy == "auto" and not camera and source_role == "sync_camera":
            continue
        projected[str(media_id)] = {
            "camera_override": camera,
            "source_role": source_role,
            "sync_policy": sync_policy,
        }
        if sync_policy == "exclude":
            excluded += 1
        if camera:
            overridden += 1
            if sync_policy != "exclude":
                camera_labels.add(camera)
    return projected, sorted(camera_labels), {
        "projected": len(projected),
        "excluded": excluded,
        "camera_overrides": overridden,
    }


def _write_config(
    config_path: Path,
    base: Path,
    export_base: Path,
    work: Path,
    output: Path,
    project_name: str,
    out_name: str,
    camera_patterns: dict[str, str] | None = None,
    media_roles: dict[str, dict[str, str]] | None = None,
    camera_labels: list[str] | None = None,
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
            "media_roles": dict(media_roles or {}),
            "camera_labels": list(camera_labels or []),
        },
    }
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _refresh_analysis_reference(link: Path, target: Path) -> tuple[Path, str]:
    """Preserve relative-URL semantics while keeping the legacy alias when safe.

    A copied or hard-linked FCPXML would be byte-identical but resolve relative
    media URLs against the wrong directory. Therefore Windows without symlink
    capability falls back to the real delivery XML path instead of duplicating
    the file under the project output directory.
    """
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() or link.exists():
        _clear_link_target(link)
    try:
        link.symlink_to(target.resolve())
        return link, "symlink"
    except OSError:
        if os.name == "nt":
            return target.resolve(), "delivery-source"
        raise RuntimeError(
            "无法创建项目内部 synchronized.fcpxml 链接；为避免相对素材路径基准错误，"
            "镜序不会复制一份到其他目录。请确认项目磁盘支持符号链接。"
        )


def run_multicam_sync(
    config: ProjectConfig,
    log: Callable[[str], None] | None = None,
    compress_gaps: bool = True,
    progress: Callable[[int, int], None] | None = None,
    cancel_requested: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    def check_cancelled() -> None:
        if cancel_requested is not None and cancel_requested():
            raise ResourceCancelled("多机位同步已按请求取消")

    check_cancelled()
    roots = tuple(config.media_roots or ((config.media_root,) if config.media_root else ()))
    if not config.is_media_directory or not roots:
        if config.fcpxml and config.fcpxml.exists():
            return {"status": "skipped", "reason": "项目已有 FCPXML", "fcpxml": str(config.fcpxml)}
        raise ValueError("multicam_sync 只用于媒体目录项目")
    missing = [root for root in roots if not root.is_dir()]
    if missing:
        raise FileNotFoundError("素材目录不存在: " + "、".join(str(root) for root in missing))

    _check_prerequisites()
    check_cancelled()
    project_runtime = config.output_dir / ".multicam-sync"
    project_config = project_runtime / "config.json"
    work = config.output_dir / ".multicam-sync" / "work"
    stage = config.output_dir / ".multicam-sync" / "media-layout"
    report_dir = config.output_dir / "sync"
    xml_delivery = config.media_root / "交付" if len(roots) == 1 and config.media_root else roots[0] / "交付"
    project_runtime.mkdir(parents=True, exist_ok=True)
    engine, engine_source = _resolve_engine()
    engine_origin = _engine_origin(engine)
    script_dir = engine / "scripts"
    work.mkdir(parents=True, exist_ok=True)
    report_dir.mkdir(parents=True, exist_ok=True)
    xml_delivery.mkdir(parents=True, exist_ok=True)
    media_base, layout, export_base = _prepare_multiple_media_roots(
        roots,
        stage,
        config.camera_patterns,
    )
    check_cancelled()
    media_roles, camera_labels, media_role_summary = _sync_media_roles(config)

    def write_builder_config(out_name: str, output: Path = xml_delivery) -> None:
        _write_config(
            project_config,
            media_base,
            export_base,
            work,
            output,
            config.name,
            out_name,
            config.camera_patterns,
            media_roles,
            camera_labels,
        )

    def emit(text: str) -> None:
        if log:
            log(text)

    def update_progress(done: int, total: int) -> None:
        if progress:
            progress(done, total)

    def run_stage(script: str, args: list[str]) -> str:
        check_cancelled()
        return _run(
            script_dir,
            script,
            args,
            emit,
            config_path=project_config,
            cancel_requested=cancel_requested,
        )

    write_builder_config("synchronized.fcpxml")
    emit(f"素材对齐算法引擎：项目内第一方（{engine_origin}）")
    emit(f"素材布局：{layout}")
    if media_role_summary["excluded"]:
        emit(f"辅助素材：{media_role_summary['excluded']} 条已标记为不参与同步")
    if media_role_summary["camera_overrides"]:
        emit(f"机位覆盖：{media_role_summary['camera_overrides']} 条人工机位标记")
    emit("盘点素材与时间码")
    update_progress(0, 1)
    run_stage("make_index.py", [])
    update_progress(1, 1)
    emit("提取同步音频缓存")
    workers = str(max(2, min(10, (os.cpu_count() or 4))))
    run_stage("extract_parallel.py", [workers])
    update_progress(2, 2)
    check_cancelled()
    days = _days_from_index(work)
    total_steps = 2 + len(days) * 3 + 3
    update_progress(2, total_steps)
    positions = []
    for index, day in enumerate(days, start=1):
        emit(f"音频互相关同步 {day}")
        run_stage("sync.py", [day])
        update_progress(2 + (index - 1) * 3 + 1, total_steps)
        raw = work / f"positions_{day}.tsv"
        if not raw.exists():
            raise RuntimeError(f"同步结果缺失: {raw}")
        compressed = work / f"positions_{day}_compressed.tsv"
        if compress_gaps:
            emit(f"压缩全机停机间隙 {day}")
            run_stage("compress_gaps.py", [str(raw)])
        else:
            check_cancelled()
            shutil.copyfile(raw, compressed)
        update_progress(2 + (index - 1) * 3 + 2, total_steps)
        if not compressed.exists():
            raise RuntimeError(f"压缩后位置表缺失: {compressed}")
        positions.append(compressed)

    check_cancelled()
    emit("生成标准 FCPXML 1.8 多机位时间线（相对素材路径）")
    write_builder_config("synchronized.fcpxml")
    run_stage("build_fcpxml.py", [])
    update_progress(total_steps - 2, total_steps)
    fcpxml = xml_delivery / "synchronized.fcpxml"
    if not fcpxml.is_file():
        raise RuntimeError("同步完成但 synchronized.fcpxml 未生成")
    emit("校验 FCPXML 帧边界、素材引用与结构")
    run_stage("validate_fcpxml.py", [str(fcpxml), str(fcpxml.parent)])
    update_progress(total_steps - 1, total_steps)
    check_cancelled()
    analysis_path, analysis_reference_mode = _refresh_analysis_reference(
        report_dir / "synchronized.fcpxml",
        fcpxml,
    )

    capcut = ""
    capcut_draft = ""
    capcut_draft_validation = ""
    premiere = ""
    if (script_dir / "build_capcut_fcpxml.py").is_file():
        try:
            emit("生成标准 FCPXML 1.8 剪映兼容时间线（相对素材路径）")
            write_builder_config("synchronized_final.fcpxml")
            run_stage("build_capcut_fcpxml.py", [])
            capcut_path = xml_delivery / "synchronized_capcut.fcpxml"
            if capcut_path.is_file():
                run_stage("validate_fcpxml.py", [str(capcut_path), str(capcut_path.parent)])
                capcut = str(capcut_path)
        except ResourceCancelled:
            raise
        except Exception as error:
            emit(f"剪映 / CapCut FCPXML 可选生成失败：{error}")

    if (script_dir / "build_capcut_draft_31.py").is_file():
        try:
            emit("生成剪映原生 3+1 多机位草稿")
            write_builder_config("synchronized.fcpxml")
            run_stage("build_capcut_draft_31.py", [])
            draft_path = xml_delivery / f"{config.name}_音频同步多机位_capcut_draft"
            if draft_path.is_dir():
                capcut_draft = str(draft_path)
                emit("校验剪映 3+1 草稿结构")
                run_stage("validate_capcut_draft.py", [str(draft_path), "--mode=raw"])
                capcut_draft_validation = "passed"
        except ResourceCancelled:
            raise
        except Exception as error:
            capcut_draft_validation = f"failed: {error}"
            emit(f"剪映 3+1 草稿可选生成或校验失败：{error}")

    if (script_dir / "build_pr_xml.py").is_file():
        try:
            emit("生成 Premiere FCP7/xmeml v4 同步 XML")
            write_builder_config("synchronized_premiere.xml")
            run_stage("build_pr_xml.py", [])
            premiere_path = xml_delivery / "synchronized_premiere.xml"
            if premiere_path.is_file():
                premiere = str(premiere_path)
        except ResourceCancelled:
            raise
        except Exception as error:
            emit(f"Premiere XML 可选生成失败：{error}")

    check_cancelled()
    report = {
        "status": "completed",
        "engine_source": "project-first-party",
        "engine_origin": engine_origin,
        "engine_execution": "in_place",
        "external_skill_dependency": False,
        "media_root": str(roots[0]),
        "media_roots": [str(root) for root in roots],
        "xml_delivery": str(xml_delivery),
        "normalized_media_base": str(media_base),
        "layout": layout,
        "days": days,
        "positions": [str(path) for path in positions],
        "fcpxml": str(fcpxml),
        "analysis_fcpxml": str(analysis_path),
        "analysis_reference_mode": analysis_reference_mode,
        "capcut_fcpxml": capcut,
        "capcut_draft": capcut_draft,
        "capcut_draft_validation": capcut_draft_validation,
        "premiere_xml": premiere,
        "media_reference_mode": "relative-to-xml",
        "source_kind": "media-directory",
        "camera_detection": {
            "conventional": ["A", "B", "C", "A机", "B机", "C机"],
            "configured_patterns": sorted(config.camera_patterns),
            "manual_camera_labels": camera_labels,
        },
        "media_roles": {
            **media_role_summary,
            "paths_projected": False,
            "identity": "media_id",
        },
        "project_promoted_to_fcpxml": False,
    }
    (report_dir / "sync_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    check_cancelled()
    update_progress(total_steps, total_steps)
    return report