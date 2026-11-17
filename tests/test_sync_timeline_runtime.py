from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from script_organizer.sync_timeline_runtime import build_sync_timeline, build_sync_delivery_artifacts


def _project(tmp_path: Path, *, media_directory: bool = True):
    output = tmp_path / "output"
    output.mkdir()
    config = SimpleNamespace(output_dir=output, is_media_directory=media_directory)
    return SimpleNamespace(config=config, project_id="p1")


def _write_sync_artifacts(project, *, days=("day1",)) -> None:
    output = project.config.output_dir
    sync = output / "sync"
    work = output / ".multicam-sync" / "work"
    sync.mkdir(parents=True)
    work.mkdir(parents=True)
    (sync / "synchronized.fcpxml").write_text("<fcpxml />", encoding="utf-8")
    (sync / "sync_report.json").write_text(json.dumps({"status": "completed", "days": list(days), "camera_detection": {"contract_version": "camera_detection.v2"}}), encoding="utf-8")
    (project.config.output_dir / "material_index.json").write_text(
        json.dumps({"clips": [{"clip_id": "clip-1", "media_id": "M_1"}], "groups": []}),
        encoding="utf-8",
    )
    for day, rows in {
        "day1": [
            "id\tday\tcam\tfile\tdur\ttc\tclipn\tpos",
            "d1a\tday1\tA\tA001.MP4\t10\t00:00:00:00\t1\t0",
            "d1b\tday1\tB\tB001.MP4\t8\t00:00:00:00\t1\t2",
        ],
        "day2": [
            "id\tday\tcam\tfile\tdur\ttc\tclipn\tpos",
            "d2a\tday2\tA\tA002.MP4\t5\t00:00:00:00\t2\t10",
        ],
    }.items():
        if day in days:
            (work / f"positions_{day}_compressed.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")


def _task(status: str, *, created_at: str, task_id: str) -> dict:
    return {
        "task_id": task_id,
        "type": "multicam_sync",
        "status": status,
        "stage": status,
        "created_at": created_at,
        "started_at": created_at,
        "completed_at": created_at if status == "completed" else "",
        "message": status,
        "progress": {},
    }


def test_cancelled_latest_attempt_does_not_unlock_from_stale_artifact(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project)

    payload = build_sync_timeline(
        project,
        [
            _task("completed", created_at="2026-01-01T00:00:00+00:00", task_id="old"),
            _task("cancelled", created_at="2026-01-01T01:00:00+00:00", task_id="new"),
        ],
    )

    assert payload["ready"] is False
    assert payload["phase"] == "cancelled"
    assert payload["tracks"] == []



def test_running_sync_exposes_worker_activity_and_stage_progress(tmp_path: Path) -> None:
    project = _project(tmp_path)
    task = _task("running", created_at="2026-11-17T08:00:00+00:00", task_id="active")
    task["stage"] = "sync"
    task["message"] = "音频互相关同步 day1"
    task["progress"] = {"done": 3, "total": 8}
    task["updated_at"] = "2026-11-17T08:05:00+00:00"
    payload = build_sync_timeline(project, [task])

    assert payload["ready"] is False
    assert payload["phase"] == "running"
    assert payload["task"]["stage"] == "sync"
    assert payload["task"]["progress"] == {"done": 3, "total": 8}
    assert payload["task"]["updated_at"] == "2026-11-17T08:05:00+00:00"
    assert payload["task"]["message"] == "音频互相关同步 day1"




def test_legacy_prepare_project_sync_is_visible_instead_of_pretending_not_started(tmp_path: Path) -> None:
    project = _project(tmp_path)
    older = _task("completed", created_at="2026-11-17T08:00:00+00:00", task_id="old-sync")
    preparing = _task("running", created_at="2026-11-17T09:00:00+00:00", task_id="prepare")
    preparing["type"] = "prepare_project"
    preparing["stage"] = "sync"
    preparing["message"] = "提取同步音频缓存"
    result = build_sync_timeline(project, [older, preparing])

    assert result["ready"] is False
    assert result["phase"] == "running"
    assert result["task"]["task_id"] == "prepare"
    assert result["task"]["message"] == "提取同步音频缓存"


def test_completed_sync_projects_tracks_by_camera_and_concatenates_days(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project, days=("day1", "day2"))

    payload = build_sync_timeline(
        project,
        [_task("completed", created_at="2026-01-01T00:00:00+00:00", task_id="done")],
    )

    assert payload["ready"] is True
    assert payload["phase"] == "completed"
    assert payload["cameras"] == ["A", "B"]
    assert payload["clip_count"] == 3
    tracks = {track["camera"]: track for track in payload["tracks"]}
    assert tracks["A"]["clips"][0]["name"] == "A001.MP4"
    assert tracks["A"]["clips"][1]["timeline_start"] > tracks["A"]["clips"][0]["timeline_start"]
    assert payload["duration_seconds"] > 10



def test_sync_preview_uses_indexed_media_clip_not_vendor_temporary_id(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project)
    index_path = project.config.output_dir / "material_index.json"
    index_path.write_text(json.dumps({"clips": [
        {"source_asset_id": "day_day1_asset_0", "clip_id": "C_REAL_A", "media_id": "M_content_a"},
        {"source_asset_id": "day_day1_asset_0", "clip_id": "C_REAL_A_SECOND", "media_id": "M_content_a"},
        {"source_asset_id": "day_day1_asset_1", "clip_id": "C_REAL_B", "media_id": "M_content_b"},
    ]}), encoding="utf-8")

    result = build_sync_timeline(project, [
        _task("completed", created_at="2026-01-01T00:00:00+00:00", task_id="ready"),
    ])
    by_camera = {track["camera"]: track["clips"][0] for track in result["tracks"]}
    assert by_camera["A"]["clip_id"] == "d1a"
    assert by_camera["A"]["media_clip_id"] == "C_REAL_A"
    assert by_camera["B"]["media_clip_id"] == "C_REAL_B"



def test_sync_preview_media_identity_uses_fcpxml_sorted_order_not_tsv_order(tmp_path: Path) -> None:
    """Bad TC can scramble TSV order; source_asset IDs come from sorted rows."""
    project = _project(tmp_path)
    _write_sync_artifacts(project)
    positions = project.config.output_dir / ".multicam-sync" / "work" / "positions_day1_compressed.tsv"
    positions.write_text(
        "id\tday\tcam\tfile\tdur\ttc\tclipn\tpos\n"
        "vendor_b\tday1\tB\tB001.MP4\t8\t00:00:01:00\t1\t5\n"
        "vendor_a_late\tday1\tA\tA002.MP4\t8\t00:00:20:00\t2\t20\n"
        "vendor_a_early\tday1\tA\tA001.MP4\t10\t00:00:00:00\t1\t0\n",
        encoding="utf-8",
    )
    index = {"clips": [
        {"source_asset_id": "day_day1_asset_0", "clip_id": "C_EARLY", "media_id": "M_early"},
        {"source_asset_id": "day_day1_asset_1", "clip_id": "C_LATE", "media_id": "M_late"},
        {"source_asset_id": "day_day1_asset_2", "clip_id": "C_B", "media_id": "M_b"},
    ]}
    (project.config.output_dir / "material_index.json").write_text(json.dumps(index), encoding="utf-8")
    result = build_sync_timeline(project, [
        _task("completed", created_at="2026-11-17T10:00:00+00:00", task_id="valid"),
    ])
    by_name = {clip["name"]: clip for track in result["tracks"] for clip in track["clips"]}
    assert result["ready"] is True
    assert by_name["A001.MP4"]["media_clip_id"] == "C_EARLY"
    assert by_name["A002.MP4"]["media_clip_id"] == "C_LATE"
    assert by_name["B001.MP4"]["media_clip_id"] == "C_B"
    assert by_name["B001.MP4"]["clip_id"] == "vendor_b"



def test_sync_preview_refuses_ambiguous_or_provisional_media_identity(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project)
    index_path = project.config.output_dir / "material_index.json"
    index_path.write_text(json.dumps({"clips": [
        {"source_asset_id": "day_day1_asset_0", "clip_id": "C_A1", "media_id": "M_one"},
        {"source_asset_id": "day_day1_asset_0", "clip_id": "C_A2", "media_id": "M_conflict"},
        {"source_asset_id": "day_day1_asset_1", "clip_id": "C_B", "media_id": "MP_filename_only"},
    ]}), encoding="utf-8")
    result = build_sync_timeline(project, [
        _task("completed", created_at="2026-01-01T00:00:00+00:00", task_id="ready"),
    ])
    assert result["ready"] is True
    assert all(not clip["media_clip_id"] for track in result["tracks"] for clip in track["clips"])
    assert all("media_path" not in clip for track in result["tracks"] for clip in track["clips"])


def test_completed_sync_without_media_index_stays_locked(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project)
    (project.config.output_dir / "material_index.json").unlink()

    payload = build_sync_timeline(
        project,
        [_task("completed", created_at="2026-01-01T00:00:00+00:00", task_id="done")],
    )

    assert payload["ready"] is False
    assert payload["phase"] == "invalid"
    assert "媒体身份索引未发布" in payload["message"]


def test_old_camera_rules_require_resync_and_unknown_is_not_a_camera_count(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project)
    report_path = project.config.output_dir / "sync" / "sync_report.json"
    report = json.loads(report_path.read_text())
    report.pop("camera_detection")
    report_path.write_text(json.dumps(report), encoding="utf-8")
    task = _task("completed", created_at="2026-01-01T00:00:00+00:00", task_id="done")

    assert build_sync_timeline(project, [task])["ready"] is False

    report["camera_detection"] = {"contract_version": "camera_detection.v2"}
    report_path.write_text(json.dumps(report), encoding="utf-8")
    path = project.config.output_dir / ".multicam-sync" / "work" / "positions_day1_compressed.tsv"
    path.write_text("id\tday\tcam\tfile\tdur\tpos\n" + "".join(f"id-{camera}\tday1\t{camera}\t{camera}.MP4\t2\t0\n" for camera in [*"ABCDEF", "?"]), encoding="utf-8")

    payload = build_sync_timeline(project, [task])
    assert payload["cameras"] == list("ABCDEF")
    assert len(payload["tracks"]) == 7
    assert payload["tracks"][-1]["label"] == "未分类机位"



def test_local_sync_artifact_manifest_lists_only_verified_export_files(tmp_path: Path) -> None:
    project = _project(tmp_path)
    media_root = tmp_path / "original_media"
    export_dir = media_root / "交付"
    export_dir.mkdir(parents=True)
    project.config.media_roots = (media_root,)
    _write_sync_artifacts(project)
    files = {
        "fcpxml": "synchronized.fcpxml",
        "capcut_fcpxml": "synchronized_capcut.fcpxml",
        "premiere_xml": "synchronized_premiere.xml",
    }
    for filename in files.values():
        (export_dir / filename).write_text("<stub />", encoding="utf-8")
    report_path = project.config.output_dir / "sync" / "sync_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report.update({key: str(export_dir / filename) for key, filename in files.items()})
    report_path.write_text(json.dumps(report), encoding="utf-8")
    task = _task("completed", created_at="2026-11-17T10:00:00+00:00", task_id="exported")

    manifest = build_sync_delivery_artifacts(project, [task])
    assert manifest["ready"] is True
    assert manifest["paths_scope"] == "localhost_response_only"
    assert [item["target"] for item in manifest["artifacts"]] == [
        "davinci", "premiere", "final-cut", "jianying",
    ]
    assert all(item["available"] for item in manifest["artifacts"])
    assert "nle_round_trip_not_verified" in manifest["validation"]


def test_sync_artifact_manifest_does_not_expose_stale_or_foreign_paths(tmp_path: Path) -> None:
    project = _project(tmp_path)
    root = tmp_path / "root"
    (root / "交付").mkdir(parents=True)
    project.config.media_roots = (root,)
    _write_sync_artifacts(project)
    foreign = tmp_path / "secret.fcpxml"
    foreign.write_text("private", encoding="utf-8")
    report_path = project.config.output_dir / "sync" / "sync_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["fcpxml"] = str(foreign)
    report_path.write_text(json.dumps(report), encoding="utf-8")
    task = _task("completed", created_at="2026-11-17T10:00:00+00:00", task_id="done")
    available = build_sync_delivery_artifacts(project, [task])
    assert not any(item["local_path"] for item in available["artifacts"])
    assert str(foreign) not in json.dumps(available)

    cancelled = _task("cancelled", created_at="2026-11-17T11:00:00+00:00", task_id="new")
    blocked = build_sync_delivery_artifacts(project, [task, cancelled])
    assert blocked["ready"] is False
    assert not any(item["available"] for item in blocked["artifacts"])



def test_fcpxml_projects_do_not_require_multicam_sync(tmp_path: Path) -> None:
    project = _project(tmp_path, media_directory=False)

    payload = build_sync_timeline(project, [])

    assert payload["ready"] is True
    assert payload["phase"] == "not-required"
