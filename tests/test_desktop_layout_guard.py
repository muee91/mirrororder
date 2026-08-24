from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_native_project_home_and_multicam_workspace_fill_available_canvas() -> None:
    source = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    native = (ROOT / "macos-app" / "NativeProjectWorkbench.swift").read_text(encoding="utf-8")

    assert "ProjectHomeView(" in source
    assert "NativeMulticamSlateProjectWorkbench(" in source
    assert "NativeProjectWorkbench: View" in native
    assert "ProjectWorkspace(" in source
    assert ".frame(maxWidth: .infinity, maxHeight: .infinity)" in source
    assert "HStack(spacing: 0)" in source
    assert "HSplitView" in source
    assert source.count(".frame(maxWidth: .infinity, maxHeight: .infinity)") >= 5
    assert ".frame(minWidth: 1220, minHeight: 760)" in source


def test_status_center_copy_remains_valid_after_layout_guard() -> None:
    source = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    assert 'Text("同步、转写、识别和审计任务集中在这里，不占制作画布。")' in source
    assert '制作画布.\\")' not in source
