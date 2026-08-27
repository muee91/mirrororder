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
  const [message, setMessage] = useState("开启后，同一网络里的团队成员可以在浏览器看片并提交个人意见。");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workspacePath.trim()) return;
    setWorkspacePaths((current) => uniquePaths([...current, workspacePath]));
  }, [workspacePath]);

  async function refresh(quiet = false): Promise<void> {
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
        if (!next.healthy && !quiet) setMessage("团队审阅服务没有正常响应，可以直接重启。详细原因在高级连接设置中。 ");
      }
    } catch (error) {
      if (!quiet) setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    if (!isTauri()) return undefined;
    void refresh(false);
    const timer = globalThis.setInterval(() => { void refresh(true); }, 2000);
    return () => globalThis.clearInterval(timer);
    // Stable native client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);

  async function addWorkspaces(): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览不能选择本机工作区。");
      return;
    }
    try {
      const selected = await openDialog({ directory: true, multiple: true, title: "添加可供团队审阅的工作区" });
      const paths = typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected : [];
      if (paths.length) setWorkspacePaths((current) => uniquePaths([...current, ...paths]));
    } catch (error) {
      setMessage(`选择工作区失败：${errorMessage(error)}`);
    }
  }

  async function start(): Promise<void> {
    setBusy(true);
    setMessage(status?.running && !status.healthy ? "正在重新开启团队审阅…" : "正在开启团队审阅…");
    try {
      const result = await gateway.start({ workspacePaths, port: Number(port), access, security, pairingCode });
      setPairingCode(result.pairing_code);
      const next = await gateway.status();
      setStatus(next);
      setMessage(next.healthy ? "团队审阅已开启，可以复制链接给团队成员。" : "服务已启动，但还不能正常访问；请查看高级连接设置。 ");
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
      await refresh(true);
      setMessage("团队审阅已关闭，不影响本机制作工作。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const processRunning = Boolean(status?.running);
  const healthy = Boolean(status?.running && status.healthy);
  const shareUrl = healthy ? teamWorkbenchUrl(status!, workspaceId, projectId) : null;

  async function copyLink(): Promise<void> {
    if (!shareUrl) {
      setMessage(access === "lan" ? "当前没有可用的局域网分享地址。" : "团队审阅还没有准备好。 ");
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setMessage("协作链接已复制。团队成员首次打开时按当前安全模式完成配对。 ");
    } catch (error) {
      setMessage(`复制协作链接失败：${errorMessage(error)}`);
    }
  }

  async function openTeamWeb(): Promise<void> {
    if (!shareUrl) {
      setMessage("团队审阅还没有可打开的地址。");
      return;
    }
    try {
      await platform.openUrl(shareUrl);
      setMessage("已在默认浏览器打开团队审阅。 ");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  return (
    <section className="team-web-workbench team-review-workbench">
      <header className="team-web-heading">
        <div>
          <p className="eyebrow">团队协作</p>
          <h2>团队审阅</h2>
          <p>团队成员只看片并提交个人意见；最终 Best / Keep / Reject 仍由本机审阅决定。</p>
        </div>
        <div className="team-web-state">
          <span className={healthy ? "is-running" : "is-stopped"}>{healthy ? "可分享" : processRunning ? "需要处理" : "未开启"}</span>
          <button type="button" className="secondary" disabled={!isTauri() || busy} onClick={() => void refresh(false)}>刷新</button>
        </div>
      </header>

      <div className="team-review-primary-grid">
        <section className="team-web-panel team-share-panel">
          <p className="eyebrow">当前项目</p>
          <h3>{healthy ? "团队审阅已就绪" : "开启团队审阅"}</h3>
          <p className="production-note">{message}</p>
          {shareUrl ? <code className="team-share-url">{shareUrl}</code> : null}
          {healthy && security === "pairing" ? <div className="team-pairing-card"><span>首次配对码</span><strong>{status?.pairing_code || pairingCode || "—"}</strong></div> : null}
          <div className="team-web-actions">
            {!healthy ? <button type="button" disabled={busy || !isTauri() || workspacePaths.length === 0} onClick={() => void start()}>{processRunning ? "重新开启" : "开启团队审阅"}</button> : null}
            {healthy ? <button type="button" disabled={!shareUrl} onClick={() => void copyLink()}>复制链接</button> : null}
            {healthy ? <button type="button" className="secondary" disabled={!shareUrl || !isTauri()} onClick={() => void openTeamWeb()}>浏览器打开</button> : null}
            {processRunning ? <button type="button" className="secondary" disabled={busy} onClick={() => void stop()}>关闭</button> : null}
          </div>
        </section>

        <section className="team-web-panel team-review-boundary-card">
          <p className="eyebrow">权限边界</p>
          <h3>团队能做什么</h3>
          <ul>
            <li>查看当前共享工作区中的项目与素材卡。</li>
            <li>提交自己的 Best / Keep / Reject 个人意见。</li>
            <li>不能改剧本归集、场记、最终剪辑决定或交付文件。</li>
          </ul>
        </section>
      </div>

      <details className="team-advanced-settings">
        <summary>高级连接设置</summary>
        <div className="team-web-grid">
          <section className="team-web-panel">
            <div className="team-web-panel-heading">
              <div><p className="eyebrow">共享范围</p><h3>工作区</h3></div>
              <button type="button" className="secondary" disabled={processRunning || !isTauri()} onClick={() => void addWorkspaces()}>添加工作区</button>
            </div>
            <div className="team-workspace-list">
              {workspacePaths.length ? workspacePaths.map((path) => (
                <div className="team-workspace-row" key={path}>
                  <code>{path}</code>
                  <button type="button" className="secondary" disabled={processRunning || workspacePaths.length <= 1} onClick={() => setWorkspacePaths((current) => current.filter((value) => value !== path))}>移除</button>
                </div>
              )) : <p className="empty-copy">尚未选择共享工作区。</p>}
            </div>
          </section>

          <section className="team-web-panel">
            <p className="eyebrow">连接</p>
            <h3>网络与安全</h3>
            <div className="team-web-options">
              <label><span>端口</span><input value={port} disabled={processRunning} inputMode="numeric" onChange={(event) => setPort(event.target.value)} /></label>
              <label><span>访问范围</span><select value={access} disabled={processRunning} onChange={(event) => setAccess(event.target.value as TeamGatewayAccess)}><option value="lan">局域网</option><option value="local">仅本机</option></select></label>
              <label><span>安全模式</span><select value={security} disabled={processRunning} onChange={(event) => setSecurity(event.target.value as TeamGatewaySecurity)}><option value="pairing">首次配对</option><option value="trusted">可信局域网免配对</option></select></label>
              {security === "pairing" ? <label><span>自定义配对码</span><input value={pairingCode} disabled={processRunning} onChange={(event) => setPairingCode(event.target.value.replace(/\s+/g, "").slice(0, 80))} placeholder="留空则自动生成" /></label> : null}
            </div>
          </section>

          <section className="team-web-panel">
            <p className="eyebrow">诊断</p>
            <h3>服务状态</h3>
            <dl className="team-web-facts">
              <div><dt>进程</dt><dd>{processRunning ? `运行中 · pid ${status?.pid ?? "-"}` : "未运行"}</dd></div>
              <div><dt>健康检查</dt><dd>{healthy ? "正常" : status?.health_error || "—"}</dd></div>
              <div><dt>本机地址</dt><dd>{status?.base_url || "—"}</dd></div>
              <div><dt>局域网地址</dt><dd>{status?.lan_url || (status?.local_only ? "仅本机模式" : "尚未验证")}</dd></div>
              <div><dt>工作区</dt><dd>{workspaceId || "未定位"}</dd></div>
              <div><dt>项目</dt><dd>{projectId || "未定位"}</dd></div>
            </dl>
          </section>
        </div>
      </details>

      {!isTauri() ? <p className="production-warning">浏览器预览只能查看界面；实际团队审阅需要从桌面 App 开启。</p> : null}
    </section>
  );
}
