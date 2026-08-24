from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from script_organizer.review_read_model import build_review_read_model


class FakeReviewStore:
    def __init__(self, payload):
        self.payload = payload

    def load(self):
        return self.payload


class FakeProject:
    def __init__(self, tmp_path: Path):
        self.project_id = "demo"
        self.workspace_id = "workspace-demo"
        self.analysis_revision = "analysis-new"
        self.config = SimpleNamespace(
            name="示例短剧",
            input_kind="fcpxml",
            output_dir=tmp_path,
        )
        self.script = {
            "segments": [
                {
                    "segment_id": "S_1",
                    "episode": 1,
                    "scene_id": "SC_1",
                    "order": 1,
                    "type": "scene_heading",
                    "speaker": "",
                    "text": "",
                    "raw_text": "1-1 室内 日",
                },
                {
                    "segment_id": "S_2",
                    "episode": 1,
                    "scene_id": "SC_1",
                    "order": 2,
                    "type": "dialogue",
                    "speaker": "甲",
                    "text": "自动候选台词",
                    "raw_text": "甲：自动候选台词",
                },
                {
                    "segment_id": "S_3",
                    "episode": 1,
                    "scene_id": "SC_1",
                    "order": 3,
                    "type": "dialogue",
                    "speaker": "乙",
                    "text": "人工归集台词",
                    "raw_text": "乙：人工归集台词",
                },
            ]
        }
        self.index = {
            "stats": {"groups": 1, "clips": 1},
            "groups": [
                {
                    "group_id": "G_1",
                    "parent_group_id": "",
                    "kind": "multicam",
                    "take_index": 1,
                    "start": 10.0,
                    "end": 20.0,
                    "duration": 10.0,
                    "cameras": ["A"],
                    "members": [
                        {
                            "clip_id": "C_1",
                            "media_id": "M_content",
                            "camera": "A",
                            "name": "A001.mov",
                            "media_path": "/Volumes/SECRET/Show/A001.mov",
                            "source_media_path": "/OriginalHost/Show/A001.mov",
                            "resolved_media_path": "/Volumes/SECRET/Show/A001.mov",
                            "local_exists": True,
                            "exists": True,
                            "timeline_start": 10.0,
                            "timeline_end": 20.0,
                            "duration": 10.0,
                            "source_start": 2.0,
                            "source_end": 12.0,
                        }
                    ],
                }
            ],
        }
        self.matches = {
            "groups": {
                "G_1": {
                    "context_episodes": [1],
                    "context_segment_ids": ["S_2", "S_3"],
                    "candidates": [
                        {
                            "candidate_id": "K_1",
                            "group_id": "G_1",
                            "script_segment_id": "S_2",
                            "script_segment_ids": ["S_2"],
                            "confidence": "exact_dialogue",
                            "total_score": 0.94,
                            "dialogue_score": 0.96,
                            "sequence_score": 0.90,
                            "context_score": 0.70,
                            "margin": 0.20,
                            "method": "dialogue",
                            "transcript_text": "演员实际说法",
                            "evidence": ["对白匹配"],
                            "context_episodes": [1],
                        }
                    ],
                }
            },
            "script_gaps": [
                {
                    "episode": 1,
                    "scene_id": "SC_1",
                    "start_order": 3,
                    "end_order": 3,
                    "segment_ids": ["S_3"],
                    "reason": "没有可靠素材对应",
                }
            ],
        }
        self.review = FakeReviewStore(
            {
                "version": 2,
                "revision": 7,
                "updated_at": "2026-08-24T00:00:00+00:00",
                "assignments": {},
                "groups": {
                    "G_1": {
                        "state": "keep",
                        "method": "manual",
                        "actor": "editor-a",
                        "updated_at": "2026-08-24T00:00:00+00:00",
                    }
                },
                "clips": {},
                "placements": {
                    "G_1": {
                        "episode_ids": [1],
                        "script_segment_ids": ["S_3"],
                        "method": "manual",
                        "actor": "editor-a",
                        "updated_at": "2026-08-24T00:00:00+00:00",
                    }
                },
            }
        )

    def reload_if_changed(self):
        return False

    def project_payload(self):
        return {
            "local_media": {
                "device_id": "device-secret",
                "device_name": "Studio Secret",
                "roots": ["/Volumes/SECRET/Show"],
                "total": 1,
                "resolved": 1,
                "missing": 0,
            }
        }


def test_review_v1_projection_preserves_authority_and_hides_host_paths(tmp_path: Path) -> None:
    project = FakeProject(tmp_path)
    automation = {
        "version": 1,
        "analysis_revision": "analysis-new",
        "updated_at": "2026-08-24T00:00:01+00:00",
        "summary": {
            "total": 1,
            "auto_confirmed": 1,
            "ai_confirmed": 0,
            "human_override": 0,
            "needs_review": 0,
            "unresolved": 0,
            "completed": 1,
        },
        "groups": {
            "G_1": {
                "status": "auto_confirmed",
                "mapping_status": "confirmed",
                "mapping_source": "deterministic",
                "candidate_id": "K_1",
                "script_segment_ids": ["S_2"],
                "episode_ids": [1],
                "confidence": 0.97,
                "reason": "高置信度对白匹配",
                "evidence": {"total_score": 0.94, "dialogue_score": 0.96, "margin": 0.20},
            }
        },
    }

    model = build_review_read_model(
        project,
        automation=automation,
        people_for_group=lambda group_id: {
            "face": [
                {
                    "identity_id": "face_1",
                    "label": "演员A",
                    "role_name": "女主",
                    "confidence": 0.91,
                    "start": 2.0,
                    "end": 3.0,
                    "confirmed": True,
                }
            ],
            "speaker": [],
        },
    )

    assert model["contract_version"] == "review.v1"
    assert model["capabilities"] == {
        "legacy_review_v2": True,
        "individual_opinions": False,
        "editorial_decision": False,
        "production_controls": False,
        "host_paths": False,
    }
    assert model["revisions"]["review"] == 7
    assert model["project"]["local_media"] == {"total": 1, "resolved": 1, "missing": 0}

    take = model["take_groups"][0]
    assert take["automatic_state"]["status"] == "auto_confirmed"
    assert take["effective_mapping"] == {
        "source": "human",
        "mapping_status": "confirmed",
        "script_segment_ids": ["S_3"],
        "episode_ids": [1],
        "inherited": False,
    }
    assert take["editorial_state"]["legacy_manual"]["effective_state"] == "keep"
    assert take["editorial_state"]["individual_opinion"] is None
    assert take["editorial_state"]["editorial_decision"] is None
    assert take["people"]["faces"][0]["role_name"] == "女主"
    assert take["angles"][0]["playback"]["url"] == (
        "/api/v1/workspaces/workspace-demo/projects/demo/media/C_1"
    )

    scene = model["episodes"][0]["scenes"][0]
    assert scene["take_group_ids"] == ["G_1"]
    segment = next(row for row in scene["script_blocks"] if row["segment_id"] == "S_3")
    assert segment["issues"][0]["code"] == "script_gap"

    serialized = json.dumps(model, ensure_ascii=False)
    assert "/Volumes/SECRET" not in serialized
    assert "/OriginalHost" not in serialized
    assert "resolved_media_path" not in serialized
    assert "device-secret" not in serialized
    assert "Studio Secret" not in serialized


def test_review_v1_adapter_keeps_team_web_path_free_and_enriches_native_drag_only() -> None:
    root = Path(__file__).resolve().parents[1]
    html = (root / "web" / "index.html").read_text(encoding="utf-8")
    adapter = (root / "web" / "review_model.js").read_text(encoding="utf-8")
    cli = (root / "src" / "script_organizer" / "cli.py").read_text(encoding="utf-8")
    runtime = (root / "src" / "script_organizer" / "review_read_model.py").read_text(encoding="utf-8")

    assert "const nativeApp = Boolean(window.webkit?.messageHandlers?.mirrorOrder);" in adapter
    assert "function nativeMediaPaths(groups)" in adapter
    assert "nativePath = nativeApp ? paths.get(angle.clip_id) : null" in adapter
    assert "projectApi('/groups')" in adapter
    assert "review.v1 stays path-free for Team Web" in adapter
    assert "projectApi('/review-model')" in adapter
    assert "effective_mapping: effectiveMapping" in adapter
    assert "script_supervisor: supervisor" in adapter
    assert "['', '/script', '/groups', '/matches']" not in adapter
    assert html.index('<script src="/review_model.js"></script>') < html.index('<script src="/ux_fixes.js"></script>')
    assert "install_review_read_model_runtime()" in cli
    assert 'CONTRACT_VERSION = "review.v1"' in runtime
    assert 'parts[4] == "review-model"' in runtime
