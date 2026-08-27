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

type AppWorkspace = "production" | "team";

export function App() {
  const [launchResume] = useState(() => loadAppResume());
  const [appWorkspace, setAppWorkspace] = useState<AppWorkspace>("production");
  const [baseUrl, setBaseUrl] = useState(defaultHostBaseUrl);
  const [workspacePath, setWorkspacePath] = useState(launchResume.workspacePath);
  const [state, setState] = useState<HostConnectionState>(launchResume.workspacePath ? "starting" : "idle");
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [statusCenterOpen, setStatusCenterOpen] = useState(false);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState(launchResume.workspacePath ? "正在恢复上次工作现场…" : "打开一个工作区开始制作。");
  const resumeAttemptedRef = useRef(false);

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
    if (!isTauri() || !launchResume.workspacePath || resumeAttemptedRef.current) return;
    resumeAttemptedRef.current = true;
    let cancelled = false;
    const resumeConnection = new HostConnection(defaultHostBaseUrl);
    setState("starting");
    setMessage("正在恢复上次工作现场…");
    void resumeConnection.startAndConnect(launchResume.workspacePath).then((next) => {
      if (cancelled) return;
      const project = projectById(next, launchResume.projectId);
      setBaseUrl(next.baseUrl);
      setSnapshot(next);
      setSelectedProject(project);
      setStatusCenterOpen(false);
      setState("connected");
      rememberWorkspace(launchResume.workspacePath);
      if (project) rememberProject(project.project_id);
      setMessage(project
        ? `已恢复 ${project.name || project.project_id}`
        : `工作区已就绪 · ${next.projects.length} 个项目 · 请选择项目继续`);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setSnapshot(null);
      setSelectedProject(null);
      setStatusCenterOpen(false);
      setState("error");
      setMessage(`无法恢复上次工作区：${errorMessage(error)}`);
    });
    return () => { cancelled = true; };
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
    const remembered = loadAppResume();
    const preferredProjectId = remembered.workspacePath === normalizedPath ? remembered.projectId : "";
    setWorkspacePath(normalizedPath);
    setState("starting");
    setMessage("正在打开工作区…");
    try {
      const next = await connection.startAndConnect(normalizedPath);
      const project = projectById(next, preferredProjectId);
      setBaseUrl(next.baseUrl);
      setSnapshot(next);
      setSelectedProject(project);
      setStatusCenterOpen(false);
      setState("connected");
      rememberWorkspace(normalizedPath);
      if (project) rememberProject(project.project_id);
      setMessage(project
        ? `已恢复 ${project.name || project.project_id}`
        : `工作区已就绪 · ${next.projects.length} 个项目 · 请选择项目继续`);
    } catch (error) {
      setSnapshot(null);
      setSelectedProject(null);
      setStatusCenterOpen(false);
      setState("error");
      setMessage(errorMessage(error));
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
    if (!workspacePath.trim()) {
      setMessage("先选择工作区。");
      return;
    }
    try {
      await platform.reveal(workspacePath);
      setMessage(`${platformInfo?.os === "windows" ? "Explorer" : platformInfo?.os === "macos" ? "Finder" : "文件管理器"} 已定位当前工作区。`);
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
      const remembered = loadAppResume();
      const currentProject = selectedProject ? projectById(next, selectedProject.project_id) : null;
      const project = currentProject ?? projectById(next, remembered.projectId);
      setSnapshot(next);
      setSelectedProject(project);
      setStatusCenterOpen(false);
      setState("connected");
      if (workspacePath.trim()) rememberWorkspace(workspacePath);
      if (project) rememberProject(project.project_id);
      setMessage(project
        ? `已连接 · ${project.name || project.project_id}`
        : `工作区已就绪 · ${next.projects.length} 个项目 · 请选择项目继续`);
    } catch (error) {
      setSnapshot(null);
      setSelectedProject(null);
      setStatusCenterOpen(false);
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
    if (project) rememberProject(project.project_id);
    setState("connected");
    setMessage(project
      ? `项目库已刷新 · ${project.name || project.project_id}`
      : `项目库已刷新 · ${next.projects.length} 个项目`);
  }

  function selectProject(project: ProjectSummary): void {
    setSelectedProject(project);
    setStatusCenterOpen(false);
    rememberProject(project.project_id);
    setMessage(`已打开 ${project.name || project.project_id}`);
  }

  function openProjectFromStatus(projectId: string): void {
    const project = snapshot?.projects.find((item) => item.project_id === projectId) ?? null;
    if (!project) return;
    setSelectedProject(project);
    setStatusCenterOpen(false);
    rememberProject(project.project_id);
    setMessage(`已打开 ${project.name || project.project_id}`);
  }

  function disableAutomaticResume(): void {
    forgetWorkspaceResume();
    setMessage("已关闭自动恢复；当前工作区仍保持打开。下次启动将停在“打开工作区”。");
  }

  const recovering = state === "starting" && Boolean(launchResume.workspacePath) && !snapshot;
  const recoveryFailed = state === "error" && Boolean(workspacePath.trim()) && !snapshot;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">镜序 · MirrorOrder</p>
          <h1>制作台</h1>
        </div>
        <div className="topbar-actions">
          <div className="app-workspace-switch" aria-label="工作空间">
            <button type="button" className={appWorkspace === "production" ? "is-active" : ""} onClick={() => setAppWorkspace("production")}>制作</button>
            <button type="button" className={appWorkspace === "team" ? "is-active" : ""} onClick={() => setAppWorkspace("team")}>团队协作</button>
          </div>
          <div className={`status-badge status-${state}`}>
            <span className="status-dot" />
            {connectionLabel(state)}{platformInfo ? ` · ${platformInfo.os === "macos" ? "macOS" : platformInfo.os === "windows" ? "Windows" : platformInfo.os}` : ""}
          </div>
        </div>
      </header>

      {appWorkspace === "team" ? (
        <section className="standalone-workspace-shell">
          <TeamWebWorkbench
            workspacePath={workspacePath}
            workspaceId={snapshot?.workspace.workspace_id ?? null}
            projectId={selectedProject?.project_id ?? null}
          />
        </section>
      ) : snapshot ? (
        <>
          <section className="workspace-session-bar">
            <div className="workspace-session-summary">
              <p className="eyebrow">当前工作区</p>
              <strong>{snapshot.workspace.workspace}</strong>
              <span>{selectedProject ? selectedProject.name || selectedProject.project_id : `${snapshot.projects.length} 个项目 · 请选择项目`}</span>
            </div>
            <details className="workspace-session-tools">
              <summary>工作区</summary>
              <div className="workspace-session-tools-body">
                <label className="workspace-field">
                  <span>本机工作区</span>
                  <input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} spellCheck={false} />
                </label>
                <div className="connection-actions workspace-picker-actions">
                  <button type="button" className="secondary" onClick={() => void chooseWorkspace(true)} disabled={!isTauri() || state === "starting"}>切换工作区</button>
                  <button type="button" className="secondary" onClick={() => void chooseWorkspace(false)} disabled={!isTauri() || state === "starting"}>打开工作区文件</button>
                  <button type="button" onClick={() => void openWorkspacePath(workspacePath)} disabled={state === "starting" || !workspacePath.trim()}>打开此路径</button>
                  <button type="button" className="secondary" onClick={() => void revealWorkspace()} disabled={!isTauri() || !workspacePath.trim()}>
                    {platformInfo?.os === "windows" ? "在 Explorer 显示" : platformInfo?.os === "macos" ? "在 Finder 显示" : "在文件管理器显示"}
                  </button>
                </div>
                <details className="advanced-connection-options">
                  <summary>高级连接</summary>
                  <label><span>本机服务地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} /></label>
                  <div className="connection-actions">
                    <button type="button" className="secondary" onClick={() => void connect()} disabled={state === "connecting"}>连接已运行服务</button>
                    <button type="button" className="secondary" onClick={disableAutomaticResume}>下次不自动打开</button>
                  </div>
                </details>
              </div>
            </details>
          </section>
          <p className={`connection-message ${state === "error" ? "is-error" : ""}`}>{message}</p>
          <section className="workspace-shell">
            <ProjectLibrary
              baseUrl={snapshot.baseUrl}
              workspace={snapshot.workspace}
              selectedProjectId={selectedProject?.project_id ?? null}
              statusCenterActive={statusCenterOpen}
              onSelectProject={selectProject}
              onOpenStatusCenter={() => setStatusCenterOpen(true)}
              onWorkspaceChanged={refreshWorkspace}
            />
            <section className="workbench-shell">
              {statusCenterOpen ? (
                <StatusCenterWorkbench baseUrl={snapshot.baseUrl} projects={snapshot.projects} onOpenProject={openProjectFromStatus} />
              ) : selectedProject ? (
                <ProjectWorkbench key={selectedProject.project_id} baseUrl={snapshot.baseUrl} project={selectedProject} />
              ) : (
                <div className="phase-placeholder project-picker-placeholder">
                  <p className="eyebrow">项目</p>
                  <strong>选择或创建一个项目</strong>
                  <p>已有项目会恢复到上次离开的制作页面；第一次进入项目从“素材 → 素材库”开始。</p>
                </div>
              )}
            </section>
          </section>
        </>
      ) : (
        <section className={`startup-home ${recoveryFailed ? "is-recovery" : ""}`}>
          <div className="startup-primary">
            <p className="eyebrow">{recovering ? "恢复工作现场" : recoveryFailed ? "工作区恢复" : "本机制作"}</p>
            <h2>{recovering ? "正在恢复上次工作现场" : recoveryFailed ? "重新定位上次工作区" : "打开工作区开始制作"}</h2>
            <p>{recovering
              ? "镜序正在启动本机 Host，并恢复上次项目与制作页面。"
              : recoveryFailed
                ? "上次工作区没有成功打开。重新定位它，或选择其他工作区；项目数据不会被改写。"
                : "正常使用只需要打开工作区。Host、服务地址与运行诊断保留在低频高级区域。"}</p>
            {workspacePath.trim() ? <code className="startup-path">{workspacePath}</code> : null}
            <div className="startup-actions">
              <button type="button" onClick={() => void chooseWorkspace(true)} disabled={!isTauri() || state === "starting"}>{recoveryFailed ? "重新定位工作区" : "打开工作区"}</button>
              <button type="button" className="secondary" onClick={() => void chooseWorkspace(false)} disabled={!isTauri() || state === "starting"}>打开工作区文件</button>
              {recoveryFailed ? <button type="button" className="secondary" onClick={() => { forgetWorkspaceResume(); setWorkspacePath(""); setState("idle"); setMessage("已清除自动恢复记录。选择工作区继续。"); }}>不再自动打开</button> : null}
            </div>
            <p className={`startup-message ${state === "error" ? "is-error" : ""}`}>{message}</p>
          </div>

          <details className="startup-advanced">
            <summary>工作区与连接</summary>
            <div className="startup-advanced-body">
              <label className="workspace-field">
                <span>工作区路径</span>
                <input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="选择项目工作区目录" spellCheck={false} />
              </label>
              <div className="connection-actions">
                <button type="button" onClick={() => void openWorkspacePath(workspacePath)} disabled={state === "starting" || !workspacePath.trim()}>打开此路径</button>
              </div>
              <label>
                <span>本机服务地址</span>
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
              </label>
              <div className="connection-actions">
                <button type="button" className="secondary" onClick={() => void connect()} disabled={state === "connecting"}>连接已运行服务</button>
              </div>
            </div>
          </details>
        </section>
      )}
    </main>
  );
}
