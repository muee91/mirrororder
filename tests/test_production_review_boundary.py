from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_app_production_is_native_and_does_not_embed_team_web_or_timeline() -> None:
    app = (ROOT / "desktop/src/app/App.tsx").read_text(encoding="utf-8")
    workbench = (ROOT / "desktop/src/features/production/ProjectWorkbench.tsx").read_text(encoding="utf-8")

    assert 'type AppSurface = "home" | "projects" | "production" | "status" | "team" | "settings"' in app
    assert "TeamWebWorkbench" in app
    assert "ProjectWorkbench" in app
    assert "TeamWebWorkbench" not in workbench
    assert "GoldenSlateWorkbench" in workbench
    assert "TimelineWorkbench" not in workbench
    assert "RoughCutWorkbench" not in workbench
    assert "AssemblyWorkbench" not in workbench


def test_native_navigation_starts_at_workspace_home_then_opens_multicam_slate() -> None:
    app = (ROOT / "desktop/src/app/App.tsx").read_text(encoding="utf-8")
    workbench = (ROOT / "desktop/src/features/production/ProjectWorkbench.tsx").read_text(encoding="utf-8")
    library = (ROOT / "desktop/src/features/projects/ProjectLibrary.tsx").read_text(encoding="utf-8")

    assert 'useState<AppSurface>("home")' in app
    assert "WorkspaceHome" in app
    assert 'useState<ProductionPage>("slate")' in workbench
    for label in ("素材库", "本机素材", "人物", "审阅", "待处理", "概览"):
        assert f'label: "{label}"' in workbench
    assert "openTeamProject(project: ProjectSummary)" in app
    assert 'setSurface("team")' in app
    assert 'aria-label="当前项目制作导航"' in library
    assert '>小镜</button>' in workbench


def test_native_slate_remains_human_evidence_not_editorial_authority() -> None:
    runtime = (ROOT / "src" / "script_organizer" / "script_supervisor_runtime.py").read_text(encoding="utf-8")
    parser = (ROOT / "src" / "script_organizer" / "script_supervisor_parser.py").read_text(encoding="utf-8")

    assert '"editorial_authority": False' in runtime
    assert "禁止编造秒数、人物身份、Best/Keep/Reject" in parser
    assert "range_hint" in parser
    assert "usable_range" not in parser.split("def deterministic_parse", 1)[1].split("def _sanitize_model", 1)[0]


def test_team_web_keeps_review_surface_without_production_dom() -> None:
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    ux = (ROOT / "web" / "ux_fixes.js").read_text(encoding="utf-8")

    assert 'id="workspace-select"' in html
    assert 'id="project-select"' in html
    assert 'id="actor-button"' in html
    assert 'id="workspace" class="workspace"' in html
    assert 'id="production-bar"' not in html
    assert 'id="production-panel"' not in html
    assert 'id="create-project" type="button" hidden' in html
    assert 'id="task-button" type="button" hidden' in html
    assert "document.createElement('script')" not in ux


def test_native_workspace_reads_host_projection_and_opens_team_review_externally() -> None:
    app = (ROOT / "desktop/src/app/App.tsx").read_text(encoding="utf-8")
    team = (ROOT / "desktop/src/features/team/TeamWebWorkbench.tsx").read_text(encoding="utf-8")
    client = (ROOT / "desktop/src/api/team.ts").read_text(encoding="utf-8")

    assert "TeamWebWorkbench" in app
    assert "teamWorkbenchUrl" in client
    assert "const shareUrl = healthy" in team
    assert "platform.openUrl(shareUrl)" in team
    assert 'const root = status.local_only ? status.base_url : status.lan_url' in client
    assert "if (!root) return null" in client


def test_boundary_document_defines_native_production_and_web_review() -> None:
    doc = (ROOT / "docs" / "production-review-boundary.md").read_text(encoding="utf-8")

    assert "App — Native Production" in doc
    assert "Web — Team Review" in doc
    assert "App 主制作画布不得嵌入 WebView" in doc
    assert "review.v1" in doc
    assert "不得自动 Reject" in doc
    assert "media-bindings.json" in doc
