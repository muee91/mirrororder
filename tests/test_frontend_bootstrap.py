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
    assistant = html.index('<script src="/assistant_control_ui.js"></script>')
    semantic = html.index('<script src="/semantic_search_ui.js"></script>')
    release = html.index('<script src="/startup_release.js"></script>')

    assert gate < app < production < device_media < assistant < semantic < release
    assert html.count('<script src="/device_media.js"></script>') == 1


def test_startup_gate_holds_only_fetch_and_fails_open() -> None:
    gate = read("web/startup_gate.js")
    release = read("web/startup_release.js")

    assert "const nativeFetch = window.fetch.bind(window)" in gate
    assert "window.fetch = (...args) => pending.then" in gate
    assert "window.fetch = nativeFetch" in gate
    assert "window.addEventListener('load'" in gate
    assert "工作台未完成加载" in gate
    assert "工作台启动超过 12 秒仍未完成" in gate
    assert "__mirrorOrderStartupGate?.release()" in release


def test_device_media_can_be_loaded_statically_without_double_wrapping() -> None:
    source = read("web/device_media.js")

    assert "window.__mirrorOrderDeviceMediaInstalled" in source
    assert "if (window.__mirrorOrderDeviceMediaInstalled) return;" in source
    assert "baseRenderContent" in source
    assert "baseReloadAnalysis" in source


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
