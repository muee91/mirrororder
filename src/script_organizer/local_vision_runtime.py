from __future__ import annotations

import atexit
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_LOCAL_VISION_MODEL = "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M"


def _application_support_root() -> Path:
    override = os.environ.get("MIRRORORDER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "MirrorOrder"


def _runtime_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _find_llama_server() -> Path | None:
    explicit = os.environ.get("MIRRORORDER_LLAMA_SERVER", "").strip()
    candidates = [
        Path(explicit).expanduser() if explicit else None,
        _runtime_root() / "bin" / "llama-server",
    ]
    discovered = shutil.which("llama-server")
    if discovered:
        candidates.append(Path(discovered))
    for candidate in candidates:
        if candidate and candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
    return None


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@dataclass(frozen=True)
class LocalVisionRuntimeConfig:
    model: str = DEFAULT_LOCAL_VISION_MODEL
    startup_timeout_seconds: int = 900

    @classmethod
    def from_env(cls, model: str = "") -> "LocalVisionRuntimeConfig":
        try:
            timeout = int(os.environ.get("MIRRORORDER_VISION_STARTUP_TIMEOUT", "900"))
        except ValueError:
            timeout = 900
        return cls(
            model=(model or os.environ.get("MIRRORORDER_VISION_MODEL", "").strip() or DEFAULT_LOCAL_VISION_MODEL),
            startup_timeout_seconds=max(30, min(3600, timeout)),
        )


class LocalVisionRuntime:
    """Own a localhost-only llama-server used for optional visual rescue.

    Model weights are runtime-only device state. `prepare_async()` is used by
    the App settings UI to trigger first download/loading without blocking the
    Host HTTP request. A later visual rescue reuses the same process/cache.
    """

    _lock = threading.RLock()
    _process: subprocess.Popen[Any] | None = None
    _base_url = ""
    _model = ""
    _log_handle: Any = None
    _registered_exit = False
    _preparing = False
    _prepare_thread: threading.Thread | None = None
    _last_error = ""

    def __init__(self, config: LocalVisionRuntimeConfig | None = None):
        self.config = config or LocalVisionRuntimeConfig.from_env()
        if not self.__class__._registered_exit:
            atexit.register(self.__class__.stop)
            self.__class__._registered_exit = True

    @property
    def root(self) -> Path:
        return _application_support_root()

    @property
    def cache_dir(self) -> Path:
        return self.root / "models" / "llama-cache"

    @property
    def log_path(self) -> Path:
        return self.root / "logs" / "llama-vision.log"

    @classmethod
    def _healthy(cls, base_url: str, timeout: float = 0.7) -> bool:
        if not base_url:
            return False
        request = urllib.request.Request(base_url.rstrip("/") + "/health", method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return 200 <= int(getattr(response, "status", 0)) < 300
        except (OSError, urllib.error.URLError, urllib.error.HTTPError, ValueError):
            return False

    def cache_bytes(self) -> int:
        total = 0
        try:
            for path in self.cache_dir.rglob("*"):
                if path.is_file():
                    try:
                        total += path.stat().st_size
                    except OSError:
                        pass
        except OSError:
            pass
        return total

    def ensure_server(self) -> str:
        cls = self.__class__
        with cls._lock:
            if (
                cls._process is not None
                and cls._process.poll() is None
                and cls._model == self.config.model
                and self._healthy(cls._base_url)
            ):
                cls._preparing = False
                return cls._base_url
            cls._preparing = True
            cls._last_error = ""
            if cls._process is not None:
                cls.stop()
                cls._preparing = True

            executable = _find_llama_server()
            if executable is None:
                cls._preparing = False
                cls._last_error = "llama-server 不可用；请使用包含本地视觉运行时的镜序 App"
                return ""

            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            port = _free_loopback_port()
            base_url = f"http://127.0.0.1:{port}"
            environment = os.environ.copy()
            environment["LLAMA_CACHE"] = str(self.cache_dir)
            environment.setdefault("LLAMA_ARG_HOST", "127.0.0.1")
            environment.setdefault("LLAMA_ARG_PORT", str(port))
            command = [
                str(executable),
                "-hf", self.config.model,
                "--host", "127.0.0.1",
                "--port", str(port),
            ]
            cls._log_handle = self.log_path.open("ab", buffering=0)
            try:
                cls._process = subprocess.Popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=cls._log_handle,
                    stderr=subprocess.STDOUT,
                    env=environment,
                    start_new_session=True,
                )
            except OSError as error:
                try:
                    cls._log_handle.close()
                except Exception:
                    pass
                cls._log_handle = None
                cls._process = None
                cls._preparing = False
                cls._last_error = str(error)
                return ""
            cls._base_url = base_url
            cls._model = self.config.model

        deadline = time.monotonic() + self.config.startup_timeout_seconds
        while time.monotonic() < deadline:
            with cls._lock:
                process = cls._process
                current_url = cls._base_url
            if process is None or process.poll() is not None:
                with cls._lock:
                    cls._last_error = "llama-server 在模型准备完成前退出"
                    cls._preparing = False
                cls.stop(preserve_error=True)
                return ""
            if self._healthy(current_url, timeout=1.0):
                with cls._lock:
                    cls._preparing = False
                return current_url
            time.sleep(0.5)
        with cls._lock:
            cls._last_error = "本地视觉模型准备超时"
            cls._preparing = False
        cls.stop(preserve_error=True)
        return ""

    def prepare_async(self) -> bool:
        cls = self.__class__
        with cls._lock:
            if _find_llama_server() is None:
                cls._last_error = "llama-server 不可用；请使用包含本地视觉运行时的镜序 App"
                return False
            if cls._preparing:
                return True
            if cls._process is not None and cls._process.poll() is None and self._healthy(cls._base_url):
                return True
            cls._preparing = True
            cls._last_error = ""
            thread = threading.Thread(target=self.ensure_server, name="mirrororder-local-vision", daemon=True)
            cls._prepare_thread = thread
            thread.start()
            return True

    @classmethod
    def stop(cls, preserve_error: bool = False) -> None:
        with cls._lock:
            process = cls._process
            cls._process = None
            cls._base_url = ""
            cls._model = ""
            cls._preparing = False
            if not preserve_error:
                cls._last_error = ""
            if process is not None and process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=5)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
            handle = cls._log_handle
            cls._log_handle = None
            if handle is not None:
                try:
                    handle.close()
                except Exception:
                    pass

    def public(self) -> dict[str, Any]:
        executable = _find_llama_server()
        cls = self.__class__
        running = bool(cls._process is not None and cls._process.poll() is None and self._healthy(cls._base_url))
        cached_bytes = self.cache_bytes()
        with cls._lock:
            preparing = bool(cls._preparing)
            last_error = cls._last_error
        if executable is None:
            status = "unavailable"
        elif preparing:
            status = "preparing"
        elif running:
            status = "running"
        elif last_error:
            status = "error"
        elif cached_bytes > 0:
            status = "cached"
        else:
            status = "not_prepared"
        return {
            "available": executable is not None,
            "running": running,
            "preparing": preparing,
            "status": status,
            "model": self.config.model,
            "cache_dir": str(self.cache_dir),
            "cache_bytes": cached_bytes,
            "last_error": last_error,
            "download_policy": "first_use_when_local_vision_enabled",
        }
