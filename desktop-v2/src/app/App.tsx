import { useMemo, useState } from "react";
import {
  HostConnection,
  HostConnectionError,
  defaultHostBaseUrl,
  type HostConnectionState,
  type HostSnapshot,
  type ProjectSummary,
} from "../api/host";
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
  const [message, setMessage] = useState("连接已运行的 Host，或从本机 workspace 启动。 ");

  const connection = useMemo(() => {
    try {
      return new HostConnection(baseUrl);
    } catch {
      return null;
    }
  }, [baseUrl]);

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

  async function startHost(): Promise<void> {
    if (!connection) {
      setState("error");
      setMessage("Host 地址无效。");
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
          {state}
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
            placeholder="/path/to/workspace 或 workspace.toml"
            spellCheck={false}
          />
        </label>
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

      {snapshot ? (
        <section className="workspace-shell">
          <ProjectLibrary
            workspace={snapshot.workspace}
            selectedProjectId={selectedProject?.project_id ?? null}
            onSelectProject={setSelectedProject}
          />
          <section className="workbench-shell">
            {selectedProject ? (
              <>
                <div className="workbench-heading">
                  <div>
                    <p className="eyebrow">项目</p>
                    <h2>{selectedProject.name || selectedProject.project_id}</h2>
                  </div>
                  <code>{selectedProject.project_id}</code>
                </div>
                <nav className="workbench-tabs" aria-label="素材剧本工作台">
                  <button type="button" className="is-active">素材</button>
                  <button type="button">剧本</button>
                </nav>
                <div className="phase-placeholder">
                  <strong>Phase 1 shell ready</strong>
                  <p>项目已由 typed Host API 读取。素材/剧本业务视图将在 Phase 2 接现有 Python Core 数据，不在 React 中复制规则。</p>
                </div>
              </>
            ) : (
              <div className="phase-placeholder">
                <strong>选择一个项目</strong>
                <p>项目库来自 `/api/v1/workspace`。</p>
              </div>
            )}
          </section>
        </section>
      ) : (
        <section className="offline-state">
          <p className="eyebrow">Phase 1</p>
          <h2>等待 HostConnection</h2>
          <p>当前页面只负责 Host 生命周期与 typed localhost API 接入，不承载 Python 业务权威。</p>
        </section>
      )}
    </main>
  );
}
