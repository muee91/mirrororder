from __future__ import annotations

import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

from script_organizer.nle_delivery.delivery_markers import (
    ENRICHED_DELIVERY_CONTRACT,
    build_enriched_sync_fcpxml_bundle,
)
from script_organizer.sync_timeline_runtime import (
    apply_sync_manual_offset,
    build_sync_timeline,
    rebase_sync_manual_offsets,
    undo_sync_manual_offset,
)


def _seed_sync_project(root: Path) -> tuple[SimpleNamespace, list[dict]]:
    output_dir = root / "output"
    sync_dir = output_dir / "sync"
    work_dir = output_dir / ".multicam-sync" / "work"
    sync_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    task_id = "sync_task_001"
    (sync_dir / "synchronized.fcpxml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<fcpxml version="1.10"><resources><format id="r1" frameDuration="1/25s"/></resources>'
        '<library><event name="E"><project name="P"><sequence format="r1" duration="250/25s"><spine/></sequence></project></event></library></fcpxml>',
        encoding="utf-8",
    )
    (sync_dir / "sync_report.json").write_text(
        json.dumps(
            {
                "status": "completed",
                "sync_task_id": task_id,
                "days": ["D1"],
                "camera_detection": {"contract_version": "camera_detection.v2"},
                "recording_inventory": {"candidates": [{"media_id": "M_0123456789abcdef01234567", "status": "unverified_candidate"}]},
                "recording_alignment": {
                    "sync_task_id": task_id,
                    "status": "confirmed",
                    "placements": [
                        {"media_id": "M_0123456789abcdef01234567", "name": "SD_042.WAV", "at": 25, "source": 0, "frames": 100}
                    ],
                },
            }
        ),
        encoding="utf-8",
    )
    (work_dir / "positions_D1_compressed.tsv").write_text(
        "id\tcam\tpos\tdur\tfile\ttc\tclipn\n"
        "c_a1\tA\t0.0\t4.0\tA001.MOV\t01:00:00:00\t1\n"
        "c_a2\tA\t5.0\t4.0\tA002.MOV\t01:00:05:00\t2\n"
        "c_b1\tB\t0.0\t4.0\tB001.MOV\t01:00:00:00\t1\n"
        "c_b2\tB\t5.0\t4.0\tB002.MOV\t01:00:05:00\t2\n",
        encoding="utf-8",
    )
    (output_dir / "material_index.json").write_text(
        json.dumps(
            {
                "clips": [
                    {"clip_id": "clip_a1", "media_id": "M_aaaaaaaaaaaaaaaaaaaaaaaa", "source_asset_id": "day_D1_asset_0", "transcript_text": "别碰那份遗嘱"},
                    {"clip_id": "clip_a2", "media_id": "M_bbbbbbbbbbbbbbbbbbbbbbbb", "source_asset_id": "day_D1_asset_1", "transcript_text": "律师还没到场"},
                    {"clip_id": "clip_b1", "media_id": "M_cccccccccccccccccccccccc", "source_asset_id": "day_D1_asset_2"},
                    {"clip_id": "clip_b2", "media_id": "M_dddddddddddddddddddddddd", "source_asset_id": "day_D1_asset_3"},
                ]
            }
        ),
        encoding="utf-8",
    )
    (output_dir / "script_supervisor_v2.json").write_text(
        json.dumps(
            {
                "revision": 2,
                "records": {
                    "slate-1": {
                        "record_id": "slate-1",
                        "episode": 1,
                        "scene": "4",
                        "shot": "2",
                        "take_number": 3,
                        "status": "usable",
                        "note": "保条 ★ 情绪爆发",
                        "attachments": [{"clip_id": "clip_a1", "camera": "A"}],
                    },
                    "slate-2": {
                        "record_id": "slate-2",
                        "episode": 1,
                        "scene": "5",
                        "shot": "1",
                        "take_number": 1,
                        "status": "ng",
                        "note": "笑场",
                        "attachments": [{"clip_id": "clip_a2", "camera": "A"}],
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    project = SimpleNamespace(
        project_id="drama_test",
        config=SimpleNamespace(output_dir=output_dir, is_media_directory=True),
    )
    tasks = [{"task_id": task_id, "type": "multicam_sync", "status": "completed", "completed_at": "2026-11-21T03:00:00Z"}]
    return project, tasks


class SyncOffsetsAndEnrichedDeliveryTests(unittest.TestCase):
    def test_versioned_following_offset_propagation_and_undo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, tasks = _seed_sync_project(Path(tmp))
            base = build_sync_timeline(project, tasks)
            self.assertTrue(base["ready"])
            self.assertEqual(base["offset_revision"], 0)

            # Shift B-cam from c_b1 onward by +5 frames (+0.2s at 25fps)
            shifted = apply_sync_manual_offset(
                project,
                tasks,
                {
                    "target_kind": "clip",
                    "scope": "following",
                    "track_id": "video:B",
                    "clip_id": "c_b1",
                    "delta_frames": 5,
                    "expected_revision": 0,
                    "actor": "editor-test",
                },
            )
            self.assertEqual(shifted["offset_revision"], 1)
            b_track = next(t for t in shifted["tracks"] if t["camera"] == "B")
            self.assertAlmostEqual(b_track["clips"][0]["timeline_start"], 0.2, places=4)
            self.assertAlmostEqual(b_track["clips"][1]["timeline_start"], 5.2, places=4)
            self.assertEqual(b_track["clips"][0]["manual_offset_frames"], 5)

            # Stale expected_revision must be rejected
            with self.assertRaises(ValueError):
                apply_sync_manual_offset(
                    project,
                    tasks,
                    {
                        "target_kind": "clip",
                        "scope": "single",
                        "track_id": "video:B",
                        "clip_id": "c_b1",
                        "delta_frames": 1,
                        "expected_revision": 0,
                    },
                )

            # Undo restores exact original positions and revision 0
            reverted = undo_sync_manual_offset(project, tasks, {"expected_revision": 1})
            self.assertEqual(reverted["offset_revision"], 0)
            b_reverted = next(t for t in reverted["tracks"] if t["camera"] == "B")
            self.assertAlmostEqual(b_reverted["clips"][0]["timeline_start"], 0.0, places=4)
            self.assertAlmostEqual(b_reverted["clips"][1]["timeline_start"], 5.0, places=4)

    def test_enriched_delivery_generates_markers_scene_subsequences_and_srt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, tasks = _seed_sync_project(Path(tmp))
            apply_sync_manual_offset(
                project,
                tasks,
                {
                    "target_kind": "clip",
                    "scope": "single",
                    "track_id": "video:A",
                    "clip_id": "c_a1",
                    "delta_frames": 2,
                    "expected_revision": 0,
                },
            )
            manifest = build_enriched_sync_fcpxml_bundle(
                project,
                tasks,
                {"include_markers": True, "split_by_scene": True, "export_srt": True},
            )
            self.assertEqual(manifest["contract"], ENRICHED_DELIVERY_CONTRACT)
            self.assertEqual(manifest["offset_revision"], 1)
            self.assertGreaterEqual(manifest["marker_count"], 2)
            self.assertEqual(manifest["srt_cue_count"], 2)

            master_path = Path(manifest["master_fcpxml"])
            self.assertTrue(master_path.is_file())
            xml_root = ET.fromstring(master_path.read_text(encoding="utf-8"))
            markers = xml_root.findall(".//marker")
            self.assertGreaterEqual(len(markers), 2)
            marker_values = " ".join(m.attrib.get("value", "") for m in markers)
            self.assertIn("[保条 ★]", marker_values)
            self.assertIn("[微调 +2f]", marker_values)
            self.assertIn("[NG]", marker_values)

            # Per-scene split created separate valid FCPXML files for EP1_4 and EP1_5
            scene_names = {item["scene"] for item in manifest["scene_sequences"]}
            self.assertIn("EP1_4", scene_names)
            self.assertIn("EP1_5", scene_names)
            for item in manifest["scene_sequences"]:
                sub_path = Path(item["local_path"])
                self.assertTrue(sub_path.is_file())
                ET.fromstring(sub_path.read_text(encoding="utf-8"))

            # Dialogue SRT exists and includes real transcript text
            srt_text = Path(manifest["dialogue_srt"]).read_text(encoding="utf-8")
            self.assertIn("别碰那份遗嘱", srt_text)
            self.assertIn("律师还没到场", srt_text)

    def test_manual_offsets_can_rebase_to_a_new_sync_task_when_clip_ids_survive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, tasks = _seed_sync_project(Path(tmp))
            apply_sync_manual_offset(
                project,
                tasks,
                {
                    "target_kind": "clip",
                    "scope": "single",
                    "track_id": "video:A",
                    "clip_id": "c_a1",
                    "delta_frames": 2,
                    "expected_revision": 0,
                },
            )
            next_tasks = [{**tasks[0], "task_id": "sync_task_002"}]
            report_path = project.config.output_dir / "sync" / "sync_report.json"
            report = json.loads(report_path.read_text(encoding="utf-8"))
            report["sync_task_id"] = "sync_task_002"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            stale = build_sync_timeline(project, next_tasks)
            self.assertEqual(stale["offset_revision"], 0)
            self.assertEqual(stale["stale_offset_revision"], 1)

            rebased = rebase_sync_manual_offsets(project, next_tasks, {"expected_stale_revision": 1})
            self.assertEqual(rebased["offset_revision"], 1)
            self.assertEqual(rebased["stale_offset_revision"], 0)
            a_track = next(track for track in rebased["tracks"] if track["camera"] == "A")
            self.assertAlmostEqual(a_track["clips"][0]["timeline_start"], 0.08, places=4)


if __name__ == "__main__":
    unittest.main()
