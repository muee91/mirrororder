from __future__ import annotations

from types import SimpleNamespace

import script_organizer.identity_runtime_v3 as runtime_v3


def test_speaker_runtime_installs_python_binding_and_same_version_native_core(monkeypatch, tmp_path) -> None:
    commands = []
    available = {"sherpa_onnx": False}

    monkeypatch.setattr(runtime_v3, "identity_python_root", lambda: tmp_path / "runtime")
    monkeypatch.setattr(runtime_v3, "_pip_available", lambda: True)
    monkeypatch.setattr(runtime_v3, "_module", lambda name: available.get(name, True))
    monkeypatch.setattr(runtime_v3, "_activate_runtime_packages", lambda: available.__setitem__("sherpa_onnx", True))

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
    available = {"cv2": False}

    monkeypatch.setattr(runtime_v3, "identity_python_root", lambda: tmp_path / "runtime")
    monkeypatch.setattr(runtime_v3, "_pip_available", lambda: True)
    monkeypatch.setattr(runtime_v3, "_module", lambda name: available.get(name, True))
    monkeypatch.setattr(runtime_v3, "_activate_runtime_packages", lambda: available.__setitem__("cv2", True))

    def run(command, **kwargs):
        commands.append(list(command))
        return SimpleNamespace(returncode=0, stdout="ok")

    monkeypatch.setattr(runtime_v3.subprocess, "run", run)
    runtime_v3.IdentityRuntime._install_optional_runtime("face")

    assert commands
    assert "opencv-python==4.14.0.94" in commands[0]
    assert not any("sherpa" in value for value in commands[0])
