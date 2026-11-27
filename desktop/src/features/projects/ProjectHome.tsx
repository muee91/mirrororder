import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { errorMessage } from "../../api/host";
import { projectTransferAvailable, saveProjectCopy } from "../../app/projectTransferActions";
import { StudioIcon } from "../../components/StudioIcons";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import type { ProjectActivitySummary } from "./projectActivity";
import { projectFlowLabel, projectPresentation } from "./projectPresentation";
import "./project-context-menu.css";
import "./project-home.css";
import "./project-library-fidelity.css";

interface Props {
  baseUrl: string;
  workspace: WorkspacePayload;
  workspacePath?: string;
  recentWorkspaces?: string[];
  activities?: Record<string, ProjectActivitySummary>;
  revealLabel?: string;
  onSwitchWorkspace?: () => void;
  onOpenWorkspacePath?: (path: string) => void;
  onRevealWorkspace?: () => void;
  onOpenProject: (project: ProjectSummary) => void;
  onOpenProjectPage?: (project: ProjectSummary, page: "sync-task" | "timeline") => void;
  onOpenTeamProject: (project: ProjectSummary) => void;
  onCopyShareLink: (project: ProjectSummary) => void | Promise<void>;
  onRevealProject: (project: ProjectSummary) => void | Promise<void>;
  onMulticamSyncProject: (project: ProjectSummary) => void | Promise<void>;
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


export function ProjectHome({
  baseUrl,
  workspace,
  workspacePath = "",
  recentWorkspaces = [],
  activities = {},
  revealLabel = "Finder / Explorer",
  onSwitchWorkspace,
  onOpenWorkspacePath,
  onRevealWorkspace,
  onOpenProject,
  onOpenProjectPage,
  onOpenTeamProject,
  onCopyShareLink,
  onRevealProject,
  // Kept in the contract for callers from the previous project menu. The
  // action now belongs to the Timeline workspace and is opened there.
  onPrepareProject,
  onOpenMediaBinding,
  onDeleteProject,
  onWorkspaceChanged,
}: Props) {
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<HomeMenuState | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const displayWorkspacePath = workspacePath.replace(/[\\/]workspace\.toml$/i, "") || workspacePath;
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
    const height = 500;
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
    if (transferBusy) return;
    setTransferBusy(true);
    try {
      const message = await saveProjectCopy(baseUrl, project);
      if (message) setActionMessage(message);
    } catch (error) {
      setActionMessage(`另存工程包失败：${errorMessage(error)}`);
    } finally {
      setTransferBusy(false);
    }
  }

  const hasProjects = workspace.projects.length > 0;
  const recentLibraries = recentWorkspaces.filter((item) => item !== workspacePath).slice(0, 3);
  const lifecycle = <ProjectLifecyclePanel baseUrl={baseUrl} workspaceId={workspace.workspace_id}
    onOpenExistingFolder={onSwitchWorkspace} onWorkspaceChanged={onWorkspaceChanged} onStatusMessage={setActionMessage} />;

  return (
    <section className="project-home-canvas">
      <header className="project-home-heading">
        <div className="project-home-heading-copy">
          <div className="project-home-title-row">
            <h1>项目库</h1>
            <span className="project-home-count">{workspace.projects.length}</span>
          </div>
          <div className="project-home-meta-row">
            {workspacePath.trim() ? (
              onRevealWorkspace ? (
                <button type="button" className="project-home-path-link" title={`在 ${revealLabel} 中打开：${displayWorkspacePath}`} onClick={onRevealWorkspace}>
                  <code>{displayWorkspacePath}</code>
                </button>
              ) : (
                <code className="project-home-path-text" title={displayWorkspacePath}>{displayWorkspacePath}</code>
              )
            ) : null}
            {actionMessage ? <span className="project-home-status-msg" role="status">{actionMessage}</span> : null}
          </div>
        </div>
        {hasProjects && <div className="project-home-actions">
          <input ref={searchInput} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目…" aria-label="搜索项目" />
          {lifecycle}
        </div>}
      </header>

      {visible.length ? (
        <div className="project-home-list" aria-label="项目列表">
          {visible.map((project) => {
            const activity = activities[project.project_id];
            const presentation = projectPresentation(project, activity);
            const detail = activity?.state === "active" ? activity.message : project.error;
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
                  <span className="project-home-source">{presentation.kind}</span>
                  <span className="project-home-project-copy">
                    <strong>{project.name || project.project_id}</strong>
                    {detail && <small title={detail}>{detail}</small>}
                  </span>
                  <span className="project-home-footer">
                    <span className={`project-home-state status-${presentation.statusTone}`}>
                      {activity?.state === "active" ? <span className="project-activity-spinner" aria-hidden="true" /> : <span className="project-home-state-dot" aria-hidden="true" />}
                      <span>{presentation.statusLabel}</span>
                    </span>
                    <span className="project-home-stats">
                      {presentation.takes > 0 && <span><strong>{presentation.takes}</strong> Take</span>}
                      {presentation.clips > 0 && <span><strong>{presentation.clips}</strong> 素材</span>}
                      {presentation.attention > 0 && presentation.statusTone !== "attention" && <span>{presentation.attention} 需关注</span>}
                    </span>
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
      ) : hasProjects ? (
        <div className="project-home-empty">
          <strong>没有匹配项目</strong>
          <button type="button" className="secondary" onClick={() => { setQuery(""); searchInput.current?.focus(); }}>清除搜索</button>
        </div>
      ) : (
        <section className="project-home-onboarding" aria-labelledby="project-start-heading">
          <StudioIcon name="film" size={32} />
          <div className="project-home-start">
            <h2 id="project-start-heading">从第一部短剧开始</h2>
            <p>选择摄影机原片和同期 WAV 所在的文件夹，就能建项并开始同步。剧本和场记可以稍后添加。</p>
            <div className="project-home-actions">{lifecycle}</div>
            {onOpenWorkspacePath && recentLibraries.length > 0 && <div className="project-onboarding-recent">
              <span>最近项目库</span>
              {recentLibraries.map((item) => (
                <button key={item} type="button" className="secondary" title={item} onClick={() => onOpenWorkspacePath(item)}>
                  {item.replace(/[\\/]workspace\.toml$/i, "").split(/[\\/]/).filter(Boolean).pop() || item}
                </button>
              ))}
            </div>}
          </div>
        </section>
      )}

      {menu ? (
        <div className="project-context-menu" role="menu" aria-label={`${menu.project.name || menu.project.project_id} 项目操作`} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="project-context-heading"><strong>{menu.project.name || menu.project.project_id}</strong><small>{menu.project.project_id}</small><small>{projectFlowLabel(menu.project)}</small></div>
          <div className="project-context-group-label">开始制作</div>
          <button type="button" role="menuitem" onClick={() => run(() => onOpenProject(menu.project))}>打开项目</button>
          <button type="button" role="menuitem" title="本机素材 / 换素材盘" onClick={() => run(() => onOpenMediaBinding(menu.project))}>连接素材</button>
          <button type="button" role="menuitem" onClick={() => run(() => onOpenProjectPage?.(menu.project, menu.project.input_kind === "media-directory" ? "sync-task" : "timeline"))}>{menu.project.input_kind === "media-directory" ? "打开同步任务" : "打开选片组接"}</button>
          <button type="button" role="menuitem" title="重新整理素材、剧本与分析结果" onClick={() => run(() => onPrepareProject(menu.project))}>后台整理素材与剧本</button>
          <button type="button" role="menuitem" disabled={transferBusy || !projectTransferAvailable()} onClick={() => run(() => saveProjectAs(menu.project))}>另存为工程包 (.mirrorproj)…</button>
          <details className="project-context-advanced">
            <summary>高级操作</summary>
            <div className="project-context-advanced-list">
              <button type="button" role="menuitem" onClick={() => run(() => onOpenTeamProject(menu.project))}>团队审阅</button>
              <button type="button" role="menuitem" onClick={() => run(() => onCopyShareLink(menu.project))}>复制局域网协作链接</button>
              <button type="button" role="menuitem" onClick={() => run(() => onRevealProject(menu.project))}>在 {revealLabel} 中显示</button>
              <button type="button" role="menuitem" className="project-context-danger" onClick={() => run(() => onDeleteProject(menu.project))}>永久删除项目…</button>
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}
