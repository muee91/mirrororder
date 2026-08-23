from __future__ import annotations

import importlib
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
    """Pinned optional runtime installer with complete native dependency checks."""

    @staticmethod
    def dependency_status(kind: str) -> dict[str, Any]:
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
