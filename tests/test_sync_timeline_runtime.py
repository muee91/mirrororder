from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from script_organizer.sync_timeline_runtime import build_sync_timeline


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


def test_fcpxml_projects_do_not_require_multicam_sync(tmp_path: Path) -> None:
    project = _project(tmp_path, media_directory=False)

    payload = build_sync_timeline(project, [])

    assert payload["ready"] is True
    assert payload["phase"] == "not-required"
