import { useEffect, useState } from "react";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { DesktopAppearanceControl } from "../settings/DesktopAppearanceControl";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import "./project-context-menu.css";
import "./projects.css";
import "./project-library-fidelity.css";

interface Props {
  baseUrl: string;
  workspace: WorkspacePayload;
  selectedProjectId: string | null;
  utilityActive?: "status" | "team" | "settings" | null;
  revealLabel?: string;
  onSelectProject: (project: ProjectSummary) => void;
  onOpenHome?: () => void;
  onOpenStatusCenter?: () => void;
  onOpenTeam?: () => void;
  onOpenSettings?: () => void;
  onOpenTeamProject?: (project: ProjectSummary) => void;
  onRevealProject?: (project: ProjectSummary) => void | Promise<void>;
  onPrepareProject?: (project: ProjectSummary) => void | Promise<void>;
  onOpenMediaBinding?: (project: ProjectSummary) => void;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
}

interface ProjectMenuState {
  project: ProjectSummary;
  x: number;
  y: number;
}

function stat(project: ProjectSummary, key: string): number {
  const value = project.stats?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function projectAttention(project: ProjectSummary): number {
  return stat(project, "missing_media") + stat(project, "unknown_groups") + stat(project, "script_gap_blocks");
}

function projectSubtitle(project: ProjectSummary): string {
  if (project.error) return "整理异常";
  const takes = stat(project, "groups") || stat(project, "takes");
  const attention = projectAttention(project);
  if (takes > 0) return `${takes} Take${attention > 0 ? ` · ${attention} 待处理` : ""}`;
  return attention > 0 ? `${attention} 待处理` : "待整理";
}

function projectIcon(project: ProjectSummary): string {
  return project.input_kind === "fcpxml" ? "▥" : "▰";
}

export function ProjectLibrary({
  baseUrl,
  workspace,
  selectedProjectId,
  utilityActive = null,
  revealLabel = "Finder / Explorer",
  onSelectProject,
  onOpenHome,
  onOpenStatusCenter,
  onOpenSettings,
  onOpenTeamProject,
  onRevealProject,
  onPrepareProject,
  onOpenMediaBinding,
  onWorkspaceChanged,
}: Props) {
  const selectedProject = workspace.projects.find((project) => project.project_id === selectedProjectId) ?? null;
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
    const height = 220;
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
    void action();
  }

  return (
    <div className="project-library">
      <button type="button" className="project-library-brand project-library-brand-button" onClick={onOpenHome} aria-label="返回项目主页">
        <span className="mirror-mark" aria-hidden="true">镜</span>
        <span className="project-library-brand-copy"><strong>镜序</strong><span>MirrorOrder</span></span>
      </button>

      <button type="button" className={`project-library-home ${homeActive ? "is-active" : ""}`} onClick={onOpenHome}>
        <span>项目</span><small>全部项目</small>
      </button>

      <div className="project-library-section-heading">
        <div><span>最近项目</span><small>{workspace.projects.length}</small></div>
        <ProjectLifecyclePanel baseUrl={baseUrl} selectedProject={selectedProject} onWorkspaceChanged={onWorkspaceChanged} />
      </div>

      <div className="project-list">
        {workspace.projects.length === 0 ? (
          <div className="project-list-empty"><strong>还没有项目</strong><span>使用上方“新建”创建第一个制作项目。</span></div>
        ) : (
          workspace.projects.slice(0, 8).map((project) => (
            <button
              className={`project-row ${utilityActive === null && selectedProjectId === project.project_id ? "is-selected" : ""}`}
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
              <span className="project-row-icon" aria-hidden="true">{projectIcon(project)}</span>
              <span className="project-row-copy"><strong>{project.name || project.project_id}</strong><small>{projectSubtitle(project)}</small></span>
              {project.error ? <span className="project-row-alert" title={project.error}>!</span> : null}
            </button>
          ))
        )}
      </div>

      <DesktopAppearanceControl />

      <nav className="project-library-global-tools" aria-label="全局工具">
        <button type="button" className={utilityActive === "status" ? "is-active" : ""} onClick={onOpenStatusCenter}><span>状态中心</span><small>后台任务与失败恢复</small></button>
        <button type="button" className={utilityActive === "settings" ? "is-active" : ""} onClick={onOpenSettings}><span>设置</span><small>本地模型与制作环境</small></button>
      </nav>

      {menu ? (
        <div className="project-context-menu" role="menu" aria-label={`${menu.project.name || menu.project.project_id} 项目操作`} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="project-context-heading"><strong>{menu.project.name || menu.project.project_id}</strong><small>{menu.project.project_id}</small></div>
          <button type="button" role="menuitem" onClick={() => run(() => onSelectProject(menu.project))}>打开项目</button>
          <button type="button" role="menuitem" disabled={!onOpenTeamProject} onClick={() => run(() => onOpenTeamProject?.(menu.project))}>团队审阅</button>
          <button type="button" role="menuitem" disabled={!onRevealProject} onClick={() => run(() => onRevealProject?.(menu.project))}>{revealLabel}</button>
          <button type="button" role="menuitem" disabled={!onOpenMediaBinding} onClick={() => run(() => onOpenMediaBinding?.(menu.project))}>本机素材 / 换素材盘</button>
          <button type="button" role="menuitem" disabled={!onPrepareProject} onClick={() => run(() => onPrepareProject?.(menu.project))}>重整项目</button>
        </div>
      ) : null}
    </div>
  );
}
