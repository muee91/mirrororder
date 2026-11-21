import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import { errorMessage } from "../../api/host";
import { projectTransferAvailable, saveProjectCopy } from "../../app/projectTransferActions";
import { ProjectLifecyclePanel } from "./ProjectLifecyclePanel";
import type { ProjectActivitySummary } from "./projectActivity";
import { projectPresentation } from "./projectPresentation";
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
      setActionMessage(`另存项目失败：${errorMessage(error)}`);
    } finally {
      setTransferBusy(false);
    }
  }

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
                <button type="button" className="project-home-path-link" title={`在 ${revealLabel} 中打开：${workspacePath}`} onClick={onRevealWorkspace}>
                  <code>{workspacePath}</code>
                </button>
              ) : (
                <code className="project-home-path-text" title={workspacePath}>{workspacePath}</code>
              )
            ) : null}
            {actionMessage ? <span className="project-home-status-msg" role="status">{actionMessage}</span> : null}
          </div>
        </div>
        <div className="project-home-actions">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目…" aria-label="搜索项目" />
          <ProjectLifecyclePanel baseUrl={baseUrl} workspaceId={workspace.workspace_id} onOpenExistingFolder={onSwitchWorkspace} onWorkspaceChanged={onWorkspaceChanged} onStatusMessage={setActionMessage} />
        </div>
      </header>

      {visible.length ? (
        <div className="project-home-list project-home-grid" aria-label="项目列表">
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
                  <div className="project-card-cover" aria-hidden="true">
                    <span className="project-card-spectrum" />
                    <span className="project-card-kind-pill">{presentation.kind}</span>
                    <span className={`project-home-state status-${presentation.statusTone}`}>
                      {activity?.state === "active" ? <span className="project-activity-spinner" aria-hidden="true" /> : <span className="project-home-state-dot" aria-hidden="true" />}
                      <span>{presentation.statusLabel}</span>
                    </span>
                  </div>
                  <div className="project-card-body">
                    <span className="project-home-project-copy">
                      <strong>{project.name || project.project_id}</strong>
                      <small title={project.project_id}>{presentation.sidebarSubtitle}</small>
                    </span>
                    <span className="project-home-stats">
                      <span><strong>{presentation.takes}</strong> Take</span>
                      <span><strong>{presentation.clips}</strong> 素材</span>
                      {presentation.attention ? <span className="needs-attention"><strong>{presentation.attention}</strong> 需关注</span> : null}
                    </span>
                  </div>
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
      ) : workspace.projects.length ? (
        <div className="project-home-empty">
          <strong>没有匹配项目</strong>
          <span>调整搜索关键词。</span>
        </div>
      ) : (
        <div className="project-home-onboarding">
          <div className="project-home-empty-hero">
            <strong>当前目录下还没有短剧项目</strong>
            <span>镜序以目录为单位管理短剧项目。你可以直接打开已有测试工程所在的文件夹，或者在这里新建一部剧。</span>
          </div>
          <div className="project-onboarding-grid">
            <article className="project-onboarding-card is-highlighted">
              <span className="project-onboarding-step">01 · 打开已有工程</span>
              <h3>选择已有工程目录</h3>
              <p>如果测试工程或素材目录在硬盘上的其他位置，直接选中那个项目目录或上级工作区目录，即可立即打开。</p>
              {onSwitchWorkspace ? (
                <button type="button" onClick={onSwitchWorkspace}>选择已有工程所在目录…</button>
              ) : null}
              {onOpenWorkspacePath && recentWorkspaces.filter((item) => item !== workspacePath).length > 0 ? (
                <div className="project-onboarding-recent">
                  <span>最近打开过：</span>
                  {recentWorkspaces.filter((item) => item !== workspacePath).slice(0, 3).map((item) => (
                    <button key={item} type="button" className="secondary" title={item} onClick={() => onOpenWorkspacePath(item)}>
                      {item.split(/[\\/]/).filter(Boolean).pop() || item}
                    </button>
                  ))}
                </div>
              ) : null}
            </article>
            <article className="project-onboarding-card">
              <span className="project-onboarding-step">02 · 从素材开新剧</span>
              <h3>新建多机位短剧工程</h3>
              <p>点击右上角 <strong>「新建项目」</strong>，选择原始视频与同期 WAV 录音目录（或导入 FCPXML），即可开始多机位同步、场记与 NLE 交付。</p>
            </article>
            <article className="project-onboarding-card">
              <span className="project-onboarding-step">03 · 跨电脑交接</span>
              <h3>导入 .mirrorproj 工程包</h3>
              <p>如果是另一台剪辑机用「另存项目」生成的便携工程包，点击右上角 <strong>「导入工程包…」</strong> 还原，再在「本机素材」中重连硬盘原片。</p>
            </article>
          </div>
        </div>
      )}

      {menu ? (
        <div className="project-context-menu" role="menu" aria-label={`${menu.project.name || menu.project.project_id} 项目操作`} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="project-context-heading"><strong>{menu.project.name || menu.project.project_id}</strong><small>{menu.project.project_id}</small><small>连接 → 同步 → 整理</small></div>
          <div className="project-context-group-label">开始制作</div>
          <button type="button" role="menuitem" onClick={() => run(() => onOpenProject(menu.project))}>打开项目</button>
          <button type="button" role="menuitem" title="本机素材 / 换素材盘" onClick={() => run(() => onOpenMediaBinding(menu.project))}>连接素材</button>
          <button type="button" role="menuitem" onClick={() => run(() => onOpenProjectPage?.(menu.project, menu.project.input_kind === "media-directory" ? "sync-task" : "timeline"))}>{menu.project.input_kind === "media-directory" ? "打开同步任务" : "打开选片组接"}</button>
          <button type="button" role="menuitem" title="重新整理项目" onClick={() => run(() => onPrepareProject(menu.project))}>完整整理项目</button>
          <details className="project-context-advanced">
            <summary>高级操作</summary>
            <div className="project-context-advanced-list">
              <button type="button" role="menuitem" onClick={() => run(() => onOpenTeamProject(menu.project))}>团队审阅</button>
              <button type="button" role="menuitem" onClick={() => run(() => onCopyShareLink(menu.project))}>复制局域网协作链接</button>
              <button type="button" role="menuitem" onClick={() => run(() => onRevealProject(menu.project))}>在 {revealLabel} 中显示</button>
              <button type="button" role="menuitem" disabled={transferBusy || !projectTransferAvailable()} onClick={() => run(() => saveProjectAs(menu.project))}>另存项目…</button>
              <button type="button" role="menuitem" className="project-context-danger" onClick={() => run(() => onDeleteProject(menu.project))}>永久删除项目…</button>
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}
