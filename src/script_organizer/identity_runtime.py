from __future__ import annotations

import hashlib
import importlib.util
import os
import shutil
import tempfile
import threading
import urllib.error
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
SPEAKER_EMBEDDER = ModelArtifact(
    name="WeSpeaker ResNet34 CN-Celeb",
    filename="wespeaker_zh_cnceleb_resnet34.onnx",
    url=(
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
        "speaker-recongition-models/wespeaker_zh_cnceleb_resnet34.onnx"
    ),
    sha256="f86cd6c509f331f0e20b07bd48d1b2eb7de54202643401c4e84695ac861a0e5a",
    size_bytes=26534363,
    license="Apache-2.0 ecosystem model",
    source="k2-fsa/sherpa-onnx speaker-recongition-models",
)


def _application_support_root() -> Path:
    override = os.environ.get("MIRRORORDER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "MirrorOrder"


def identity_model_root() -> Path:
    return _application_support_root() / "models" / "identity"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


class IdentityRuntime:
    """Device-local model lifecycle for actor and speaker identity features.

    Model weights are fetched only after the corresponding device setting has
    been enabled or the user explicitly prepares that feature. Build/refactor
    time never downloads these artifacts.
    """

    _lock = threading.RLock()
    _preparing: set[str] = set()
    _errors: dict[str, str] = {"face": "", "speaker": ""}

    @staticmethod
    def artifacts(kind: str) -> tuple[ModelArtifact, ...]:
        if kind == "face":
            return (FACE_DETECTOR, FACE_RECOGNIZER)
        if kind == "speaker":
            return (SPEAKER_EMBEDDER,)
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
            if not path.is_file() or path.stat().st_size != artifact.size_bytes:
                return False
            return _sha256(path) == artifact.sha256
        except OSError:
            return False

    @classmethod
    def prepared(cls, kind: str) -> bool:
        return all(cls._valid_artifact(kind, artifact) for artifact in cls.artifacts(kind))

    @staticmethod
    def dependency_status(kind: str) -> dict[str, Any]:
        if kind == "face":
            modules = {"numpy": _module("numpy"), "cv2": _module("cv2")}
            return {
                "available": all(modules.values()),
                "modules": modules,
                "commands": {},
            }
        if kind == "speaker":
            modules = {"numpy": _module("numpy"), "sherpa_onnx": _module("sherpa_onnx")}
            commands = {"ffmpeg": bool(shutil.which("ffmpeg"))}
            return {
                "available": all(modules.values()) and all(commands.values()),
                "modules": modules,
                "commands": commands,
            }
        raise ValueError("identity kind 必须是 face 或 speaker")

    @classmethod
    def _download(cls, kind: str, artifact: ModelArtifact) -> Path:
        directory = cls.model_dir(kind)
        directory.mkdir(parents=True, exist_ok=True)
        target = cls.model_path(kind, artifact)
        if cls._valid_artifact(kind, artifact):
            return target
        target.unlink(missing_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=artifact.filename + ".", suffix=".download", dir=directory)
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
            actual_hash = _sha256(tmp)
            if actual_hash != artifact.sha256:
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
            except Exception as error:  # runtime status must survive provider failures
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
        elif ready:
            status = "missing_runtime"
        elif not dependency["available"]:
            status = "missing_runtime"
        else:
            status = "not_prepared"
        return {
            "kind": kind,
            "available": bool(dependency["available"]),
            "prepared": ready,
            "preparing": preparing,
            "status": status,
            "cache_dir": str(cls.model_dir(kind)),
            "cache_bytes": cache_bytes,
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
        }
