from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_project_opens_on_full_native_slate_table() -> None:
    native = source("macos-app/NativeProjectWorkbench.swift")
    assert 'case supervisor = "场记"' in native
    assert '@State private var surface: NativeProjectSurface = .supervisor' in native
    assert "NativeScriptSupervisorWorkspace(" in native
    assert "NativeScriptSupervisorSheet" not in native
    assert "Table(drafts, selection: $selectedRecordID)" in native
    for column in ("素材", "集", "场", "镜", "次", "状态", "可用范围", "备注"):
        assert f'TableColumn("{column}")' in native


def test_slate_write_is_revision_safe_and_never_uses_device_path_as_project_data() -> None:
    native = source("macos-app/NativeProjectWorkbench.swift")
    runtime = source("src/script_organizer/script_supervisor_runtime.py")
    store = source("src/script_organizer/script_supervisor_store.py")

    assert '"expected_revision": board.revision' in native
    assert '"actor": operatorName' in native
    assert "场记已在其它窗口更新" in native
    assert '"source_media_path"' not in native
    assert '"resolved_media_path"' not in native
    assert "Path(str(raw.get(\"display_name\"" in runtime
    assert "record_may_exist_without_take" in runtime
    assert "editorial_authority" in runtime
    assert "ScriptSupervisorConflictError" in store


def test_slate_refresh_preserves_dirty_rows_and_unsaved_delete_stays_local() -> None:
    native = source("macos-app/NativeProjectWorkbench.swift")
    assert "rebuildDraftsFromBoard(preservingDirty: preserveDirty)" in native
    assert "dirtyIDs.contains(row.id) ? (localByID[row.id] ?? row) : row" in native
    assert "merged.append(contentsOf: drafts.filter" in native
    assert "if store.board?.records[selectedRecordID] == nil" in native
    assert "await store.delete" in native


def test_slate_quick_entry_inherits_previous_row_without_inventing_seconds() -> None:
    native = source("macos-app/NativeProjectWorkbench.swift")
    parser = source("src/script_organizer/script_supervisor_parser.py")
    assert "previousContext = drafts[draftIndex - 1].parseContext()" in native
    assert "parsed.range_hint" in native
    assert "前半段可用" in native and "后半段可用" in native
    assert "absoluteSeconds - playback.sourceStart" in native
    deterministic = parser.split("def deterministic_parse", 1)[1].split("def _sanitize_model", 1)[0]
    assert 'result["range_hint"] = "first_half"' in deterministic
    assert 'result["range_hint"] = "second_half"' in deterministic
    assert "usable_range" not in deterministic
    assert "不得猜时间码" in parser


def test_slate_take_and_finder_attachment_keep_media_identity() -> None:
    native = source("macos-app/NativeProjectWorkbench.swift")
    identity = source("src/script_organizer/media_identity.py")
    assert "playback?.mediaID ?? \"\"" in native
    assert "UTType.fileURL.identifier" in native
    assert "quickMediaID(for: url)" in native
    assert 'projectEndpoint(controller, "media-inventory")' in native
    assert "playbackByClip.values.filter { $0.mediaID == mediaID }" in native
    assert "Insecure.SHA1()" in native
    assert "_SAMPLE_BYTES = 1024 * 1024" in identity
    assert 'return "M_" + digest.hexdigest()[:24]' in identity


def test_native_playback_uses_take_source_range_for_long_bridge_media() -> None:
    native = source("macos-app/NativeProjectWorkbench.swift")
    review = source("src/script_organizer/review_read_model.py")
    assert "NativePlaybackDescriptor" in native
    assert "sourceStart: descriptor?.source_start ?? angle.source_start ?? 0" in native
    assert "sourceEnd: descriptor?.source_end ?? angle.source_end" in native
    assert "item.forwardPlaybackEndTime" in native
    assert "player.seek(to: start" in native
    assert '"source_start": _float(member.get("source_start"), 0.0)' in review


def test_preferred_slate_angle_is_not_editorial_best() -> None:
    native = source("macos-app/NativeProjectWorkbench.swift")
    runtime = source("src/script_organizer/script_supervisor_runtime.py")
    assert "不是 Editorial Best" in native
    assert '"script_supervisor_is_editorial_authority": False' in runtime
