from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_identity_runtime_import_does_not_mutate_sys_path(tmp_path: Path) -> None:
    """compatibility facade 契约：import 不得修改全局 Host runtime state。

    子进程里先放置一个真实存在的 runtime python-packages 目录
    （MIRRORORDER_DATA_DIR 指向它），保证任何重新出现的 import-time
    ``_activate_runtime_packages()`` 都会在 sys.path 里留下痕迹。
    """
    runtime_packages = tmp_path / "runtime" / "python-packages"
    runtime_packages.mkdir(parents=True)
    code = "\n".join(
        [
            "import json, sys",
            "before = list(sys.path)",
            "import script_organizer.identity_runtime",
            "import script_organizer.identity_runtime_v2",
            "import script_organizer.identity_runtime_v3",
            "json.dump({'before': before, 'after': list(sys.path)}, sys.stdout)",
        ]
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = "src"
    env["MIRRORORDER_DATA_DIR"] = str(tmp_path)
    completed = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    state = json.loads(completed.stdout)
    assert state["before"] == state["after"]
    assert str(runtime_packages) not in state["after"]


def test_identity_runtime_still_activates_lazily_on_module_lookup(tmp_path: Path) -> None:
    """显式依赖检查路径仍要能激活 device-local runtime 目录。"""
    runtime_packages = tmp_path / "runtime" / "python-packages"
    runtime_packages.mkdir(parents=True)
    probe = runtime_packages / "mirrororder_identity_probe.py"
    probe.write_text("PROBE = True\n", encoding="utf-8")
    env = os.environ.copy()
    env["PYTHONPATH"] = "src"
    env["MIRRORORDER_DATA_DIR"] = str(tmp_path)
    code = "\n".join(
        [
            "import json, sys",
            "from script_organizer.identity_runtime_v2 import _module, identity_python_root",
            "found = _module('mirrororder_identity_probe')",
            "json.dump(",
            "    {'found': found, 'root': str(identity_python_root()), 'path': list(sys.path)},",
            "    sys.stdout,",
            ")",
        ]
    )
    completed = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    state = json.loads(completed.stdout)
    assert state["found"] is True
    assert Path(state["root"]) == runtime_packages.resolve()
    assert str(runtime_packages) in state["path"]
