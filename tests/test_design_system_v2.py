from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def review_css() -> str:
    return (ROOT / "web" / "design-system-v2.css").read_text(encoding="utf-8")


def test_review_design_system_v2_is_loaded_last():
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    assert '<link rel="stylesheet" href="/design-system-v2.css">' in html
    assert html.index('/design-system-v2.css') > html.index('/placement_drag.css')


def test_review_no_longer_requires_a_1500px_canvas():
    css = review_css()
    assert re.search(r"body\s*\{[^}]*min-width:\s*0", css, re.S)
    assert "@media (max-width: 1260px)" in css
    assert "@media (max-width: 900px)" in css
    assert "@media (max-width: 680px)" in css
    assert 'grid-template-areas: "script takes inspector"' in css


def test_review_has_keyboard_focus_contract():
    css = review_css()
    assert ":focus-visible" in css
    assert "outline: 2px solid" in css


def test_review_reserves_camera_slots_for_a_b_c_aux():
    css = review_css()
    assert "grid-template-columns: repeat(4, 164px)" in css
    assert ".camera-run:has(.camera-A)" in css
    assert ".camera-run:has(.camera-B)" in css
    assert ".camera-run:has(.camera-C)" in css
    assert ".camera-run:has(.camera-AUX)" in css
    assert "grid-column: 1; grid-row: 1" in css
    assert "grid-column: 2; grid-row: 1" in css
    assert "grid-column: 3; grid-row: 1" in css
    assert "grid-column: 4; grid-row: 1" in css


def test_review_decision_and_placement_actions_do_not_shift_when_restore_appears():
    css = review_css()
    assert ".decision-button.best { grid-column: 1; }" in css
    assert ".decision-button.keep { grid-column: 2; }" in css
    assert ".decision-button.reject { grid-column: 3; }" in css
    assert '.decision-button[data-decision="unreviewed"] { grid-column: 4; }' in css
    assert ".placement-button { grid-column: 5;" in css
    assert ".take-details { grid-column: 6;" in css


def test_review_camera_identity_is_separate_from_review_status():
    css = review_css()
    assert "--mo-camera-a:" in css
    assert "--mo-camera-b:" in css
    assert "--mo-camera-c:" in css
    assert "--mo-camera-aux:" in css
    assert ".confidence-rail" in css
    assert ".mapping-marker::before" in css
    assert ".decision-button.best.selected" in css


def test_review_v2_does_not_introduce_sub_10px_production_copy():
    css = review_css()
    assert not re.search(r"font-size:\s*(?:7|8|9)px", css)
