from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"
WINDOWS = os.name == "nt"
NPM = "npm.cmd" if WINDOWS else "npm"


def fail(message: str) -> None:
    print(f"\nFull gate failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    if not (DESKTOP / "node_modules").is_dir():
        fail("desktop/node_modules 不存在；先在 desktop/ 执行 npm install。full gate 不会自动联网安装依赖。")
    if shutil.which(NPM) is None:
        fail(f"required command is unavailable: {NPM}")

    print("\n=== MirrorOrder local full source gate ===")
    completed = subprocess.run(
        [NPM, "run", "verify:rc"],
        cwd=DESKTOP,
        env=os.environ.copy(),
        check=False,
    )
    if completed.returncode != 0:
        fail(f"desktop verify:rc exited {completed.returncode}")

    print("\nLocal full source gate passed.")
    print("Packaged macOS/Windows runtime, real media, LAN and FCP/installer smoke gates remain separate native requirements.")


if __name__ == "__main__":
    main()
