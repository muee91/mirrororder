from pathlib import Path

import pytest

from script_organizer.media_identity import DeviceMediaStore, MediaScanCancelled, media_id_for_path


def _index(media_path: Path) -> dict:
    media_id = media_id_for_path(media_path)
    assert media_id.startswith("M_")
    return {
        "clips": [
            {
                "clip_id": "C1",
                "media_id": media_id,
                "name": media_path.name,
                "source_media_path": str(media_path),
            }
        ]
    }


def test_cancelled_replacement_keeps_last_known_good_binding(tmp_path: Path) -> None:
    old_root = tmp_path / "old"
    new_root = tmp_path / "new"
    old_root.mkdir()
    new_root.mkdir()
    old_media = old_root / "A001.mov"
    new_media = new_root / "A001.mov"
    old_media.write_bytes(b"mirrororder-media" * 2048)
    new_media.write_bytes(old_media.read_bytes())

    store = DeviceMediaStore(tmp_path / "device" / "media-bindings.json")
    index = _index(old_media)
    original = store.scan("WS", "P1", index, [str(old_root)])
    assert original["resolved"] == 1
    before = store.project_snapshot("WS", "P1")
    media_id = index["clips"][0]["media_id"]
    assert before["roots"] == [str(old_root.resolve())]
    assert before["bindings"][media_id] == str(old_media)

    with pytest.raises(MediaScanCancelled):
        store.scan(
            "WS",
            "P1",
            index,
            [str(new_root)],
            replace=True,
            cancelled=lambda: True,
        )

    after = store.project_snapshot("WS", "P1")
    assert after["roots"] == before["roots"]
    assert after["bindings"] == before["bindings"]


def test_successful_replacement_commits_new_root_and_matching_content(tmp_path: Path) -> None:
    old_root = tmp_path / "old"
    new_root = tmp_path / "new"
    old_root.mkdir()
    new_root.mkdir()
    old_media = old_root / "A001.mov"
    new_media = new_root / "A001.mov"
    old_media.write_bytes(b"same-content" * 4096)
    new_media.write_bytes(old_media.read_bytes())

    store = DeviceMediaStore(tmp_path / "device" / "media-bindings.json")
    index = _index(old_media)
    store.scan("WS", "P1", index, [str(old_root)])

    result = store.scan("WS", "P1", index, [str(new_root)], replace=True)
    state = store.project_snapshot("WS", "P1")
    media_id = index["clips"][0]["media_id"]

    assert result["resolved"] == 1
    assert result["missing"] == 0
    assert state["roots"] == [str(new_root.resolve())]
    assert state["bindings"][media_id] == str(new_media)


def test_probe_replacement_does_not_commit_before_enumeration_succeeds(tmp_path: Path) -> None:
    old_root = tmp_path / "old"
    new_root = tmp_path / "new"
    old_root.mkdir()
    new_root.mkdir()
    (old_root / "A.mov").write_bytes(b"old")
    (new_root / "A.mov").write_bytes(b"new")

    store = DeviceMediaStore(tmp_path / "device" / "media-bindings.json")
    store.add_roots("WS", "P1", [str(old_root)])

    with pytest.raises(MediaScanCancelled):
        store.probe_roots(
            "WS",
            "P1",
            [str(new_root)],
            replace=True,
            cancelled=lambda: True,
        )

    assert store.project_snapshot("WS", "P1")["roots"] == [str(old_root.resolve())]


def test_summary_keeps_preanalysis_media_roots_visible_as_pending(tmp_path: Path) -> None:
    root = tmp_path / "media"
    root.mkdir()
    store = DeviceMediaStore(tmp_path / "device" / "media-bindings.json")
    store.add_roots("WS", "P1", [str(root)])

    summary = store.summary("WS", "P1", {})

    assert summary["roots"] == [str(root.resolve())]
    assert summary["total"] == 0
    assert summary["pending_analysis"] is True


def test_media_inventory_runtime_guards_single_flight_and_avoids_eager_replace() -> None:
    source = Path("src/script_organizer/media_inventory_task_runtime.py").read_text(encoding="utf-8")

    assert "当前项目已有本机素材扫描正在进行" in source
    assert 'str(task.get("status", "")) in {"queued", "running"}' in source
    assert "replace=replace" in source
    assert "cancelled=cancelled" in source
    assert "store.replace_roots(workspace_id, project_id, roots)" not in source
    assert "原有本机素材绑定保持不变" in source
