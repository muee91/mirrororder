from __future__ import annotations

import json
from pathlib import Path

import pytest

from script_organizer.auto_resolver import resolve_project
from script_organizer.analysis_runtime import analyze as analyze_project
from script_organizer.automation_runtime import _replace_project_script
from script_organizer.config import ProjectConfig
from script_organizer.model_provider import ModelProvider, ModelProviderConfig
from script_organizer.multicam_sync_engine import MulticamSyncUnavailable, _check_prerequisites
from script_organizer.review_store import ReviewStore


def config_for(tmp_path: Path) -> ProjectConfig:
    script = tmp_path / "script.txt"
    script.write_text("dummy", encoding="utf-8")
    output = tmp_path / "output"
    output.mkdir()
    return ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="demo",
        fcpxml=tmp_path / "input.fcpxml",
        script=script,
        output_dir=output,
        transcript_dir=tmp_path / "transcripts",
        input_kind="fcpxml",
        high_confidence=0.82,
        possible_confidence=0.65,
        minimum_margin=0.08,
    )


def write_analysis(config: ProjectConfig) -> None:
    segments = [
        {"segment_id": "S1", "episode": 1, "scene_id": "1-1", "order": 1, "type": "dialogue", "raw_text": "王总你怎么来了", "text": "王总你怎么来了"},
        {"segment_id": "S2", "episode": 1, "scene_id": "1-1", "order": 2, "type": "dialogue", "raw_text": "以后别再来了", "text": "以后别再来了"},
    ]
    groups = [
        {"group_id": "G1", "start": 0, "end": 5, "members": []},
        {"group_id": "G2", "start": 6, "end": 10, "members": []},
    ]
    matches = {
        "groups": {
            "G1": {"candidates": [{
                "candidate_id": "K1", "confidence": "exact_dialogue", "total_score": 0.94,
                "dialogue_score": 0.93, "sequence_score": 0.90, "margin": 0.20,
                "script_segment_ids": ["S1"], "transcript_text": "王总你怎么来了",
            }]},
            "G2": {"candidates": [{
                "candidate_id": "K2", "confidence": "possible_dialogue", "total_score": 0.61,
                "dialogue_score": 0.62, "sequence_score": 0.60, "margin": 0.01,
                "script_segment_ids": ["S2"], "transcript_text": "走吧以后别来了",
            }]},
        }
    }
    (config.output_dir / "material_index.json").write_text(json.dumps({"groups": groups, "clips": []}), encoding="utf-8")
    (config.output_dir / "script.json").write_text(json.dumps({"segments": segments}), encoding="utf-8")
    (config.output_dir / "matches.json").write_text(json.dumps(matches), encoding="utf-8")


def test_high_confidence_auto_confirms_mapping_without_editorial_keep(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    write_analysis(config)
    provider = ModelProvider(ModelProviderConfig())
    result = resolve_project(config, provider)

    confirmed = result["groups"]["G1"]
    ambiguous = result["groups"]["G2"]
    assert confirmed["status"] == "auto_confirmed"
    assert confirmed["mapping_status"] == "confirmed"
    assert confirmed["mapping_source"] == "deterministic"
    assert confirmed["editorial_state"] == "unreviewed"
    assert confirmed["script_segment_ids"] == ["S1"]
    assert ambiguous["status"] == "needs_review"
    assert ambiguous["mapping_status"] == "ambiguous"
    assert ambiguous["editorial_state"] == "unreviewed"
    assert result["summary"]["completed"] == 1


def test_editorial_reject_does_not_become_mapping_evidence_and_manual_placement_does(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    write_analysis(config)
    review = ReviewStore(config.output_dir / "review.json")
    review.apply_action({
        "action": "set_group", "group_id": "G1", "state": "reject", "actor": "editor",
    })

    editorial_only = resolve_project(config, ModelProvider(ModelProviderConfig()))
    entry = editorial_only["groups"]["G1"]
    assert entry["status"] == "auto_confirmed"
    assert entry["mapping_status"] == "confirmed"
    assert entry["mapping_source"] == "deterministic"
    assert entry["script_segment_ids"] == ["S1"]
    assert entry["editorial_state"] == "reject"

    review.apply_action({
        "action": "set_group_placement",
        "group_id": "G1",
        "episode_ids": [1],
        "script_segment_ids": ["S2"],
        "actor": "editor",
    })
    manually_mapped = resolve_project(config, ModelProvider(ModelProviderConfig()))
    entry = manually_mapped["groups"]["G1"]
    assert entry["status"] == "human_override"
    assert entry["mapping_status"] == "confirmed"
    assert entry["mapping_source"] == "human"
    assert entry["script_segment_ids"] == ["S2"]
    assert entry["editorial_state"] == "reject"


def test_desktop_build_can_bundle_sync_engine() -> None:
    root = Path(__file__).resolve().parents[1]
    stage = (root / "desktop/scripts/stage-runtime.mjs").read_text(encoding="utf-8")
    bundle = (root / "desktop/scripts/verify-macos-bundle.mjs").read_text(encoding="utf-8")
    tauri = json.loads((root / "desktop/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    tasks = (root / "src" / "script_organizer" / "tasks.py").read_text(encoding="utf-8")
    automation = (root / "web" / "automation.js").read_text(encoding="utf-8")

    assert "MIRRORORDER_MULTICAM_SYNC_ROOT" in stage
    assert 'path.join(repoRoot, "vendor", "multicam-audio-sync")' in stage
    assert "MIRRORORDER_PORTABLE_PYTHON_ROOT" in stage
    assert "MIRRORORDER_MEDIA_TOOLS_ROOT" in stage
    assert ".agents/skills/multicam-audio-sync" not in stage
    assert 'path.join(core, "vendor", "multicam-audio-sync")' in bundle
    assert tauri["build"]["beforeBuildCommand"] == "npm run stage:runtime && npm run build"
    assert tauri["bundle"]["resources"]["resources/mirrororder-core/"] == "mirrororder-core/"
    assert '"prepare_project"' in tasks
    assert '"auto_resolve"' in tasks
    assert "ai_confirmed" in automation
    assert "待处理" in automation


def test_first_party_multicam_engine_is_complete_and_path_clean() -> None:
    root = Path(__file__).resolve().parents[1]
    engine = root / "vendor" / "multicam-audio-sync"
    required = {
        "project_config.py",
        "make_index.py",
        "extract_parallel.py",
        "sync.py",
        "compress_gaps.py",
        "build_fcpxml.py",
        "build_capcut_fcpxml.py",
        "build_capcut_draft_31.py",
        "build_pr_xml.py",
        "capcut_draft_codec.py",
        "validate_capcut_draft.py",
        "validate_fcpxml.py",
        "capcut_draft_schema.json",
    }
    assert (engine / "SKILL.md").is_file()
    assert (engine / "requirements.txt").is_file()
    assert required <= {path.name for path in (engine / "scripts").iterdir()}
    # Importing the first-party scripts during the suite may create transient
    # __pycache__ entries; repository cleanliness is checked via Git status.
    assert not list(engine.rglob("._*"))
    text = "\n".join(path.read_text(encoding="utf-8", errors="ignore")
                      for path in engine.rglob("*")
                      if path.is_file()
                      and path.name != "config.json"
                      and path.suffix in {".md", ".py", ".json"})
    assert "/Users/editor/" not in text
    assert "/Volumes/PSSD" not in text
    assert "MIRRORORDER_MULTICAM_SYNC_ROOT" not in text


def test_host_runtime_does_not_fallback_to_external_skill() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "multicam_sync_engine.py").read_text(encoding="utf-8")
    assert "Path.home() / \".agents\"" not in runtime
    assert "zipfile" not in runtime
    assert "validate_fcpxml.py" in runtime
    assert "_check_prerequisites()" in runtime
    assert "_materialize_engine" not in runtime
    assert '".multicam-sync" / "engine"' not in runtime
    assert "MIRRORORDER_MULTICAM_CONFIG" in (root / "vendor" / "multicam-audio-sync" / "scripts" / "project_config.py").read_text(encoding="utf-8")


def test_multicam_engine_is_project_first_party_and_runs_in_place() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "multicam_sync_engine.py").read_text(encoding="utf-8")
    diagnostics = (root / "src" / "script_organizer" / "runtime_diagnostics.py").read_text(encoding="utf-8")
    assert "project-first-party" in runtime
    assert '"engine_execution": "in_place"' in runtime
    assert '"external_skill_dependency": False' in runtime
    assert '"execution": "in_place"' in diagnostics


def test_multicam_prerequisites_fail_before_sync_work(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("script_organizer.multicam_sync_engine.shutil.which", lambda _name: None)
    monkeypatch.setattr("script_organizer.multicam_sync_engine.importlib.util.find_spec", lambda _name: None)

    with pytest.raises(MulticamSyncUnavailable, match="缺少命令.*ffmpeg.*ffprobe.*缺少 Python 模块"):
        _check_prerequisites()


def test_project_creation_defaults_to_raw_media_and_is_host_local() -> None:
    root = Path(__file__).resolve().parents[1]
    app = (root / "web" / "app.js").read_text(encoding="utf-8")
    automation = (root / "web" / "automation.js").read_text(encoding="utf-8")
    server = (root / "src" / "script_organizer" / "web_server.py").read_text(encoding="utf-8")

    assert "function openProjectDialog()" in app
    assert "new-project-kind').value = 'media-directory'" in app
    assert "function preferredProject(projects)" in app
    assert "function hasExplicitProjectSelection()" in app
    assert "script-organizer-project-selection-explicit" in app
    assert "kind.value = 'media-directory'" not in automation
    assert "原始多机位素材目录（推荐" in automation
    assert "已有同步 FCPXML（高级入口）" in automation
    assert "项目创建只在 Host 本机或镜序 App 执行" in automation
    assert 'if parts == ["api", "v1", "projects"]:' in server
    assert "self._local_only()" in server


def test_host_script_replacement_updates_only_script_source(tmp_path: Path) -> None:
    old_script = tmp_path / "old.md"
    new_script = tmp_path / "new.docx"
    old_script.write_text("old", encoding="utf-8")
    new_script.write_bytes(b"docx-placeholder")
    fcpxml = tmp_path / "input.fcpxml"
    fcpxml.write_text("<fcpxml/>", encoding="utf-8")
    config_path = tmp_path / "project.toml"
    config_path.write_text(
        f'''[project]\nname = "Demo"\n\n[input]\nkind = "fcpxml"\nscript = "{old_script}"\nfcpxml = "{fcpxml}"\n\n[output]\ndirectory = "./output"\n''',
        encoding="utf-8",
    )
    review_path = tmp_path / "output" / "review.json"
    review_path.parent.mkdir()
    review_payload = {"version": 2, "revision": 7, "groups": {"G1": {"state": "best"}}}
    review_path.write_text(json.dumps(review_payload), encoding="utf-8")

    selected = _replace_project_script(config_path, new_script)

    project_script = config_path.parent / "inputs" / "script.docx"
    assert selected == project_script
    assert ProjectConfig.from_file(config_path).script == project_script.resolve()
    assert project_script.read_bytes() == new_script.read_bytes()
    assert json.loads(review_path.read_text(encoding="utf-8")) == review_payload


def test_media_directory_analysis_redacts_host_paths_after_sync_input(tmp_path: Path) -> None:
    media_root = tmp_path / "HostOnly" / "media"
    media_root.mkdir(parents=True)
    media = media_root / "A001.mov"
    media.write_bytes(b"video")
    project = tmp_path / "project"
    inputs = project / "inputs"
    sync = project / "output" / "sync"
    inputs.mkdir(parents=True)
    sync.mkdir(parents=True)
    script = inputs / "script.md"
    script.write_text("# 第1集\n\n1-1 室内\n\n小王：你好\n", encoding="utf-8")
    generated = sync / "synchronized.fcpxml"
    generated.write_text(
        f'''<fcpxml version="1.8"><resources><asset id="a" src="file://{media}"/></resources>
        <library><event><project><sequence><spine>
        <asset-clip name="A001" ref="a" lane="1" offset="0s" duration="1s"/>
        </spine></sequence></project></event></library></fcpxml>''',
        encoding="utf-8",
    )
    config_path = project / "project.toml"
    config_path.write_text(
        f'''[project]
name = "Portable Directory"
[input]
kind = "media-directory"
script = "./inputs/script.md"
[output]
directory = "./output"
[asr]
backend = "cache"
transcript_dir = "./cache/transcripts"
[media]
root = "{media_root}"
''',
        encoding="utf-8",
    )

    result = analyze_project(ProjectConfig.from_file(config_path))
    index = result["index"]

    assert index["source"]["media_root"] == ""
    assert index["source"]["derived_fcpxml"] == "./output/sync/synchronized.fcpxml"
    assert index["clips"][0]["media_path"] == ""
    assert index["clips"][0]["exists"] is False
    assert str(media_root) not in json.dumps(index, ensure_ascii=False)


def test_script_replacement_route_is_local_and_reanalyzes() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "automation_runtime.py").read_text(encoding="utf-8")
    automation = (root / "web" / "automation.js").read_text(encoding="utf-8")

    assert 'parts[4] == "script"' in runtime
    assert "self._local_only()" in runtime
    assert '"incremental_analyze"' in runtime
    assert "replace-project-script" in automation
    assert "正在重新分析和归集" in automation
