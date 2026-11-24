from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from script_organizer import slate_ocr_runtime
from script_organizer.tasks import TaskManager


def _config(tmp_path: Path, slate: Path | None) -> SimpleNamespace:
    return SimpleNamespace(
        output_dir=tmp_path / "output",
        slate=slate,
        is_media_directory=True,
    )


def test_read_model_reports_attached_slate_without_reading_file(tmp_path: Path) -> None:
    slate = tmp_path / "paper-slate.pdf"
    slate.write_bytes(b"%PDF-1.4 synthetic")
    config = _config(tmp_path, slate)
    with mock.patch.object(slate_ocr_runtime, "extract_paper_slate_photo_candidates") as extract:
        state = slate_ocr_runtime.read_slate_candidates(config, "proj-1")
    extract.assert_not_called()
    assert state["slate_attached"] is True
    assert state["slate_name"] == "paper-slate.pdf"
    assert state["status"] == "none"
    assert state["candidates"] == []


def test_ocr_walks_every_page_and_persists_proposals(tmp_path: Path) -> None:
    slate = tmp_path / "slate.pdf"
    slate.write_bytes(b"%PDF-1.4 synthetic")
    config = _config(tmp_path, slate)

    def fake_extract(payload: dict, config=None) -> dict:
        page = payload["page_label"]
        return {
            "provider": "synthetic",
            "model": "vision",
            "warning": "",
            "candidates": [{
                "page": page, "row": 1, "episode": 1, "scene": "12", "shot": "A",
                "take": f"T{page}", "status": "usable", "note": f"page {page}",
                "confidence": 0.9, "authority": True,
            }],
        }

    with mock.patch.object(slate_ocr_runtime, "pdf_page_count", return_value=8), \
         mock.patch.object(slate_ocr_runtime, "extract_paper_slate_photo_candidates", side_effect=fake_extract):
        summary = slate_ocr_runtime.run_slate_ocr(config, project_id="proj-1", task_id="task_1")

    assert summary["status"] == "completed"
    assert summary["pages_total"] == 8
    assert summary["pages_done"] == 8
    state = slate_ocr_runtime.read_slate_candidates(config, "proj-1")
    assert [row["page"] for row in state["candidates"]] == [str(page) for page in range(1, 9)]
    assert all(row["authority"] is False for row in state["candidates"])
    assert state["revision"] == 1
    assert state["task_id"] == "task_1"


def test_ocr_result_never_leaks_device_path_or_secret(tmp_path: Path) -> None:
    slate = tmp_path / "private-slate.png"
    slate.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    config = _config(tmp_path, slate)

    def fake_extract(payload: dict, config=None) -> dict:
        assert "GEMINI_SECRET" not in json.dumps(payload)
        return {
            "provider": "gemini", "model": "gemini-x", "warning": "",
            "candidates": [{
                "page": "1", "row": 2, "episode": 2, "scene": "8", "shot": "A1",
                "take": "1", "status": "OK", "note": "门口", "confidence": 0.9, "authority": True,
            }],
        }

    with mock.patch.object(slate_ocr_runtime, "extract_paper_slate_photo_candidates", side_effect=fake_extract):
        slate_ocr_runtime.run_slate_ocr(config, project_id="proj-1")
    state = slate_ocr_runtime.read_slate_candidates(config, "proj-1")
    serialized = json.dumps(state, ensure_ascii=False)
    assert str(slate) not in serialized
    assert "GEMINI_SECRET" not in serialized


def test_ocr_stops_on_cancellation_and_keeps_partial_progress(tmp_path: Path) -> None:
    slate = tmp_path / "slate.pdf"
    slate.write_bytes(b"%PDF-1.4 synthetic")
    config = _config(tmp_path, slate)
    calls = []

    def fake_extract(payload: dict, config=None) -> dict:
        calls.append(payload["page_label"])
        return {"provider": "synthetic", "model": "vision", "warning": "", "candidates": []}

    cancelled = mock.Mock(side_effect=lambda: len(calls) >= 1)
    with mock.patch.object(slate_ocr_runtime, "pdf_page_count", return_value=6), \
         mock.patch.object(slate_ocr_runtime, "extract_paper_slate_photo_candidates", side_effect=fake_extract):
        summary = slate_ocr_runtime.run_slate_ocr(config, project_id="proj-1", cancelled=cancelled)

    assert summary["status"] == "cancelled"
    assert summary["pages_done"] == 1
    assert summary["pages_total"] == 6
    assert calls == ["1"]


def test_ocr_without_attached_slate_fails_with_actionable_error(tmp_path: Path) -> None:
    config = _config(tmp_path, None)
    with mock.patch.object(slate_ocr_runtime, "extract_paper_slate_photo_candidates") as extract:
        summary = slate_ocr_runtime.run_slate_ocr(config, project_id="proj-1")
    extract.assert_not_called()
    assert summary["status"] == "failed"
    assert "场记文件" in summary["error"]


def test_multicam_sync_queues_analysis_separately_when_script_attached(tmp_path: Path) -> None:
    script = tmp_path / "script.md"
    script.write_text("场 1-1", encoding="utf-8")

    class Stub:
        submit = mock.Mock()

    config = SimpleNamespace(is_media_directory=True, script=script)
    TaskManager._queue_post_sync_analysis(Stub(), "proj-1", config, {"task_id": "sync-1"})
    assert Stub.submit.call_args.args == ("proj-1", "incremental_analyze", {})
    assert "sync-1" in Stub.submit.call_args.kwargs["idempotency_key"]


def test_multicam_sync_does_not_queue_analysis_without_script(tmp_path: Path) -> None:
    class Stub:
        submit = mock.Mock()

    for config in (
        SimpleNamespace(is_media_directory=True, script=None),
        SimpleNamespace(is_media_directory=False, script=tmp_path / "script.md"),
    ):
        Stub.submit.reset_mock()
        TaskManager._queue_post_sync_analysis(Stub(), "proj-1", config, {"task_id": "sync-1"})
        Stub.submit.assert_not_called()


def test_attached_slate_auto_queues_ocr_without_embedding_device_path(tmp_path: Path) -> None:
    slate = tmp_path / "slate.pdf"
    slate.write_bytes(b"%PDF-1.4 synthetic")

    class Stub:
        submit = mock.Mock()

    TaskManager._queue_slate_ocr(Stub(), "proj-1", SimpleNamespace(slate=slate))
    assert Stub.submit.call_args.args == ("proj-1", "slate_ocr", {})
    assert str(slate) not in json.dumps(Stub.submit.call_args)

    Stub.submit.reset_mock()
    TaskManager._queue_slate_ocr(Stub(), "proj-1", SimpleNamespace(slate=None))
    Stub.submit.assert_not_called()
