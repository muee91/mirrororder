import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
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
import { TeamWebWorkbench } from "../features/team/TeamWebWorkbench";

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

type AppWorkspace = "production" | "team";

export function App() {
  const [appWorkspace, setAppWorkspace] = useState<AppWorkspace>("production");
  const [baseUrl, setBaseUrl] = useState(defaultHostBaseUrl);
  const [workspacePath, setWorkspacePath] = useState("");
  const [state, setState] = useState<HostConnectionState>("idle");
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState("选择一个本机工作区开始制作。");

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

  async function chooseWorkspace(directory: boolean): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览不能打开系统目录选择器；可在高级连接选项中手动填写路径。");
      return;
    }
    try {
      const selected = await openDialog({
        directory,
        multiple: false,
        title: directory ? "选择镜序工作区目录" : "选择镜序工作区文件",
      });
      if (typeof selected === "string" && selected.trim()) {
        setWorkspacePath(selected);
        setMessage("工作区已选择，点击“打开工作区”继续。");
      }
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
      setSnapshot(next);
      setSelectedProject((current) =>
        current ? next.projects.find((item) => item.project_id === current.project_id) ?? null : next.projects[0] ?? null,
      );
      setState("connected");
      setMessage(`工作区已就绪 · ${next.projects.length} 个项目`);
    } catch (error) {
      setSnapshot(null);
      setSelectedProject(null);
      setState("error");
      setMessage(errorMessage(error));
    }
  }

  async function refreshWorkspace(preferredProjectId?: string): Promise<void> {
    if (!connection) throw new HostConnectionError("本机服务地址无效");
    const next = await connection.connect();
    setSnapshot(next);
    setSelectedProject((current) => {
      if (preferredProjectId) {
        const preferred = next.projects.find((item) => item.project_id === preferredProjectId);
        if (preferred) return preferred;
      }
      if (current) {
        const existing = next.projects.find((item) => item.project_id === current.project_id);
        if (existing) return existing;
      }
      return next.projects[0] ?? null;
    });
    setState("connected");
    setMessage(`项目库已刷新 · ${next.projects.length} 个项目`);
  }

  async function startHost(): Promise<void> {
    if (!connection) {
      setState("error");
      setMessage("本机服务地址无效。");
      return;
    }
    if (!workspacePath.trim()) {
      setState("error");
      setMessage("先选择工作区目录或文件。");
      return;
    }
    setState("starting");
    setMessage("正在打开工作区…");
    try {
      const next = await connection.startAndConnect(workspacePath);
      setBaseUrl(next.baseUrl);
      setSnapshot(next);
      setSelectedProject(next.projects[0] ?? null);
      setState("connected");
      setMessage(`工作区已就绪 · ${next.projects.length} 个项目`);
    } catch (error) {
      setState("error");
      setMessage(errorMessage(error));
    }
  }

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
      ) : (
        <>
          <section className="connection-panel">
            <label className="workspace-field">
              <span>本机工作区</span>
              <input
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
                placeholder="选择项目工作区目录"
                spellCheck={false}
              />
            </label>
            <div className="connection-actions workspace-picker-actions">
              <button type="button" className="secondary" onClick={() => void chooseWorkspace(true)} disabled={!isTauri()}>
                选择目录
              </button>
              <button type="button" className="secondary" onClick={() => void chooseWorkspace(false)} disabled={!isTauri()}>
                选择工作区文件
              </button>
              <button type="button" onClick={() => void startHost()} disabled={state === "starting" || !workspacePath.trim()}>
                打开工作区
              </button>
              <button type="button" className="secondary" onClick={() => void revealWorkspace()} disabled={!isTauri() || !workspacePath.trim()}>
                {platformInfo?.os === "windows" ? "在 Explorer 显示" : platformInfo?.os === "macos" ? "在 Finder 显示" : "在文件管理器显示"}
              </button>
            </div>
            <details className="advanced-connection-options">
              <summary>高级连接选项</summary>
              <label>
                <span>本机服务地址</span>
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
              </label>
              <div className="connection-actions">
                <button type="button" className="secondary" onClick={() => void connect()} disabled={state === "connecting"}>
                  连接已运行服务
                </button>
              </div>
            </details>
          </section>

          <p className={`connection-message ${state === "error" ? "is-error" : ""}`}>{message}</p>

          {snapshot ? (
            <section className="workspace-shell">
              <ProjectLibrary
                baseUrl={snapshot.baseUrl}
                workspace={snapshot.workspace}
                selectedProjectId={selectedProject?.project_id ?? null}
                onSelectProject={setSelectedProject}
                onWorkspaceChanged={refreshWorkspace}
              />
              <section className="workbench-shell">
                {selectedProject ? (
                  <ProjectWorkbench key={selectedProject.project_id} baseUrl={snapshot.baseUrl} project={selectedProject} />
                ) : (
                  <div className="phase-placeholder">
                    <strong>选择或创建一个项目</strong>
                    <p>从左侧项目库进入素材、场记、人物、剪辑和交付工作流。</p>
                  </div>
                )}
              </section>
            </section>
          ) : (
            <section className="offline-state">
              <p className="eyebrow">本机制作</p>
              <h2>选择工作区开始</h2>
              <p>镜序会在本机读取项目与素材；连接和运行环境的详细信息集中在项目设置与状态页。</p>
            </section>
          )}
        </>
      )}
    </main>
  );
}
