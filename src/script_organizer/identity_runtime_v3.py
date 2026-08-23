from __future__ import annotations

import os
import subprocess
import sys

from .identity_runtime_v2 import (
    FACE_DETECTOR,
    FACE_RECOGNIZER,
    SPEAKER_EMBEDDER,
    SPEAKER_SEGMENTER,
    IdentityRuntime as _IdentityRuntimeV2,
    ModelArtifact,
    _activate_runtime_packages,
    _module,
    _pip_available,
    identity_model_root,
    identity_python_root,
)


class IdentityRuntime(_IdentityRuntimeV2):
    """Pinned optional runtime installer with complete sherpa native closure."""

    @classmethod
    def _install_optional_runtime(cls, kind: str) -> None:
        if kind == "face":
            module_name = "cv2"
            packages = ["opencv-python==4.14.0.94"]
        elif kind == "speaker":
            module_name = "sherpa_onnx"
            # sherpa-onnx uses a split package on current macOS wheels. Keep the
            # Python binding and native core on exactly the same pinned version
            # instead of relying on an unconstrained dependency resolver.
            packages = [
                "sherpa-onnx==1.13.5",
                "sherpa-onnx-core==1.13.5",
            ]
        else:
            raise ValueError("identity kind 必须是 face 或 speaker")

        if _module(module_name):
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
        if not _module(module_name):
            raise RuntimeError(
                f"{', '.join(packages)} 已安装，但模块 {module_name} 无法加载"
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
