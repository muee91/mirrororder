from __future__ import annotations

from pathlib import Path

import pytest

from script_organizer.project_package import (
    LEGACY_PROJECT_SCHEMA_VERSION,
    PROJECT_PACKAGE_FORMAT,
    PROJECT_PACKAGE_SCHEMA_VERSION,
    ProjectPackageError,
    UnsupportedProjectPackage,
    load_project_package_manifest,
    validate_project_relative_path,
)


def _write_manifest(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "project.toml"
    path.write_text(text, encoding="utf-8")
    return path


def _v1(extra: str = "") -> str:
    return f'''[project]\nformat = "{PROJECT_PACKAGE_FORMAT}"\nschema_version = {PROJECT_PACKAGE_SCHEMA_VERSION}\nid = "demo"\nname = "Demo"\n\n[input]\nkind = "fcpxml"\nscript = "./inputs/script.txt"\nfcpxml = "./inputs/source.fcpxml"\n\n[output]\ndirectory = "./output"\n\n[asr]\ntranscript_dir = "./cache/transcripts"\n{extra}'''


def test_v1_manifest_is_recognized_without_mutation(tmp_path):
    path = _write_manifest(tmp_path, _v1())
    before = path.read_bytes()

    manifest = load_project_package_manifest(path)

    assert manifest.format == PROJECT_PACKAGE_FORMAT
    assert manifest.schema_version == PROJECT_PACKAGE_SCHEMA_VERSION
    assert manifest.project_id == "demo"
    assert manifest.name == "Demo"
    assert manifest.legacy is False
    assert manifest.needs_migration is False
    assert path.read_bytes() == before


def test_legacy_manifest_remains_readable_and_is_not_rewritten(tmp_path):
    path = _write_manifest(
        tmp_path,
        '''[project]\nid = "legacy"\nname = "Legacy"\n\n[input]\nkind = "media-directory"\nscript = "./inputs/script.txt"\n''',
    )
    before = path.read_bytes()

    manifest = load_project_package_manifest(tmp_path)

    assert manifest.schema_version == LEGACY_PROJECT_SCHEMA_VERSION
    assert manifest.legacy is True
    assert manifest.needs_migration is True
    assert path.read_bytes() == before


def test_explicit_marker_pair_is_atomic(tmp_path):
    path = _write_manifest(
        tmp_path,
        f'''[project]\nformat = "{PROJECT_PACKAGE_FORMAT}"\nid = "demo"\nname = "Demo"\n''',
    )
    with pytest.raises(ProjectPackageError, match="必须同时声明"):
        load_project_package_manifest(path)


def test_future_schema_fails_fast(tmp_path):
    path = _write_manifest(tmp_path, _v1().replace("schema_version = 1", "schema_version = 2"))
    with pytest.raises(UnsupportedProjectPackage, match="schema"):
        load_project_package_manifest(path)


def test_foreign_format_fails_fast(tmp_path):
    path = _write_manifest(tmp_path, _v1().replace(PROJECT_PACKAGE_FORMAT, "foreign-project"))
    with pytest.raises(UnsupportedProjectPackage, match="项目格式"):
        load_project_package_manifest(path)


@pytest.mark.parametrize(
    "value",
    [
        "/Volumes/RAID/show/script.txt",
        "C:\\show\\script.txt",
        "../outside/script.txt",
        "./inputs/../../outside.txt",
        "~/show/script.txt",
        "$HOME/show/script.txt",
    ],
)
def test_nonportable_paths_are_rejected(value):
    with pytest.raises(ProjectPackageError):
        validate_project_relative_path(value, field="input.script")


def test_v1_rejects_device_local_media_roots(tmp_path):
    path = _write_manifest(
        tmp_path,
        _v1() + '\n[media]\nroot = "/Volumes/RAID/show"\n',
    )
    with pytest.raises(ProjectPackageError, match="device-local"):
        load_project_package_manifest(path)


def test_media_directory_v1_does_not_require_fcpxml(tmp_path):
    text = _v1().replace('kind = "fcpxml"', 'kind = "media-directory"').replace(
        'fcpxml = "./inputs/source.fcpxml"\n', ""
    )
    path = _write_manifest(tmp_path, text)
    assert load_project_package_manifest(path).schema_version == PROJECT_PACKAGE_SCHEMA_VERSION
