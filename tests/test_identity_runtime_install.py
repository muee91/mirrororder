from __future__ import annotations

import pytest

import script_organizer.identity_runtime_v3 as runtime_v3


class _CompletedProcess:
    def __init__(self, command, **kwargs) -> None:
        self.command = list(command)
        self.kwargs = kwargs
        self.returncode = 0
        self.terminated = False

    def communicate(self, timeout=None):
        return ("ok", None)

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.terminated = True


def _capture_popen(monkeypatch):
    processes = []

    def popen(command, **kwargs):
        process = _CompletedProcess(command, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(runtime_v3.subprocess, "Popen", popen)
    return processes


def test_speaker_runtime_installs_python_binding_and_same_version_native_core(monkeypatch, tmp_path) -> None:
    ready = {"speaker": False}
    processes = _capture_popen(monkeypatch)

    monkeypatch.setattr(runtime_v3, "identity_python_root", lambda: tmp_path / "runtime")
    monkeypatch.setattr(runtime_v3, "_pip_available", lambda: True)
    monkeypatch.setattr(runtime_v3, "_kind_importable", lambda kind: ready.get(kind, False))
    monkeypatch.setattr(runtime_v3, "_activate_runtime_packages", lambda: ready.__setitem__("speaker", True))
    monkeypatch.setattr(runtime_v3.importlib, "invalidate_caches", lambda: None)

    runtime_v3.IdentityRuntime._install_optional_runtime("speaker")

    assert len(processes) == 1
    command = processes[0].command
    assert "--no-deps" in command
    assert "sherpa-onnx==1.13.5" in command
    assert "sherpa-onnx-core==1.13.5" in command
    assert command.index("sherpa-onnx==1.13.5") < command.index("sherpa-onnx-core==1.13.5")


def test_face_runtime_remains_pinned_without_unrelated_speaker_packages(monkeypatch, tmp_path) -> None:
    ready = {"face": False}
    processes = _capture_popen(monkeypatch)

    monkeypatch.setattr(runtime_v3, "identity_python_root", lambda: tmp_path / "runtime")
    monkeypatch.setattr(runtime_v3, "_pip_available", lambda: True)
    monkeypatch.setattr(runtime_v3, "_kind_importable", lambda kind: ready.get(kind, False))
    monkeypatch.setattr(runtime_v3, "_activate_runtime_packages", lambda: ready.__setitem__("face", True))
    monkeypatch.setattr(runtime_v3.importlib, "invalidate_caches", lambda: None)

    runtime_v3.IdentityRuntime._install_optional_runtime("face")

    assert processes
    assert "opencv-python==4.14.0.94" in processes[0].command
    assert not any("sherpa" in value for value in processes[0].command)


def test_cancellable_runtime_install_terminates_pip(monkeypatch, tmp_path) -> None:
    process = _CompletedProcess(["pip"])
    process.communicate = lambda timeout=None: (_ for _ in ()).throw(runtime_v3.subprocess.TimeoutExpired("pip", timeout))

    monkeypatch.setattr(runtime_v3, "identity_python_root", lambda: tmp_path / "runtime")
    monkeypatch.setattr(runtime_v3, "_pip_available", lambda: True)
    monkeypatch.setattr(runtime_v3, "_kind_importable", lambda _kind: False)
    monkeypatch.setattr(runtime_v3.subprocess, "Popen", lambda *args, **kwargs: process)
    checks = iter([False, True])

    with pytest.raises(runtime_v3.IdentityPreparationCancelled):
        runtime_v3.IdentityRuntime._install_optional_runtime_cancellable(
            "face",
            lambda: next(checks, True),
        )

    assert process.terminated is True


def test_dependency_status_rejects_partial_sherpa_binding(monkeypatch) -> None:
    monkeypatch.setattr(runtime_v3, "_importable", lambda name, attributes=(): name == "numpy")
    monkeypatch.setattr(runtime_v3.shutil, "which", lambda name: "/usr/bin/ffmpeg" if name == "ffmpeg" else None)
    monkeypatch.setattr(runtime_v3, "_pip_available", lambda: True)
    status = runtime_v3.IdentityRuntime.dependency_status("speaker")
    assert status["available"] is False
    assert status["installable"] is True
    assert status["modules"]["sherpa_onnx"] is False
