import { useEffect, useState } from "react";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
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
  utilityActive?: "status" | "team" | "settings" | null;
  revealLabel?: string;
  onSelectProject: (project: ProjectSummary) => void;
  onOpenHome?: () => void;
  onOpenStatusCenter?: () => void;
  onOpenTeam?: () => void;
  onOpenSettings?: () => void;
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

export function ProjectLibrary({
  workspace,
  activities = {},
  selectedProjectId,
  utilityActive = null,
  revealLabel = "Finder / Explorer",
  onSelectProject,
  onOpenHome,
  onOpenStatusCenter,
  onOpenSettings,
  onOpenTeamProject,
  onCopyShareLink,
  onRevealProject,
  onPrepareProject,
  onOpenMediaBinding,
  onDeleteProject,
}: Props) {
  const homeActive = utilityActive === null && selectedProjectId === null;
  const [menu, setMenu] = useState<ProjectMenuState | null>(null);

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
    const width = 190;
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

  return (
    <div className="project-library">
      <button type="button" className="project-library-brand project-library-brand-button" onClick={onOpenHome} aria-label="返回项目主页">
        <span className="mirror-mark" aria-hidden="true" />
        <span className="project-library-brand-copy"><strong>镜序</strong><span>MirrorOrder</span></span>
      </button>

      <button type="button" className={`project-library-home ${homeActive ? "is-active" : ""}`} onClick={onOpenHome}>
        <span>项目</span><small>{workspace.projects.length}</small>
      </button>

      <div className="project-library-section-heading">
        <div><span>最近项目</span><small>快速切换</small></div>
      </div>

      <div className="project-list">
        {workspace.projects.length === 0 ? (
          <div className="project-list-empty"><strong>还没有项目</strong><span>返回项目主页创建第一个制作项目。</span></div>
        ) : (
          workspace.projects.slice(0, 8).map((project) => {
            const activity = activities[project.project_id];
            const presentation = projectPresentation(project, activity);
            const taskActive = activity?.state === "active";
            return (
              <button
                className={`project-row ${utilityActive === null && selectedProjectId === project.project_id ? "is-selected" : ""} ${taskActive ? "is-active-task" : ""}`}
                key={project.project_id}
                type="button"
                aria-haspopup="menu"
                title="打开项目；右键查看项目操作"
                onClick={() => onSelectProject(project)}
                onContextMenu={(event) => { event.preventDefault(); openMenu(project, event.clientX, event.clientY); }}
                onKeyDown={(event) => {
                  if (event.key === "F10" && event.shiftKey) {
                    event.preventDefault();
                    const box = event.currentTarget.getBoundingClientRect();
                    openMenu(project, box.left + 24, box.top + 24);
                  }
                }}
              >
                <span className="project-row-copy"><strong>{project.name || project.project_id}</strong><small>{presentation.sidebarSubtitle}</small></span>
                {taskActive ? <span className="project-activity-spinner" title={activity.label || "后台处理中"} /> : presentation.statusTone === "error" ? <span className="project-row-alert" title={activity?.message || project.error || "整理异常"}>异常</span> : null}
              </button>
            );
          })
        )}
      </div>

      <nav className="project-library-global-tools" aria-label="全局工具">
        <button type="button" className={utilityActive === "status" ? "is-active" : ""} onClick={onOpenStatusCenter}><span>状态中心</span><small>后台任务与失败恢复</small></button>
        <button type="button" className={utilityActive === "settings" ? "is-active" : ""} onClick={onOpenSettings}><span>设置</span><small>外观、模型与团队审阅</small></button>
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
