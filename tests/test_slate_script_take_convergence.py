from __future__ import annotations

import json
from pathlib import Path

from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.review_read_model import build_review_read_model
from script_organizer.review_store import ReviewStore
from script_organizer.script_supervisor_store import ScriptSupervisorStore


ROOT = Path(__file__).resolve().parents[1]


class FakeProject:
    def __init__(self, config: ProjectConfig):
        self.project_id = "demo"
        self.workspace_id = "ws-demo"
        self.config = config
        self.review = ReviewStore(config.output_dir / "review.json")
        self.analysis_revision = "analysis-current"
        self.reload_if_changed()

    def reload_if_changed(self) -> bool:
        self.index = json.loads((self.config.output_dir / "material_index.json").read_text(encoding="utf-8"))
        self.script = json.loads((self.config.output_dir / "script.json").read_text(encoding="utf-8"))
        self.matches = json.loads((self.config.output_dir / "matches.json").read_text(encoding="utf-8"))
        return False

    def project_payload(self) -> dict:
        return {"local_media": {"total": 2, "resolved": 2, "missing": 0}}


def _project(tmp_path: Path) -> FakeProject:
    root = tmp_path / "project"
    output = root / "output"
    transcript = root / "cache" / "transcripts"
    output.mkdir(parents=True)
    transcript.mkdir(parents=True)
    script_path = root / "script.txt"
    script_path.write_text("demo", encoding="utf-8")
    config_path = root / "project.toml"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")

    segments = [
        {"segment_id": "H1", "episode": 1, "scene_id": "SC1", "order": 1, "type": "scene_heading", "raw_text": "1-1"},
        {"segment_id": "S1", "episode": 1, "scene_id": "SC1", "order": 2, "type": "dialogue", "text": "旧自动匹配"},
        {"segment_id": "H2", "episode": 2, "scene_id": "SC2", "order": 1, "type": "scene_heading", "raw_text": "2-1"},
        {"segment_id": "S2", "episode": 2, "scene_id": "SC2", "order": 2, "type": "dialogue", "text": "人工改到这里"},
    ]
    group = {
        "group_id": "G1",
        "start": 30.0,
        "end": 40.0,
        "duration": 10.0,
        "take_index": 1,
        "cameras": ["A", "B"],
        "members": [
            {"clip_id": "CA", "media_id": "M_A", "camera": "A", "name": "A.mov", "duration": 10.0},
            {"clip_id": "CB", "media_id": "M_B", "camera": "B", "name": "B.mov", "duration": 10.0},
        ],
    }
    (output / "script.json").write_text(json.dumps({"segments": segments}, ensure_ascii=False), encoding="utf-8")
    (output / "material_index.json").write_text(
        json.dumps({"groups": [group], "stats": {"groups": 1, "clips": 2}}, ensure_ascii=False),
        encoding="utf-8",
    )
    (output / "matches.json").write_text(
        json.dumps(
            {
                "groups": {
                    "G1": {
                        "candidates": [
                            {
                                "candidate_id": "auto-s1",
                                "group_id": "G1",
                                "script_segment_id": "S1",
                                "script_segment_ids": ["S1"],
                                "confidence": "exact_dialogue",
                                "total_score": 0.98,
                                "context_episodes": [1],
                            }
                        ],
                        "context_episodes": [1],
                    }
                },
                "by_segment": {},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    AutomationStore(output).save(
        "analysis-current",
        {
            "G1": {
                "status": "auto_confirmed",
                "mapping_status": "confirmed",
                "mapping_source": "dialogue",
                "candidate_id": "auto-s1",
                "script_segment_ids": ["S1"],
                "episode_ids": [1],
                "confidence": 0.98,
            }
        },
        {},
    )
    config = ProjectConfig(
        config_path=config_path,
        name="demo",
        fcpxml=None,
        script=script_path,
        output_dir=output,
        transcript_dir=transcript,
        input_kind="media-directory",
        media_root=None,
    )
    return FakeProject(config)


def test_manual_take_placement_converges_review_slate_and_review_model(tmp_path: Path) -> None:
    project = _project(tmp_path)

    automatic_before = AutomationStore(project.config.output_dir).load()["groups"]["G1"]
    assert automatic_before["script_segment_ids"] == ["S1"]

    saved = project.review.apply_action(
        {
            "action": "set_group_placement",
            "group_id": "G1",
            "episode_ids": [2],
            "script_segment_ids": ["S2"],
            "actor": "剪辑甲",
            "interaction": "drag_drop",
            "source_surface": "web_review",
            "source_kind": "take",
        }
    )
    assert saved["placements"]["G1"]["episode_ids"] == [2]
    assert saved["placements"]["G1"]["script_segment_ids"] == ["S2"]

    # Review is the mapping authority, but the production slate receives the
    # same explicit scene/episode projection without inventing a new authority.
    slate = ScriptSupervisorStore(project.config.output_dir).load()
    slate_entry = slate["entries"]["G1"]
    assert slate_entry["episode"] == 2
    assert slate_entry["script_scene_id"] == "SC2"
    record = next(row for row in slate["records"].values() if row["source_group_id"] == "G1")
    assert {item["clip_id"] for item in record["attachments"]} == {"CA", "CB"}

    model = build_review_read_model(
        project,
        automation=AutomationStore(project.config.output_dir).load(),
        people_for_group=lambda _group_id: {"face": [], "speaker": []},
    )
    take = model["take_groups"][0]
    assert take["automatic_state"]["script_segment_ids"] == ["S1"]
    assert take["effective_mapping"] == {
        "source": "human",
        "mapping_status": "confirmed",
        "script_segment_ids": ["S2"],
        "episode_ids": [2],
        "inherited": False,
    }
    assert model["review_state"]["legacy_review"]["placements"]["G1"]["script_segment_ids"] == ["S2"]


def test_slate_angle_edit_is_projected_to_web_without_becoming_mapping_authority(tmp_path: Path) -> None:
    project = _project(tmp_path)
    store = ScriptSupervisorStore(project.config.output_dir)
    saved = store.apply(
        {
            "group_id": "G1",
            "expected_revision": 0,
            "actor": "场记甲",
            "entry": {
                "episode": 1,
                "scene": "1-1",
                "angles": {"CB": {"shot_type": "closeup", "note": "人物近景"}},
            },
        }
    )
    assert saved["entries"]["G1"]["angles"]["CB"]["shot_type"] == "closeup"
    assert project.review.load()["placements"] == {}

    runtime = (ROOT / "src" / "script_organizer" / "script_supervisor_runtime.py").read_text(encoding="utf-8")
    adapter = (ROOT / "web" / "review_model.js").read_text(encoding="utf-8")
    cards = (ROOT / "web" / "material_card_ui.js").read_text(encoding="utf-8")
    assert 'take["script_supervisor"] = _safe_entry(entries.get(group_id))' in runtime
    assert "script_supervisor: supervisor" in adapter
    assert "group?.script_supervisor?.angles || {}" in cards
    assert "supervisorAngles?.[clipId]?.shot_type" in cards
    assert "supervisorType || member?.shot_type" in cards


def test_web_mapping_order_is_episode_first_then_authority_confidence_then_xml() -> None:
    app = (ROOT / "web" / "app.js").read_text(encoding="utf-8")

    # Within an episode: manual > exact/high-confidence script > possible script
    # > episode-only > XML fallback.
    assert "let rank = 4;" in app
    assert "candidateConfidence === 'manual'" in app
    assert "rank = 0;" in app
    assert "candidateConfidence === 'exact_dialogue'" in app
    assert "rank = 1;" in app
    assert "candidateConfidence === 'possible_dialogue'" in app
    assert "rank = 2;" in app
    assert "rank = 3;" in app
    assert "label = 'XML待标记';" in app

    comparator = app[app.index("function compareMappingMarkers"):]
    episode = comparator.index("left.episodeRank - right.episodeRank")
    authority = comparator.index("left.rank - right.rank")
    script_order = comparator.index("left.scriptOrder - right.scriptOrder")
    xml_order = comparator.index("left.xmlOrder - right.xmlOrder")
    assert 0 <= episode < authority < script_order < xml_order


def test_default_first_episode_remains_a_performance_policy_with_explicit_all_option() -> None:
    app = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    assert "default_episode: 'first'" in app
    assert "if (preference === 'all')" in app
    assert "state.episode = null;" in app
    assert 'data-episode="all"' in app
