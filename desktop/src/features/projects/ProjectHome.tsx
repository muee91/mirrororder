import { isTauri } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { HostConnectionError } from "../../api/host";
import { ProjectActionClient } from "../../api/projectActions";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import type { ProjectActivitySummary } from "./projectActivity";
import { projectPresentation } from "./projectPresentation";
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

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function safeFileStem(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "MirrorOrder Project";
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
  const projectActions = useMemo(() => new ProjectActionClient(baseUrl), [baseUrl]);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<HomeMenuState | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
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
    const height = 404;
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

  async function saveProjectAs(project: ProjectSummary): Promise<void> {
    if (!isTauri() || transferBusy) {
      setActionMessage("另存项目只能从桌面 App 执行。");
      return;
    }
    const title = project.name || project.project_id;
    try {
      const destination = await saveDialog({
        title: "另存镜序项目",
        defaultPath: `${safeFileStem(title)} 副本.mirrorproj`,
        filters: [{ name: "镜序项目", extensions: ["mirrorproj"] }],
      });
      if (typeof destination !== "string" || !destination.trim()) return;
      setTransferBusy(true);
      const submission = await projectActions.saveProjectAs(project.project_id, destination, {
        name: `${title} 副本`,
        includeCache: false,
      });
      setActionMessage(`已提交“${title}”另存任务${submission.task.task_id ? ` · ${submission.task.task_id}` : ""}；进度在状态中心查看。`);
    } catch (error) {
      setActionMessage(`另存项目失败：${errorMessage(error)}`);
    } finally {
      setTransferBusy(false);
    }
  }

  async function collectProject(project: ProjectSummary): Promise<void> {
    if (!isTauri() || transferBusy) {
      setActionMessage("收集项目只能从桌面 App 执行。");
      return;
    }
    const title = project.name || project.project_id;
    try {
      const destination = await saveDialog({
        title: "收集镜序项目",
        defaultPath: `${safeFileStem(title)}.mirrorpkg`,
        filters: [{ name: "镜序项目归档", extensions: ["mirrorpkg"] }],
      });
      if (typeof destination !== "string" || !destination.trim()) return;
      const includeMedia = globalThis.confirm(
        "是否同时收集这台电脑已经定位的原始媒体？\n\n确定：项目 + 原始媒体\n取消：只收集项目状态和项目内文件",
      );
      setTransferBusy(true);
      const submission = await projectActions.collectProject(project.project_id, destination, {
        includeCache: false,
        includeMedia,
      });
      setActionMessage(`已提交“${title}”收集任务${includeMedia ? "（含本机已定位媒体）" : ""}${submission.task.task_id ? ` · ${submission.task.task_id}` : ""}；进度在状态中心查看。`);
    } catch (error) {
      setActionMessage(`收集项目失败：${errorMessage(error)}`);
    } finally {
      setTransferBusy(false);
    }
  }

  return (
    <section className="project-home-canvas">
      <header className="project-home-heading">
        <div className="project-home-heading-copy">
          <div><h1>项目</h1><span className="project-home-count">{workspace.projects.length}</span></div>
          <span aria-live="polite">{actionMessage || "管理工作区内的制作项目"}</span>
        </div>
        <div className="project-home-actions">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目…" aria-label="搜索项目" />
          <ProjectLifecyclePanel baseUrl={baseUrl} onWorkspaceChanged={onWorkspaceChanged} onStatusMessage={setActionMessage} />
        </div>
      </header>

      {visible.length ? (
        <div className="project-home-list" aria-label="项目列表">
          {visible.map((project) => {
            const activity = activities[project.project_id];
            const presentation = projectPresentation(project, activity);
            return (
              <article
                className={`project-home-card status-${presentation.statusTone}`}
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
                  <span className="project-home-project-copy">
                    <span className="project-home-title-row"><strong>{project.name || project.project_id}</strong><small>{presentation.kind}</small></span>
                    <span className="project-home-stats"><span>{presentation.takes} Take</span><span>{presentation.clips} 素材</span></span>
                  </span>
                  <span className={`project-home-state status-${presentation.statusTone}`}>
                    {activity?.state === "active" ? <span className="project-activity-spinner" aria-hidden="true" /> : <span className="project-home-state-dot" aria-hidden="true" />}
                    <span>{presentation.statusLabel}</span>
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
                >更多</button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="project-home-empty">
          <strong>{workspace.projects.length ? "没有匹配项目" : "还没有项目"}</strong>
          <span>{workspace.projects.length ? "调整搜索关键词。" : "使用右上角“新建项目”或“打开项目”开始制作。"}</span>
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
          <button type="button" role="menuitem" disabled={transferBusy || !isTauri()} onClick={() => run(() => saveProjectAs(menu.project))}>另存项目…</button>
          <button type="button" role="menuitem" disabled={transferBusy || !isTauri()} onClick={() => run(() => collectProject(menu.project))}>收集项目…</button>
          <button type="button" role="menuitem" className="project-context-danger" onClick={() => run(() => onDeleteProject(menu.project))}>永久删除项目…</button>
        </div>
      ) : null}
    </section>
  );
}
