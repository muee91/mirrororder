from __future__ import annotations

import importlib.util
import os
import shutil
import socket
import sys
from pathlib import Path
from typing import Any

from .multicam_sync_engine import _engine_candidates, _valid_engine


def _command_status(name: str) -> dict[str, Any]:
    path = shutil.which(name)
    return {"name": name, "available": bool(path), "path": path or ""}


def _module_status(name: str, required: bool) -> dict[str, Any]:
    try:
        available = importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        available = False
    return {"name": name, "available": available, "required": required}


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".mirrororder-write-test"
        probe.write_bytes(b"ok")
        probe.unlink()
        return True
    except OSError:
        return False


def _engine_status() -> dict[str, Any]:
    for candidate in _engine_candidates():
        if _valid_engine(candidate):
            return {"available": True, "path": str(candidate)}
    return {"available": False, "path": ""}


def environment_payload(workspaces: list[Path] | None = None) -> dict[str, Any]:
    workspaces = workspaces or []
    commands = [_command_status(name) for name in ("ffmpeg", "ffprobe", "llama-server")]
    modules = [
        _module_status("numpy", True),
        _module_status("pandas", True),
        _module_status("scipy", True),
        _module_status("faster_whisper", False),
        _module_status("mlx_whisper", False),
        _module_status("cv2", False),
        _module_status("sherpa_onnx", False),
    ]
    command_map = {item["name"]: item for item in commands}
    module_map = {item["name"]: item for item in modules}
    workspace_rows = [
        {
            "path": str(path),
            "exists": path.is_dir(),
            "writable": _writable(path) if path.is_dir() else False,
        }
        for path in workspaces
    ]
    required_ok = (
        command_map["ffmpeg"]["available"]
        and command_map["ffprobe"]["available"]
        and all(module_map[name]["available"] for name in ("numpy", "pandas", "scipy"))
    )
    return {
        "python": {
            "executable": sys.executable,
            "version": sys.version.split()[0],
        },
        "commands": commands,
        "python_modules": modules,
        "multicam_engine": _engine_status(),
        "workspaces": workspace_rows,
        "media_directory_sync_ready": bool(required_ok),
        "identity_runtime": {
            "face": bool(module_map["numpy"]["available"] and module_map["cv2"]["available"]),
            "speaker": bool(
                module_map["numpy"]["available"]
                and module_map["sherpa_onnx"]["available"]
                and command_map["ffmpeg"]["available"]
            ),
        },
        "host": socket.gethostname(),
        "platform": sys.platform,
        "data_root": os.environ.get("MIRRORORDER_DATA_DIR", ""),
    }
