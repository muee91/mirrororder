from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_macos_build_uses_drag_capable_desktop_shell():
    build = read("macos-app/build_app.sh")
    source = read("macos-app/MirrorOrderDesktopApp.swift")

    assert 'SOURCE="$ROOT/macos-app/MirrorOrderDesktopApp.swift"' in build
    assert "WKScriptMessageHandler" in source
    assert 'name: "mirrorOrder"' in source
    assert "NSDraggingSession" in source
    assert "NSDraggingItem" in source
    assert ".fileURL" in source
    assert 'NSFilenamesPboardType' in source


def test_web_loader_uses_review_aware_timeline_v3_only():
    loader = read("web/timeline.js")
    timeline = read("web/timeline_v3.js")

    assert "/timeline_v3.js" in loader
    assert "/device_media.js" in loader
    assert "timeline_v2" not in loader
    assert "media-rep" in timeline
    assert "placementForGroup" in timeline
    assert "manualScriptIds" in timeline
    assert "dragPath" in timeline
    assert "未关联" in timeline


def test_external_drag_is_native_not_html5_datatransfer():
    timeline = read("web/timeline_v3.js")
    source = read("macos-app/MirrorOrderDesktopApp.swift")

    assert "dataTransfer" not in timeline
    assert "beginDraggingSession" in source
    assert "prepareFileDrag" in timeline
    assert "prepareFileDrag" in source


def test_timeline_extension_is_installed_from_review_workbench():
    ux = read("web/ux_fixes.js")
    assert "'/timeline.js'" in ux or '"/timeline.js"' in ux


def test_desktop_can_scan_this_macs_media_without_writing_shared_paths():
    source = read("macos-app/MirrorOrderDesktopApp.swift")
    cli = read("src/script_organizer/cli.py")
    identity = read("src/script_organizer/media_identity.py")
    runtime = read("src/script_organizer/device_media_runtime.py")

    assert "这台 Mac 的素材副本" in source
    assert "media-scan-all" in source
    assert 'subparsers.add_parser("media-scan-all"' in cli
    assert '"Application Support" / "MirrorOrder"' in identity
    assert 'item["source_media_path"]' in runtime
    assert 'item["resolved_media_path"]' in runtime
    assert 'item["media_path"] = resolved or source_path' in runtime


def test_sync_contract_keeps_device_paths_outside_shared_workspace():
    sync = read("SYNC_MODEL.md")
    agents = read("AGENTS.md")

    assert "media-bindings.json" in sync
    assert "不得放进共享 workspace" in sync
    assert "review.json" in sync
    assert "单一写入权威" in sync
    assert "绝对路径不是共享身份" in agents
