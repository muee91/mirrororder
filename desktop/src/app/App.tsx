import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  HostConnection,
  HostConnectionError,
  defaultHostBaseUrl,
  type HostConnectionState,
  type HostSnapshot,
  type ProjectSummary,
} from "../api/host";
import { PlatformClient, type PlatformInfo } from "../api/platform";
import { ProjectWorkbench } from "../features/production/ProjectWorkbench";
import { ProjectLibrary } from "../features/projects/ProjectLibrary";
import { SettingsStatusWorkbench } from "../features/settings/SettingsStatusWorkbench";
import { StatusCenterWorkbench } from "../features/status/StatusCenterWorkbench";
import { TeamWebWorkbench } from "../features/team/TeamWebWorkbench";
import {
  forgetWorkspaceResume,
  loadAppResume,
  rememberProject,
  rememberWorkspace,
} from "./resumeState";

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

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

type AppSurface = "production" | "status" | "team" | "settings";

export function App() {
  const [launchResume] = useState(() => loadAppResume());
  const [surface, setSurface] = useState<AppSurface>("production");
  const [baseUrl, setBaseUrl] = useState(defaultHostBaseUrl);
  const [workspacePath, setWorkspacePath] = useState(launchResume.workspacePath);
  const [state, setState] = useState<HostConnectionState>("idle");
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState(launchResume.workspacePath ? "准备恢复上次工作现场…" : "打开一个工作区开始制作。");
  const [resumeEnabledForSession, setResumeEnabledForSession] = useState(false);
  const resumeTaskRef = useRef<Promise<HostSnapshot> | null>(null);

  const connection = useMemo(() => {
    try {
      return new HostConnection(baseUrl);
    } catch {
      return null;
    }
  }, [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);

  useEffect(() => {
    if (!isTauri()) return;
    void platform.info().then(setPlatformInfo).catch(() => setPlatformInfo(null));
  }, [platform]);

  useEffect(() => {
    if (!isTauri() || !launchResume.workspacePath) return;
    let active = true;
    setState("starting");
    setMessage("正在恢复上次工作现场…");
    const task = resumeTaskRef.current ?? new HostConnection(defaultHostBaseUrl).startAndConnect(launchResume.workspacePath);
    resumeTaskRef.current = task;
    void task.then((next) => {
      if (!active) return;
      const project = projectById(next, launchResume.projectId);
      setBaseUrl(next.baseUrl);
      setWorkspacePath(launchResume.workspacePath);
      setSnapshot(next);
      setSelectedProject(project);
      setSurface("production");
      setResumeEnabledForSession(true);
      setState("connected");
      rememberWorkspace(launchResume.workspacePath);
      if (project) rememberProject(project.project_id);
      setMessage(project ? `已恢复 ${project.name || project.project_id}` : `工作区已就绪 · ${next.projects.length} 个项目`);
    }).catch((error: unknown) => {
      if (!active) return;
      setSnapshot(null);
      setSelectedProject(null);
      setResumeEnabledForSession(false);
      setState("error");
      setMessage(`无法恢复上次工作区：${errorMessage(error)}`);
    });
    return () => { active = false; };
  }, [launchResume.projectId, launchResume.workspacePath]);

  async function openWorkspacePath(path: string): Promise<void> {
    if (!connection) {
      setState("error");
      setMessage("本机服务地址无效。");
      return;
    }
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      setState("error");
      setMessage("先选择工作区目录或文件。");
      return;
    }
    const previousSnapshot = snapshot;
    const previousProject = selectedProject;
    const previousPath = workspacePath;
    const remembered = loadAppResume();
    const preferredProjectId = remembered.workspacePath === normalizedPath ? remembered.projectId : "";
    setWorkspacePath(normalizedPath);
    setState("starting");
    setMessage("正在打开工作区…");
    try {
      const next = await connection.startAndConnect(normalizedPath);
      const project = projectById(next, preferredProjectId);
      setBaseUrl(next.baseUrl);
      setWorkspacePath(normalizedPath);
      setSnapshot(next);
      setSelectedProject(project);
      setSurface("production");
      setResumeEnabledForSession(true);
      setState("connected");
      rememberWorkspace(normalizedPath);
      if (project) rememberProject(project.project_id);
      setMessage(project ? `已恢复 ${project.name || project.project_id}` : `工作区已就绪 · ${next.projects.length} 个项目`);
    } catch (error) {
      if (previousSnapshot) {
        setWorkspacePath(previousPath);
        setSnapshot(previousSnapshot);
        setSelectedProject(previousProject);
        setState("error");
        setMessage(`未能切换工作区：${errorMessage(error)} · 当前工作现场保持打开`);
      } else {
        setSnapshot(null);
        setSelectedProject(null);
        setResumeEnabledForSession(false);
        setState("error");
        setMessage(errorMessage(error));
      }
    }
  }

  async function chooseWorkspace(directory: boolean): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览不能打开系统目录选择器；可在“工作区与连接”中手动填写路径。");
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
      setMessage(`选择工作区失败：${errorMessage(error)}`);
    }
  }

  async function revealWorkspace(): Promise<void> {
    if (!workspacePath.trim()) return;
    try {
      await platform.reveal(workspacePath);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function connect(): Promise<void> {
    if (!connection) {
      setState("error");
      setMessage("高级连接地址无效。");
      return;
    }
    setState("connecting");
    setMessage("正在连接已有的本机服务…");
    try {
      const next = await connection.connect();
      const project = selectedProject ? projectById(next, selectedProject.project_id) : null;
      setSnapshot(next);
      setSelectedProject(project);
      setSurface("production");
      setResumeEnabledForSession(false);
      setState("connected");
      setMessage(project ? `已连接 · ${project.name || project.project_id}` : `工作区已就绪 · ${next.projects.length} 个项目`);
    } catch (error) {
      setSnapshot(null);
      setSelectedProject(null);
      setResumeEnabledForSession(false);
      setState("error");
      setMessage(errorMessage(error));
    }
  }

  async function refreshWorkspace(preferredProjectId?: string): Promise<void> {
    if (!connection) throw new HostConnectionError("本机服务地址无效");
    const next = await connection.connect();
    const preferred = projectById(next, preferredProjectId);
    const existing = selectedProject ? projectById(next, selectedProject.project_id) : null;
    const project = preferred ?? existing;
    setSnapshot(next);
    setSelectedProject(project);
    if (project && resumeEnabledForSession) rememberProject(project.project_id);
    setState("connected");
    setMessage(project ? `项目已刷新 · ${project.name || project.project_id}` : `项目库已刷新 · ${next.projects.length} 个项目`);
  }

  function selectProject(project: ProjectSummary): void {
    setSelectedProject(project);
    setSurface("production");
    if (resumeEnabledForSession) rememberProject(project.project_id);
    setMessage(`已打开 ${project.name || project.project_id}`);
  }

  function openProjectFromStatus(projectId: string): void {
    const project = snapshot?.projects.find((item) => item.project_id === projectId) ?? null;
    if (!project) return;
    selectProject(project);
  }

  function disableAutomaticResume(): void {
    forgetWorkspaceResume();
    setResumeEnabledForSession(false);
    setMessage("已关闭下次自动恢复；当前工作现场保持打开。");
  }

  const recovering = state === "starting" && Boolean(launchResume.workspacePath) && !snapshot;
  const recoveryFailed = state === "error" && Boolean(workspacePath.trim()) && !snapshot;
  const utilityActive = surface === "production" ? null : surface;

  if (!snapshot) {
    return (
      <main className="startup-shell">
        <section className={`startup-home ${recoveryFailed ? "is-recovery" : ""}`}>
          <div className="startup-brand">
            <div className="startup-logo" aria-hidden="true">镜</div>
            <div>
              <strong>镜序</strong>
              <span>MirrorOrder</span>
            </div>
          </div>
          <div className="startup-primary">
            <p className="eyebrow">{recovering ? "恢复工作现场" : recoveryFailed ? "工作区恢复" : "Production"}</p>
            <h1>{recovering ? "正在恢复上次工作现场" : recoveryFailed ? "重新定位工作区" : "继续制作"}</h1>
            <p>{recovering
              ? "正在启动本机制作服务，并恢复上次项目与工作画布。"
              : recoveryFailed
                ? "上次工作区没有成功打开。重新定位它，或选择其他工作区；项目数据不会被改写。"
                : "打开镜序工作区后直接进入项目。Host、端口与运行诊断只在高级区域出现。"}</p>
            {workspacePath.trim() ? <code className="startup-path">{workspacePath}</code> : null}
            <div className="startup-actions">
              <button type="button" onClick={() => void chooseWorkspace(true)} disabled={!isTauri() || state === "starting"}>{recoveryFailed ? "重新定位" : "打开工作区"}</button>
              <button type="button" className="secondary" onClick={() => void chooseWorkspace(false)} disabled={!isTauri() || state === "starting"}>打开工作区文件</button>
              {recoveryFailed ? <button type="button" className="secondary" onClick={() => { forgetWorkspaceResume(); setWorkspacePath(""); setResumeEnabledForSession(false); setState("idle"); setMessage("已清除自动恢复记录。"); }}>清除恢复记录</button> : null}
            </div>
            <p className={`startup-message ${state === "error" ? "is-error" : ""}`}>{message}</p>
          </div>
          <details className="startup-advanced">
            <summary>工作区与连接</summary>
            <div className="startup-advanced-body">
              <label><span>工作区路径</span><input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} spellCheck={false} /></label>
              <button type="button" onClick={() => void openWorkspacePath(workspacePath)} disabled={state === "starting" || !workspacePath.trim()}>打开此路径</button>
              <label><span>本机服务地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} /></label>
              <button type="button" className="secondary" onClick={() => void connect()} disabled={state === "connecting"}>连接已运行服务</button>
            </div>
          </details>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell production-app-shell">
      <section className="workspace-shell application-frame">
        <aside className="global-sidebar">
          <ProjectLibrary
            baseUrl={snapshot.baseUrl}
            workspace={snapshot.workspace}
            selectedProjectId={selectedProject?.project_id ?? null}
            utilityActive={utilityActive}
            onSelectProject={selectProject}
            onOpenStatusCenter={() => setSurface("status")}
            onOpenTeam={() => setSurface("team")}
            onOpenSettings={() => setSurface("settings")}
            onWorkspaceChanged={refreshWorkspace}
          />

          <details className="workspace-control">
            <summary>
              <span className={`status-dot status-${state}`} />
              <span>{snapshot.workspace.workspace}</span>
              <small>{connectionLabel(state)}</small>
            </summary>
            <div className="workspace-control-body">
              <label><span>工作区</span><input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} spellCheck={false} /></label>
              <div className="workspace-control-actions">
                <button type="button" className="secondary" onClick={() => void chooseWorkspace(true)} disabled={!isTauri() || state === "starting"}>切换</button>
                <button type="button" className="secondary" onClick={() => void revealWorkspace()} disabled={!isTauri() || !workspacePath.trim()}>{platformInfo?.os === "windows" ? "Explorer" : platformInfo?.os === "macos" ? "Finder" : "文件管理器"}</button>
              </div>
              <details className="workspace-advanced">
                <summary>高级连接</summary>
                <label><span>服务地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} /></label>
                <button type="button" className="secondary" onClick={() => void connect()} disabled={state === "connecting"}>连接服务</button>
                {resumeEnabledForSession ? <button type="button" className="secondary" onClick={disableAutomaticResume}>下次不自动恢复</button> : null}
              </details>
            </div>
          </details>
        </aside>

        <section className="workbench-shell main-stage">
          {surface === "status" ? (
            <StatusCenterWorkbench baseUrl={snapshot.baseUrl} projects={snapshot.projects} onOpenProject={openProjectFromStatus} />
          ) : surface === "team" ? (
            <TeamWebWorkbench workspacePath={workspacePath} workspaceId={snapshot.workspace.workspace_id} projectId={selectedProject?.project_id ?? null} />
          ) : surface === "settings" ? (
            selectedProject ? <SettingsStatusWorkbench baseUrl={snapshot.baseUrl} projectId={selectedProject.project_id} /> : <div className="primary-empty"><strong>选择项目后配置制作环境</strong><p>模型、运行时和项目级设置跟随当前项目。</p></div>
          ) : selectedProject ? (
            <ProjectWorkbench key={selectedProject.project_id} baseUrl={snapshot.baseUrl} project={selectedProject} />
          ) : (
            <div className="primary-empty project-picker-placeholder">
              <p className="eyebrow">项目</p>
              <h2>选择一个项目开始</h2>
              <p>从左侧项目栏进入制作。第一次进入项目默认打开电子场记，之后恢复你上次离开的工作画布。</p>
            </div>
          )}
        </section>
      </section>
      <div className={`app-notice ${state === "error" ? "is-error" : ""}`} aria-live="polite">{message}</div>
    </main>
  );
}
