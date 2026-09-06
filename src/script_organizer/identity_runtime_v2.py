from __future__ import annotations

import hashlib
import importlib
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ModelArtifact:
    name: str
    filename: str
    url: str
    sha256: str
    size_bytes: int
    license: str
    source: str


FACE_DETECTOR = ModelArtifact(
    name="OpenCV YuNet",
    filename="face_detection_yunet_2023mar.onnx",
    url=(
        "https://huggingface.co/opencv/face_detection_yunet/resolve/main/"
        "face_detection_yunet_2023mar.onnx?download=true"
    ),
    sha256="8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    size_bytes=232589,
    license="MIT",
    source="opencv/face_detection_yunet",
)
FACE_RECOGNIZER = ModelArtifact(
    name="OpenCV SFace",
    filename="face_recognition_sface_2021dec.onnx",
    url=(
        "https://huggingface.co/opencv/face_recognition_sface/resolve/main/"
        "face_recognition_sface_2021dec.onnx?download=true"
    ),
    sha256="0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    size_bytes=38696353,
    license="Apache-2.0",
    source="opencv/face_recognition_sface",
)
SPEAKER_SEGMENTER = ModelArtifact(
    name="Pyannote Segmentation 3.0 ONNX",
    filename="pyannote_segmentation_3_0.onnx",
    url=(
        "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/"
        "resolve/main/model.onnx?download=true"
    ),
    sha256="220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    size_bytes=5992913,
    license="MIT",
    source="csukuangfj/sherpa-onnx-pyannote-segmentation-3-0",
)
SPEAKER_EMBEDDER = ModelArtifact(
    name="WeSpeaker ResNet34 CN-Celeb",
    filename="wespeaker_zh_cnceleb_resnet34.onnx",
    url=(
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
        "speaker-recongition-models/wespeaker_zh_cnceleb_resnet34.onnx"
    ),
    sha256="f86cd6c509f331f0e20b07bd48d1b2eb7de54202643401c4e84695ac861a0e5a",
    size_bytes=26534363,
    license="Apache-2.0",
    source="k2-fsa/sherpa-onnx speaker-recongition-models",
)

_RUNTIME_PACKAGES = {
    "face": ("cv2", "opencv-python==4.14.0.94"),
    "speaker": ("sherpa_onnx", "sherpa-onnx==1.13.5"),
}


def _application_support_root() -> Path:
    override = os.environ.get("MIRRORORDER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "MirrorOrder"


def identity_model_root() -> Path:
    return _application_support_root() / "models" / "identity"


def identity_python_root() -> Path:
    return _application_support_root() / "runtime" / "python-packages"


def _activate_runtime_packages() -> None:
    root = identity_python_root()
    if not root.is_dir():
        return
    value = str(root)
    if value not in sys.path:
        sys.path.insert(0, value)
    importlib.invalidate_caches()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _module(name: str) -> bool:
    _activate_runtime_packages()
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _pip_available() -> bool:
    try:
        return importlib.util.find_spec("pip") is not None
    except (ImportError, ValueError):
        return False


class IdentityRuntime:
    """Device-local lifecycle for face identity and speaker diarization.

    Optional Python wheels and ONNX weights are installed only after explicit
    user preparation / enablement. App build and deterministic analysis never
    fetch these artifacts.
    """

    _lock = threading.RLock()
    _prepare_locks = {"face": threading.Lock(), "speaker": threading.Lock()}
    _preparing: set[str] = set()
    _errors: dict[str, str] = {"face": "", "speaker": ""}

    @staticmethod
    def artifacts(kind: str) -> tuple[ModelArtifact, ...]:
        if kind == "face":
            return (FACE_DETECTOR, FACE_RECOGNIZER)
        if kind == "speaker":
            return (SPEAKER_SEGMENTER, SPEAKER_EMBEDDER)
        raise ValueError("identity kind 必须是 face 或 speaker")

    @staticmethod
    def model_dir(kind: str) -> Path:
        if kind not in {"face", "speaker"}:
            raise ValueError("identity kind 必须是 face 或 speaker")
        return identity_model_root() / kind

    @classmethod
    def model_path(cls, kind: str, artifact: ModelArtifact) -> Path:
        return cls.model_dir(kind) / artifact.filename

    @classmethod
    def _valid_artifact(cls, kind: str, artifact: ModelArtifact) -> bool:
        path = cls.model_path(kind, artifact)
        try:
            return (
                path.is_file()
                and path.stat().st_size == artifact.size_bytes
                and _sha256(path) == artifact.sha256
            )
        except OSError:
            return False

    @classmethod
    def prepared(cls, kind: str) -> bool:
        return all(cls._valid_artifact(kind, artifact) for artifact in cls.artifacts(kind))

    @staticmethod
    def dependency_status(kind: str) -> dict[str, Any]:
        if kind == "face":
            modules = {"numpy": _module("numpy"), "cv2": _module("cv2")}
            commands: dict[str, bool] = {}
            base_ready = modules["numpy"]
            optional_ready = modules["cv2"]
        elif kind == "speaker":
            modules = {"numpy": _module("numpy"), "sherpa_onnx": _module("sherpa_onnx")}
            commands = {"ffmpeg": bool(shutil.which("ffmpeg"))}
            base_ready = modules["numpy"] and commands["ffmpeg"]
            optional_ready = modules["sherpa_onnx"]
        else:
            raise ValueError("identity kind 必须是 face 或 speaker")
        installer = _pip_available()
        return {
            "available": bool(base_ready and optional_ready),
            "installable": bool(base_ready and installer),
            "installer": "pip" if installer else "",
            "modules": modules,
            "commands": commands,
        }

    @classmethod
    def _install_optional_runtime(cls, kind: str) -> None:
        module_name, package = _RUNTIME_PACKAGES[kind]
        if _module(module_name):
            return
        if not _pip_available():
            raise RuntimeError(f"当前 Python 没有 pip，无法自动安装 {package}")
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
            package,
        ]
        try:
            completed = subprocess.run(
                command,
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=600,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise RuntimeError(f"安装 {package} 失败：{error}") from error
        if completed.returncode != 0:
            tail = "\n".join((completed.stdout or "").splitlines()[-8:])
            raise RuntimeError(f"安装 {package} 失败：{tail}"[:1600])
        _activate_runtime_packages()
        if not _module(module_name):
            raise RuntimeError(f"{package} 已安装但模块 {module_name} 无法加载")

    @classmethod
    def _download(cls, kind: str, artifact: ModelArtifact) -> Path:
        directory = cls.model_dir(kind)
        directory.mkdir(parents=True, exist_ok=True)
        target = cls.model_path(kind, artifact)
        if cls._valid_artifact(kind, artifact):
            return target
        target.unlink(missing_ok=True)
        fd, temporary = tempfile.mkstemp(
            prefix=artifact.filename + ".", suffix=".download", dir=directory
        )
        os.close(fd)
        tmp = Path(temporary)
        try:
            request = urllib.request.Request(
                artifact.url,
                headers={"User-Agent": "MirrorOrder/1.0 identity-model-runtime"},
            )
            with urllib.request.urlopen(request, timeout=60) as response, tmp.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            actual_size = tmp.stat().st_size
            if actual_size != artifact.size_bytes:
                raise RuntimeError(
                    f"{artifact.name} 下载大小异常：{actual_size} != {artifact.size_bytes}"
                )
            if _sha256(tmp) != artifact.sha256:
                raise RuntimeError(f"{artifact.name} SHA-256 校验失败")
            os.replace(tmp, target)
            try:
                os.chmod(target, 0o600)
            except OSError:
                pass
            return target
        finally:
            tmp.unlink(missing_ok=True)

    @classmethod
    def prepare(cls, kind: str) -> dict[str, Any]:
        if kind not in cls._prepare_locks:
            raise ValueError("identity kind 必须是 face 或 speaker")
        with cls._prepare_locks[kind]:
            dependency = cls.dependency_status(kind)
            if not dependency["available"]:
                if dependency["installable"]:
                    cls._install_optional_runtime(kind)
                    dependency = cls.dependency_status(kind)
                if not dependency["available"]:
                    missing = [name for name, ok in dependency["modules"].items() if not ok]
                    missing.extend(name for name, ok in dependency["commands"].items() if not ok)
                    raise RuntimeError("缺少本地识别运行时：" + ", ".join(missing))
            with cls._lock:
                cls._errors[kind] = ""
            for artifact in cls.artifacts(kind):
                cls._download(kind, artifact)
            return cls.public_kind(kind)

    @classmethod
    def prepare_async(cls, kind: str) -> bool:
        if kind not in {"face", "speaker"}:
            raise ValueError("identity kind 必须是 face 或 speaker")
        with cls._lock:
            if kind in cls._preparing:
                return True
            cls._preparing.add(kind)
            cls._errors[kind] = ""

        def worker() -> None:
            try:
                cls.prepare(kind)
            except Exception as error:
                with cls._lock:
                    cls._errors[kind] = str(error)
            finally:
                with cls._lock:
                    cls._preparing.discard(kind)

        threading.Thread(target=worker, name=f"mirrororder-{kind}-prepare", daemon=True).start()
        return True

    @classmethod
    def ensure_models(cls, kind: str) -> dict[str, Path]:
        cls.prepare(kind)
        return {
            artifact.filename: cls.model_path(kind, artifact)
            for artifact in cls.artifacts(kind)
        }

    @classmethod
    def public_kind(cls, kind: str) -> dict[str, Any]:
        dependency = cls.dependency_status(kind)
        with cls._lock:
            preparing = kind in cls._preparing
            error = cls._errors.get(kind, "")
        rows = []
        cache_bytes = 0
        for artifact in cls.artifacts(kind):
            path = cls.model_path(kind, artifact)
            exists = cls._valid_artifact(kind, artifact)
            try:
                size = path.stat().st_size if path.is_file() else 0
            except OSError:
                size = 0
            cache_bytes += size
            rows.append(
                {
                    "name": artifact.name,
                    "filename": artifact.filename,
                    "ready": exists,
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
        }

    @classmethod
    def public(cls) -> dict[str, Any]:
        return {
            "face": cls.public_kind("face"),
            "speaker": cls.public_kind("speaker"),
            "root": str(identity_model_root()),
            "python_runtime_root": str(identity_python_root()),
        }
