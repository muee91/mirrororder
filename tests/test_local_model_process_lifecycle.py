from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX parent-loss lifecycle")
ROOT = Path(__file__).resolve().parents[1]


def _alive(pid: int) -> bool:
    state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
    return state.returncode == 0 and not state.stdout.strip().startswith("Z")


@pytest.mark.parametrize("shutdown", ["owner-killed", "runtime-stop", "stubborn-model"])
def test_local_model_does_not_outlive_its_owner(tmp_path: Path, shutdown: str) -> None:
    worker = tmp_path / "fake-llama-server"
    term_behavior = "import signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n" if shutdown == "stubborn-model" else ""
    worker.write_text(
        f"#!{sys.executable}\n"
        "import os, time\nfrom pathlib import Path\n"
        + term_behavior
        + "Path(os.environ['MODEL_PID_FILE']).write_text(str(os.getpid()))\n"
        "time.sleep(60)\n"
    )
    worker.chmod(0o755)
    model_pid_file, ready = tmp_path / "model.pid", tmp_path / "ready"
    environment = {
        **os.environ,
        "PYTHONPATH": str(ROOT / "src"),
        "MIRRORORDER_DATA_DIR": str(tmp_path / "device"),
        "MODEL_PID_FILE": str(model_pid_file),
        "FAKE_MODEL_SERVER": str(worker),
        "OWNER_READY": str(ready),
    }
    code = (
        "import os, sys, time\nfrom pathlib import Path\n"
        "import script_organizer.local_vision_runtime as m\n"
        "m._find_llama_server = lambda: Path(os.environ['FAKE_MODEL_SERVER'])\n"
        "m.LocalVisionRuntime._healthy = classmethod(lambda cls, *a, **kw: True)\n"
        "r = m.LocalVisionRuntime(m.LocalVisionRuntimeConfig(model='fixture'))\n"
        "assert r.ensure_server()\n"
        "Path(os.environ['OWNER_READY']).write_text(str(r._process.pid))\n"
        "if sys.stdin.readline().strip() == 'stop': r.stop()\n"
        "time.sleep(60)\n"
    )
    owner = subprocess.Popen([sys.executable, "-c", code], env=environment, stdin=subprocess.PIPE)
    model_pid = supervisor_pid = None
    try:
        deadline = time.monotonic() + 8
        while not (model_pid_file.exists() and ready.exists()) and time.monotonic() < deadline:
            assert owner.poll() is None, "fixture owner failed before model startup"
            time.sleep(0.05)
        assert model_pid_file.exists() and ready.exists()
        model_pid = int(model_pid_file.read_text())
        supervisor_pid = int(ready.read_text())
        if shutdown != "runtime-stop":
            owner.kill()
            owner.wait(timeout=3)
        else:
            assert owner.stdin is not None
            owner.stdin.write(b"stop\n")
            owner.stdin.flush()
        deadline = time.monotonic() + 6
        while _alive(model_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not _alive(model_pid), "model server survived owner shutdown"
        assert not _alive(supervisor_pid), "model supervisor survived shutdown"
        if shutdown == "runtime-stop":
            assert owner.poll() is None
    finally:
        if owner.poll() is None:
            owner.kill()
        owner.wait(timeout=3)
        if owner.stdin:
            owner.stdin.close()
        for pid in {model_pid, supervisor_pid} - {None}:
            if _alive(pid):
                os.kill(pid, signal.SIGKILL)
