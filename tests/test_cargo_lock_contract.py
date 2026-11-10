from __future__ import annotations

import ast
import json
from pathlib import Path
import re
import shlex

import pytest


ROOT = Path(__file__).resolve().parents[1]
RESOLVING_COMMANDS = {"build", "test", "check", "run", "clippy", "fetch", "metadata"}


@pytest.mark.parametrize("relative", [".github/workflows/ci.yml", "desktop/README.md"])
def test_cargo_shell_commands_preserve_lockfiles(relative: str) -> None:
    source = (ROOT / relative).read_text(encoding="utf-8")
    commands = [
        shlex.split(match.group(1))
        for match in re.finditer(r"\bcargo ([^\n]+)", source)
        if match.group(1).split()[0] in RESOLVING_COMMANDS
    ]
    assert commands, f"No Cargo validation commands found in {relative}"
    for args in commands:
        assert "--locked" in args, f"{relative}: cargo {' '.join(args)}"


def test_fast_gate_cargo_commands_preserve_lockfiles() -> None:
    source = (ROOT / "scripts/check_fast.py").read_text(encoding="utf-8")
    commands = [
        ast.literal_eval(node.args[2])
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "run"
        and len(node.args) >= 3
        and isinstance(node.args[1], ast.Name)
        and node.args[1].id == "CARGO"
    ]
    assert commands, "No Cargo fast gate commands found"
    for args in commands:
        if args[0] in RESOLVING_COMMANDS:
            assert "--locked" in args, args


def test_release_gate_cargo_commands_preserve_lockfiles() -> None:
    source = (ROOT / "desktop/scripts/verify-local-rc.mjs").read_text(encoding="utf-8")
    commands = [
        json.loads(match.group(1))
        for match in re.finditer(r'run\(\s*"[^"]+",\s*cargo,\s*(\[[^\]]+\])', source)
    ]
    assert commands, "No Cargo release gate commands found"
    for args in commands:
        if args[0] in RESOLVING_COMMANDS:
            assert "--locked" in args, args
