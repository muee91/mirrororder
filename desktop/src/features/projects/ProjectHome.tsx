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

function projectKind(project: ProjectSummary): string {
  return project.input_kind === "fcpxml" ? "FCPXML" : "素材目录";
}

function projectStatus(project: ProjectSummary, activity?: ProjectActivitySummary): { label: string; tone: string } {
  if (project.error || activity?.state === "failed") return { label: "需要处理", tone: "error" };
  if (activity?.state === "active") return { label: activity.label || "后台整理中", tone: "active" };
  const needsAttention = attention(project);
  if (needsAttention > 0) return { label: `${needsAttention} 待处理`, tone: "attention" };
  return { label: "就绪", tone: "ready" };
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
        <div className="project-home-heading-copy">
          <div><h1>项目</h1><span className="project-home-count">{workspace.projects.length}</span></div>
          <span>管理工作区内的制作项目</span>
        </div>
        <div className="project-home-actions">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目…" aria-label="搜索项目" />
          <ProjectLifecyclePanel baseUrl={baseUrl} onWorkspaceChanged={onWorkspaceChanged} />
        </div>
      </header>

      {visible.length ? (
        <div className="project-home-list" aria-label="项目列表">
          {visible.map((project) => {
            const takes = numberStat(project, "groups", "takes");
            const clips = numberStat(project, "clips", "media");
            const activity = activities[project.project_id];
            const status = projectStatus(project, activity);
            return (
              <article
                className={`project-home-card status-${status.tone}`}
                key={project.project_id}
                onContextMenu={(event) => { event.preventDefault(); openMenu(project, event.clientX, event.clientY); }}
              >
                <button
                  type="button"
                  className="project-home-open"
                  title={`打开 ${project.name || project.project_id}`}
                  onClick={() => onOpenProject(project)}
                  onKeyDown={(event) => {
                    if (event.key === "F10" && event.shiftKey) {
                      event.preventDefault();
                      const box = event.currentTarget.getBoundingClientRect();
                      openMenu(project, box.right - 190, box.top + 34);
                    }
                  }}
                >
                  <span className="project-home-project-icon" aria-hidden="true">{project.input_kind === "fcpxml" ? "▥" : "▰"}</span>
                  <span className="project-home-project-copy">
                    <span className="project-home-title-row"><strong>{project.name || project.project_id}</strong><small>{projectKind(project)}</small></span>
                    <span className="project-home-stats"><span>{takes} Take</span><span>{clips} 素材</span></span>
                  </span>
                  <span className={`project-home-state status-${status.tone}`}>
                    {activity?.state === "active" ? <span className="project-activity-spinner" aria-hidden="true" /> : <span className="project-home-state-dot" aria-hidden="true" />}
                    <span>{status.label}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="project-home-more"
                  aria-haspopup="menu"
                  aria-label={`${project.name || project.project_id} 项目操作`}
                  title="项目操作"
                  onClick={(event) => {
                    event.stopPropagation();
                    const box = event.currentTarget.getBoundingClientRect();
                    openMenu(project, box.right - 190, box.bottom + 4);
                  }}
                >•••</button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="project-home-empty">
          <strong>{workspace.projects.length ? "没有匹配项目" : "还没有项目"}</strong>
          <span>{workspace.projects.length ? "调整搜索关键词。" : "使用右上角“新建项目”开始第一个制作项目。"}</span>
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
          <button type="button" role="menuitem" onClick={() => run(() => onPrepareProject(menu.project))}>重新整理项目</button>
          <button type="button" role="menuitem" className="project-context-danger" onClick={() => run(() => onDeleteProject(menu.project))}>永久删除项目…</button>
        </div>
      ) : null}
    </section>
  );
}
