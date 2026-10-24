"""Automation / AI 不得写创意 state 或 Editorial authority。

行为测试直接调用真实写入方：
- ``auto_resolver.resolve_project`` → ``auto_decisions.json``（映射轴）；
- ``ReviewStore`` → ``review.json``（人工 creative state）；
- ``EditorialStore`` → ``editorial.json``（Individual Opinion 与最终编辑决定）。

web/*.js 仍保留两条最小结构断言：它们是绑定 window/state 全局的浏览器 IIFE，
仓库没有 JS DOM harness，pytest 无法在本层构造输入调用真实函数；具体理由写在
对应测试的 docstring 里。
"""

from __future__ import annotations

import json
from pathlib import Path

from script_organizer.auto_resolver import resolve_project
from script_organizer.automation_store import AUTOMATION_STATUSES
from script_organizer.config import ProjectConfig
from script_organizer.editorial_store import EditorialStore
from script_organizer.model_provider import ModelProvider, ModelProviderConfig
from script_organizer.review_store import ReviewStore


ROOT = Path(__file__).resolve().parents[1]


def _project_with_analysis(tmp_path: Path) -> ProjectConfig:
    script = tmp_path / "script.txt"
    script.write_text("dummy", encoding="utf-8")
    output = tmp_path / "output"
    output.mkdir()
    config = ProjectConfig(
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
    (output / "material_index.json").write_text(json.dumps({"groups": groups, "clips": []}), encoding="utf-8")
    (output / "script.json").write_text(json.dumps({"segments": segments}), encoding="utf-8")
    (output / "matches.json").write_text(json.dumps(matches), encoding="utf-8")
    return config


def test_automation_never_supplies_best_keep_reject_state(tmp_path: Path) -> None:
    config = _project_with_analysis(tmp_path)
    review = ReviewStore(config.output_dir / "review.json")
    review.apply_action({"action": "set_group", "group_id": "G1", "state": "reject", "actor": "editor"})
    review.apply_action({"action": "set_group", "group_id": "G2", "state": "best", "actor": "editor"})
    editorial = EditorialStore(config.output_dir)
    editorial.apply_decision({
        "target_kind": "group",
        "group_id": "G1",
        "state": "keep",
        "actor": "editor",
        "expected_revision": 0,
    })
    review_path = config.output_dir / "review.json"
    editorial_path = config.output_dir / "editorial.json"
    review_before = review_path.read_text(encoding="utf-8")
    editorial_before = editorial_path.read_text(encoding="utf-8")

    automation = resolve_project(config, ModelProvider(ModelProviderConfig()))

    assert review_path.read_text(encoding="utf-8") == review_before, "automation wrote creative review state"
    assert editorial_path.read_text(encoding="utf-8") == editorial_before, "automation wrote editorial authority"
    assert "decisions" not in automation and "opinions" not in automation

    groups = automation["groups"]
    assert {entry["status"] for entry in groups.values()} <= AUTOMATION_STATUSES
    # 映射轴保持独立：人工 creative state 不改变自动归集结论。
    assert groups["G1"]["status"] == "auto_confirmed"
    assert groups["G2"]["status"] == "needs_review"
    # creative state 只作为只读事实被带出，automation 不拥有它。
    assert groups["G1"]["editorial_state"] == "reject"
    assert groups["G2"]["editorial_state"] == "best"

    saved = json.loads((config.output_dir / "auto_decisions.json").read_text(encoding="utf-8"))
    assert {entry["status"] for entry in saved["groups"].values()} <= AUTOMATION_STATUSES
    assert json.loads(editorial_path.read_text(encoding="utf-8"))["decisions"]["group|G1"]["state"] == "keep"


def test_individual_opinion_never_becomes_final_editorial_decision(tmp_path: Path) -> None:
    store = EditorialStore(tmp_path)

    store.apply_opinion({
        "target_kind": "group", "group_id": "G1", "state": "best",
        "actor": "reviewer-a", "reviewer_id": "r-a",
    })
    payload = store.apply_opinion({
        "target_kind": "group", "group_id": "G1", "state": "reject",
        "actor": "reviewer-b", "reviewer_id": "r-b",
    })

    assert payload["decisions"] == {}, "an individual opinion became the final editorial decision"
    opinions = payload["opinions"]["group|G1"]["reviewers"]
    assert {row["state"] for row in opinions.values()} == {"best", "reject"}

    decided = store.apply_decision({
        "target_kind": "group",
        "group_id": "G1",
        "state": "keep",
        "actor": "editor",
        "expected_revision": payload["revision"],
    })

    assert decided["decisions"]["group|G1"]["state"] == "keep"
    assert {row["state"] for row in decided["opinions"]["group|G1"]["reviewers"].values()} == {"best", "reject"}


def test_web_automation_never_reads_or_writes_editorial_authority() -> None:
    """最小结构断言。

    ``web/automation.js`` 是直接改写全局 ``window`` / ``state`` 的浏览器 IIFE，
    没有可独立 import 的导出，仓库也没有 JS DOM harness；在 pytest 里构造输入调用
    它需要新增浏览器测试栈，超出本测试的修复范围。因此这里只静态锁定红线：
    automation 展示层不得读取或写入 editorial authority 的任何字段与入口。
    """
    automation = (ROOT / "web" / "automation.js").read_text(encoding="utf-8")

    assert "editorial_state" not in automation
    assert "editorial_decision" not in automation
    assert "projectApi('/editorial" not in automation


def test_web_assignment_state_derives_only_from_own_opinion() -> None:
    """最小结构断言（理由同上：web IIFE 无 JS harness）。

    团队 Web 的 assignmentState 必须只反映当前 reviewer 自己的 opinion，缺失时
    回落 ``unreviewed``；不得回落成 group automation 或 review 的 Best/Keep/Reject。
    """
    editorial = (ROOT / "web" / "editorial_ui.js").read_text(encoding="utf-8")
    marker = "assignmentState = function editorialAssignmentState"
    start = editorial.index(marker)
    block = editorial[start:editorial.index("};", start)]

    assert "myOpinion(" in block
    assert "'unreviewed'" in block
    assert "automation" not in block
    assert "groupReviewEntry" not in block
