import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { DesktopClient } from "../../api/desktop";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { PlatformClient } from "../../api/platform";
import { ProjectActionClient } from "../../api/projectActions";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import "./project-context-menu.css";
import "./project-home.css";
import "./project-library-fidelity.css";

interface Props {
  baseUrl: string;
  workspace: WorkspacePayload;
  onOpenProject: (project: ProjectSummary) => void;
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

export function ProjectHome({ baseUrl, workspace, onOpenProject, onWorkspaceChanged }: Props) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<HomeMenuState | null>(null);
  const platform = useMemo(() => new PlatformClient(), []);
  const projectActions = useMemo(() => new ProjectActionClient(baseUrl), [baseUrl]);
  const desktop = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
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
    const height = 170;
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

  async function revealProject(project: ProjectSummary): Promise<void> {
    if (!isTauri()) return;
    const location = await projectActions.localLocation(project.project_id);
    if (!location.project_exists) return;
    await platform.reveal(location.project_dir);
  }

  async function prepareProject(project: ProjectSummary): Promise<void> {
    await desktop.prepareProject(project.project_id);
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
            return (
              <button
                type="button"
                className={`project-home-card ${project.error ? "has-error" : ""}`}
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

      {menu ? (
        <div className="project-context-menu" role="menu" aria-label={`${menu.project.name || menu.project.project_id} 项目操作`} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="project-context-heading"><strong>{menu.project.name || menu.project.project_id}</strong><small>{menu.project.project_id}</small></div>
          <button type="button" role="menuitem" onClick={() => run(() => onOpenProject(menu.project))}>打开项目</button>
          <button type="button" role="menuitem" disabled={!isTauri()} onClick={() => run(() => revealProject(menu.project))}>在 Finder / Explorer 中显示</button>
          <button type="button" role="menuitem" onClick={() => run(() => prepareProject(menu.project))}>开始 / 重新整理</button>
        </div>
      ) : null}
    </section>
  );
}
