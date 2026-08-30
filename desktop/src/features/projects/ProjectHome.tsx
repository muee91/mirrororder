import { useMemo, useState } from "react";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import "./project-home.css";
import "./project-library-fidelity.css";

interface Props {
  baseUrl: string;
  workspace: WorkspacePayload;
  onOpenProject: (project: ProjectSummary) => void;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
}

function numberStat(project: ProjectSummary, ...keys: string[]): number {
  for (const key of keys) {
    const value = project.stats?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function attention(project: ProjectSummary): number {
  const explicit = numberStat(project, "attention", "issues", "pending_review");
  if (explicit > 0) return explicit;
  return numberStat(project, "missing_media") + numberStat(project, "unknown_groups") + numberStat(project, "script_gap_blocks");
}

function backdropSymbol(project: ProjectSummary): string {
  const values = ["▤", "◫", "◉", "▥", "▶"];
  let checksum = 0;
  for (const char of project.project_id) checksum = ((checksum * 31) + char.charCodeAt(0)) & 0x7fffffff;
  return values[checksum % values.length];
}

export function ProjectHome({ baseUrl, workspace, onOpenProject, onWorkspaceChanged }: Props) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return workspace.projects;
    return workspace.projects.filter((project) => `${project.name} ${project.project_id}`.toLowerCase().includes(value));
  }, [query, workspace.projects]);

  return (
    <section className="project-home-canvas">
      <header className="project-home-heading">
        <div>
          <h1>全部项目</h1>
          <span>{workspace.projects.length} 个项目 · Production</span>
        </div>
        <div className="project-home-actions">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目…" aria-label="搜索项目" />
          <ProjectLifecyclePanel baseUrl={baseUrl} selectedProject={null} onWorkspaceChanged={onWorkspaceChanged} />
        </div>
      </header>

      {visible.length ? (
        <div className="project-home-grid">
          {visible.map((project) => {
            const takes = numberStat(project, "groups", "takes");
            const clips = numberStat(project, "clips", "media");
            const needsAttention = attention(project);
            return (
              <button type="button" className={`project-home-card ${project.error ? "has-error" : ""}`} key={project.project_id} onClick={() => onOpenProject(project)}>
                <div className="project-home-visual" aria-hidden="true">
                  <span className="project-home-kind">{project.input_kind === "fcpxml" ? "FCPXML" : "原始素材"}</span>
                  <strong>{backdropSymbol(project)}</strong>
                </div>
                <div className="project-home-copy">
                  <div className="project-home-title-row">
                    <strong>{project.name || project.project_id}</strong>
                    {project.error ? <span className="project-home-error">!</span> : null}
                  </div>
                  <div className="project-home-stats">
                    <span>{takes} Take</span>
                    <span>{clips} 素材</span>
                    {needsAttention > 0 ? <em>{needsAttention} 待处理</em> : null}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="project-home-empty">
          <strong>{workspace.projects.length ? "没有匹配项目" : "还没有项目"}</strong>
          <span>{workspace.projects.length ? "调整搜索关键词。" : "使用右上角“新建”创建第一个制作项目。"}</span>
        </div>
      )}
    </section>
  );
}
