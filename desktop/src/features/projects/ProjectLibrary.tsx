import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import "./projects.css";

interface Props {
  baseUrl: string;
  workspace: WorkspacePayload;
  selectedProjectId: string | null;
  statusCenterActive?: boolean;
  onSelectProject: (project: ProjectSummary) => void;
  onOpenStatusCenter?: () => void;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
}

function projectSubtitle(project: ProjectSummary): string {
  if (project.error) return project.error;
  const clips = project.stats?.clips;
  const suffix = typeof clips === "number" ? ` · ${clips} clips` : "";
  return `${project.input_kind || "project"}${suffix}`;
}

export function ProjectLibrary({
  baseUrl,
  workspace,
  selectedProjectId,
  statusCenterActive = false,
  onSelectProject,
  onOpenStatusCenter,
  onWorkspaceChanged,
}: Props) {
  const selectedProject = workspace.projects.find((project) => project.project_id === selectedProjectId) ?? null;

  return (
    <aside className="project-library">
      <div className="section-heading">
        <div>
          <p className="eyebrow">项目</p>
          <h2>{workspace.workspace}</h2>
        </div>
        <span className="count-pill">{workspace.projects.length}</span>
      </div>

      <ProjectLifecyclePanel
        baseUrl={baseUrl}
        selectedProject={selectedProject}
        onWorkspaceChanged={onWorkspaceChanged}
      />

      <div className="project-list">
        {workspace.projects.length === 0 ? (
          <p className="empty-copy">这个工作区还没有项目。</p>
        ) : (
          workspace.projects.map((project) => (
            <button
              className={`project-row ${!statusCenterActive && selectedProjectId === project.project_id ? "is-selected" : ""}`}
              key={project.project_id}
              type="button"
              onClick={() => onSelectProject(project)}
            >
              <strong>{project.name || project.project_id}</strong>
              <span>{projectSubtitle(project)}</span>
            </button>
          ))
        )}
      </div>

      <div className="project-library-global-tools">
        <button type="button" className={statusCenterActive ? "is-active" : ""} onClick={onOpenStatusCenter}>
          <span>状态中心</span>
          <small>后台工作与失败恢复</small>
        </button>
      </div>
    </aside>
  );
}
