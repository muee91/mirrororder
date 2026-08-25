from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_desktop_slate_uses_existing_python_supervisor_contract() -> None:
    ui = source("desktop/src/features/slate/SlateWorkbench.tsx")
    production = source("desktop/src/api/production.ts")

    assert "production.scriptSupervisor(projectId)" in ui
    assert "production.parseSlate(projectId" in ui
    assert "production.writeSlateEntry(projectId" in ui
    assert 'contract: "script_supervisor.v2"' in production
    assert "script-supervisor-parse" in production
    assert "script-supervisor" in production


def test_slate_quick_entry_is_sparse_revision_safe_and_continuous() -> None:
    ui = source("desktop/src/features/slate/SlateWorkbench.tsx")

    assert "angles: SlateEntry[\"angles\"] = { ...(existing?.angles ?? {}) }" in ui
    assert "expectedRevision: board.revision" in ui
    assert "actor," in ui
    assert "error.status === 409" in ui
    assert "请重新确认" in ui
    assert '(event.metaKey || event.ctrlKey) && event.key === "Enter"' in ui
    assert 'event.altKey && event.key === "ArrowUp"' in ui
    assert 'event.altKey && event.key === "ArrowDown"' in ui
    assert "已进入下一条 Take" in ui


def test_camera_specific_shot_facts_stay_clip_level() -> None:
    ui = source("desktop/src/features/slate/SlateWorkbench.tsx")

    assert "parsed.angle_shots[camera]" in ui
    assert "angles[angle.clip_id]" in ui
    assert "不会自动复制到 A/B/C" in ui
    assert "generic_shot" in ui


def test_range_hint_never_invents_seconds() -> None:
    ui = source("desktop/src/features/slate/SlateWorkbench.tsx")
    parser = source("src/script_organizer/script_supervisor_parser.py")

    assert "parsed.range_hint" in ui
    assert "不生成虚构秒数" in ui
    deterministic = parser.split("def deterministic_parse", 1)[1].split("def _sanitize_model", 1)[0]
    assert 'result["range_hint"] = "first_half"' in deterministic
    assert 'result["range_hint"] = "second_half"' in deterministic
    assert "usable_range" not in deterministic


def test_slate_authority_stays_human_and_not_editorial_best() -> None:
    ui = source("desktop/src/features/slate/SlateWorkbench.tsx")
    runtime = source("src/script_organizer/script_supervisor_runtime.py")
    store = source("src/script_organizer/script_supervisor_store.py")

    assert "确认写入" in ui
    assert '"script_supervisor_is_editorial_authority": False' in runtime
    assert "ScriptSupervisorConflictError" in store


def test_deleted_swiftui_slate_is_not_a_runtime_dependency() -> None:
    assert not (ROOT / "macos-app").exists()
    assert (ROOT / "desktop" / "src" / "features" / "slate" / "SlateWorkbench.tsx").is_file()
