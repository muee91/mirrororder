import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { HostConnectionError } from "../../api/host";
import { PlatformClient } from "../../api/platform";
import {
  TeamGatewayClient,
  teamWorkbenchUrl,
  type TeamGatewayAccess,
  type TeamGatewaySecurity,
  type TeamGatewayStatus,
} from "../../api/team";
import "./team.css";

interface Props {
  workspacePath: string;
  workspaceId?: string | null;
  projectId?: string | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function TeamWebWorkbench({ workspacePath, workspaceId, projectId }: Props) {
  const gateway = useMemo(() => new TeamGatewayClient(), []);
  const platform = useMemo(() => new PlatformClient(), []);
  const [workspacePaths, setWorkspacePaths] = useState<string[]>(() => uniquePaths([workspacePath]));
  const [status, setStatus] = useState<TeamGatewayStatus | null>(null);
  const [port, setPort] = useState("8766");
  const [access, setAccess] = useState<TeamGatewayAccess>("lan");
  const [security, setSecurity] = useState<TeamGatewaySecurity>("pairing");
  const [pairingCode, setPairingCode] = useState("");
  const [message, setMessage] = useState("Team Web Gateway 与 Production Host 独立运行。");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workspacePath.trim()) return;
    setWorkspacePaths((current) => uniquePaths([...current, workspacePath]));
  }, [workspacePath]);

  async function refresh(): Promise<void> {
    if (!isTauri()) return;
    try {
      const next = await gateway.status();
      setStatus(next);
      if (next.running) {
        if (next.port) setPort(String(next.port));
        setAccess(next.local_only ? "local" : "lan");
        setSecurity(next.trusted_lan ? "trusted" : "pairing");
        if (next.pairing_code) setPairingCode(next.pairing_code);
        if (next.workspace_paths.length) setWorkspacePaths(next.workspace_paths);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    void refresh();
    // Stable native client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);

  async function addWorkspaces(): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览不能选择本机 Workspace。");
      return;
    }
    try {
      const selected = await openDialog({
        directory: true,
        multiple: true,
        title: "添加到 Team Web Gateway 的 Workspace",
      });
      const paths = typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected : [];
      if (paths.length) setWorkspacePaths((current) => uniquePaths([...current, ...paths]));
    } catch (error) {
      setMessage(`选择 Workspace 失败：${errorMessage(error)}`);
    }
  }

  async function start(): Promise<void> {
    setBusy(true);
    setMessage("正在启动独立 Team Web Gateway…");
    try {
      const parsedPort = Number(port);
      const result = await gateway.start({
        workspacePaths,
        port: parsedPort,
        access,
        security,
        pairingCode,
      });
      setPairingCode(result.pairing_code);
      const next = await gateway.status();
      setStatus(next);
      setMessage(result.already_running ? "Team Web Gateway 已在运行。" : "Team Web Gateway 已启动。生产 Host 未受影响。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    setBusy(true);
    try {
      await gateway.stop();
      await refresh();
      setMessage("Team Web Gateway 已停止；Production Host 保持运行。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const shareUrl = status?.running
    ? teamWorkbenchUrl(status, workspaceId, projectId)
    : null;

  async function copyLink(): Promise<void> {
    if (!shareUrl) {
      setMessage(access === "lan" ? "当前没有可用 LAN 地址；未生成 localhost 伪协作链接。" : "Gateway 尚未启动。");
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setMessage("协作链接已复制。链接只定位 workspace/project；配对仍由 Gateway session 控制。");
    } catch (error) {
      setMessage(`复制协作链接失败：${errorMessage(error)}`);
    }
  }

  async function openTeamWeb(): Promise<void> {
    if (!shareUrl) {
      setMessage("当前没有可打开的 Team Web 地址。");
      return;
    }
    try {
      await platform.openUrl(shareUrl);
      setMessage("已交给系统默认浏览器打开 Team Web。");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  const running = Boolean(status?.running);

  return (
    <section className="team-web-workbench">
      <header className="team-web-heading">
        <div>
          <p className="eyebrow">Phase 7 · Isolated Collaboration Workspace</p>
          <h2>团队协作 / Team Web</h2>
          <p>只管理现有 Python Workspace Gateway。它不承载剪辑、分析、模型下载或 Review 权威。</p>
        </div>
        <div className="team-web-state">
          <span className={running ? "is-running" : "is-stopped"}>{running ? `running · pid ${status?.pid ?? "-"}` : "stopped"}</span>
          <button type="button" className="secondary" disabled={!isTauri() || busy} onClick={() => void refresh()}>刷新</button>
        </div>
      </header>

      <div className="team-web-grid">
        <section className="team-web-panel">
          <div className="team-web-panel-heading">
            <div>
              <p className="eyebrow">Gateway Scope</p>
              <h3>Workspace</h3>
            </div>
            <button type="button" className="secondary" disabled={running || !isTauri()} onClick={() => void addWorkspaces()}>添加 Workspace</button>
          </div>
          <div className="team-workspace-list">
            {workspacePaths.length ? workspacePaths.map((path) => (
              <div className="team-workspace-row" key={path}>
                <code>{path}</code>
                <button
                  type="button"
                  className="secondary"
                  disabled={running || workspacePaths.length <= 1}
                  onClick={() => setWorkspacePaths((current) => current.filter((value) => value !== path))}
                >移除</button>
              </div>
            )) : <p className="empty-copy">先在制作工作区选择 Workspace，或使用原生目录选择器添加。</p>}
          </div>
          <p className="production-note">多 Workspace 只属于 Team Web Gateway；Production Host 仍保持单 Workspace、127.0.0.1:8765。</p>
        </section>

        <section className="team-web-panel">
          <p className="eyebrow">Network Boundary</p>
          <h3>访问与安全</h3>
          <div className="team-web-options">
            <label>
              <span>端口</span>
              <input value={port} disabled={running} inputMode="numeric" onChange={(event) => setPort(event.target.value)} />
            </label>
            <label>
              <span>访问范围</span>
              <select value={access} disabled={running} onChange={(event) => setAccess(event.target.value as TeamGatewayAccess)}>
                <option value="lan">可信局域网</option>
                <option value="local">仅本机</option>
              </select>
            </label>
            <label>
              <span>安全模式</span>
              <select value={security} disabled={running} onChange={(event) => setSecurity(event.target.value as TeamGatewaySecurity)}>
                <option value="pairing">首次配对</option>
                <option value="trusted">可信 LAN 免配对</option>
              </select>
            </label>
            {security === "pairing" ? (
              <label>
                <span>Pairing code</span>
                <input
                  value={pairingCode}
                  disabled={running}
                  onChange={(event) => setPairingCode(event.target.value.replace(/\s+/g, "").slice(0, 80))}
                  placeholder="留空则安全随机生成"
                />
              </label>
            ) : null}
          </div>
          <div className="team-web-actions">
            <button type="button" disabled={running || busy || !isTauri() || workspacePaths.length === 0} onClick={() => void start()}>启动 Gateway</button>
            <button type="button" className="secondary" disabled={!running || busy} onClick={() => void stop()}>停止</button>
          </div>
        </section>

        <section className="team-web-panel team-share-panel">
          <p className="eyebrow">Current Project Link</p>
          <h3>团队审阅入口</h3>
          {running ? (
            <dl className="team-web-facts">
              <div><dt>local</dt><dd>{status?.base_url || "-"}</dd></div>
              <div><dt>LAN</dt><dd>{status?.lan_url || (status?.local_only ? "仅本机模式" : "未解析到局域网地址")}</dd></div>
              <div><dt>workspace</dt><dd>{workspaceId || "未定位"}</dd></div>
              <div><dt>project</dt><dd>{projectId || "未定位"}</dd></div>
              {status?.trusted_lan ? null : <div><dt>pairing</dt><dd>{status?.pairing_code || "由 Gateway 生成"}</dd></div>}
            </dl>
          ) : <p className="empty-copy">启动 Gateway 后才生成协作入口。</p>}
          {shareUrl ? <code className="team-share-url">{shareUrl}</code> : null}
          <div className="team-web-actions">
            <button type="button" disabled={!shareUrl} onClick={() => void copyLink()}>复制协作链接</button>
            <button type="button" className="secondary" disabled={!shareUrl || !isTauri()} onClick={() => void openTeamWeb()}>默认浏览器打开</button>
          </div>
        </section>
      </div>

      <p className="team-web-message">{message}</p>
      {!isTauri() ? <p className="production-warning">浏览器预览只展示布局；Gateway 生命周期必须由 Tauri native manager 执行。</p> : null}
    </section>
  );
}
