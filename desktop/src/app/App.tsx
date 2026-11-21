import { FinderProjectOpen } from "./FinderProjectOpen";
import "./finder-project-open.css";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DesktopClient } from "../api/desktop";
import {
  HostConnection,
  HostConnectionError,
  defaultHostBaseUrl,
  errorMessage,
  invalidateReviewModelCache,
  type HostConnectionState,
  type HostSnapshot,
  type ProjectSummary,
} from "../api/host";
import { PlatformClient, type PlatformInfo } from "../api/platform";
import { StudioIcon } from "../components/StudioIcons";
import { ProjectActionClient } from "../api/projectActions";
import { TeamGatewayClient, teamWorkbenchUrl } from "../api/team";
import {
  listenXiaoJingMainAction, syncXiaoJingContext, toggleXiaoJingWindow,
  type XiaoJingContextSnapshot, type XiaoJingMainAction,
} from "../api/xiaojingWindow";
import { diagnosticPage } from "../features/assistant/assistantPresentation";
import { ProjectWorkbench } from "../features/production/ProjectWorkbench";
import { ProjectHome } from "../features/projects/ProjectHome";
import { ProjectLibrary } from "../features/projects/ProjectLibrary";
import { WorkspaceLauncher } from "../features/projects/WorkspaceLauncher";
import { WorkspaceHome } from "../features/projects/WorkspaceHome";
import { useProjectActivities } from "../features/projects/projectActivity";
import { SettingsStatusWorkbench } from "../features/settings/SettingsStatusWorkbench";
import { StatusCenterWorkbench } from "../features/status/StatusCenterWorkbench";
import { TeamWebWorkbench } from "../features/team/TeamWebWorkbench";
import type { PendingSlateDrafts, SlateDraftSession } from "../features/slate/slateDraftSession";
import { desktopAppearanceEventName, readDesktopAppearance } from "./desktopAppearance";
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

async function verifiedPreviousWorkspace(previous: HostSnapshot | null): Promise<HostSnapshot | null> {
  if (!previous) return null;
  try {
    // A replacement may have stopped the old managed process or reused its
    // port. A saved projection is never evidence that it is still connected.
    const fresh = await new HostConnection(previous.baseUrl).connect();
    if (fresh.workspace.workspace_id === previous.workspace.workspace_id) {
      invalidateReviewModelCache(fresh.baseUrl);
      return fresh;
    }
    return null;
  } catch {
    return null;
  }
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
  const desktopHud = isTauri();
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
  const [state, setState] = useState<HostConnectionState>(() => isTauri() && launchResume.workspacePath ? "starting" : "idle");
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [pageRequest, setPageRequest] = useState<ProjectPageRequest | null>(null);
  const [activeProjectPage, setActiveProjectPage] = useState<ProductionPage | null>(null);
  const [projectSyncStatus, setProjectSyncStatus] = useState<{ projectId: string; ready: boolean; phase: string } | null>(null);
  const [externalXiaoJingAction, setExternalXiaoJingAction] = useState<(XiaoJingMainAction & { nonce: number }) | null>(null);
  const [appearance, setAppearance] = useState(() => readDesktopAppearance());
  const handleSyncStatusChange = useCallback((ready: boolean, phase: string) => {
    if (selectedProject) setProjectSyncStatus({ projectId: selectedProject.project_id, ready, phase });
  }, [selectedProject?.project_id]);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState(launchResume.workspacePath ? "准备恢复上次工作区…" : "");
  const [noticeVisible, setNoticeVisible] = useState(false);
  const [resumeEnabledForSession, setResumeEnabledForSession] = useState(false);
  const resumeTaskRef = useRef<Promise<HostSnapshot> | null>(null);
  const [connectionLifetime, setConnectionLifetime] = useState(() => ({ version: 0, controller: new AbortController() }));
  const activeConnectionLifetime = useRef(connectionLifetime);
  const [slateDrafts] = useState(() => new Map<string, PendingSlateDrafts>());
  const workspaceId = snapshot?.workspace.workspace_id;
  const projectId = selectedProject?.project_id;
  const pageRequestNonce = useRef(0);
  const activeSnapshot = state === "starting" || state === "connecting" ? null : snapshot;
  const xiaojingWorkspace = useMemo<Pick<XiaoJingContextSnapshot, "workspace_name" | "projects" | "appearance">>(() => ({
    workspace_name: activeSnapshot?.workspace.workspace ?? "",
    projects: activeSnapshot?.projects.map(({ project_id, name, input_kind }) => ({ project_id, name, input_kind })) ?? [],
    appearance,
  }), [activeSnapshot, appearance]);

  const slateDraftSession = useMemo<SlateDraftSession | undefined>(() => {
    if (!workspaceId || !projectId) return undefined;
    const key = JSON.stringify([workspaceId, projectId]);
    return {
      workspaceId,
      signal: connectionLifetime.controller.signal,
      read: () => slateDrafts.get(key),
      write: (drafts) => {
        if (drafts.size) slateDrafts.set(key, drafts);
        else slateDrafts.delete(key);
      },
    };
  }, [connectionLifetime, projectId, slateDrafts, workspaceId]);

  function beginWorkspaceConnection(): AbortSignal {
    // Invalidate in-flight Slate commands before replacing the Host, even
    // before React commits the launcher and its unmounts.
    const current = activeConnectionLifetime.current;
    current.controller.abort();
    const next = { version: current.version + 1, controller: new AbortController() };
    activeConnectionLifetime.current = next;
    setConnectionLifetime(next);
    setExternalXiaoJingAction(null);
    return next.controller.signal;
  }

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
    if (!desktopHud) return;
    const sync = () => setAppearance(readDesktopAppearance());
    const event = desktopAppearanceEventName();
    window.addEventListener(event, sync);
    return () => window.removeEventListener(event, sync);
  }, [desktopHud]);

  useEffect(() => {
    if (!desktopHud || (activeSnapshot && surface === "production" && selectedProject)) return;
    void syncXiaoJingContext({
      ...xiaojingWorkspace,
      base_url: activeSnapshot?.baseUrl ?? "",
      workspace_id: activeSnapshot?.workspace.workspace_id ?? "",
      project_id: activeSnapshot ? selectedProject?.project_id ?? "" : "",
      project_name: activeSnapshot ? selectedProject?.name ?? "" : "",
      current_page: "",
      selection: {},
      selection_summary: "",
    }).catch((error) => console.error("无法同步小镜上下文", error));
  }, [activeSnapshot, desktopHud, selectedProject, surface, xiaojingWorkspace]);

  useEffect(() => {
    if (!desktopHud) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        void toggleXiaoJingWindow().catch((error) => setMessage(`无法切换小镜窗口：${errorMessage(error)}`));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [desktopHud]);

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
    const attempt = beginWorkspaceConnection();
    setState("starting");
    setMessage("正在恢复上次工作区…");
    const task = resumeTaskRef.current ?? new HostConnection(defaultHostBaseUrl).startAndConnect(launchResume.workspacePath);
    resumeTaskRef.current = task;
    void task.then((next) => {
      if (!active || attempt.aborted) return;
      const rememberedProject = projectById(next, launchResume.projectId);
      const rememberedPage = rememberedProject ? readProjectPage(rememberedProject.project_id) : "slate";
      setBaseUrl(next.baseUrl);
      setWorkspacePath(launchResume.workspacePath);
      setActiveWorkspacePath(launchResume.workspacePath);
      setSnapshot(next);
      setSelectedProject(rememberedProject);
      setPageRequest(null);
      setActiveProjectPage(rememberedProject ? rememberedPage : null);
      setProjectSyncStatus(null);
      setSurface(rememberedProject ? "production" : "projects");
      setResumeEnabledForSession(true);
      setState("connected");
      rememberWorkspace(launchResume.workspacePath);
      setRecentWorkspaces(loadRecentWorkspaces());
      setMessage(rememberedProject
        ? `已恢复 · ${rememberedProject.name || rememberedProject.project_id} · ${pageTitle(rememberedPage)}`
        : `工作区已恢复 · ${next.projects.length} 个项目`);
    }).catch((error: unknown) => {
      if (!active || attempt.aborted) return;
      setActiveWorkspacePath("");
      setSnapshot(null);
      setSelectedProject(null);
      setPageRequest(null);
      setActiveProjectPage(null);
      setProjectSyncStatus(null);
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
    const previousPath = activeWorkspacePath;
    const previousPageRequest = pageRequest;
    const previousSurface = surface;
    const attempt = beginWorkspaceConnection();
    setWorkspacePath(normalizedPath);
    setState("starting");
    setMessage(resolved.targetProjectId ? "已定位到项目所属工作区，正在打开…" : "正在打开工作区…");
    try {
      const next = await new HostConnection(defaultHostBaseUrl).startAndConnect(normalizedPath);
      if (attempt.aborted) return;
      const targetProject = resolved.targetProjectId ? projectById(next, resolved.targetProjectId) : null;
      invalidateReviewModelCache(next.baseUrl);
      setBaseUrl(next.baseUrl);
      setWorkspacePath(normalizedPath);
      setActiveWorkspacePath(normalizedPath);
      setSnapshot(next);
      setSelectedProject(targetProject);
      setPageRequest(null);
      setActiveProjectPage(null);
      setProjectSyncStatus(null);
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
      if (attempt.aborted) return;
      const recovered = await verifiedPreviousWorkspace(previousSnapshot);
      if (attempt.aborted) return;
      if (recovered) {
        const project = projectById(recovered, previousProject?.project_id);
        setBaseUrl(recovered.baseUrl);
        setWorkspacePath(previousPath);
        setActiveWorkspacePath(previousPath);
        setSnapshot(recovered);
        setSelectedProject(project);
        setPageRequest(project ? previousPageRequest : null);
        setActiveProjectPage(null);
        setProjectSyncStatus(null);
        setSurface(previousSurface === "production" && !project ? "projects" : previousSurface);
        setState("connected");
        setMessage(`未能切换工作区：${errorMessage(error)} · 当前工作现场保持打开`);
      } else {
        setActiveWorkspacePath("");
        setSnapshot(null);
        setSelectedProject(null);
        setPageRequest(null);
        setActiveProjectPage(null);
        setProjectSyncStatus(null);
        setResumeEnabledForSession(false);
        setState("error");
        setMessage(`${errorMessage(error)}${previousSnapshot ? " · 原工作区连接未确认，已断开" : ""}`);
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
    const attempt = beginWorkspaceConnection();
    setState("connecting");
    setMessage("正在连接已有的本机服务…");
    try {
      const next = await connection.connect();
      if (attempt.aborted) return;
      const sameWorkspace = previousSnapshot?.workspace.workspace_id === next.workspace.workspace_id;
      const project = sameWorkspace && selectedProject ? projectById(next, selectedProject.project_id) : null;
      const connectedWorkspacePath = sameWorkspace ? activeWorkspacePath : "";
      invalidateReviewModelCache(next.baseUrl);
      setBaseUrl(next.baseUrl);
      setWorkspacePath(connectedWorkspacePath);
      setActiveWorkspacePath(connectedWorkspacePath);
      setSnapshot(next);
      setSelectedProject(project);
      setPageRequest(null);
      setActiveProjectPage(null);
      setProjectSyncStatus(null);
      setSurface(sameWorkspace ? previousSurface : "projects");
      setResumeEnabledForSession(false);
      setState("connected");
      setMessage(project
        ? `已重新连接 · ${project.name || project.project_id}`
        : connectedWorkspacePath
          ? `工作区已就绪 · ${next.projects.length} 个项目`
          : `工作区已就绪 · ${next.projects.length} 个项目 · 本机路径未知`);
    } catch (error) {
      if (attempt.aborted) return;
      const recovered = await verifiedPreviousWorkspace(previousSnapshot);
      if (attempt.aborted) return;
      if (recovered) {
        const project = projectById(recovered, previousProject?.project_id);
        setBaseUrl(recovered.baseUrl);
        setSnapshot(recovered);
        setSelectedProject(project);
        setPageRequest(project ? previousPageRequest : null);
        setActiveProjectPage(null);
        setProjectSyncStatus(null);
        setSurface(previousSurface === "production" && !project ? "projects" : previousSurface);
        setState("connected");
        setMessage(`未能连接新的本机服务：${errorMessage(error)} · 当前工作现场保持打开`);
      } else {
        setActiveWorkspacePath("");
        setSnapshot(null);
        setSelectedProject(null);
        setPageRequest(null);
        setActiveProjectPage(null);
        setProjectSyncStatus(null);
        setResumeEnabledForSession(false);
        setState("error");
        setMessage(`${errorMessage(error)}${previousSnapshot ? " · 原工作区连接未确认，已断开" : ""}`);
      }
    }
  }

  async function refreshWorkspace(preferredProjectId?: string, openProject = false): Promise<void> {
    const binding = connectionLifetime.controller.signal;
    if (binding.aborted) return;
    const activeBaseUrl = snapshot?.baseUrl ?? baseUrl;
    let activeConnection: HostConnection;
    try {
      activeConnection = new HostConnection(activeBaseUrl);
    } catch {
      throw new HostConnectionError("当前工作现场的本机服务地址无效");
    }
    const next = await activeConnection.connect();
    if (binding.aborted) return;
    if (snapshot && next.workspace.workspace_id !== snapshot.workspace.workspace_id) {
      beginWorkspaceConnection();
      setActiveWorkspacePath("");
      setSnapshot(null);
      setSelectedProject(null);
      setPageRequest(null);
      setActiveProjectPage(null);
      setProjectSyncStatus(null);
      setResumeEnabledForSession(false);
      setState("error");
      setMessage("本机服务已切换到其他工作区，请重新连接原工作区。");
      return;
    }
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
    setActiveProjectPage(null);
    setProjectSyncStatus(null);
    setExternalXiaoJingAction(null);
    setSurface("production");
    if (resumeEnabledForSession) rememberProject(project.project_id);
  }

  function openProjectPage(project: ProjectSummary, page: ProductionPage): void {
    pageRequestNonce.current += 1;
    setSelectedProject(project);
    setPageRequest({ projectId: project.project_id, page, nonce: pageRequestNonce.current });
    setActiveProjectPage(page);
    setExternalXiaoJingAction(null);
    setSurface("production");
    if (resumeEnabledForSession) rememberProject(project.project_id);
  }

  function openTeamProject(project: ProjectSummary): void {
    setSelectedProject(project);
    setPageRequest(null);
    setActiveProjectPage(null);
    setProjectSyncStatus(null);
    setExternalXiaoJingAction(null);
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
    setExternalXiaoJingAction(null);
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

  const handleXiaoJingAction = useRef<(action: XiaoJingMainAction) => void>(() => undefined);
  handleXiaoJingAction.current = (action) => {
    switch (action.kind) {
      case "task_submitted":
        void refreshActivities();
        return;
      case "open_settings":
        setSurface("settings");
        return;
      case "open_status":
        setSurface("status");
        return;
      case "select_project":
      case "open_diagnostic":
      case "focus_take": {
        if (!activeSnapshot) return;
        const target = projectById(activeSnapshot, action.project_id ?? selectedProject?.project_id);
        if (!target) {
          setMessage("小镜所指的项目不在当前工作区。");
          return;
        }
        if (action.kind === "open_diagnostic") {
          const page = diagnosticPage(action.page);
          if (page) openProjectPage(target, page);
          return;
        }
        selectProject(target);
        if (action.kind === "focus_take") {
          setExternalXiaoJingAction({ ...action, project_id: target.project_id, nonce: ++pageRequestNonce.current });
        }
      }
    }
  };

  useEffect(() => {
    if (!desktopHud) return;
    let active = true;
    let stop: (() => void) | undefined;
    void listenXiaoJingMainAction((action) => { if (active) handleXiaoJingAction.current(action); }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    }).catch((error) => { if (active) setMessage(`无法监听小镜窗口：${errorMessage(error)}`); });
    return () => { active = false; stop?.(); };
  }, [desktopHud]);

  const recovering = state === "starting" && Boolean(launchResume.workspacePath) && !snapshot;
  const recoveryFailed = state === "error" && Boolean(workspacePath.trim()) && !snapshot;
  const primaryActive = surface === "production" ? null : surface;
  const revealLabel = platformInfo?.os === "windows" ? "Explorer" : platformInfo?.os === "macos" ? "Finder" : "文件管理器";

  const finderProject = <FinderProjectOpen
    destination={snapshot && state === "connected" && activeWorkspacePath ? {
      id: snapshot.workspace.workspace_id,
      name: snapshot.workspace.workspace,
      baseUrl: snapshot.baseUrl,
      projects: snapshot.projects,
    } : null}
    signal={connectionLifetime.controller.signal}
    onOpen={(project) => refreshWorkspace(project, true)}
    onNotice={setMessage}
  />;

  // Unmount writable project controls before a managed Host can be replaced.
  // Recovery keeps this barrier until a fresh workspace identity is verified.
  if (!snapshot || state === "starting" || state === "connecting") {
    return <><WorkspaceLauncher
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
      recentWorkspaces={recentWorkspaces}
      onOpenRecent={(path) => void openWorkspacePath(path)}
      onConnect={() => void connect()}
      onClearRecovery={() => {
        forgetWorkspaceResume();
        setWorkspacePath("");
        setResumeEnabledForSession(false);
        setState("idle");
        setMessage("已清除自动恢复记录。");
      }}
    />{finderProject}</>;
  }

  const isProjectOpen = surface === "production" && selectedProject !== null;
  const projectRailOpen = surface !== "projects" && selectedProject !== null;
  const activeProjectSyncStatus = selectedProject && projectSyncStatus?.projectId === selectedProject.project_id
    ? projectSyncStatus
    : null;
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
        <span>
          {snapshot.workspace.workspace}
          {state !== "connected" && <small> · {connectionLabel(state)}</small>}
        </span>
        <small aria-hidden="true"><StudioIcon name="chevron-down" size={11.5} /></small>
      </summary>
      <div className="app-workspace-menu-popover">
        <div className="app-workspace-menu-heading">
          <span><strong>{snapshot.workspace.workspace}</strong><small>{connectionLabel(state)}</small></span>
          {activeWorkspacePath.trim() ? <code title={activeWorkspacePath}>{activeWorkspacePath}</code> : null}
        </div>
        <div className="app-workspace-menu-actions">
          <button type="button" className="secondary" onClick={() => void refreshWorkspace(selectedProject?.project_id).catch((error) => setMessage(errorMessage(error)))}>刷新工作区</button>
          <button type="button" onClick={() => void chooseWorkspace(true)} disabled={!isTauri()}>切换工作区…</button>
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
          <button type="button" className="secondary" onClick={() => void openWorkspacePath(workspacePath)} disabled={!workspacePath.trim()}>打开此路径</button>
          <label><span>本机服务地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} /></label>
          <button type="button" className="secondary" onClick={() => void connect()}>连接已运行服务</button>
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

  return (<>
    <main className="app-shell production-app-shell mirrororder-redesign-shell">
      <section className={`workspace-shell application-frame${isProjectOpen ? " is-project-open" : ""}`}>
        <aside className="global-sidebar" data-tauri-drag-region>
          <ProjectLibrary
            baseUrl={snapshot.baseUrl}
            workspace={snapshot.workspace}
            workspacePath={activeWorkspacePath}
            activities={projectActivities}
            selectedProjectId={selectedProject?.project_id ?? null}
            primaryActive={primaryActive}
            activeProjectPage={activeProjectPage}
            projectOpen={projectRailOpen}
            syncReady={activeProjectSyncStatus?.ready ?? false}
            syncPhase={activeProjectSyncStatus?.phase ?? "idle"}
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
        </aside>

        <section className="app-main-column">
          {!isProjectOpen && <header className="app-global-topbar" data-tauri-drag-region>
            <div className="app-global-context" data-tauri-drag-region="deep">
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
            <div className="app-global-actions" data-tauri-drag-region>
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
                key={JSON.stringify([snapshot.workspace.workspace_id, selectedProject.project_id, connectionLifetime.version])}
                baseUrl={snapshot.baseUrl}
                project={selectedProject}
                slateDraftSession={slateDraftSession}
                active={surface === "production"}
                projectNavigation={switchProject}
                workspaceMenu={workspaceMenu}
                pageRequest={pageRequest?.projectId === selectedProject.project_id ? { page: pageRequest.page, nonce: pageRequest.nonce } : null}
                externalXiaoJingAction={externalXiaoJingAction?.project_id === selectedProject.project_id ? externalXiaoJingAction : null}
                xiaojingWorkspace={xiaojingWorkspace}
                onXiaoJingError={setMessage}
                onOpenTeamReview={() => openTeamProject(selectedProject)}
                workspaceId={snapshot.workspace.workspace_id}
                showModuleRail={!isProjectOpen}
                onPageChange={setActiveProjectPage}
                onSyncStatusChange={handleSyncStatusChange}
                onTaskChanged={() => void refreshActivities()}
                onOpenStatus={() => setSurface("status")}
                onOpenSettings={() => setSurface("settings")}
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
    </main>{finderProject}
  </>);
}
