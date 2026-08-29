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
CARGO = os.environ.get("CARGO", "cargo")


def fail(message: str) -> None:
    print(f"\nFast gate failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_command(command: str) -> None:
    if shutil.which(command) is None:
        fail(f"required command is unavailable: {command}")


def run(label: str, command: str, args: list[str], cwd: Path) -> None:
    print(f"\n=== {label} ===")
    completed = subprocess.run([command, *args], cwd=cwd, env=os.environ.copy(), check=False)
    if completed.returncode != 0:
        fail(f"{label} exited {completed.returncode}")


def main() -> None:
    if not (DESKTOP / "node_modules").is_dir():
        fail("desktop/node_modules 不存在；先在 desktop/ 执行 npm install。fast gate 不会自动联网安装依赖。")

    require_command(NPM)
    require_command(CARGO)

    run("Development baseline gate", NPM, ["run", "check:baseline"], DESKTOP)
    run("Runtime media tool policy tests", NPM, ["run", "test:runtime-tools"], DESKTOP)
    run("TypeScript strict typecheck", NPM, ["run", "typecheck"], DESKTOP)
    run("Vitest", NPM, ["test"], DESKTOP)
    run(
        "Rust Timeline Core tests",
        CARGO,
        ["test", "--manifest-path", "src-tauri/crates/timeline-core/Cargo.toml", "--lib"],
        DESKTOP,
    )
    run(
        "Rust Timeline bridge golden lifecycle",
        CARGO,
        [
            "test",
            "--manifest-path",
            "src-tauri/Cargo.toml",
            "golden_timeline_lifecycle_replays_undo_redo_and_reopens_deterministically",
        ],
        DESKTOP,
    )
    run(
        "Tauri host cargo check",
        CARGO,
        ["check", "--manifest-path", "src-tauri/Cargo.toml"],
        DESKTOP,
    )
    run("Python compileall", sys.executable, ["-m", "compileall", "-q", "src/script_organizer"], ROOT)
    run(
        "Python production contract smoke",
        sys.executable,
        [
            "-m",
            "pytest",
            "-q",
            "tests/test_repository_layout_guard.py",
            "tests/test_runtime_read_paths_contract.py",
            "tests/test_runtime_stack_installation.py",
            "tests/test_device_tasks.py",
            "tests/test_delivery_semantics.py",
            "tests/test_delivery_artifact_paths.py",
            "tests/test_golden_production_project.py",
        ],
        ROOT,
    )

    print("\nLocal fast gate passed.")
    print("This is not the full RC/native runtime gate. Run python scripts/check_full.py before merging high-risk work.")


if __name__ == "__main__":
    main()
