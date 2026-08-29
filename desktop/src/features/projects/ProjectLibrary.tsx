import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import "./projects.css";

interface Props {
  baseUrl: string;
  workspace: WorkspacePayload;
  selectedProjectId: string | null;
  utilityActive?: "status" | "team" | "settings" | null;
  onSelectProject: (project: ProjectSummary) => void;
  onOpenHome?: () => void;
  onOpenStatusCenter?: () => void;
  onOpenTeam?: () => void;
  onOpenSettings?: () => void;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
}

function projectSubtitle(project: ProjectSummary): string {
  if (project.error) return "需要处理";
  const stats = project.stats ?? {};
  const takeCount = typeof stats.groups === "number" ? stats.groups : typeof stats.takes === "number" ? stats.takes : null;
  const clipCount = typeof stats.clips === "number" ? stats.clips : null;
  if (takeCount !== null) return `${takeCount} Take${clipCount !== null ? ` · ${clipCount} 素材` : ""}`;
  if (clipCount !== null) return `${clipCount} 素材`;
  return "Production 项目";
}

export function ProjectLibrary({
  baseUrl,
  workspace,
  selectedProjectId,
  utilityActive = null,
  onSelectProject,
  onOpenHome,
  onOpenStatusCenter,
  onOpenTeam,
  onOpenSettings,
  onWorkspaceChanged,
}: Props) {
  const selectedProject = workspace.projects.find((project) => project.project_id === selectedProjectId) ?? null;
  const homeActive = utilityActive === null && selectedProjectId === null;

  return (
    <div className="project-library">
      <button type="button" className="project-library-brand project-library-brand-button" onClick={onOpenHome} aria-label="返回项目主页">
        <span className="mirror-mark" aria-hidden="true">镜</span>
        <span className="project-library-brand-copy">
          <strong>镜序</strong>
          <span>MirrorOrder</span>
        </span>
      </button>

      <button type="button" className={`project-library-home ${homeActive ? "is-active" : ""}`} onClick={onOpenHome}>
        <span>项目主页</span>
        <small>全部项目</small>
      </button>

      <div className="project-library-section-heading">
        <div>
          <span>最近项目</span>
          <small>{workspace.projects.length}</small>
        </div>
        <ProjectLifecyclePanel
          baseUrl={baseUrl}
          selectedProject={selectedProject}
          onWorkspaceChanged={onWorkspaceChanged}
        />
      </div>

      <div className="project-list">
        {workspace.projects.length === 0 ? (
          <div className="project-list-empty">
            <strong>还没有项目</strong>
            <span>使用上方“新建”创建第一个制作项目。</span>
          </div>
        ) : (
          workspace.projects.slice(0, 12).map((project) => (
            <button
              className={`project-row ${utilityActive === null && selectedProjectId === project.project_id ? "is-selected" : ""}`}
              key={project.project_id}
              type="button"
              onClick={() => onSelectProject(project)}
            >
              <span className="project-row-leading" aria-hidden="true" />
              <span className="project-row-copy">
                <strong>{project.name || project.project_id}</strong>
                <small>{projectSubtitle(project)}</small>
              </span>
              {project.error ? <span className="project-row-alert" title={project.error}>!</span> : null}
            </button>
          ))
        )}
      </div>

      <nav className="project-library-global-tools" aria-label="全局工具">
        <button type="button" className={utilityActive === "status" ? "is-active" : ""} onClick={onOpenStatusCenter}>
          <span>状态中心</span>
          <small>后台任务与失败恢复</small>
        </button>
        <button type="button" className={utilityActive === "team" ? "is-active" : ""} onClick={onOpenTeam}>
          <span>团队审阅</span>
          <small>共享、配对与意见协作</small>
        </button>
        <button type="button" className={utilityActive === "settings" ? "is-active" : ""} onClick={onOpenSettings}>
          <span>设置</span>
          <small>本地模型与制作环境</small>
        </button>
      </nav>
    </div>
  );
}
