from __future__ import annotations

import hashlib
import importlib
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from typing import Any, Callable

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


class IdentityPreparationCancelled(RuntimeError):
    pass


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


def _cancelled(callback: Callable[[], bool] | None) -> bool:
    try:
        return bool(callback and callback())
    except Exception:
        return False


def _raise_if_cancelled(callback: Callable[[], bool] | None) -> None:
    if _cancelled(callback):
        raise IdentityPreparationCancelled("身份运行时准备已取消")


def _terminate_process(process: subprocess.Popen[str]) -> str:
    try:
        process.terminate()
        output, _ = process.communicate(timeout=5)
        return output or ""
    except Exception:
        try:
            process.kill()
        except Exception:
            pass
        try:
            output, _ = process.communicate(timeout=2)
            return output or ""
        except Exception:
            return ""


class IdentityRuntime(_IdentityRuntimeV2):
    """Pinned optional runtime installer with complete native dependency checks.

    Full native imports and SHA-256 artifact verification happen only on explicit
    prepare/analysis paths. Public status is deliberately lightweight so opening
    Settings never loads OpenCV/sherpa or hashes model weights. Durable device
    tasks may use `prepare_cancellable()` so cancellation propagates into pip,
    downloads and weight verification rather than waiting for the whole stage.
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
    def _packages(cls, kind: str) -> tuple[str, list[str]]:
        if kind == "face":
            return "cv2", ["opencv-python==4.14.0.94"]
        if kind == "speaker":
            return "sherpa_onnx", [
                "sherpa-onnx==1.13.5",
                "sherpa-onnx-core==1.13.5",
            ]
        raise ValueError("identity kind 必须是 face 或 speaker")

    @classmethod
    def _install_optional_runtime(cls, kind: str) -> None:
        cls._install_optional_runtime_cancellable(kind, None)

    @classmethod
    def _install_optional_runtime_cancellable(
        cls,
        kind: str,
        cancel_requested: Callable[[], bool] | None,
    ) -> None:
        module_name, packages = cls._packages(kind)
        if _kind_importable(kind):
            return
        if not _pip_available():
            raise RuntimeError(f"当前 Python 没有 pip，无法自动安装 {', '.join(packages)}")
        _raise_if_cancelled(cancel_requested)
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
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
            )
        except OSError as error:
            raise RuntimeError(f"安装本地识别运行时失败：{error}") from error

        deadline = time.monotonic() + 600
        output = ""
        while True:
            if _cancelled(cancel_requested):
                _terminate_process(process)
                raise IdentityPreparationCancelled("安装身份识别运行时时已取消")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                output = _terminate_process(process)
                raise RuntimeError(f"安装本地识别运行时超时：{output[-1200:]}")
            try:
                output, _ = process.communicate(timeout=min(0.25, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if process.returncode != 0:
            tail = "\n".join((output or "").splitlines()[-10:])
            raise RuntimeError(f"安装本地识别运行时失败：{tail}"[:1800])
        _raise_if_cancelled(cancel_requested)
        _activate_runtime_packages()
        importlib.invalidate_caches()
        # A failed native import can leave a partial module in sys.modules.
        sys.modules.pop(module_name, None)
        if not _kind_importable(kind):
            raise RuntimeError(
                f"{', '.join(packages)} 已安装，但模块 {module_name} 的本地推理 API 无法加载"
            )

    @classmethod
    def _artifact_valid_cancellable(
        cls,
        kind: str,
        artifact: ModelArtifact,
        cancel_requested: Callable[[], bool] | None,
    ) -> bool:
        path = cls.model_path(kind, artifact)
        try:
            if not path.is_file() or path.stat().st_size != artifact.size_bytes:
                return False
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                while True:
                    _raise_if_cancelled(cancel_requested)
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
            return digest.hexdigest() == artifact.sha256
        except OSError:
            return False

    @classmethod
    def _download_cancellable(
        cls,
        kind: str,
        artifact: ModelArtifact,
        cancel_requested: Callable[[], bool] | None,
    ) -> None:
        directory = cls.model_dir(kind)
        directory.mkdir(parents=True, exist_ok=True)
        target = cls.model_path(kind, artifact)
        if cls._artifact_valid_cancellable(kind, artifact, cancel_requested):
            return
        target.unlink(missing_ok=True)
        fd, temporary = tempfile.mkstemp(
            prefix=artifact.filename + ".",
            suffix=".download",
            dir=directory,
        )
        os.close(fd)
        tmp = os.fspath(temporary)
        digest = hashlib.sha256()
        total = 0
        try:
            request = urllib.request.Request(
                artifact.url,
                headers={"User-Agent": "MirrorOrder/1.0 identity-model-runtime"},
            )
            with urllib.request.urlopen(request, timeout=10) as response, open(tmp, "wb") as handle:
                while True:
                    _raise_if_cancelled(cancel_requested)
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    digest.update(chunk)
                    total += len(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            _raise_if_cancelled(cancel_requested)
            if total != artifact.size_bytes:
                raise RuntimeError(
                    f"{artifact.name} 下载大小异常：{total} != {artifact.size_bytes}"
                )
            if digest.hexdigest() != artifact.sha256:
                raise RuntimeError(f"{artifact.name} SHA-256 校验失败")
            os.replace(tmp, target)
            try:
                os.chmod(target, 0o600)
            except OSError:
                pass
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    @classmethod
    def prepare_cancellable(
        cls,
        kind: str,
        cancel_requested: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        if kind not in cls._prepare_locks:
            raise ValueError("identity kind 必须是 face 或 speaker")
        with cls._lock:
            cls._preparing.add(kind)
            cls._errors[kind] = ""
        try:
            with cls._prepare_locks[kind]:
                _raise_if_cancelled(cancel_requested)
                dependency = cls.dependency_status(kind)
                if not dependency["available"]:
                    if dependency["installable"]:
                        cls._install_optional_runtime_cancellable(kind, cancel_requested)
                        dependency = cls.dependency_status(kind)
                    if not dependency["available"]:
                        missing = [name for name, ok in dependency["modules"].items() if not ok]
                        missing.extend(name for name, ok in dependency["commands"].items() if not ok)
                        raise RuntimeError("缺少本地识别运行时：" + ", ".join(missing))
                for artifact in cls.artifacts(kind):
                    _raise_if_cancelled(cancel_requested)
                    cls._download_cancellable(kind, artifact, cancel_requested)
                _raise_if_cancelled(cancel_requested)
                return cls.public_kind(kind)
        except IdentityPreparationCancelled:
            raise
        except Exception as error:
            with cls._lock:
                cls._errors[kind] = str(error)
            raise
        finally:
            with cls._lock:
                cls._preparing.discard(kind)


__all__ = [
    "ModelArtifact",
    "FACE_DETECTOR",
    "FACE_RECOGNIZER",
    "SPEAKER_SEGMENTER",
    "SPEAKER_EMBEDDER",
    "IdentityPreparationCancelled",
    "IdentityRuntime",
    "identity_model_root",
    "identity_python_root",
]
