from __future__ import annotations

from types import SimpleNamespace

import script_organizer.identity_runtime_v3 as runtime_v3


def test_speaker_runtime_installs_python_binding_and_same_version_native_core(monkeypatch, tmp_path) -> None:
    commands = []
    ready = {"speaker": False}

    monkeypatch.setattr(runtime_v3, "identity_python_root", lambda: tmp_path / "runtime")
    monkeypatch.setattr(runtime_v3, "_pip_available", lambda: True)
    monkeypatch.setattr(runtime_v3, "_kind_importable", lambda kind: ready.get(kind, False))
    monkeypatch.setattr(runtime_v3, "_activate_runtime_packages", lambda: ready.__setitem__("speaker", True))
    monkeypatch.setattr(runtime_v3.importlib, "invalidate_caches", lambda: None)

    def run(command, **kwargs):
        commands.append((list(command), kwargs))
        return SimpleNamespace(returncode=0, stdout="ok")

    monkeypatch.setattr(runtime_v3.subprocess, "run", run)
    runtime_v3.IdentityRuntime._install_optional_runtime("speaker")

    assert len(commands) == 1
    command = commands[0][0]
    assert "--no-deps" in command
    assert "sherpa-onnx==1.13.5" in command
    assert "sherpa-onnx-core==1.13.5" in command
    assert command.index("sherpa-onnx==1.13.5") < command.index("sherpa-onnx-core==1.13.5")


def test_face_runtime_remains_pinned_without_unrelated_speaker_packages(monkeypatch, tmp_path) -> None:
    commands = []
    ready = {"face": False}

    monkeypatch.setattr(runtime_v3, "identity_python_root", lambda: tmp_path / "runtime")
    monkeypatch.setattr(runtime_v3, "_pip_available", lambda: True)
    monkeypatch.setattr(runtime_v3, "_kind_importable", lambda kind: ready.get(kind, False))
    monkeypatch.setattr(runtime_v3, "_activate_runtime_packages", lambda: ready.__setitem__("face", True))
    monkeypatch.setattr(runtime_v3.importlib, "invalidate_caches", lambda: None)

    def run(command, **kwargs):
        commands.append(list(command))
        return SimpleNamespace(returncode=0, stdout="ok")

    monkeypatch.setattr(runtime_v3.subprocess, "run", run)
    runtime_v3.IdentityRuntime._install_optional_runtime("face")

    assert commands
    assert "opencv-python==4.14.0.94" in commands[0]
    assert not any("sherpa" in value for value in commands[0])


def test_dependency_status_rejects_partial_sherpa_binding(monkeypatch) -> None:
    monkeypatch.setattr(runtime_v3, "_importable", lambda name, attributes=(): name == "numpy")
    monkeypatch.setattr(runtime_v3.shutil, "which", lambda name: "/usr/bin/ffmpeg" if name == "ffmpeg" else None)
    monkeypatch.setattr(runtime_v3, "_pip_available", lambda: True)
    status = runtime_v3.IdentityRuntime.dependency_status("speaker")
    assert status["available"] is False
    assert status["installable"] is True
    assert status["modules"]["sherpa_onnx"] is False
