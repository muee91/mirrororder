import { useEffect, useState } from "react";
import mirrororderLogo from "../../assets/mirrororder-logo.svg";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import type { ProductionPage } from "../../app/resumeState";
import { StudioIcon } from "../../components/StudioIcons";
import { ProjectModuleNavigation } from "../production/ProjectModuleNavigation";
import type { ProjectActivitySummary } from "./projectActivity";
import { projectPresentation } from "./projectPresentation";
import "./project-context-menu.css";
import "./projects.css";
import "./project-library-fidelity.css";

interface Props {
  baseUrl?: string;
  workspace: WorkspacePayload;
  workspacePath?: string;
  activities?: Record<string, ProjectActivitySummary>;
  selectedProjectId: string | null;
  primaryActive?: "home" | "projects" | "status" | "settings" | "team" | null;
  activeProjectPage?: ProductionPage | null;
  productionActive?: boolean;
  projectOpen?: boolean;
  syncReady?: boolean;
  syncPhase?: string;
  revealLabel?: string;
  onSelectProject: (project: ProjectSummary) => void;
  onOpenProjects?: () => void;
  onOpenStatusCenter?: () => void;
  onOpenSettings?: () => void;
  onSwitchWorkspace?: () => void;
  onOpenProjectPage?: (project: ProjectSummary, page: ProductionPage) => void;
  onOpenTeamProject?: (project: ProjectSummary) => void;
  onCopyShareLink?: (project: ProjectSummary) => void | Promise<void>;
  onRevealProject?: (project: ProjectSummary) => void | Promise<void>;
  onMulticamSyncProject?: (project: ProjectSummary) => void | Promise<void>;
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

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  const width = 204;
  const height = 410;
  const viewportWidth = globalThis.innerWidth || 1280;
  const viewportHeight = globalThis.innerHeight || 800;
  return {
    x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}

export function ProjectLibrary({
  workspace,
  workspacePath = "",
  activities = {},
  selectedProjectId,
  primaryActive = null,
  activeProjectPage = null,
  productionActive = false,
  projectOpen = false,
  syncReady = false,
  syncPhase = "idle",
  revealLabel = "Finder / Explorer",
  onSelectProject,
  onOpenProjects,
  onOpenProjectPage,
  onOpenStatusCenter,
  onOpenSettings,
  onSwitchWorkspace,
  onOpenTeamProject,
  onCopyShareLink,
  onRevealProject,
  onPrepareProject,
  onOpenMediaBinding,
  onDeleteProject,
}: Props) {
  const [menu, setMenu] = useState<ProjectMenuState | null>(null);
  const selectedProject = workspace.projects.find((project) => project.project_id === selectedProjectId) ?? null;
  const switchProjects = workspace.projects.filter((project) => project.project_id !== selectedProjectId).slice(0, 3);
  const projectStatuses = switchProjects.map((project) => {
    const activity = activities[project.project_id];
    return projectPresentation(project, activity);
  });
  const runningCount = Object.values(activities).filter((activity) => activity.state === "active").length;
  const failedCount = workspace.projects.filter((project) => {
    const error = typeof project.error === "string" ? project.error.trim() : project.error;
    const errors = project.errors;
    const hasErrors = Array.isArray(errors)
      ? errors.length > 0
      : Boolean(errors && typeof errors === "object" ? Object.keys(errors).length : errors);
    return Boolean(error || hasErrors);
  }).length;
  const statusCount = runningCount + failedCount;

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
    setMenu({ project, ...clampMenuPosition(x, y) });
  }

  function run(action: () => void | Promise<void>): void {
    setMenu(null);
    void Promise.resolve(action()).catch(() => undefined);
  }

  function openSelectedMenu(event: React.MouseEvent<HTMLButtonElement>): void {
    if (!selectedProject) return;
    event.preventDefault();
    openMenu(selectedProject, event.clientX, event.clientY);
  }

  function openSelectedMenuFromKeyboard(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (!selectedProject || !((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu")) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    openMenu(selectedProject, box.right + 4, box.bottom);
  }

  return (
    <div className="project-library project-library-redesign professional-global-sidebar" data-project-open={projectOpen || undefined}>
      <nav className="project-primary-nav" aria-label="主导航">
        <button
          type="button"
          className={`project-library-brand project-library-brand-button${!projectOpen && primaryActive === "projects" ? " is-active" : ""}`}
          aria-current={!projectOpen && primaryActive === "projects" ? "page" : undefined}
          data-tauri-drag-region="no-drag"
          onClick={onOpenProjects}
          onContextMenu={openSelectedMenu}
          onKeyDown={openSelectedMenuFromKeyboard}
          aria-label="项目"
          title="项目"
        >
          <img className="mirror-mark" src={mirrororderLogo} alt="" aria-hidden="true" />
          <span className="project-library-brand-copy"><strong>项目</strong><span>MirrorOrder</span></span>
        </button>
      </nav>

      <div className="project-rail-divider" aria-hidden="true" />

      {projectOpen && selectedProject ? (
        <nav className="project-module-rail project-production-nav" aria-label="制作区域">
          <ProjectModuleNavigation
            inputKind={selectedProject.input_kind}
            selected={productionActive ? (activeProjectPage ?? (selectedProject.input_kind === "media-directory" ? "sync-task" : "timeline")) : null}
            syncReady={syncReady}
            syncPhase={syncPhase}
            onNavigate={(page) => onOpenProjectPage?.(selectedProject, page)}
          />
        </nav>
      ) : null}

      <div className="project-sidebar-spacer" />

      <nav className="project-system-nav" aria-label="系统导航">
        <button type="button" className={`${primaryActive === "status" ? "is-active " : ""}${statusCount > 0 ? "has-activity" : "is-idle"}`} aria-current={primaryActive === "status" ? "page" : undefined} data-tauri-drag-region="no-drag" onClick={onOpenStatusCenter} title="查看后台同步、转写与导出任务">
          <StudioIcon name="activity" size={16} className="project-nav-icon" />
          <span>状态</span>
          {statusCount > 0 ? <small className={`project-system-badge${failedCount > 0 ? " is-error" : ""}`} aria-label={`${runningCount ? `${runningCount} 个任务运行中` : ""}${failedCount ? `${runningCount ? "，" : ""}${failedCount} 个项目需处理` : ""}`}><span className="project-activity-spinner" aria-hidden="true" />{statusCount}</small> : null}
        </button>
        <button type="button" className={primaryActive === "settings" ? "is-active" : ""} aria-current={primaryActive === "settings" ? "page" : undefined} data-tauri-drag-region="no-drag" onClick={onOpenSettings} title="外观主题、本机模型与协作设置">
          <StudioIcon name="settings" size={16} className="project-nav-icon" />
          <span>设置</span>
        </button>
      </nav>

      {menu ? (
        <div className="project-context-menu" role="menu" aria-label={`${menu.project.name || menu.project.project_id} 项目操作`} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="project-context-heading"><strong>{menu.project.name || menu.project.project_id}</strong><small>{menu.project.project_id}</small><small>连接 → 同步 → 整理</small></div>
          <div className="project-context-group-label">开始制作</div>
          <button type="button" role="menuitem" onClick={() => run(() => onSelectProject(menu.project))}>打开项目</button>
          <button type="button" role="menuitem" title="本机素材 / 换素材盘" disabled={!onOpenMediaBinding} onClick={() => run(() => onOpenMediaBinding?.(menu.project))}>连接素材</button>
          <button type="button" role="menuitem" disabled={!onOpenProjectPage} onClick={() => run(() => onOpenProjectPage?.(menu.project, menu.project.input_kind === "media-directory" ? "sync-task" : "timeline"))}>{menu.project.input_kind === "media-directory" ? "打开同步任务" : "打开选片组接"}</button>
          <button type="button" role="menuitem" title="重新整理项目" disabled={!onPrepareProject} onClick={() => run(() => onPrepareProject?.(menu.project))}>完整整理项目</button>
          <details className="project-context-advanced">
            <summary>高级操作</summary>
            <div className="project-context-advanced-list">
              <button type="button" role="menuitem" disabled={!onOpenTeamProject} onClick={() => run(() => onOpenTeamProject?.(menu.project))}>团队审阅</button>
              <button type="button" role="menuitem" disabled={!onCopyShareLink} onClick={() => run(() => onCopyShareLink?.(menu.project))}>复制局域网协作链接</button>
              <button type="button" role="menuitem" disabled={!onRevealProject} onClick={() => run(() => onRevealProject?.(menu.project))}>{revealLabel}</button>
              <button type="button" role="menuitem" className="project-context-danger" disabled={!onDeleteProject} onClick={() => run(() => onDeleteProject?.(menu.project))}>永久删除项目…</button>
            </div>
          </details>
        </div>
      ) : null}
      <span className="sr-only">{workspacePath || workspace.workspace} 最近使用 {projectStatuses.map((presentation) => presentation.sidebarSubtitle).join("、")}</span>
      {onSwitchWorkspace ? <button type="button" className="sr-only" onClick={onSwitchWorkspace}>切换工作区</button> : null}
    </div>
  );
}
