from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_review_design_system_v2_is_loaded_last():
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    assert '<link rel="stylesheet" href="/design-system-v2.css">' in html
    assert html.index('/design-system-v2.css') > html.index('/placement_drag.css')


def test_review_no_longer_requires_a_1500px_canvas():
    css = (ROOT / "web" / "design-system-v2.css").read_text(encoding="utf-8")
    assert "body {\n  min-width: 0;" in css
    assert "@media (max-width: 1260px)" in css
    assert "@media (max-width: 900px)" in css
    assert "@media (max-width: 680px)" in css
    assert 'grid-template-areas: "script takes inspector"' in css


def test_review_has_keyboard_focus_contract():
    css = (ROOT / "web" / "design-system-v2.css").read_text(encoding="utf-8")
    assert ":focus-visible" in css
    assert "outline: 2px solid" in css
