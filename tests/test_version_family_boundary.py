from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "src" / "script_organizer"
PACKAGE_NAME = "script_organizer"

# 一个版本家族 = 一个稳定 facade + 它选择使用的私有实现链。
# 家族外只允许 import facade；私有实现只允许同族成员 import，避免新 caller
# 绕过 facade 直接黏在 _v2 / _legacy 上，把旧实现固定成第二套入口。
VERSION_FAMILIES = {
    "identity_index": ("identity_index", "identity_index_legacy", "identity_index_v2", "identity_index_v3"),
    "identity_runtime": ("identity_runtime", "identity_runtime_v2", "identity_runtime_v3"),
    "auto_resolver": ("auto_resolver", "auto_resolver_v2", "auto_resolver_v3"),
    "tasks": ("tasks", "tasks_v2"),
}

PRIVATE_IMPL_OWNER = {
    module: family
    for family, members in VERSION_FAMILIES.items()
    for module in members[1:]
}


def _dotted(parts: list[str]) -> str:
    return ".".join(part for part in parts if part)


def _resolved_from(node: ast.ImportFrom, package: list[str]) -> list[str]:
    """Resolve one ``from ... import ...`` into absolute dotted names.

    Handles both package-relative (`from .identity_index_v2 import X`,
    `from . import tasks_v2`) and absolute (`from script_organizer import x`)
    forms, including imports that name a submodule through an alias.
    """
    base: list[str] = []
    if node.level:
        base = list(package)
        for _ in range(node.level - 1):
            if base:
                base.pop()
    if node.module:
        module = node.module.split(".")
        names = [_dotted([*base, *module])]
        names.extend(_dotted([*base, *module, alias.name]) for alias in node.names)
        return names
    return [_dotted([*base, alias.name]) for alias in node.names]


def _package_top_level(dotted: str) -> str:
    if dotted == PACKAGE_NAME:
        return ""
    if dotted.startswith(PACKAGE_NAME + "."):
        dotted = dotted[len(PACKAGE_NAME) + 1 :]
    return dotted.split(".")[0]


def _imported_modules(tree: ast.AST, module_parts: tuple[str, ...]) -> set[str]:
    """Return the top-level package modules a source file imports."""
    package = list(module_parts[:-1])
    touched: set[str] = set()
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.ImportFrom):
            names.extend(_resolved_from(node, package))
        elif isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        for name in names:
            module = _package_top_level(name)
            if module:
                touched.add(module)
    return touched


def _importer_family(path: Path) -> str | None:
    if path.parent != PACKAGE:
        return None
    for family, members in VERSION_FAMILIES.items():
        if path.stem in members:
            return family
    return None


def test_scanner_resolves_relative_and_absolute_family_imports() -> None:
    source = "\n".join(
        [
            "from .identity_index_v3 import IdentityIndexer",
            "from . import tasks_v2 as _impl",
            "import script_organizer.auto_resolver_v2",
            "from .config import ProjectConfig",
        ]
    )
    touched = _imported_modules(ast.parse(source), (PACKAGE_NAME, "probe"))

    assert {"identity_index_v3", "tasks_v2", "auto_resolver_v2", "config"} <= touched


def test_every_versioned_implementation_module_is_registered_in_a_family() -> None:
    registered = set(PRIVATE_IMPL_OWNER)
    versioned = {
        path.stem
        for path in PACKAGE.glob("*.py")
        if path.stem.endswith(("_legacy", "_v2", "_v3"))
    }

    assert versioned == registered, (
        "every *_legacy / *_v2 / *_v3 implementation must be registered in VERSION_FAMILIES: "
        f"unregistered={sorted(versioned - registered)}, missing={sorted(registered - versioned)}"
    )
    for family, members in VERSION_FAMILIES.items():
        assert (PACKAGE / f"{members[0]}.py").is_file(), f"{family} facade module is missing: {members[0]}.py"


def test_version_family_private_modules_are_not_imported_outside_their_family() -> None:
    violations: list[str] = []
    scanned = 0
    for path in sorted(PACKAGE.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        scanned += 1
        module_parts = (PACKAGE_NAME, *path.relative_to(PACKAGE).with_suffix("").parts)
        importer_family = _importer_family(path)
        for module in sorted(_imported_modules(ast.parse(path.read_text(encoding="utf-8")), module_parts)):
            owner = PRIVATE_IMPL_OWNER.get(module)
            if owner is not None and owner != importer_family:
                violations.append(
                    f"{path.relative_to(ROOT)} imports {owner} private module {module}"
                )

    assert scanned >= 100, f"version-family scan covered only {scanned} modules"
    assert violations == [], (
        "version-family private implementations must only be imported by their own family:\n"
        + "\n".join(violations)
    )
