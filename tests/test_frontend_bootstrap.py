from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_workbench_boot_waits_until_static_extensions_are_installed() -> None:
    html = read("web/index.html")

    gate = html.index('<script src="/startup_gate.js"></script>')
    app = html.index('<script src="/app.js"></script>')
    production = html.index('<script src="/production_mode.js"></script>')
    device_media = html.index('<script src="/device_media.js"></script>')
    timeline = html.index('<script src="/timeline.js"></script>')
    assistant = html.index('<script src="/assistant_control_ui.js"></script>')
    semantic = html.index('<script src="/semantic_search_ui.js"></script>')
    release = html.index('<script src="/startup_release.js"></script>')

    assert gate < app < production < device_media < timeline < assistant < semantic < release
    assert html.count('<script src="/device_media.js"></script>') == 1
    assert html.count('<script src="/timeline.js"></script>') == 1


def test_startup_gate_holds_only_fetch_and_fails_open() -> None:
    gate = read("web/startup_gate.js")
    release = read("web/startup_release.js")

    assert "const nativeFetch = window.fetch.bind(window)" in gate
    assert "window.fetch = (...args) => pending.then" in gate
    assert "window.fetch = nativeFetch" in gate
    assert "window.addEventListener('load'" in gate
    assert "工作台未完成加载" in gate
    assert "工作台启动超过 12 秒仍未完成" in gate
    assert "const gate = window.__mirrorOrderStartupGate" in release
    assert "timelineReady" in release
    assert "gate.release()" in release


def test_device_media_can_be_loaded_statically_without_double_wrapping() -> None:
    source = read("web/device_media.js")
    ux = read("web/ux_fixes.js")

    assert "window.__mirrorOrderDeviceMediaInstalled" in source
    assert "if (window.__mirrorOrderDeviceMediaInstalled) return;" in source
    assert "baseRenderContent" in source
    assert "baseReloadAnalysis" in source
    assert "deviceMediaScript" not in ux
    assert "document.createElement('script')" not in ux


def test_timeline_loader_is_native_gated_and_boot_awaitable() -> None:
    source = read("web/timeline.js")

    assert "window.webkit?.messageHandlers?.mirrorOrder" in source
    assert "window.__mirrorOrderTimelineReady = Promise.resolve()" in source
    assert "window.__mirrorOrderTimelineReady = new Promise" in source
    assert "/timeline_v3.js" in source
    assert "/automation.js" not in source
    assert "/device_media.js" not in source


def test_startup_layer_has_no_production_authority_write_path() -> None:
    source = read("web/startup_gate.js") + read("web/startup_release.js")

    for forbidden in (
        "review.json",
        "editorial.json",
        "auto_decisions.json",
        "method: 'POST'",
        'method: "POST"',
    ):
        assert forbidden not in source
