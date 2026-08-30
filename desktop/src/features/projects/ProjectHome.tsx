import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import type { ProjectActivitySummary } from "./projectActivity";
import "./project-context-menu.css";
import "./project-home.css";
import "./project-library-fidelity.css";

interface Props {
  baseUrl: string;
  workspace: WorkspacePayload;
  activities?: Record<string, ProjectActivitySummary>;
  revealLabel?: string;
  onOpenProject: (project: ProjectSummary) => void;
  onOpenTeamProject: (project: ProjectSummary) => void;
  onCopyShareLink: (project: ProjectSummary) => void | Promise<void>;
  onRevealProject: (project: ProjectSummary) => void | Promise<void>;
  onPrepareProject: (project: ProjectSummary) => void | Promise<void>;
  onOpenMediaBinding: (project: ProjectSummary) => void;
  onDeleteProject: (project: ProjectSummary) => void | Promise<void>;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
}

interface HomeMenuState {
  project: ProjectSummary;
  x: number;
  y: number;
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

export function ProjectHome({
  baseUrl,
  workspace,
  activities = {},
  revealLabel = "Finder / Explorer",
  onOpenProject,
  onOpenTeamProject,
  onCopyShareLink,
  onRevealProject,
  onPrepareProject,
  onOpenMediaBinding,
  onDeleteProject,
  onWorkspaceChanged,
}: Props) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<HomeMenuState | null>(null);
  const visible = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return workspace.projects;
    return workspace.projects.filter((project) => `${project.name} ${project.project_id}`.toLowerCase().includes(value));
  }, [query, workspace.projects]);

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
    const height = 326;
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
            const activity = activities[project.project_id];
            const taskFailed = activity?.state === "failed";
            const taskActive = activity?.state === "active";
            return (
              <button
                type="button"
                className={`project-home-card ${project.error || taskFailed ? "has-error" : ""} ${taskActive ? "is-active" : ""}`}
                key={project.project_id}
                aria-haspopup="menu"
                title="打开项目；右键查看项目操作"
                onClick={() => onOpenProject(project)}
                onContextMenu={(event) => { event.preventDefault(); openMenu(project, event.clientX, event.clientY); }}
                onKeyDown={(event) => {
                  if (event.key === "F10" && event.shiftKey) {
                    event.preventDefault();
                    const box = event.currentTarget.getBoundingClientRect();
                    openMenu(project, box.left + 28, box.top + 28);
                  }
                }}
              >
                <div className="project-home-visual" aria-hidden="true">
                  <span className="project-home-kind">{project.input_kind === "fcpxml" ? "FCPXML" : "原始素材"}</span>
                  <strong>{backdropSymbol(project)}</strong>
                </div>
                <div className="project-home-copy">
                  <div className="project-home-title-row">
                    <strong>{project.name || project.project_id}</strong>
                    {taskActive ? <span className="project-activity-spinner" title={activity.label || "后台处理中"} /> : null}
                    {project.error || taskFailed ? <span className="project-home-error" title={activity?.message || project.error || "整理异常"}>!</span> : null}
                  </div>
                  <div className="project-home-stats">
                    <span>{takes} Take</span>
                    <span>{clips} 素材</span>
                    {taskFailed ? <em className="is-error">整理异常</em> : needsAttention > 0 ? <em>{needsAttention} 待处理</em> : null}
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

      {menu ? (
        <div className="project-context-menu" role="menu" aria-label={`${menu.project.name || menu.project.project_id} 项目操作`} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="project-context-heading"><strong>{menu.project.name || menu.project.project_id}</strong><small>{menu.project.project_id}</small></div>
          <button type="button" role="menuitem" onClick={() => run(() => onOpenProject(menu.project))}>打开项目</button>
          <button type="button" role="menuitem" onClick={() => run(() => onOpenTeamProject(menu.project))}>团队审阅</button>
          <button type="button" role="menuitem" onClick={() => run(() => onCopyShareLink(menu.project))}>复制局域网协作链接</button>
          <button type="button" role="menuitem" onClick={() => run(() => onRevealProject(menu.project))}>在 {revealLabel} 中显示</button>
          <button type="button" role="menuitem" onClick={() => run(() => onOpenMediaBinding(menu.project))}>本机素材 / 换素材盘</button>
          <button type="button" role="menuitem" onClick={() => run(() => onPrepareProject(menu.project))}>重整项目</button>
          <button type="button" role="menuitem" className="project-context-danger" onClick={() => run(() => onDeleteProject(menu.project))}>永久删除项目…</button>
        </div>
      ) : null}
    </section>
  );
}
