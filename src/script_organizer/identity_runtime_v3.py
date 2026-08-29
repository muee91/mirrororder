from __future__ import annotations

import importlib
import importlib.util
import os
import shutil
import subprocess
import sys
from typing import Any

from .identity_runtime_v2 import (
    FACE_DETECTOR,
    FACE_RECOGNIZER,
    SPEAKER_EMBEDDER,
    SPEAKER_SEGMENTER,
    IdentityRuntime as _IdentityRuntimeV2,
    ModelArtifact,
    _activate_runtime_packages,
    _pip_available,
    identity_model_root,
    identity_python_root,
)


def _importable(name: str, attributes: tuple[str, ...] = ()) -> bool:
    _activate_runtime_packages()
    try:
        module = importlib.import_module(name)
    except Exception:
        return False
    return all(getattr(module, attribute, None) is not None for attribute in attributes)


def _discoverable(name: str) -> bool:
    """Cheap module presence check for read-only status surfaces."""
    _activate_runtime_packages()
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _kind_importable(kind: str) -> bool:
    if kind == "face":
        return _importable("cv2", ("FaceDetectorYN", "FaceRecognizerSF"))
    if kind == "speaker":
        return _importable(
            "sherpa_onnx",
            (
                "SpeakerEmbeddingExtractor",
                "OfflineSpeakerDiarization",
                "OfflineSpeakerDiarizationConfig",
            ),
        )
    raise ValueError("identity kind 必须是 face 或 speaker")


class IdentityRuntime(_IdentityRuntimeV2):
    """Pinned optional runtime installer with complete native dependency checks.

    Full native imports and SHA-256 artifact verification happen only on explicit
    prepare/analysis paths. Public status is deliberately lightweight so opening
    Settings never loads OpenCV/sherpa or hashes model weights.
    """

    @staticmethod
    def dependency_status(kind: str) -> dict[str, Any]:
        """Full runtime validation used by explicit preparation."""
        numpy_ready = _importable("numpy")
        if kind == "face":
            runtime_ready = _kind_importable("face")
            modules = {"numpy": numpy_ready, "cv2": runtime_ready}
            commands: dict[str, bool] = {}
            base_ready = numpy_ready
        elif kind == "speaker":
            runtime_ready = _kind_importable("speaker")
            modules = {"numpy": numpy_ready, "sherpa_onnx": runtime_ready}
            commands = {"ffmpeg": bool(shutil.which("ffmpeg"))}
            base_ready = numpy_ready and commands["ffmpeg"]
        else:
            raise ValueError("identity kind 必须是 face 或 speaker")
        installer = _pip_available()
        return {
            "available": bool(base_ready and runtime_ready),
            "installable": bool(base_ready and installer),
            "installer": "pip" if installer else "",
            "modules": modules,
            "commands": commands,
        }

    @staticmethod
    def status_dependency(kind: str) -> dict[str, Any]:
        """Read-only dependency projection without importing native modules."""
        numpy_ready = _discoverable("numpy")
        if kind == "face":
            runtime_ready = _discoverable("cv2")
            modules = {"numpy": numpy_ready, "cv2": runtime_ready}
            commands: dict[str, bool] = {}
            base_ready = numpy_ready
        elif kind == "speaker":
            runtime_ready = _discoverable("sherpa_onnx")
            modules = {"numpy": numpy_ready, "sherpa_onnx": runtime_ready}
            commands = {"ffmpeg": bool(shutil.which("ffmpeg"))}
            base_ready = numpy_ready and commands["ffmpeg"]
        else:
            raise ValueError("identity kind 必须是 face 或 speaker")
        installer = _pip_available()
        return {
            "available": bool(base_ready and runtime_ready),
            "installable": bool(base_ready and installer),
            "installer": "pip" if installer else "",
            "modules": modules,
            "commands": commands,
        }

    @classmethod
    def public_kind(cls, kind: str) -> dict[str, Any]:
        dependency = cls.status_dependency(kind)
        with cls._lock:
            preparing = kind in cls._preparing
            error = cls._errors.get(kind, "")
        rows = []
        cache_bytes = 0
        for artifact in cls.artifacts(kind):
            path = cls.model_path(kind, artifact)
            try:
                is_file = path.is_file()
                size = path.stat().st_size if is_file else 0
            except OSError:
                is_file = False
                size = 0
            cache_bytes += size
            present = bool(is_file and size == artifact.size_bytes)
            rows.append(
                {
                    "name": artifact.name,
                    "filename": artifact.filename,
                    "ready": present,
                    "bytes": size,
                    "expected_bytes": artifact.size_bytes,
                    "license": artifact.license,
                    "source": artifact.source,
                }
            )
        ready = bool(rows) and all(row["ready"] for row in rows)
        if error:
            status = "error"
        elif preparing:
            status = "preparing"
        elif ready and dependency["available"]:
            status = "ready"
        elif not dependency["available"]:
            status = "missing_runtime"
        else:
            status = "not_prepared"
        return {
            "kind": kind,
            "available": bool(dependency["available"] or dependency["installable"]),
            "prepared": ready,
            "preparing": preparing,
            "status": status,
            "cache_dir": str(cls.model_dir(kind)),
            "cache_bytes": cache_bytes,
            "python_runtime_dir": str(identity_python_root()),
            "dependencies": dependency,
            "artifacts": rows,
            "last_error": error,
            "download_policy": "runtime_only_when_enabled_or_explicitly_prepared",
            "integrity_check": "deferred_to_explicit_prepare",
            "read_path_native_import": False,
            "read_path_sha256": False,
        }

    @classmethod
    def public(cls) -> dict[str, Any]:
        return {
            "face": cls.public_kind("face"),
            "speaker": cls.public_kind("speaker"),
            "root": str(identity_model_root()),
            "python_runtime_root": str(identity_python_root()),
        }

    @classmethod
    def _install_optional_runtime(cls, kind: str) -> None:
        if kind == "face":
            module_name = "cv2"
            packages = ["opencv-python==4.14.0.94"]
        elif kind == "speaker":
            module_name = "sherpa_onnx"
            # Current macOS wheels are split: the Python binding depends on a
            # same-version native core wheel. Install both explicitly so a
            # previous partial install can be repaired deterministically.
            packages = [
                "sherpa-onnx==1.13.5",
                "sherpa-onnx-core==1.13.5",
            ]
        else:
            raise ValueError("identity kind 必须是 face 或 speaker")

        if _kind_importable(kind):
            return
        if not _pip_available():
            raise RuntimeError(f"当前 Python 没有 pip，无法自动安装 {', '.join(packages)}")
        root = identity_python_root()
        root.mkdir(parents=True, exist_ok=True)
        command = [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--only-binary=:all:",
            "--no-deps",
            "--upgrade",
            "--target",
            str(root),
            *packages,
        ]
        env = dict(os.environ)
        env.setdefault("PIP_NO_PYTHON_VERSION_WARNING", "1")
        try:
            completed = subprocess.run(
                command,
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=600,
                env=env,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise RuntimeError(f"安装本地识别运行时失败：{error}") from error
        if completed.returncode != 0:
            tail = "\n".join((completed.stdout or "").splitlines()[-10:])
            raise RuntimeError(f"安装本地识别运行时失败：{tail}"[:1800])
        _activate_runtime_packages()
        importlib.invalidate_caches()
        # A failed native import can leave a partial module in sys.modules.
        sys.modules.pop(module_name, None)
        if not _kind_importable(kind):
            raise RuntimeError(
                f"{', '.join(packages)} 已安装，但模块 {module_name} 的本地推理 API 无法加载"
            )


__all__ = [
    "ModelArtifact",
    "FACE_DETECTOR",
    "FACE_RECOGNIZER",
    "SPEAKER_SEGMENTER",
    "SPEAKER_EMBEDDER",
    "IdentityRuntime",
    "identity_model_root",
    "identity_python_root",
]
