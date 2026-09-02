from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "web" / "index.html"
RUNTIME = ROOT / "web" / "review_components_v2.js"
COMPONENTS = ROOT / "web" / "review-components-v2.css"
DESIGN_SYSTEM = ROOT / "web" / "design-system-v2.css"
INTELLIGENCE = ROOT / "web" / "intelligence.css"
REVIEW = ROOT / "web" / "review.css"


def test_review_component_layer_loads_after_design_and_editorial_runtime() -> None:
    html = HTML.read_text(encoding="utf-8")
    assert '<link rel="stylesheet" href="/review-components-v2.css">' in html
    assert html.index('/review-components-v2.css') > html.index('/design-system-v2.css')
    assert '<script src="/review_components_v2.js"></script>' in html
    assert html.index('/review_components_v2.js') > html.index('/editorial_ui.js')
    assert html.index('/review_components_v2.js') < html.index('/intelligence_ui.js')
    assert html.index('/review_components_v2.js') < html.index('/startup_release.js')


def test_review_runtime_canonicalizes_a_b_c_aux_before_custom_cameras() -> None:
    runtime = RUNTIME.read_text(encoding="utf-8")
    assert "function cameraPresentation(value)" in runtime
    assert "rank: 0, tone: 'a', token: 'A', label: 'A'" in runtime
    assert "rank: 1, tone: 'b', token: 'B', label: 'B'" in runtime
    assert "rank: 2, tone: 'c', token: 'C', label: 'C'" in runtime
    assert "rank: 3, tone: 'aux', token: 'AUX', label: 'AUX'" in runtime
    assert "rank: 50" in runtime
    assert "sortedMembers = function professionalSortedMembers" in runtime
    assert "renderMemberStrip = function professionalRenderMemberStrip" in runtime
    assert 'data-camera-tone="${presentation.tone}"' in runtime


def test_review_member_tile_reserves_evidence_and_media_health_without_geometry_shift() -> None:
    runtime = RUNTIME.read_text(encoding="utf-8")
    css = COMPONENTS.read_text(encoding="utf-8")
    assert "review-member-tile" in runtime
    assert "media-health-indicator" in runtime
    assert "const healthLabel = available ? '可播放' : '离线'" in runtime
    assert "height: 84px" in css
    assert "grid-template-rows: minmax(30px, 1fr) 18px 16px" in css
    assert ".media-health-indicator.is-ready" in css
    assert ".media-health-indicator.is-offline" in css
    assert ".review-member-tile.active { border-width: 1px; }" in css


def test_review_media_health_has_one_authority_and_stable_mobile_camera_slots() -> None:
    css = COMPONENTS.read_text(encoding="utf-8")
    design = DESIGN_SYSTEM.read_text(encoding="utf-8")
    legacy = REVIEW.read_text(encoding="utf-8")
    assert '.member-card:disabled::before{content:"缺失"' in legacy
    assert ".review-member-tile:disabled::before" in css
    assert 'content: "";' in css
    assert "background: var(--member-camera)" in css
    assert ".review-member-tile:disabled::after" not in css
    assert "grid-template-columns: repeat(4, 164px)" in design
    assert "overflow-x: auto" in design
    assert "@media (max-width: 680px)" in design
    assert "grid-template-columns: repeat(4, 148px)" in design
    assert "text-overflow: ellipsis" in design
    assert '.member-strip > .review-camera-run[data-camera-tone="aux"] { grid-column: 4; grid-row: 1; }' in css
    assert '.member-strip > .review-camera-run[data-camera-tone="custom"] { grid-row: 2; }' in css


def test_review_opinion_editorial_decision_and_placement_have_distinct_semantics() -> None:
    runtime = RUNTIME.read_text(encoding="utf-8")
    css = COMPONENTS.read_text(encoding="utf-8")
    assert "review-opinion-indicator" in runtime
    assert "review-opinion-control" in runtime
    assert "review-opinion-summary" in runtime
    assert "editorial-decision-indicator" in runtime
    assert "placement-indicator" in runtime
    assert ".review-opinion-summary" in css
    assert ".editorial-decision-indicator" in css
    assert ".placement-indicator" in css
    assert "border-left: 3px solid var(--ink)" in css


def test_native_editorial_decision_uses_shared_best_keep_reject_semantics() -> None:
    css = COMPONENTS.read_text(encoding="utf-8")
    assert '.native-editorial-actions button[data-final-state="best"].selected' in css
    assert 'border-color: var(--blue)' in css
    assert 'background: var(--blue-soft)' in css
    assert '.native-editorial-actions button[data-final-state="keep"].selected' in css
    assert 'border-color: var(--green)' in css
    assert 'background: var(--green-soft)' in css
    assert '.native-editorial-actions button[data-final-state="reject"].selected' in css
    assert 'border-color: var(--red)' in css
    assert 'background: var(--red-soft)' in css


def test_review_component_layer_uses_camera_authority_and_10px_evidence_floor() -> None:
    css = COMPONENTS.read_text(encoding="utf-8")
    design = DESIGN_SYSTEM.read_text(encoding="utf-8")
    intelligence = INTELLIGENCE.read_text(encoding="utf-8")
    for token in ("--mo-camera-a", "--mo-camera-b", "--mo-camera-c", "--mo-camera-aux"):
        assert token in design
        assert f"var({token})" in css
    assert not re.search(r"font-size:\s*(?:7|8|9)px", css)
    assert not re.search(r"font-size:\s*(?:7|8|9)px", intelligence)
    assert "var(--muted" in intelligence
    assert 'data-camera-tone="aux"' in css
    assert 'grid-column: 4; grid-row: 1' in css
