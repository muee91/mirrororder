import { useMemo, useState } from "react";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import "./project-home.css";

interface Props {
  baseUrl: string;
  workspace: WorkspacePayload;
  onOpenProject: (project: ProjectSummary) => void;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
}

function numberStat(project: ProjectSummary, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = project.stats?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function subtitle(project: ProjectSummary): string {
  if (project.error) return "需要处理";
  const takes = numberStat(project, "groups", "takes");
  const clips = numberStat(project, "clips", "media");
  if (takes !== null && clips !== null) return `${takes} Take · ${clips} 素材`;
  if (takes !== null) return `${takes} Take`;
  if (clips !== null) return `${clips} 素材`;
  return project.input_kind === "fcpxml" ? "Final Cut Pro 项目" : "Production 项目";
}

function attention(project: ProjectSummary): number {
  return numberStat(project, "attention", "issues", "pending_review") ?? 0;
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
          <p className="eyebrow">Production</p>
          <h1>全部项目</h1>
          <span>{workspace.projects.length} 个制作项目</span>
        </div>
        <div className="project-home-actions">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目" aria-label="搜索项目" />
          <ProjectLifecyclePanel baseUrl={baseUrl} selectedProject={null} onWorkspaceChanged={onWorkspaceChanged} />
        </div>
      </header>

      {visible.length ? (
        <div className="project-home-grid">
          {visible.map((project) => {
            const needsAttention = attention(project);
            return (
              <button type="button" className={`project-home-card ${project.error ? "has-error" : ""}`} key={project.project_id} onClick={() => onOpenProject(project)}>
                <div className="project-home-visual" aria-hidden="true">
                  <span>{project.input_kind === "fcpxml" ? "▤" : "镜"}</span>
                </div>
                <div className="project-home-copy">
                  <strong>{project.name || project.project_id}</strong>
                  <span>{subtitle(project)}</span>
                  <div className="project-home-meta">
                    {needsAttention > 0 ? <em>{needsAttention} 待处理</em> : <small>制作就绪</small>}
                    {project.error ? <em className="is-error">需要处理</em> : null}
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
