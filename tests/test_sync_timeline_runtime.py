from __future__ import annotations

import json
from pathlib import Path

import pytest
from types import SimpleNamespace

from script_organizer.media_identity import DeviceMediaStore, media_id_for_path
from script_organizer.nle_delivery.resolve_plan import build_resolve_plan
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


def test_sync_preview_rejects_partial_multi_day_positions(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project, days=("day1", "day2"))
    positions = project.config.output_dir / ".multicam-sync" / "work" / "positions_day2_compressed.tsv"
    positions.unlink()

    payload = build_sync_timeline(project, [
        _task("completed", created_at="2026-01-01T00:00:00+00:00", task_id="done"),
    ])

    assert payload["phase"] == "invalid"
    assert payload["ready"] is False
    assert payload["tracks"] == []


def test_sync_preview_only_removes_whole_frames_without_any_camera(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project, days=("day1", "day2"))
    output = project.config.output_dir
    report_path = output / "sync" / "sync_report.json"
    report = {**json.loads(report_path.read_text()), "gap_policy": "preserve-all-gaps"}
    report_path.write_text(json.dumps(report), encoding="utf-8")
    master = output / "sync" / "synchronized.fcpxml"
    master.write_text(
        '<fcpxml><resources><format id="f1" frameDuration="1/50s"/></resources>'
        '<project><sequence format="f1"/></project></fcpxml>',
        encoding="utf-8",
    )
    positions = output / ".multicam-sync" / "work" / "positions_day1_compressed.tsv"
    positions.write_text(
        "id\tday\tcam\tfile\tdur\tpos\n"
        "a\tday1\tA\tA.MP4\t2\t100\n"
        "b\tday1\tB\tB.MP4\t2.005\t101\n"
        "c\tday1\tA\tC.MP4\t2\t107.007\n"
        "d\tday1\tC\tD.MP4\t2\t108\n",
        encoding="utf-8",
    )
    before = {path: path.read_bytes() for path in output.rglob("*") if path.is_file()}
    tasks = [_task("completed", created_at="2026-11-18T00:00:00+00:00", task_id="done")]

    payload = build_sync_timeline(project, tasks)

    assert payload["review_gaps"] == [{"start_frame": 151, "end_frame": 351}]
    assert payload["duration_seconds"] == 15
    assert payload["clip_count"] == 5
    clips = {clip["clip_id"]: clip for track in payload["tracks"] for clip in track["clips"]}
    assert abs(clips["c"]["timeline_start"] - 7.007) < 1e-9
    assert clips["b"]["duration"] == 2.005
    assert {path: path.read_bytes() for path in before} == before


def test_sync_preview_keeps_negative_offsets_before_normalizing_each_day(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project)
    positions = project.config.output_dir / ".multicam-sync" / "work" / "positions_day1_compressed.tsv"
    positions.write_text("id\tday\tcam\tfile\tdur\tpos\n"
                         "a\tday1\tA\tA001.MP4\t2\t-0.5\n"
                         "b\tday1\tB\tB001.MP4\t2\t0\n", encoding="utf-8")

    payload = build_sync_timeline(project, [
        _task("completed", created_at="2026-01-01T00:00:00+00:00", task_id="done"),
    ])

    tracks = {track["camera"]: track["clips"][0] for track in payload["tracks"]}
    assert tracks["A"]["timeline_start"] == 0
    assert tracks["B"]["timeline_start"] == 0.5
    assert payload["duration_seconds"] == 2.5


def test_resolve_plan_uses_verified_media_and_splits_recording_at_common_gap(tmp_path: Path) -> None:
    project = _project(tmp_path)
    project.workspace_id = "workspace"
    _write_sync_artifacts(project)
    output = project.config.output_dir
    master = output / "sync" / "synchronized.fcpxml"
    master.write_text(
        '<fcpxml><resources><format id="f1" frameDuration="1/50s"/></resources>'
        '<project><sequence format="f1"/></project></fcpxml>', encoding="utf-8",
    )
    positions = output / ".multicam-sync" / "work" / "positions_day1_compressed.tsv"
    positions.write_text(
        "id\tday\tcam\tfile\tdur\tpos\n"
        "a\tday1\tA\tleft.mov\t2\t0\n"
        "b\tday1\tB\tright.mov\t2\t5\n", encoding="utf-8",
    )
    inputs = [tmp_path / name for name in ("left.mov", "right.mov", "recorder.wav")]
    for path in inputs:
        path.write_bytes(path.name.encode())
    ids = [media_id_for_path(path) for path in inputs]
    state = tmp_path / "bindings.json"
    state.write_text(json.dumps({"workspaces": {"workspace": {"projects": {"p1": {"bindings": dict(
        zip(ids, [str(path) for path in inputs])
    )}}}}}), encoding="utf-8")
    (output / "material_index.json").write_text(json.dumps({"clips": [
        {"clip_id": f"clip_{i}", "media_id": media_id, "source_asset_id": f"day_day1_asset_{i}"}
        for i, media_id in enumerate(ids[:2])
    ]}), encoding="utf-8")
    report_path = output / "sync" / "sync_report.json"
    report = json.loads(report_path.read_text())
    report["recording_alignment"] = {"status": "confirmed", "sync_task_id": "done", "placements": [
        {"track": "同期声", "name": inputs[2].name, "media_id": ids[2], "at": 50, "frames": 250, "source": 15, "source_kind": "original", "timing_basis": "original_unretimed", "source_rate_ratio": [1, 1]},
    ]}
    report_path.write_text(json.dumps(report), encoding="utf-8")
    task = _task("completed", created_at="2026-11-18T00:00:00+00:00", task_id="done")
    store = DeviceMediaStore(state)

    plan = build_resolve_plan(project, [task], store, lambda: False)

    assert plan["gaps"] == 1 and plan["frames"] == 200
    assert [track["camera"] for track in plan["tracks"]] == ["A", "B"]
    assert [track["clips"][0]["at"] for track in plan["tracks"]] == [0, 100]
    assert [(row["at"], row["frames"], row["source"]) for row in plan["recordings"]] == [(50, 50, 15), (100, 50, 215)]
    assert {row["path"] for row in plan["recordings"]} == {str(inputs[2].resolve())}
    stale = {**task, "task_id": "other-revision"}
    assert build_resolve_plan(project, [stale], store, lambda: False)["recordings"] == []
    assert build_resolve_plan(project, [stale], store, lambda: False)["diagnostics"][0]["code"] == "original_recordings_not_exported"
    report["recording_inventory"] = {"candidates": [{"media_id": ids[2]}]}
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert build_resolve_plan(project, [task], store, lambda: False)["recordings"]
    with pytest.raises(ValueError, match="独立录音交付不完整"):
        build_resolve_plan(project, [stale], store, lambda: False)
    report["recording_inventory"]["candidates"].append({"media_id": "M_unplaced"})
    with pytest.raises(ValueError, match="独立录音交付不完整"):
        report_path.write_text(json.dumps(report), encoding="utf-8")
        build_resolve_plan(project, [task], store, lambda: False)
    report.pop("recording_inventory")
    report_path.write_text(json.dumps(report), encoding="utf-8")
    # No dependency on another workstation's old absolute root. Stable media IDs
    # bind to this device's relocated originals, without copying/rendering audio.
    relocated = tmp_path / "second-device"
    relocated.mkdir()
    moved = []
    for original in inputs:
        target = relocated / original.name
        target.write_bytes(original.read_bytes())
        moved.append(target)
    state.write_text(json.dumps({"workspaces": {"workspace": {"projects": {"p1": {"bindings": dict(
        zip(ids, [str(path) for path in moved])
    )}}}}}), encoding="utf-8")
    rebound = build_resolve_plan(project, [task], DeviceMediaStore(state), lambda: False)
    assert {row["path"] for row in rebound["recordings"]} == {str(moved[2].resolve())}
    assert all(Path(row["path"]).parent == relocated for track in rebound["tracks"] for row in track["clips"])
    for unsafe in ({"source_kind": "corrected"}, {"timing_basis": "corrected"}, {"source_rate_ratio": [100001, 100000]}, {"source_kind": None}):
        record = report["recording_alignment"]["placements"][0]
        original = dict(record)
        record.update(unsafe)
        report_path.write_text(json.dumps(report), encoding="utf-8")
        with pytest.raises(ValueError, match="来源/时间映射待确认"):
            build_resolve_plan(project, [task], DeviceMediaStore(state), lambda: False)
        record.clear(); record.update(original)




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
    assert manifest["artifacts"][0]["filename"].endswith(".drp")
    assert manifest["artifacts"][0]["unavailable_reason"] == "not_generated"
    assert all(item["available"] for item in manifest["artifacts"][1:])
    assert "nle_round_trip_not_verified" in manifest["validation"]

    project.config.media_roots = (tmp_path / "additional_source", media_root)
    reordered = build_sync_delivery_artifacts(project, [task])
    assert all(item["available"] for item in reordered["artifacts"][1:])

    project.config.media_roots = ()
    unbound = build_sync_delivery_artifacts(project, [task])
    assert unbound["ready"] is True
    assert all(not item["local_path"] and item["unavailable_reason"] == "media_roots_unbound"
               for item in unbound["artifacts"][1:])


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
    final_cut = next(item for item in available["artifacts"] if item["target"] == "final-cut")
    assert final_cut["unavailable_reason"] == "unexpected_location"

    cancelled = _task("cancelled", created_at="2026-11-17T11:00:00+00:00", task_id="new")
    blocked = build_sync_delivery_artifacts(project, [task, cancelled])
    assert blocked["ready"] is False
    assert not any(item["available"] for item in blocked["artifacts"])



def test_fcpxml_projects_do_not_require_multicam_sync(tmp_path: Path) -> None:
    project = _project(tmp_path, media_directory=False)

    payload = build_sync_timeline(project, [])

    assert payload["ready"] is True
    assert payload["phase"] == "not-required"


def test_sync_inspection_uses_the_generated_master_rational_timebase(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project)
    (project.config.output_dir / 'sync' / 'synchronized.fcpxml').write_text(
        '<fcpxml><resources><format id="f1" frameDuration="1001/30000s"/></resources>'
        '<library><event><project><sequence format="f1"/></project></event></library></fcpxml>', encoding='utf-8',
    )
    payload = build_sync_timeline(project, [_task("completed", created_at="2026-11-18T00:00:00+00:00", task_id="done")])
    assert payload['ready'] is True
    assert payload['timebase']['status'] == 'confirmed'
    assert payload['timebase']['numerator'] == 30000
    assert payload['timebase']['denominator'] == 1001
    assert str(tmp_path) not in json.dumps(payload['timebase'])


def test_sync_inspection_does_not_invent_a_frame_rate_when_master_is_unproven(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _write_sync_artifacts(project)
    payload = build_sync_timeline(project, [_task("completed", created_at="2026-11-18T00:00:00+00:00", task_id="done")])
    assert payload['ready'] is True
    assert payload['timebase']['status'] == 'unknown'
    assert 'numerator' not in payload['timebase']
