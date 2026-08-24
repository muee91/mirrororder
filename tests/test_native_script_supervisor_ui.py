from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_project_opens_on_full_native_multicam_slate_table() -> None:
    ui = source("macos-app/MirrorOrderDesktopUI.swift")

    assert "private struct ProjectHomeView" in ui
    assert "@Published var showProjectHome = true" in ui
    assert "private struct NativeMulticamSlateProjectWorkbench" in ui
    assert "NativeMulticamSlateProjectWorkbench(" in ui
    assert "private func slateTableRows(_ rows: [MCDraft]) -> some View" in ui
    assert "Table(rows, selection: $selectedRecordID)" in ui
    for column in (
        "序号",
        "集",
        "场号",
        "镜号",
        "次号",
        "A 机",
        "B 机",
        "C 机",
        "辅助 / 特殊",
        "状态",
    ):
        assert f'TableColumn("{column}")' in ui
    assert 'TableColumn("可用范围 / 备注")' not in ui
    assert 'TableColumn("素材")' not in ui


def test_native_media_cards_have_fixed_visual_contract_and_clear_selected_state() -> None:
    ui = source("macos-app/MirrorOrderDesktopUI.swift")

    assert "private struct MCMediaCard" in ui
    assert "private enum MCMediaCardSize" in ui
    assert "AVAssetImageGenerator" in ui
    assert "MCMediaThumbnailView" in ui
    assert "lineWidth: selected ? 2 : 1" in ui
    assert "checkmark.circle.fill" in ui
    assert "video.slash" in ui
    assert "repeatedCount" in ui
    assert '"景别—"' in ui
    assert '"时长—"' in ui
    assert 'preferred ? "首选" : "非首选"' in ui
    for label in ("未标记", "全景", "全身", "中景", "中近景", "近景", "特写", "大特写", "细节"):
        assert f'label: "{label}"' in ui


def test_sparse_native_slate_actions_and_episode_only_take_are_first_class() -> None:
    ui = source("macos-app/MirrorOrderDesktopUI.swift")

    assert "!episodeText.isEmpty" in ui
    assert r'Text("EP \(draft.episodeText.isEmpty ? "—" : draft.episodeText) / 场' in ui
    assert 'Label("同场下一条"' in ui
    assert 'Label("同上"' in ui
    assert 'Label("空白"' in ui
    assert "@FocusState private var focusedField: MCFocusField?" in ui
    assert "DispatchQueue.main.async { selectedRecordID = draft.id; focusedField = focus }" in ui
    assert "private func createEmptyRow() { let draft = MCDraft(); appendDraft(draft, focus: .episode(draft.id)) }" in ui
    assert "appendDraft(draft, focus: .take(draft.id))" in ui
    assert "appendDraft(draft, focus: .take(draft.id)); showTakePicker = true" in ui
    assert "target.sourceGroupID.isEmpty, target.attachments.isEmpty" in ui
    assert "draft.attachments = attachments" in ui
    assert 'Label("加入 Take / 镜头", systemImage: "film.stack")' in ui
    assert ".menuIndicator(.hidden)" in ui
    assert 'Image(systemName: "trash")' in ui
    assert "private func deleteDraft(_ id: String) async" in ui
    assert 'Button("删除场记"' not in ui
    assert "take.effective_mapping?.episode_ids.first ?? link?.episode" in ui
    assert 'scene: "", attachments: attachments' in ui


def test_slate_write_is_revision_safe_and_never_uses_device_path_as_project_data() -> None:
    ui = source("macos-app/MirrorOrderDesktopUI.swift")
    runtime = source("src/script_organizer/script_supervisor_runtime.py")
    store = source("src/script_organizer/script_supervisor_store.py")

    assert '"expected_revision": board.revision' in ui
    assert '"actor": actor' in ui
    assert "场记已在其它窗口更新" in ui
    assert '"source_media_path"' not in ui
    assert '"resolved_media_path"' not in ui
    assert "Path(_text(raw.get(\"display_name\")" in store
    assert "record_may_exist_without_take" in runtime
    assert "editorial_authority" in runtime
    assert "ScriptSupervisorConflictError" in store


def test_slate_refresh_preserves_dirty_rows_and_unsaved_delete_stays_local() -> None:
    ui = source("macos-app/MirrorOrderDesktopUI.swift")

    assert "rebuildDrafts(preserveDirty: preserveDirty)" in ui
    assert "dirtyIDs.contains($0.id) ? (local[$0.id] ?? $0) : $0" in ui
    assert "merged.append(contentsOf: drafts.filter" in ui
    assert "if store.board?.records[id] != nil" in ui
    assert "await store.delete(recordID: id" in ui
    assert "drafts.removeAll { $0.id == id }" in ui


def test_slate_quick_entry_inherits_previous_row_without_inventing_seconds() -> None:
    ui = source("macos-app/MirrorOrderDesktopUI.swift")
    parser = source("src/script_organizer/script_supervisor_parser.py")

    assert "drafts[index - 1].parseContext()" in ui
    assert "parsed.range_hint" in ui
    assert "前半段可用" in ui and "后半段可用" in ui
    assert "absolute - playback.sourceStart" in ui
    deterministic = parser.split("def deterministic_parse", 1)[1].split("def _sanitize_model", 1)[0]
    assert 'result["range_hint"] = "first_half"' in deterministic
    assert 'result["range_hint"] = "second_half"' in deterministic
    assert "usable_range" not in deterministic
    assert "不得猜时间码" in parser


def test_slate_take_and_finder_attachment_keep_media_identity() -> None:
    ui = source("macos-app/MirrorOrderDesktopUI.swift")
    identity = source("src/script_organizer/media_identity.py")

    assert "playback?.mediaID ?? \"\"" in ui
    assert "UTType.fileURL.identifier" in ui
    assert "mcQuickMediaID(url)" in ui
    assert 'projectEndpoint(controller, "media-inventory")' in ui
    assert "store.playbackByClip.values.filter { $0.mediaID == mediaID }" in ui
    assert "Insecure.SHA1()" in ui
    assert "_SAMPLE_BYTES = 1024 * 1024" in identity
    assert 'return "M_" + digest.hexdigest()[:24]' in identity


def test_native_playback_uses_take_source_range_for_long_bridge_media() -> None:
    ui = source("macos-app/MirrorOrderDesktopUI.swift")
    review = source("src/script_organizer/review_read_model.py")

    assert "MCPlaybackDescriptor" in ui
    assert "sourceStart: descriptor?.source_start ?? angle.source_start ?? 0" in ui
    assert "sourceEnd: descriptor?.source_end ?? angle.source_end" in ui
    assert "item.forwardPlaybackEndTime" in ui
    assert "player.seek(to:" in ui
    assert '"source_start": _float(member.get("source_start"), 0.0)' in review


def test_preferred_slate_angle_is_not_editorial_best() -> None:
    ui = source("macos-app/MirrorOrderDesktopUI.swift")
    runtime = source("src/script_organizer/script_supervisor_runtime.py")

    assert "不是 Editorial Best" in ui
    assert '"script_supervisor_is_editorial_authority": False' in runtime
