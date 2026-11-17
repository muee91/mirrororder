"""Keep a POSIX model server bounded by its owning Python Host's lifetime.

The supervisor survives a hard-killed Host long enough to reap the model. It
also handles normal LocalVisionRuntime.stop() without leaving a detached server.
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time


def launch_command(command: list[str]) -> list[str]:
    if os.name == "nt":
        return command
    return [
        sys.executable, "-m", "script_organizer.local_models.supervisor",
        "--parent-pid", str(os.getpid()), "--", *command,
    ]


def _stop(child: subprocess.Popen) -> None:
    if child.poll() is not None:
        return
    try:
        child.terminate()
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=2)
    except ProcessLookupError:
        child.wait(timeout=2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent-pid", required=True, type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("model command is required")
    stopping = False

    def stop_requested(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop_requested)
    signal.signal(signal.SIGINT, stop_requested)
    # A delayed startup must not launch a model after the Host has exited.
    if args.parent_pid <= 1 or os.getppid() != args.parent_pid or stopping:
        return 0
    child = subprocess.Popen(command)
    try:
        while not stopping and os.getppid() == args.parent_pid:
            result = child.poll()
            if result is not None:
                return result
            time.sleep(0.1)
        return 0
    finally:
        _stop(child)


if __name__ == "__main__":
    raise SystemExit(main())
