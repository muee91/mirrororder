import { useEffect, useMemo, useState } from "react";
import mirrororderLogo from "../../assets/mirrororder-logo.svg";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import type { ProductionPage } from "../../app/resumeState";
import type { ProjectActivitySummary } from "./projectActivity";
import { projectPresentation } from "./projectPresentation";
import "./project-context-menu.css";
import "./projects.css";
import "./project-library-fidelity.css";

interface Props {
  baseUrl?: string;
  workspace: WorkspacePayload;
  activities?: Record<string, ProjectActivitySummary>;
  selectedProjectId: string | null;
  primaryActive?: "home" | "projects" | "status" | "settings" | "team" | null;
  activeProjectPage?: ProductionPage | null;
  revealLabel?: string;
  onSelectProject: (project: ProjectSummary) => void;
  onOpenHome?: () => void;
  onOpenProjects?: () => void;
  onOpenStatusCenter?: () => void;
  onOpenSettings?: () => void;
  onOpenProjectPage?: (project: ProjectSummary, page: ProductionPage) => void;
  onOpenTeamProject?: (project: ProjectSummary) => void;
  onCopyShareLink?: (project: ProjectSummary) => void | Promise<void>;
  onRevealProject?: (project: ProjectSummary) => void | Promise<void>;
  onPrepareProject?: (project: ProjectSummary) => void | Promise<void>;
  onOpenMediaBinding?: (project: ProjectSummary) => void;
  onDeleteProject?: (project: ProjectSummary) => void | Promise<void>;
  onWorkspaceChanged?: (preferredProjectId?: string) => Promise<void>;
}

interface ProjectMenuState {
  project: ProjectSummary;
  x: number;
  y: number;
}

type IconName = "home" | "projects" | "slate" | "media" | "people" | "review" | "overview" | "status" | "settings";

function NavIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    home: "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
    projects: "M3 6.5h7l2 2H21v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
    slate: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
    media: "M4 5h16v14H4zM8 15l3-3 2 2 3-4 2 5M8 9h.01",
    people: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6-1a2.5 2.5 0 1 0 0-5M3.5 20c.5-4 2.5-6 5.5-6s5 2 5.5 6M15 14c3 0 5 2 5.5 5",
    review: "M4 5h16v12H9l-5 4Zm4 4h8M8 13h5",
    overview: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    status: "M12 3a9 9 0 1 0 9 9M12 7v5l3 2",
    settings: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5 1.2 2.3 2.6.4.5 2.6 2 1.7-1.2 2.3 1.2 2.3-2 1.7-.5 2.6-2.6.4L12 20.5l-1.2-2.3-2.6-.4-.5-2.6-2-1.7 1.2-2.3-1.2-2.3 2-1.7.5-2.6 2.6-.4Z",
  };
  return <svg className="project-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function projectPageActive(activePage: ProductionPage | null | undefined, pages: ProductionPage[]): boolean {
  return Boolean(activePage && pages.includes(activePage));
}

export function ProjectLibrary({
  workspace,
  activities = {},
  selectedProjectId,
  primaryActive = null,
  activeProjectPage = null,
  revealLabel = "Finder / Explorer",
  onSelectProject,
  onOpenHome,
  onOpenProjects,
  onOpenStatusCenter,
  onOpenSettings,
  onOpenProjectPage,
  onOpenTeamProject,
  onCopyShareLink,
  onRevealProject,
  onPrepareProject,
  onOpenMediaBinding,
  onDeleteProject,
}: Props) {
  const [menu, setMenu] = useState<ProjectMenuState | null>(null);
  const selectedProject = useMemo(
    () => workspace.projects.find((project) => project.project_id === selectedProjectId) ?? null,
    [selectedProjectId, workspace.projects],
  );
  const switchProjects = useMemo(
    () => workspace.projects.filter((project) => project.project_id !== selectedProjectId).slice(0, 3),
    [selectedProjectId, workspace.projects],
  );
  const selectedPresentation = selectedProject ? projectPresentation(selectedProject, activities[selectedProject.project_id]) : null;
  const runningCount = Object.values(activities).filter((activity) => activity.state === "active").length;

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    globalThis.addEventListener("pointerdown", close);
    globalThis.addEventListener("blur", close);
    globalThis.addEventListener("keydown", keydown);
    return () => {
      globalThis.removeEventListener("pointerdown", close);
      globalThis.removeEventListener("blur", close);
      globalThis.removeEventListener("keydown", keydown);
    };
  }, [menu]);

  function openMenu(project: ProjectSummary, x: number, y: number): void {
    const width = 204;
    const height = 310;
    const viewportWidth = globalThis.innerWidth || 1280;
    const viewportHeight = globalThis.innerHeight || 800;
    setMenu({
      project,
      x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
      y: Math.max(8, Math.min(y, viewportHeight - height - 8)),
    });
  }

  function run(action: () => void | Promise<void>): void {
    setMenu(null);
    void Promise.resolve(action()).catch(() => undefined);
  }

  function openPage(page: ProductionPage): void {
    if (selectedProject && onOpenProjectPage) onOpenProjectPage(selectedProject, page);
  }

  return (
    <div className="project-library project-library-redesign">
      <button type="button" className="project-library-brand project-library-brand-button" onClick={onOpenHome} aria-label="返回首页">
        <img className="mirror-mark" src={mirrororderLogo} alt="" aria-hidden="true" />
        <span className="project-library-brand-copy"><strong>镜序</strong><span>MirrorOrder</span></span>
      </button>

      <nav className="project-primary-nav" aria-label="主导航">
        <button type="button" className={primaryActive === "home" ? "is-active" : ""} onClick={onOpenHome}><NavIcon name="home" /><span>首页</span></button>
        <button type="button" className={primaryActive === "projects" ? "is-active" : ""} onClick={onOpenProjects}><NavIcon name="projects" /><span>项目</span><small>{workspace.projects.length}</small></button>
      </nav>

      {selectedProject ? (
        <section className="project-current-context">
          <p className="project-nav-section-label">当前项目</p>
          <button
            type="button"
            className="project-current-card"
            onClick={() => onSelectProject(selectedProject)}
            onContextMenu={(event) => { event.preventDefault(); openMenu(selectedProject, event.clientX, event.clientY); }}
            onKeyDown={(event) => {
              if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                openMenu(selectedProject, box.right - 204, box.bottom + 4);
              }
            }}
          >
            <span className={`project-current-status status-${selectedPresentation?.statusTone ?? "idle"}`} aria-hidden="true" />
            <span><strong>{selectedProject.name || selectedProject.project_id}</strong><small>{selectedPresentation?.sidebarSubtitle ?? "项目"}</small></span>
          </button>

          <nav className="project-production-nav" aria-label="当前项目制作导航">
            <button type="button" className={primaryActive === null && projectPageActive(activeProjectPage, ["slate", "takes", "script"]) ? "is-active" : ""} onClick={() => openPage("slate")}><NavIcon name="slate" /><span>场记</span></button>
            <button type="button" className={primaryActive === null && projectPageActive(activeProjectPage, ["media-library", "media-binding"]) ? "is-active" : ""} onClick={() => openPage("media-library")}><NavIcon name="media" /><span>素材</span></button>
            <button type="button" className={primaryActive === null && activeProjectPage === "identity" ? "is-active" : ""} onClick={() => openPage("identity")}><NavIcon name="people" /><span>人物</span></button>
            <button type="button" className={primaryActive === null && projectPageActive(activeProjectPage, ["watch", "attention"]) ? "is-active" : ""} onClick={() => openPage("watch")}><NavIcon name="review" /><span>审阅</span></button>
            <button type="button" className={primaryActive === null && activeProjectPage === "overview" ? "is-active" : ""} onClick={() => openPage("overview")}><NavIcon name="overview" /><span>概览</span></button>
          </nav>
        </section>
      ) : (
        <section className="project-current-context is-empty">
          <p className="project-nav-section-label">制作</p>
          <div className="project-current-empty"><strong>尚未选择项目</strong><span>从“项目”进入制作工作区。</span></div>
        </section>
      )}

      <div className="project-sidebar-spacer" />

      {switchProjects.length ? (
        <section className="project-recent-switcher">
          <div className="project-nav-section-label"><span>切换项目</span><small>最近使用</small></div>
          <div className="project-recent-list">
            {switchProjects.map((project) => {
              const activity = activities[project.project_id];
              const presentation = projectPresentation(project, activity);
              const taskActive = activity?.state === "active";
              return (
                <button
                  type="button"
                  key={project.project_id}
                  onClick={() => onSelectProject(project)}
                  onContextMenu={(event) => { event.preventDefault(); openMenu(project, event.clientX, event.clientY); }}
                  onKeyDown={(event) => {
                    if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
                      event.preventDefault();
                      const box = event.currentTarget.getBoundingClientRect();
                      openMenu(project, box.right - 204, box.bottom + 4);
                    }
                  }}
                >
                  <span><strong>{project.name || project.project_id}</strong><small>{presentation.sidebarSubtitle}</small></span>
                  {taskActive ? <span className="project-activity-spinner" /> : null}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <nav className="project-system-nav" aria-label="系统导航">
        <button type="button" className={primaryActive === "status" ? "is-active" : ""} onClick={onOpenStatusCenter}><NavIcon name="status" /><span>状态中心</span>{runningCount ? <small className="project-system-badge">{runningCount}</small> : null}</button>
        <button type="button" className={primaryActive === "settings" ? "is-active" : ""} onClick={onOpenSettings}><NavIcon name="settings" /><span>设置</span></button>
      </nav>

      {menu ? (
        <div className="project-context-menu" role="menu" aria-label={`${menu.project.name || menu.project.project_id} 项目操作`} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="project-context-heading"><strong>{menu.project.name || menu.project.project_id}</strong><small>{menu.project.project_id}</small></div>
          <button type="button" role="menuitem" onClick={() => run(() => onSelectProject(menu.project))}>打开项目</button>
          <button type="button" role="menuitem" disabled={!onOpenTeamProject} onClick={() => run(() => onOpenTeamProject?.(menu.project))}>团队审阅</button>
          <button type="button" role="menuitem" disabled={!onCopyShareLink} onClick={() => run(() => onCopyShareLink?.(menu.project))}>复制局域网协作链接</button>
          <button type="button" role="menuitem" disabled={!onRevealProject} onClick={() => run(() => onRevealProject?.(menu.project))}>{revealLabel}</button>
          <button type="button" role="menuitem" disabled={!onOpenMediaBinding} onClick={() => run(() => onOpenMediaBinding?.(menu.project))}>本机素材 / 换素材盘</button>
          <button type="button" role="menuitem" disabled={!onPrepareProject} onClick={() => run(() => onPrepareProject?.(menu.project))}>重新整理项目</button>
          <button type="button" role="menuitem" className="project-context-danger" disabled={!onDeleteProject} onClick={() => run(() => onDeleteProject?.(menu.project))}>永久删除项目…</button>
        </div>
      ) : null}
    </div>
  );
}
