import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { DesktopClient } from "../api/desktop";
import {
  HostConnection,
  HostConnectionError,
  defaultHostBaseUrl,
  errorMessage,
  type HostConnectionState,
  type HostSnapshot,
  type ProjectSummary,
} from "../api/host";
import { PlatformClient, type PlatformInfo } from "../api/platform";
import { StudioIcon } from "../components/StudioIcons";
import { ProjectActionClient } from "../api/projectActions";
import { TeamGatewayClient, teamWorkbenchUrl } from "../api/team";
import { ProjectWorkbench } from "../features/production/ProjectWorkbench";
import { ProjectHome } from "../features/projects/ProjectHome";
import { ProjectLibrary } from "../features/projects/ProjectLibrary";
import { WorkspaceLauncher } from "../features/projects/WorkspaceLauncher";
import { WorkspaceHome } from "../features/projects/WorkspaceHome";
import { useProjectActivities } from "../features/projects/projectActivity";
import { SettingsStatusWorkbench } from "../features/settings/SettingsStatusWorkbench";
import { StatusCenterWorkbench } from "../features/status/StatusCenterWorkbench";
import { TeamWebWorkbench } from "../features/team/TeamWebWorkbench";
import {
  forgetWorkspaceResume,
  loadAppResume,
  loadRecentWorkspaces,
  readProjectPage,
  rememberProject,
  rememberWorkspace,
  type ProductionPage,
} from "./resumeState";

const EMPTY_PROJECTS: ProjectSummary[] = [];
const NOTICE_DURATION_MS = 3200;
const ERROR_NOTICE_DURATION_MS = 7000;

function connectionLabel(state: HostConnectionState): string {
  return {
    idle: "未打开",
    connecting: "正在连接",
    starting: "正在打开",
    connected: "已就绪",
    error: "需要处理",
  }[state] ?? state;
}

function projectById(snapshot: HostSnapshot, projectId: string | null | undefined): ProjectSummary | null {
  const id = projectId?.trim();
  return id ? snapshot.projects.find((item) => item.project_id === id) ?? null : null;
}

/**
 * Users often pick an inner `project.toml`, `projects/<id>`, or `projects/`
 * folder when trying to open an existing project. Walk back up to the parent
 * workspace root so the Host loads the real `workspace.toml` & project list
 * instead of treating the inner folder as an empty 0-project workspace.
 */
function normalizeWorkspaceSelection(rawPath: string): { workspacePath: string; targetProjectId: string } {
  const trimmed = rawPath.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return { workspacePath: "", targetProjectId: "" };
  const projectToml = trimmed.match(/^(.*)[\\/]projects[\\/]([^\\/]+)[\\/]project\.toml$/i);
  if (projectToml && projectToml[1]) {
    return { workspacePath: projectToml[1], targetProjectId: projectToml[2] || "" };
  }
  const registryFile = trimmed.match(/^(.*)[\\/]projects[\\/]registry\.json$/i);
  if (registryFile && registryFile[1]) {
    return { workspacePath: registryFile[1], targetProjectId: "" };
  }
  const projectDir = trimmed.match(/^(.*)[\\/]projects[\\/]([^\\/]+)$/i);
  if (projectDir && projectDir[1]) {
    return { workspacePath: projectDir[1], targetProjectId: projectDir[2] || "" };
  }
  const projectsDir = trimmed.match(/^(.*)[\\/]projects$/i);
  if (projectsDir && projectsDir[1]) {
    return { workspacePath: projectsDir[1], targetProjectId: "" };
  }
  return { workspacePath: trimmed, targetProjectId: "" };
}

type AppSurface = "home" | "projects" | "production" | "status" | "team" | "settings";
interface ProjectPageRequest { projectId: string; page: ProductionPage; nonce: number }

const PRODUCTION_PAGE_TITLES: Partial<Record<ProductionPage, string>> = {
  "sync-task": "同步任务",
  "sync-inspect": "同步核对",
  "sync-delivery": "工程交付",
  slate: "场记",
  takes: "Take",
  script: "剧本",
  "media-library": "素材",
  "media-binding": "本机素材",
  identity: "人物",
  watch: "审阅",
  timeline: "时间线",
};

function pageTitle(page: ProductionPage): string {
  // All page writes canonicalize through canonicalProductionPage; the legacy
  // keys (coverage/rough-cut/assembly/delivery/attention/overview) never
  // render, so the title table only owns canonical production pages.
  return PRODUCTION_PAGE_TITLES[page] ?? "制作";
}

export function App() {
  const [launchResume] = useState(() => {
    const raw = loadAppResume();
    const resolved = normalizeWorkspaceSelection(raw.workspacePath);
    return {
      workspacePath: resolved.workspacePath || raw.workspacePath,
      projectId: resolved.targetProjectId || raw.projectId,
    };
  });
  const [surface, setSurface] = useState<AppSurface>("home");
  const [baseUrl, setBaseUrl] = useState(defaultHostBaseUrl);
  const [workspacePath, setWorkspacePath] = useState(launchResume.workspacePath);
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => loadRecentWorkspaces());
  const [state, setState] = useState<HostConnectionState>("idle");
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [pageRequest, setPageRequest] = useState<ProjectPageRequest | null>(null);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState(launchResume.workspacePath ? "准备恢复上次工作区…" : "");
  const [noticeVisible, setNoticeVisible] = useState(false);
  const [resumeEnabledForSession, setResumeEnabledForSession] = useState(false);
  const resumeTaskRef = useRef<Promise<HostSnapshot> | null>(null);
  const pageRequestNonce = useRef(0);

  // baseUrl and workspacePath are editable advanced-control drafts. Once a
  // workspace is open, snapshot.baseUrl and activeWorkspacePath are the active
  // production authority. Merely typing into either field must not redirect
  // background refreshes, Finder reveal, or Team Web away from the open work.
  const connection = useMemo(() => {
    try {
      return new HostConnection(baseUrl);
    } catch {
      return null;
    }
  }, [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const teamGateway = useMemo(() => new TeamGatewayClient(), []);
  const { activities: projectActivities, refreshActivities } = useProjectActivities(
    snapshot?.baseUrl ?? baseUrl,
    snapshot?.projects ?? EMPTY_PROJECTS,
  );

  useEffect(() => {
    if (!isTauri()) return;
    void platform.info().then(setPlatformInfo).catch(() => setPlatformInfo(null));
  }, [platform]);

  useEffect(() => {
    if (!snapshot || !message) {
      setNoticeVisible(false);
      return;
    }
    setNoticeVisible(true);
    const timer = globalThis.setTimeout(
      () => setNoticeVisible(false),
      state === "error" ? ERROR_NOTICE_DURATION_MS : NOTICE_DURATION_MS,
    );
    return () => globalThis.clearTimeout(timer);
  }, [message, snapshot, state]);

  useEffect(() => {
    if (!isTauri() || !launchResume.workspacePath) return;
    let active = true;
    setState("starting");
    setMessage("正在恢复上次工作区…");
    const task = resumeTaskRef.current ?? new HostConnection(defaultHostBaseUrl).startAndConnect(launchResume.workspacePath);
    resumeTaskRef.current = task;
    void task.then((next) => {
      if (!active) return;
      const rememberedProject = projectById(next, launchResume.projectId);
      const rememberedPage = rememberedProject ? readProjectPage(rememberedProject.project_id) : "slate";
      setBaseUrl(next.baseUrl);
      setWorkspacePath(launchResume.workspacePath);
      setActiveWorkspacePath(launchResume.workspacePath);
      setSnapshot(next);
      setSelectedProject(rememberedProject);
      setPageRequest(null);
      setSurface(rememberedProject ? "production" : "projects");
      setResumeEnabledForSession(true);
      setState("connected");
      rememberWorkspace(launchResume.workspacePath);
      setRecentWorkspaces(loadRecentWorkspaces());
      setMessage(rememberedProject
        ? `已恢复 · ${rememberedProject.name || rememberedProject.project_id} · ${pageTitle(rememberedPage)}`
        : `工作区已恢复 · ${next.projects.length} 个项目`);
    }).catch((error: unknown) => {
      if (!active) return;
      setActiveWorkspacePath("");
      setSnapshot(null);
      setSelectedProject(null);
      setPageRequest(null);
      setResumeEnabledForSession(false);
      setState("error");
      setMessage(`无法恢复上次工作区：${errorMessage(error)}`);
    });
    return () => { active = false; };
  }, [launchResume.projectId, launchResume.workspacePath]);

  async function openWorkspacePath(path: string): Promise<void> {
    const resolved = normalizeWorkspaceSelection(path);
    const normalizedPath = resolved.workspacePath;
    if (!normalizedPath) {
      setState("error");
      setMessage("先选择工作区目录或文件。");
      return;
    }
    const previousSnapshot = snapshot;
    const previousProject = selectedProject;
    const previousPath = workspacePath;
    const previousSurface = surface;
    setWorkspacePath(normalizedPath);
    setState("starting");
    setMessage(resolved.targetProjectId ? "已定位到项目所属工作区，正在打开…" : "正在打开工作区…");
    try {
      const next = await new HostConnection(defaultHostBaseUrl).startAndConnect(normalizedPath);
      const targetProject = resolved.targetProjectId ? projectById(next, resolved.targetProjectId) : null;
      setBaseUrl(next.baseUrl);
      setWorkspacePath(normalizedPath);
      setActiveWorkspacePath(normalizedPath);
      setSnapshot(next);
      setSelectedProject(targetProject);
      setPageRequest(null);
      setSurface(targetProject ? "production" : "projects");
      setResumeEnabledForSession(true);
      setState("connected");
      rememberWorkspace(normalizedPath);
      if (targetProject) rememberProject(targetProject.project_id);
      setRecentWorkspaces(loadRecentWorkspaces());
      setMessage(targetProject
        ? `已打开工程 · ${targetProject.name || targetProject.project_id}`
        : `工作区已就绪 · ${next.projects.length} 个项目`);
    } catch (error) {
      if (previousSnapshot) {
        setWorkspacePath(previousPath);
        setSnapshot(previousSnapshot);
        setSelectedProject(previousProject);
        setSurface(previousSurface);
        setState("connected");
        setMessage(`未能切换工作区：${errorMessage(error)} · 当前工作现场保持打开`);
      } else {
        setActiveWorkspacePath("");
        setSnapshot(null);
        setSelectedProject(null);
        setPageRequest(null);
        setResumeEnabledForSession(false);
        setState("error");
        setMessage(errorMessage(error));
      }
    }
  }

  async function chooseWorkspace(directory: boolean): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览不能打开系统目录选择器；可在工作区菜单的高级连接中手动填写路径。");
      return;
    }
    try {
      const selected = await openDialog({
        directory,
        multiple: false,
        title: directory ? "打开镜序工作区" : "打开镜序工作区文件",
      });
      if (typeof selected === "string" && selected.trim()) await openWorkspacePath(selected);
    } catch (error) {
      if (!snapshot) setState("error");
      setMessage(`选择工作区失败：${errorMessage(error)}`);
    }
  }

  async function revealWorkspace(): Promise<void> {
    const target = snapshot ? activeWorkspacePath : workspacePath;
    if (!target.trim()) {
      setMessage("当前工作区没有可定位的本机路径。");
      return;
    }
    try {
      await platform.reveal(target);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function connect(): Promise<void> {
    if (!connection) {
      setState(snapshot ? "connected" : "error");
      setMessage(snapshot ? "高级连接地址无效；当前工作现场保持打开。" : "高级连接地址无效。");
      return;
    }
    const previousSnapshot = snapshot;
    const previousProject = selectedProject;
    const previousPageRequest = pageRequest;
    const previousSurface = surface;
    setState("connecting");
    setMessage("正在连接已有的本机服务…");
    try {
      const next = await connection.connect();
      const sameWorkspace = previousSnapshot?.workspace.workspace_id === next.workspace.workspace_id;
      const project = sameWorkspace && selectedProject ? projectById(next, selectedProject.project_id) : null;
      const connectedWorkspacePath = sameWorkspace ? activeWorkspacePath : "";
      setBaseUrl(next.baseUrl);
      setWorkspacePath(connectedWorkspacePath);
      setActiveWorkspacePath(connectedWorkspacePath);
      setSnapshot(next);
      setSelectedProject(project);
      setPageRequest(null);
      setSurface(sameWorkspace ? previousSurface : "projects");
      setResumeEnabledForSession(false);
      setState("connected");
      setMessage(project
        ? `已重新连接 · ${project.name || project.project_id}`
        : connectedWorkspacePath
          ? `工作区已就绪 · ${next.projects.length} 个项目`
          : `工作区已就绪 · ${next.projects.length} 个项目 · 本机路径未知`);
    } catch (error) {
      if (previousSnapshot) {
        setSnapshot(previousSnapshot);
        setSelectedProject(previousProject);
        setPageRequest(previousPageRequest);
        setSurface(previousSurface);
        setState("connected");
        setMessage(`未能连接新的本机服务：${errorMessage(error)} · 当前工作现场保持打开`);
      } else {
        setActiveWorkspacePath("");
        setSnapshot(null);
        setSelectedProject(null);
        setPageRequest(null);
        setResumeEnabledForSession(false);
        setState("error");
        setMessage(errorMessage(error));
      }
    }
  }

  async function refreshWorkspace(preferredProjectId?: string, openProject = false): Promise<void> {
    const activeBaseUrl = snapshot?.baseUrl ?? baseUrl;
    let activeConnection: HostConnection;
    try {
      activeConnection = new HostConnection(activeBaseUrl);
    } catch {
      throw new HostConnectionError("当前工作现场的本机服务地址无效");
    }
    const next = await activeConnection.connect();
    const preferred = projectById(next, preferredProjectId);
    if (openProject && !preferred) {
      throw new HostConnectionError("项目已保存，刷新后的工作区尚未找到该项目。");
    }
    const existing = selectedProject ? projectById(next, selectedProject.project_id) : null;
    const project = preferred ?? existing;
    setSnapshot(next);
    setSelectedProject(project);
    if (openProject && project) {
      setPageRequest(null);
      setSurface("production");
    }
    if (project && resumeEnabledForSession) rememberProject(project.project_id);
    setState("connected");
    setMessage(project ? `项目已刷新 · ${project.name || project.project_id}` : `工作区已刷新 · ${next.projects.length} 个项目`);
  }

  function selectProject(project: ProjectSummary): void {
    setSelectedProject(project);
    setPageRequest(null);
    setSurface("production");
    if (resumeEnabledForSession) rememberProject(project.project_id);
  }

  function openProjectPage(project: ProjectSummary, page: ProductionPage): void {
    pageRequestNonce.current += 1;
    setSelectedProject(project);
    setPageRequest({ projectId: project.project_id, page, nonce: pageRequestNonce.current });
    setSurface("production");
    if (resumeEnabledForSession) rememberProject(project.project_id);
  }

  function openTeamProject(project: ProjectSummary): void {
    setSelectedProject(project);
    setPageRequest(null);
    setSurface("team");
    if (resumeEnabledForSession) rememberProject(project.project_id);
  }

  async function copyProjectShareLink(project: ProjectSummary): Promise<void> {
    if (!snapshot || !isTauri()) {
      setMessage("协作链接只能从桌面 App 的团队审阅服务复制。");
      return;
    }
    try {
      const status = await teamGateway.status();
      const shareUrl = status.running && status.healthy
        ? teamWorkbenchUrl(status, snapshot.workspace.workspace_id, project.project_id)
        : null;
      if (!shareUrl) {
        openTeamProject(project);
        setMessage("团队审阅尚未就绪；已打开团队审阅，请先开启共享服务。");
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      setMessage(`已复制 ${project.name || project.project_id} 的局域网协作链接。`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function revealProject(project: ProjectSummary): Promise<void> {
    if (!snapshot || !isTauri()) return;
    try {
      const location = await new ProjectActionClient(snapshot.baseUrl).localLocation(project.project_id);
      if (!location.project_exists) {
        setMessage(`项目目录不存在：${project.name || project.project_id}`);
        return;
      }
      await platform.reveal(location.project_dir);
      setMessage(`已在 ${platformInfo?.os === "windows" ? "Explorer" : platformInfo?.os === "macos" ? "Finder" : "文件管理器"} 中定位 ${project.name || project.project_id}`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function prepareProject(project: ProjectSummary): Promise<void> {
    if (!snapshot) return;
    try {
      const task = await new DesktopClient(snapshot.baseUrl).prepareProject(project.project_id);
      await refreshActivities();
      setMessage(`已提交 ${project.name || project.project_id} 的重整任务${task.task_id ? ` · ${task.task_id}` : ""}；运行状态统一在状态中心。`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function multicamSyncProject(project: ProjectSummary): Promise<void> {
    if (!snapshot) return;
    try {
      const task = await new DesktopClient(snapshot.baseUrl).multicamSync(project.project_id);
      await refreshActivities();
      setMessage(`已提交 ${project.name || project.project_id} 的多机位同步任务${task.task_id ? ` · ${task.task_id}` : ""}；这一步只生成同步交付，状态在状态中心查看。`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function deleteProject(project: ProjectSummary): Promise<void> {
    if (!snapshot) return;
    const title = project.name || project.project_id;
    const confirmed = globalThis.confirm(`永久删除项目“${title}”？\n\n会删除工作区内生成的项目目录、分析缓存和项目记录；原始媒体、剧本与 FCPXML 不会删除。`);
    if (!confirmed) return;
    try {
      await new DesktopClient(snapshot.baseUrl).deleteProject(project.project_id);
      if (selectedProject?.project_id === project.project_id) {
        setSelectedProject(null);
        setPageRequest(null);
        setSurface("projects");
      }
      await refreshWorkspace();
      await refreshActivities();
      setMessage(`已永久删除项目 · ${title}`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  function openProjects(): void {
    setPageRequest(null);
    setSurface("projects");
  }

  function openProjectFromStatus(projectId: string): void {
    const project = snapshot?.projects.find((item) => item.project_id === projectId) ?? null;
    if (!project) return;
    selectProject(project);
  }

  function openProjectPageFromStatus(projectId: string, page: ProductionPage): void {
    const project = snapshot?.projects.find((item) => item.project_id === projectId) ?? null;
    if (!project) return;
    openProjectPage(project, page);
  }

  function disableAutomaticResume(): void {
    forgetWorkspaceResume();
    setResumeEnabledForSession(false);
    setMessage("已关闭下次自动恢复；当前工作现场保持打开。");
  }

  const recovering = state === "starting" && Boolean(launchResume.workspacePath) && !snapshot;
  const recoveryFailed = state === "error" && Boolean(workspacePath.trim()) && !snapshot;
  const primaryActive = surface === "production" ? null : surface;
  const revealLabel = platformInfo?.os === "windows" ? "Explorer" : platformInfo?.os === "macos" ? "Finder" : "文件管理器";

  if (!snapshot) {
    return <WorkspaceLauncher
      state={state}
      recovering={recovering}
      recoveryFailed={recoveryFailed}
      native={isTauri()}
      workspacePath={workspacePath}
      serviceAddress={baseUrl}
      message={message}
      onWorkspacePathChange={setWorkspacePath}
      onServiceAddressChange={setBaseUrl}
      onChooseWorkspace={(directory) => void chooseWorkspace(directory)}
      onOpenPath={() => void openWorkspacePath(workspacePath)}
      onConnect={() => void connect()}
      onClearRecovery={() => {
        forgetWorkspaceResume();
        setWorkspacePath("");
        setResumeEnabledForSession(false);
        setState("idle");
        setMessage("已清除自动恢复记录。");
      }}
    />;
  }

  const isProjectOpen = surface === "production" && selectedProject !== null;
  const runningProjects = Object.values(projectActivities).filter((activity) => activity.state === "active").length;
  const currentTitle = surface === "home"
    ? "首页"
      : surface === "projects"
        ? "项目库"
      : surface === "status"
        ? "状态中心"
        : surface === "settings"
          ? "设置"
          : surface === "team"
            ? "团队审阅"
            : "项目库";
  const contextLabel = (surface === "production" || surface === "team") && selectedProject
    ? selectedProject.name || selectedProject.project_id
    : snapshot.workspace.workspace;

  const workspaceMenu = (
    <details className="app-workspace-menu">
      <summary className="app-workspace-chip">
        <span className={`status-dot status-${state}`} aria-hidden="true" />
        <span>{snapshot.workspace.workspace}</span>
        <small aria-hidden="true">⌄</small>
      </summary>
      <div className="app-workspace-menu-popover">
        <div className="app-workspace-menu-heading">
          <span><strong>{snapshot.workspace.workspace}</strong><small>{connectionLabel(state)}</small></span>
          {activeWorkspacePath.trim() ? <code title={activeWorkspacePath}>{activeWorkspacePath}</code> : null}
        </div>
        <div className="app-workspace-menu-actions">
          <button type="button" className="secondary" onClick={() => void refreshWorkspace(selectedProject?.project_id).catch((error) => setMessage(errorMessage(error)))}>刷新工作区</button>
          <button type="button" onClick={() => void chooseWorkspace(true)} disabled={!isTauri() || state === "starting"}>切换工作区…</button>
          <button type="button" onClick={() => void revealWorkspace()} disabled={!isTauri() || !activeWorkspacePath.trim()}>在 {revealLabel} 中显示</button>
        </div>
        {recentWorkspaces.filter((item) => item !== activeWorkspacePath).length > 0 ? (
          <div className="app-workspace-recent">
            <span className="app-workspace-recent-label">最近工作区</span>
            {recentWorkspaces.filter((item) => item !== activeWorkspacePath).slice(0, 4).map((item) => (
              <button
                key={item}
                type="button"
                className="secondary app-workspace-recent-item"
                disabled={state === "starting"}
                title={item}
                onClick={() => void openWorkspacePath(item)}
              >
                <strong>{item.split(/[\\/]/).filter(Boolean).pop() || item}</strong>
                <code>{item}</code>
              </button>
            ))}
          </div>
        ) : null}
        <details className="workspace-advanced app-workspace-advanced">
          <summary>高级连接</summary>
          <label><span>工作区路径</span><input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} spellCheck={false} /></label>
          <button type="button" className="secondary" onClick={() => void openWorkspacePath(workspacePath)} disabled={state === "starting" || !workspacePath.trim()}>打开此路径</button>
          <label><span>本机服务地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} /></label>
          <button type="button" className="secondary" onClick={() => void connect()} disabled={state === "connecting"}>连接已运行服务</button>
          {resumeEnabledForSession ? <button type="button" className="secondary" onClick={disableAutomaticResume}>下次不自动恢复</button> : null}
        </details>
      </div>
    </details>
  );
  const switchProject = selectedProject && (
    <>
      <button type="button" className="secondary app-project-library-link" onClick={openProjects}>
        <StudioIcon name="back" size={13.5} />
        <span>项目库</span>
      </button>
      <details className="app-project-switcher" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }} onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}>
        <summary aria-label={`切换项目 · ${selectedProject.name || selectedProject.project_id}`}>
          <span>{selectedProject.name || selectedProject.project_id}</span>
        </summary>
        <div className="app-project-switcher-list">
          {snapshot.projects.map((project) => (
            <button key={project.project_id} type="button" className="secondary"
              aria-current={project.project_id === selectedProject.project_id ? "true" : undefined}
              onClick={(event) => {
                const menu = event.currentTarget.closest("details");
                if (menu) {
                  menu.open = false;
                  menu.querySelector("summary")?.focus();
                }
                selectProject(project);
              }}>{project.name || project.project_id}</button>
          ))}
        </div>
      </details>
    </>
  );

  return (
    <main className="app-shell production-app-shell mirrororder-redesign-shell">
      <section className={`workspace-shell application-frame${isProjectOpen ? " is-project-open" : ""}`}>
        {!isProjectOpen && <aside className="global-sidebar">
          <ProjectLibrary
            baseUrl={snapshot.baseUrl}
            workspace={snapshot.workspace}
            workspacePath={activeWorkspacePath}
            activities={projectActivities}
            selectedProjectId={selectedProject?.project_id ?? null}
            primaryActive={primaryActive}
            revealLabel={revealLabel}
            onSelectProject={selectProject}
            onOpenProjects={openProjects}
            onOpenStatusCenter={() => setSurface("status")}
            onOpenSettings={() => setSurface("settings")}
            onSwitchWorkspace={isTauri() ? () => void chooseWorkspace(true) : undefined}
            onOpenProjectPage={openProjectPage}
            onOpenTeamProject={openTeamProject}
            onCopyShareLink={(project) => copyProjectShareLink(project)}
            onRevealProject={(project) => revealProject(project)}
            onMulticamSyncProject={(project) => multicamSyncProject(project)}
            onPrepareProject={(project) => prepareProject(project)}
            onOpenMediaBinding={(project) => openProjectPage(project, "media-binding")}
            onDeleteProject={(project) => deleteProject(project)}
            onWorkspaceChanged={refreshWorkspace}
          />
        </aside>}

        <section className="app-main-column">
          {!isProjectOpen && <header className="app-global-topbar">
            <div className="app-global-context">
              {surface === "projects" ? (
                <>
                  <span>工作区</span>
                  <strong>{contextLabel}</strong>
                </>
              ) : (
                <>
                  <span>{contextLabel}</span>
                  <strong>{currentTitle}</strong>
                </>
              )}
            </div>
            <div className="app-global-actions">
              <button type="button" className="app-topbar-status" onClick={() => setSurface("status")}>
                <span className={`app-topbar-status-dot ${runningProjects ? "is-active" : ""}`} />
                {runningProjects ? `${runningProjects} 个项目处理中` : "后台正常"}
              </button>
              {workspaceMenu}
            </div>
          </header>}

          <section className={`workbench-shell main-stage surface-${surface}`}>
            {surface === "home" ? (
              <WorkspaceHome
                workspace={snapshot.workspace}
                activities={projectActivities}
                onOpenProject={selectProject}
                onOpenProjects={openProjects}
                onOpenStatus={() => setSurface("status")}
                onOpenSettings={() => setSurface("settings")}
              />
            ) : surface === "projects" ? (
              <ProjectHome
                baseUrl={snapshot.baseUrl}
                workspace={snapshot.workspace}
                workspacePath={activeWorkspacePath}
                recentWorkspaces={recentWorkspaces}
                activities={projectActivities}
                revealLabel={revealLabel}
                onSwitchWorkspace={isTauri() ? () => void chooseWorkspace(true) : undefined}
                onOpenWorkspacePath={isTauri() ? (path) => void openWorkspacePath(path) : undefined}
                onRevealWorkspace={isTauri() && activeWorkspacePath.trim() ? () => void revealWorkspace() : undefined}
                onOpenProject={selectProject}
                onOpenProjectPage={openProjectPage}
                onOpenTeamProject={openTeamProject}
                onCopyShareLink={(project) => copyProjectShareLink(project)}
                onRevealProject={(project) => revealProject(project)}
                onMulticamSyncProject={(project) => multicamSyncProject(project)}
                onPrepareProject={(project) => prepareProject(project)}
                onOpenMediaBinding={(project) => openProjectPage(project, "media-binding")}
                onDeleteProject={(project) => deleteProject(project)}
                onWorkspaceChanged={(id) => refreshWorkspace(id, Boolean(id))}
              />
            ) : surface === "status" ? (
              <StatusCenterWorkbench
                baseUrl={snapshot.baseUrl}
                projects={snapshot.projects}
                onOpenProject={openProjectFromStatus}
                onOpenProjectPage={openProjectPageFromStatus}
                onOpenSettings={() => setSurface("settings")}
              />
            ) : surface === "team" ? (
              <TeamWebWorkbench workspacePath={activeWorkspacePath} workspaceId={snapshot.workspace.workspace_id} projectId={selectedProject?.project_id ?? null} />
            ) : surface === "settings" ? (
              <SettingsStatusWorkbench baseUrl={snapshot.baseUrl} projectId={selectedProject?.project_id} />
            ) : !selectedProject ? (
              <WorkspaceHome
                workspace={snapshot.workspace}
                activities={projectActivities}
                onOpenProject={selectProject}
                onOpenProjects={openProjects}
                onOpenStatus={() => setSurface("status")}
                onOpenSettings={() => setSurface("settings")}
              />
            ) : null}
            {selectedProject && <div className="app-project-surface" hidden={surface !== "production"}>
              <ProjectWorkbench
                key={`${snapshot.workspace.workspace_id}:${selectedProject.project_id}`}
                baseUrl={snapshot.baseUrl}
                project={selectedProject}
                active={surface === "production"}
                projectNavigation={switchProject}
                systemTools={<>
                  <button type="button" className="secondary app-project-status" onClick={() => setSurface("status")}>
                    <StudioIcon name="activity" size={13.5} />
                    <span>{runningProjects ? `后台任务 ${runningProjects}` : "状态中心"}</span>
                  </button>
                  <button type="button" className="secondary" onClick={() => setSurface("settings")}>
                    <StudioIcon name="settings" size={13.5} />
                    <span>设置</span>
                  </button>
                  {workspaceMenu}
                </>}
                pageRequest={pageRequest?.projectId === selectedProject.project_id ? { page: pageRequest.page, nonce: pageRequest.nonce } : null}
                onOpenTeamReview={() => openTeamProject(selectedProject)}
                workspaceId={snapshot.workspace.workspace_id}
                onTaskChanged={() => void refreshActivities()}
                onOpenStatus={() => setSurface("status")}
              />
            </div>}
          </section>
        </section>
      </section>
      {noticeVisible ? (
        <div
          className={`app-notice ${state === "error" ? "is-error" : ""}`}
          role={state === "error" ? "alert" : "status"}
          aria-live={state === "error" ? "assertive" : "polite"}
        >
          {message}
        </div>
      ) : null}
    </main>
  );
}
