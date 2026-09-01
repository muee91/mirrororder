from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_desktop_slate_uses_existing_python_supervisor_contract() -> None:
    ui = source("desktop/src/features/slate/GoldenSlateWorkbench.tsx")
    production = source("desktop/src/api/production.ts")
    records = source("desktop/src/api/slateRecords.ts")

    assert "production.scriptSupervisor(projectId)" in ui
    assert "production.parseSlate(projectId" in ui
    assert "records.upsert(projectId" in ui
    assert 'contract: "script_supervisor.v2"' in production
    assert "script-supervisor-parse" in production
    assert "script-supervisor" in production
    assert 'action: "upsert_record"' in records


def test_slate_quick_entry_is_sparse_revision_safe_and_continuous() -> None:
    ui = source("desktop/src/features/slate/GoldenSlateWorkbench.tsx")

    assert "function recordPayload(draft: Draft): Partial<SlateRecord>" in ui
    assert "expectedRevision: revision" in ui
    assert "actor," in ui
    assert "未覆盖其他人的修改" in ui
    assert "请刷新后重试" in ui
    assert '(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s"' in ui
    assert '(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n"' in ui
    assert "同场下一条" in ui
    assert "同上" in ui


def test_camera_specific_shot_facts_stay_clip_level() -> None:
    ui = source("desktop/src/features/slate/GoldenSlateWorkbench.tsx")

    assert 'camera: "A" | "B" | "C" | "AUX"' in ui
    assert 'if (camera === "AUX")' in ui
    assert 'source_role === "sync_camera"' in ui
    assert "const shot = parsed.angle_shots[cameraKey(attachment.camera)]" in ui
    assert "shot_type: shot" in ui


def test_range_hint_stays_verbatim_and_never_invents_seconds() -> None:
    ui = source("desktop/src/features/slate/GoldenSlateWorkbench.tsx")
    parser = source("src/script_organizer/script_supervisor_parser.py")

    assert "parsed.range_hint" in ui
    assert "范围原话" in ui
    deterministic = parser.split("def deterministic_parse", 1)[1].split("def _sanitize_model", 1)[0]
    assert 'result["range_hint"] = "first_half"' in deterministic
    assert 'result["range_hint"] = "second_half"' in deterministic
    assert "usable_range" not in deterministic


def test_slate_authority_stays_human_and_requires_explicit_save() -> None:
    ui = source("desktop/src/features/slate/GoldenSlateWorkbench.tsx")
    runtime = source("src/script_organizer/script_supervisor_runtime.py")
    store = source("src/script_organizer/script_supervisor_store.py")

    assert "patchRecord(selected.record_id" in ui
    assert "已填入解析结果" in ui
    assert "仍需保存" in ui
    assert "records.upsert(projectId" in ui
    assert '"script_supervisor_is_editorial_authority": False' in runtime
    assert "ScriptSupervisorConflictError" in store


def test_deleted_swiftui_slate_is_not_a_runtime_dependency() -> None:
    assert not (ROOT / "macos-app").exists()
    assert (ROOT / "desktop" / "src" / "features" / "slate" / "SlateWorkbench.tsx").is_file()
