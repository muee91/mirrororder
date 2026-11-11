from __future__ import annotations

import json
from pathlib import Path

from script_organizer.analysis_runtime import _prefill_transcripts, analyze as analyze_runtime
from script_organizer.config import ProjectConfig
from script_organizer.device_media_runtime import _resolve_project_media_path
from script_organizer.material_index import _reconcile_previous_clip_identity, analyze
from script_organizer.media_identity import (
    DeviceMediaStore,
    media_id_for_path,
    resolve_fcpxml_clips,
)
from script_organizer.fcpxml_reader import read_fcpxml
from script_organizer.models import Transcript


def _clip_xml(path: Path) -> Path:
    xml = path.parent / "source.fcpxml"
    xml.write_text(
        f'''<?xml version="1.0"?><fcpxml version="1.8"><resources>
        <asset id="a1" src="file://{path}"/>
        </resources><library><event><project><sequence><spine>
        <asset-clip name="A001" ref="a1" offset="0s" duration="4s"/>
        </spine></sequence></project></event></library></fcpxml>''',
        encoding="utf-8",
    )
    return xml


def test_moved_binding_wins_and_original_hash_is_fail_closed(tmp_path: Path) -> None:
    original = tmp_path / "old" / "A001.mov"
    moved = tmp_path / "new" / "A001.mov"
    original.parent.mkdir()
    moved.parent.mkdir()
    original.write_bytes(b"stable media bytes")
    moved.write_bytes(original.read_bytes())
    clip = read_fcpxml(_clip_xml(original))[0]
    media_id = media_id_for_path(original)
    assert clip.media_id == media_id

    store = DeviceMediaStore(tmp_path / "device" / "bindings.json")
    store.scan(
        "workspace",
        "project",
        {"clips": [{"media_id": media_id, "name": "A001.mov", "source_media_path": str(original)}]},
        [str(moved.parent)],
    )
    resolved = resolve_fcpxml_clips([clip], "workspace", "project", store=store)[0]
    assert resolved.media_path == str(moved)

    # If the original locator now points at replacement bytes and no binding
    # exists, the old M_ identity must not be silently adopted.
    original.write_bytes(b"replacement bytes")
    no_binding = DeviceMediaStore(tmp_path / "device" / "empty.json")
    rejected = resolve_fcpxml_clips([clip], "workspace", "project", store=no_binding)[0]
    assert rejected.media_path == ""
    assert rejected.exists is False


def test_partial_context_fails_closed_and_previous_m_identity_reconnects(tmp_path: Path) -> None:
    media = tmp_path / "A001.mov"
    media.write_bytes(b"stable media bytes")
    xml = _clip_xml(media)
    located = read_fcpxml(xml)[0]
    previous = {"clips": [{"source_asset_id": located.source_asset_id, "clip_id": "C_old", "media_id": located.media_id}]}
    locatorless = tmp_path / "locatorless.fcpxml"
    locatorless.write_text(xml.read_text(encoding="utf-8").replace(f' src="file://{media}"', ""), encoding="utf-8")
    blank = read_fcpxml(locatorless)[0]
    restored = _reconcile_previous_clip_identity([blank], previous)[0]
    assert restored.media_id.startswith("M_")
    assert resolve_fcpxml_clips([restored], "workspace", "")[0].media_path == ""

    store = DeviceMediaStore(tmp_path / "device" / "bindings.json")
    store.scan(
        "workspace",
        "project",
        {"clips": [{"media_id": restored.media_id, "name": "A001.mov"}]},
        [str(media.parent)],
    )
    assert resolve_fcpxml_clips([restored], "workspace", "project", store=store)[0].media_path == str(media)
    # The reader exposes the same resolver for prepare/ASR callers that parse
    # FCPXML outside material_index.
    resolved_by_reader = read_fcpxml(
        locatorless,
        workspace_id="workspace",
        project_id="project",
        previous_index=previous,
        device_store=store,
    )[0]
    assert resolved_by_reader.media_path == str(media)


def test_context_analysis_keeps_memory_paths_but_redacts_shared_artifacts(tmp_path: Path) -> None:
    media = tmp_path / "A001.mov"
    media.write_bytes(b"stable media bytes")
    script = tmp_path / "script.txt"
    script.write_text("# 第1集\n\n## 场1\n甲：你好\n", encoding="utf-8")
    fcpxml = _clip_xml(media)
    output = tmp_path / "output"
    config = ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="binding",
        fcpxml=fcpxml,
        script=script,
        output_dir=output,
        transcript_dir=tmp_path / "transcripts",
        asr_backend="cache",
    )
    result = analyze(config, workspace_id="workspace", project_id="project")
    assert result["index"]["clips"][0]["media_path"] == str(media)
    published = json.loads((output / "material_index.json").read_text(encoding="utf-8"))
    snapshot = json.loads((output / "analysis_snapshot.json").read_text(encoding="utf-8"))
    assert published["clips"][0]["media_path"] == ""
    assert published["clips"][0]["exists"] is False
    assert snapshot["index"]["clips"][0]["media_path"] == ""
    assert published["source"]["media_binding"] == "device-local"


def test_contextless_fcpxml_analysis_also_redacts_persisted_paths(tmp_path: Path) -> None:
    media = tmp_path / "A001.mov"
    media.write_bytes(b"stable media bytes")
    script = tmp_path / "script.txt"
    script.write_text("甲：你好\n", encoding="utf-8")
    config = ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="contextless",
        fcpxml=_clip_xml(media),
        script=script,
        output_dir=tmp_path / "output",
        transcript_dir=tmp_path / "transcripts",
        asr_backend="cache",
    )
    result = analyze_runtime(config)
    published = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    snapshot = json.loads((config.output_dir / "analysis_snapshot.json").read_text(encoding="utf-8"))
    assert result["index"]["clips"][0]["media_path"] == str(media)
    assert published["clips"][0]["media_path"] == ""
    assert snapshot["index"]["clips"][0]["media_path"] == ""

    # The lower-level material_index API has the same persistence boundary,
    # even when callers do not go through analysis_runtime.
    direct = analyze(config)
    direct_published = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    assert direct["index"]["clips"][0]["media_path"] == str(media)
    assert direct_published["clips"][0]["media_path"] == ""


def test_asr_prefill_uses_moved_device_binding(tmp_path: Path) -> None:
    old = tmp_path / "old" / "A001.mov"
    moved = tmp_path / "new" / "A001.mov"
    old.parent.mkdir()
    moved.parent.mkdir()
    old.write_bytes(b"stable media bytes")
    moved.write_bytes(old.read_bytes())
    fcpxml = _clip_xml(old)
    clip = read_fcpxml(fcpxml)[0]
    store = DeviceMediaStore(tmp_path / "device" / "bindings.json")
    store.scan(
        "workspace",
        "project",
        {"clips": [{"media_id": clip.media_id, "name": clip.name}]},
        [str(moved.parent)],
    )
    script = tmp_path / "script.txt"
    script.write_text("甲：你好\n", encoding="utf-8")
    config = ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="asr",
        fcpxml=fcpxml,
        script=script,
        output_dir=tmp_path / "output",
        transcript_dir=tmp_path / "transcripts",
        asr_backend="faster-whisper",
    )

    seen: list[str] = []

    class StubRuntime:
        enabled = True

        @staticmethod
        def public() -> dict[str, str]:
            return {"backend": "test"}

        def transcribe(self, resolved_clip, transcript_store, prompt):
            seen.append(resolved_clip.media_path)
            return Transcript(resolved_clip.clip_id, resolved_clip.name, resolved_clip.media_id, "你好")

    _prefill_transcripts(
        config,
        config,
        StubRuntime(),
        workspace_id="workspace",
        project_id="project",
        previous_index={"clips": [{"source_asset_id": clip.source_asset_id, "clip_id": clip.clip_id, "media_id": clip.media_id}]},
        device_store=store,
    )
    assert seen == [str(moved)]


def test_playback_reconnects_moved_binding_when_shared_clip_has_no_source_path(tmp_path: Path) -> None:
    old = tmp_path / "old" / "A001.mov"
    moved = tmp_path / "new" / "A001.mov"
    old.parent.mkdir()
    moved.parent.mkdir()
    old.write_bytes(b"stable media bytes")
    moved.write_bytes(old.read_bytes())
    fcpxml = _clip_xml(old)
    clip = read_fcpxml(fcpxml)[0]
    store = DeviceMediaStore(tmp_path / "device" / "bindings.json")
    store.scan(
        "workspace",
        "project",
        {"clips": [{"media_id": clip.media_id, "name": clip.name}]},
        [str(moved.parent)],
    )

    class RuntimeProject:
        project_id = "project"
        config = type("Config", (), {"fcpxml": fcpxml})()
        _device_media_store = store
        _device_media_workspace_id = "workspace"

    resolved = _resolve_project_media_path(
        RuntimeProject(),
        {
            "clip_id": clip.clip_id,
            "source_asset_id": clip.source_asset_id,
            "media_id": clip.media_id,
            "media_path": "",
        },
    )
    assert resolved == str(moved)
