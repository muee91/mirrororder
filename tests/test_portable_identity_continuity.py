"""Portable round-trip identity continuity regression.

真实流程：本机 analyze（设备路径可读，media_id 为 M_ content hash）→
portable export（剥除 FCPXML 设备 src + redact 索引路径）→ import 复制 →
对 imported 项目再次执行正式 analysis_runtime.analyze() → 断言 stable
media_id / clip_id / group_id 与 export 前一致，且 shared artifact 无设备路径。
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

from script_organizer.analysis_runtime import analyze
from script_organizer.config import ProjectConfig
from script_organizer.project_transfer.operations import (
    _DEVICE_PATH_PATTERN,
    copy_project_package,
)

FCPXML_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.8">
  <resources>
    <format id="r1" frameDuration="100/3000s"/>
    <asset id="asset-a" name="A001" src="file://{media_a}" format="r1" hasVideo="1"/>
    <asset id="asset-b" name="B001" src="file://{media_b}" format="r1" hasVideo="1"/>
  </resources>
  <library>
    <event name="导出">
      <project name="P">
        <sequence format="r1" duration="3000/3000s" tcStart="0s">
          <spine>
            <asset-clip name="A001" ref="asset-a" lane="1" offset="0/3000s" duration="3000/3000s" start="0/3000s"/>
            <asset-clip name="B001" ref="asset-b" lane="2" offset="0/3000s" duration="3000/3000s" start="0/3000s"/>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
"""


def _write_origin_project(root: Path) -> ProjectConfig:
    device_media = root / "device-media"
    (device_media / "A1").mkdir(parents=True)
    (device_media / "B1").mkdir(parents=True)
    media_a = device_media / "A1" / "A001.mp4"
    media_b = device_media / "B1" / "B001.mov"
    media_a.write_bytes(b"origin-camera-a-bytes")
    media_b.write_bytes(b"origin-camera-b-bytes")

    project = root / "origin"
    (project / "inputs").mkdir(parents=True)
    (project / "output").mkdir(parents=True)
    (project / "cache" / "transcripts").mkdir(parents=True)
    (project / "inputs" / "script.md").write_text(
        "# 第1集\n\n## 场1\n门口的对话。\n",
        encoding="utf-8",
    )
    (project / "inputs" / "source.fcpxml").write_text(
        FCPXML_TEMPLATE.format(media_a=quote(str(media_a)), media_b=quote(str(media_b))),
        encoding="utf-8",
    )
    config_path = project / "project.toml"
    config_path.write_text(
        "\n".join(
            [
                "[project]",
                'format = "mirrororder-project"',
                "schema_version = 1",
                'id = "portable-continuity"',
                'name = "Portable Continuity"',
                "",
                "[input]",
                'kind = "fcpxml"',
                'script = "./inputs/script.md"',
                'fcpxml = "./inputs/source.fcpxml"',
                "",
                "[output]",
                'directory = "./output"',
                "",
                "[cache]",
                'directory = "./cache"',
                "",
                "[asr]",
                'transcript_dir = "./cache/transcripts"',
                'backend = "cache"',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return ProjectConfig.from_file(config_path)


def _clips_by_asset(index: dict) -> dict:
    return {clip["source_asset_id"]: clip for clip in index["clips"] if clip.get("source_asset_id")}


def _assert_no_device_paths(root: Path) -> None:
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        assert not _DEVICE_PATH_PATTERN.search(text), path


def test_portable_round_trip_preserves_media_and_clip_identity(tmp_path: Path) -> None:
    origin_config = _write_origin_project(tmp_path)
    analyze(origin_config)

    origin_index = json.loads((origin_config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    origin_clips = _clips_by_asset(origin_index)
    assert set(origin_clips) == {"asset-a", "asset-b"}
    assert all(clip["media_id"].startswith("M_") for clip in origin_clips.values())
    origin_group_ids = {group["group_id"] for group in origin_index["groups"]}

    copy_project_package(origin_config.project_dir, tmp_path / "Export")
    package = tmp_path / "Export.mirrorproj"
    _assert_no_device_paths(package)
    # 夹具路径不在枚举模式内，用夹具唯一目录名做穷尽泄漏检查。
    for path in package.rglob("*"):
        if path.is_file():
            assert "device-media" not in path.read_text(encoding="utf-8", errors="ignore"), path

    imported = tmp_path / "workspace" / "imported"
    imported.parent.mkdir(parents=True)
    copy_project_package(package, imported, require_external_source=True, destination_extension=None)
    imported_config = ProjectConfig.from_file(imported / "project.toml")
    analyze(imported_config)

    imported_index = json.loads(
        (imported_config.output_dir / "material_index.json").read_text(encoding="utf-8")
    )
    imported_clips = _clips_by_asset(imported_index)
    assert set(imported_clips) == {"asset-a", "asset-b"}
    for asset_id, origin_clip in origin_clips.items():
        reanalyzed = imported_clips[asset_id]
        assert reanalyzed["media_id"] == origin_clip["media_id"]
        assert reanalyzed["clip_id"] == origin_clip["clip_id"]
        assert reanalyzed["media_path"] == ""
    assert {group["group_id"] for group in imported_index["groups"]} == origin_group_ids
    _assert_no_device_paths(imported_config.output_dir)


def test_reconcile_adopts_clip_id_but_only_verified_media_ids(tmp_path: Path) -> None:
    """clip_id 恢复是结构连续性；media 身份只在 fresh 推导为空时采纳 previous
    verified M_（MP_ 不替代，fresh 已验证结果不被历史覆盖）。"""
    from script_organizer.fcpxml_reader import read_fcpxml
    from script_organizer.material_index import _reconcile_previous_clip_identity

    media = tmp_path / "media"
    media.mkdir()
    (media / "A001.mp4").write_bytes(b"bytes")
    locator = f'<?xml version="1.0"?><fcpxml><resources><asset id="a" src="file://{quote(str(media / "A001.mp4"))}"/></resources><library><event><project><sequence><spine><asset-clip name="A001" ref="a" lane="1" offset="0s" duration="10s"/></spine></sequence></project></event></library></fcpxml>'
    locator_less = '<?xml version="1.0"?><fcpxml><resources><asset id="a"/></resources><library><event><project><sequence><spine><asset-clip name="A001" ref="a" lane="1" offset="0s" duration="10s"/></spine></sequence></project></event></library></fcpxml>'

    located_path = tmp_path / "located.fcpxml"
    located_path.write_text(locator, encoding="utf-8")
    blank_path = tmp_path / "blank.fcpxml"
    blank_path.write_text(locator_less, encoding="utf-8")
    located = read_fcpxml(located_path)
    fresh_clip_id = located[0].clip_id
    fresh_media_id = located[0].media_id
    assert fresh_media_id.startswith("M_")

    # fresh 已推导出 verified M_：previous 的 MP_/其他 M_ 都不覆盖（本机内容
    # 校验结果优先），clip_id 仍恢复（结构连续）。
    for previous_media in ("MP_provisional", "M_verified"):
        previous = {"clips": [{"source_asset_id": "a", "clip_id": "C_old", "media_id": previous_media}]}
        reconciled = _reconcile_previous_clip_identity(located, previous)
        assert reconciled[0].clip_id == "C_old"
        assert reconciled[0].media_id == fresh_media_id

    # fresh 推导为空（portable locator-less 文档）：previous verified M_ 采纳，
    # MP_ provisional 不采纳（保持空，等待设备 rebind 验证）。
    blank = read_fcpxml(blank_path)
    assert blank[0].media_id == ""
    verified = {"clips": [{"source_asset_id": "a", "clip_id": "C_old", "media_id": "M_verified"}]}
    restored = _reconcile_previous_clip_identity(blank, verified)
    assert restored[0].clip_id == "C_old"
    assert restored[0].media_id == "M_verified"
    provisional = {"clips": [{"source_asset_id": "a", "clip_id": "C_old", "media_id": "MP_provisional"}]}
    kept_empty = _reconcile_previous_clip_identity(read_fcpxml(blank_path), provisional)
    assert kept_empty[0].clip_id == "C_old"
    assert kept_empty[0].media_id == ""

    # 本机完整重分析（fresh 与 previous 一致）为 no-op。
    same = {"clips": [{"source_asset_id": "a", "clip_id": fresh_clip_id, "media_id": fresh_media_id}]}
    untouched = _reconcile_previous_clip_identity(read_fcpxml(located_path), same)
    assert untouched[0].clip_id == fresh_clip_id
    assert untouched[0].media_id == fresh_media_id
