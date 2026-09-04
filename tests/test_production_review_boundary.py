from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_app_production_is_native_and_team_web_remains_a_separate_surface() -> None:
    app = (ROOT / "desktop/src/app/App.tsx").read_text(encoding="utf-8")
    workbench = (ROOT / "desktop/src/features/production/ProjectWorkbench.tsx").read_text(encoding="utf-8")

    assert 'type AppSurface = "home" | "projects" | "production" | "status" | "team" | "settings"' in app
    assert "TeamWebWorkbench" in app
    assert "ProjectWorkbench" in app
    assert "TeamWebWorkbench" not in workbench
    assert "GoldenSlateWorkbench" in workbench
    assert "RoughCutWorkbench" not in workbench
    assert "AssemblyWorkbench" not in workbench
    assert "TimelineWorkbench" in workbench
    assert "DeliveryWorkbench" in workbench
    assert 'page === "rough-cut" || page === "assembly" ? "timeline" : page' in workbench


def test_native_navigation_starts_at_workspace_home_and_uses_production_toolbar_resume() -> None:
    app = (ROOT / "desktop/src/app/App.tsx").read_text(encoding="utf-8")
    workbench = (ROOT / "desktop/src/features/production/ProjectWorkbench.tsx").read_text(encoding="utf-8")
    library = (ROOT / "desktop/src/features/projects/ProjectLibrary.tsx").read_text(encoding="utf-8")

    assert 'useState<AppSurface>("home")' in app
    assert "WorkspaceHome" in app
    assert "safeProductionPage(readProjectPage(project.project_id))" in workbench
    assert 'className="professional-project-toolbar"' in workbench
    assert 'aria-label="制作区域"' in workbench
    for label in ("素材", "剧本", "剪辑", "审阅"):
        assert f'label: "{label}"' in workbench
    for label in ("场记", "素材库", "镜次", "人物", "剧本", "覆盖", "剪辑工作台", "交付", "看片", "待处理", "概览"):
        assert f'label: "{label}"' in workbench
    assert '{ page: "rough-cut",' not in workbench
    assert '{ page: "assembly",' not in workbench
    assert "openTeamProject(project: ProjectSummary)" in app
    assert 'setSurface("team")' in app
    assert 'aria-label="当前项目制作导航"' not in library
    assert "制作区在项目画布顶部切换。" in library
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


def test_current_authority_documents_define_production_and_team_review_boundary() -> None:
    ia = (ROOT / "docs" / "app-information-architecture.md").read_text(encoding="utf-8")
    bridge = (ROOT / "docs" / "architecture" / "desktop-bridge.md").read_text(encoding="utf-8")
    review = (ROOT / "docs" / "review-read-model.md").read_text(encoding="utf-8")

    assert "团队审阅是独立协作 surface" in ia
    assert "Team Web" in ia and "Final Editorial Decision" in ia
    assert "React / TypeScript UI" in bridge
    assert "Team Web 是浏览器 Review / Projection surface" in bridge
    assert "review.v1" in review
    assert "Read Model 不返回原始媒体绝对路径" in review
