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

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [baseUrl, setBaseUrl] = useState(defaultHostBaseUrl);
  const [workspacePath, setWorkspacePath] = useState("");
  const [state, setState] = useState<HostConnectionState>("idle");
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState("连接已运行的 Host，或从本机 workspace 启动。 ");

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
      setMessage("浏览器预览不提供原生路径选择；可继续手动填写 Workspace 路径。");
      return;
    }
    try {
      const selected = await openDialog({
        directory,
        multiple: false,
        title: directory ? "选择 MirrorOrder Workspace 目录" : "选择 MirrorOrder Workspace 文件",
      });
      if (typeof selected === "string" && selected.trim()) {
        setWorkspacePath(selected);
        setMessage(`已选择 ${directory ? "Workspace 目录" : "Workspace 文件"}。`);
      }
    } catch (error) {
      setMessage(`原生路径选择失败：${errorMessage(error)}`);
    }
  }

  async function revealWorkspace(): Promise<void> {
    if (!workspacePath.trim()) {
      setMessage("先选择 Workspace 路径。");
      return;
    }
    try {
      await platform.reveal(workspacePath);
      setMessage(`${platformInfo?.os === "windows" ? "Explorer" : platformInfo?.os === "macos" ? "Finder" : "文件管理器"} 已定位 Workspace。`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function connect(): Promise<void> {
    if (!connection) {
      setState("error");
      setMessage("Host 地址无效。");
      return;
    }
    setState("connecting");
    setMessage("正在读取 Host 与 workspace…");
    try {
      const next = await connection.connect();
      setSnapshot(next);
      setSelectedProject((current) =>
        current ? next.projects.find((item) => item.project_id === current.project_id) ?? null : next.projects[0] ?? null,
      );
      setState("connected");
      setMessage(`已连接 ${next.ping.service} · API ${next.workspace.api_version}`);
    } catch (error) {
      setSnapshot(null);
      setSelectedProject(null);
      setState("error");
      setMessage(errorMessage(error));
    }
  }

  async function refreshWorkspace(preferredProjectId?: string): Promise<void> {
    if (!connection) throw new HostConnectionError("Host 地址无效");
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
    setMessage(`项目库已刷新 · ${next.projects.length} projects`);
  }

  async function startHost(): Promise<void> {
    if (!connection) {
      setState("error");
      setMessage("Host 地址无效。");
      return;
    }
    if (!workspacePath.trim()) {
      setState("error");
      setMessage("先选择或填写 Workspace 路径。");
      return;
    }
    setState("starting");
    setMessage("正在启动现有 Python Core Host…");
    try {
      const next = await connection.startAndConnect(workspacePath);
      setBaseUrl(next.baseUrl);
      setSnapshot(next);
      setSelectedProject(next.projects[0] ?? null);
      setState("connected");
      setMessage(`Host 已就绪 · ${next.workspace.workspace}`);
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
          <h1>Desktop v2</h1>
        </div>
        <div className={`status-badge status-${state}`}>
          <span className="status-dot" />
          {state}{platformInfo ? ` · ${platformInfo.os}` : ""}
        </div>
      </header>

      <section className="connection-panel">
        <label>
          <span>Host</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
        </label>
        <label className="workspace-field">
          <span>Workspace 路径</span>
          <input
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
            placeholder="选择目录 / workspace 文件，或手动填写"
            spellCheck={false}
          />
        </label>
        <div className="connection-actions workspace-picker-actions">
          <button type="button" className="secondary" onClick={() => void chooseWorkspace(true)} disabled={!isTauri()}>
            选择目录
          </button>
          <button type="button" className="secondary" onClick={() => void chooseWorkspace(false)} disabled={!isTauri()}>
            选择文件
          </button>
          <button type="button" className="secondary" onClick={() => void revealWorkspace()} disabled={!isTauri() || !workspacePath.trim()}>
            {platformInfo?.os === "windows" ? "在 Explorer 显示" : platformInfo?.os === "macos" ? "在 Finder 显示" : "在文件管理器显示"}
          </button>
        </div>
        <div className="connection-actions">
          <button type="button" className="secondary" onClick={() => void connect()} disabled={state === "connecting"}>
            连接 Host
          </button>
          <button type="button" onClick={() => void startHost()} disabled={state === "starting"}>
            启动并连接
          </button>
        </div>
      </section>

      <p className={`connection-message ${state === "error" ? "is-error" : ""}`}>{message}</p>
      {platformInfo ? (
        <p className="connection-message platform-capabilities">
          Phase 6 · native dialog ✓ · reveal ✓ · FCP adapter {platformInfo.fcp_adapter ? "available on macOS" : "n/a"} · security-scoped media {platformInfo.security_scoped_media ? "✓" : "pending native gate"} · Resolve/Premiere adapters extension-only
        </p>
      ) : null}

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
                <p>项目生命周期现在由 Desktop 调用现有 Python WorkspaceRegistry 管理。</p>
              </div>
            )}
          </section>
        </section>
      ) : (
        <section className="offline-state">
          <p className="eyebrow">Phase 1 / Phase 6</p>
          <h2>等待 HostConnection</h2>
          <p>HostConnection 负责 Python Core 生命周期；原生路径选择和 Finder/Explorer 能力由跨平台 Tauri adapter 提供，业务权威仍在 Python Core。</p>
        </section>
      )}
    </main>
  );
}
