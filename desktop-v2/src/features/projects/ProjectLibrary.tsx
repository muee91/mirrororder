import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";

interface Props {
  baseUrl: string;
  workspace: WorkspacePayload;
  selectedProjectId: string | null;
  onSelectProject: (project: ProjectSummary) => void;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
}

function projectSubtitle(project: ProjectSummary): string {
  if (project.error) return project.error;
  const clips = project.stats?.clips;
  const suffix = typeof clips === "number" ? ` · ${clips} clips` : "";
  return `${project.input_kind || "project"}${suffix}`;
}

export function ProjectLibrary({ baseUrl, workspace, selectedProjectId, onSelectProject, onWorkspaceChanged }: Props) {
  const selectedProject = workspace.projects.find((project) => project.project_id === selectedProjectId) ?? null;

  return (
    <aside className="project-library">
      <div className="section-heading">
        <div>
          <p className="eyebrow">工作区</p>
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
              className={`project-row ${selectedProjectId === project.project_id ? "is-selected" : ""}`}
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
    </aside>
  );
}
