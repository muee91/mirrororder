from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PYTHON_CONTRACT_TESTS = (
    "tests/test_repository_layout_guard.py",
    "tests/test_runtime_read_paths_contract.py",
    "tests/test_runtime_stack_installation.py",
    "tests/test_device_tasks.py",
    "tests/test_delivery_semantics.py",
    "tests/test_delivery_artifact_paths.py",
    "tests/test_golden_production_project.py",
    "tests/test_python_package_migration_contract.py",
)


def fail(message: str) -> None:
    print(f"\nPython source gate failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def run(label: str, args: list[str]) -> None:
    print(f"\n=== {label} ===")
    completed = subprocess.run(
        [sys.executable, *args],
        cwd=ROOT,
        env=os.environ.copy(),
        check=False,
    )
    if completed.returncode != 0:
        fail(f"{label} exited {completed.returncode}")


def main() -> None:
    if importlib.util.find_spec("pytest") is None:
        fail("pytest 不可用；该 gate 不会自动联网安装依赖。")

    missing = [relative for relative in PYTHON_CONTRACT_TESTS if not (ROOT / relative).is_file()]
    if missing:
        fail(f"缺少 contract tests: {', '.join(missing)}")

    run("Python compileall", ["-m", "compileall", "-q", "src/script_organizer"])
    run("Python production contract smoke", ["-m", "pytest", "-q", *PYTHON_CONTRACT_TESTS])

    print("\nPython-only source gate passed.")
    print("This does not replace TypeScript/Vitest, Rust/Tauri, full RC, packaged runtime or native media/FCP smoke gates.")


if __name__ == "__main__":
    main()
