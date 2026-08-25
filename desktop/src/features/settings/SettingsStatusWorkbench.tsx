import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import parity from "../../../phase7-parity.json";
import { DesktopClient, type DesktopStatusPayload, type FrontendSettings } from "../../api/desktop";
import { HostConnection, HostConnectionError, type HostProcessStatus } from "../../api/host";
import { PlatformClient, type PlatformInfo } from "../../api/platform";
import { TimelineClient, type TimelineRuntimeStatus } from "../../api/timeline";
import { CollaborationPanel } from "./CollaborationPanel";
import { LocalRuntimePanel } from "./LocalRuntimePanel";
import { TaskStatusPanel } from "./TaskStatusPanel";

interface Props { baseUrl: string; projectId: string }

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
function yesNo(value: boolean): string { return value ? "ready" : "missing"; }
function pollInterval(value: string): FrontendSettings["poll_interval_ms"] {
  const parsed = Number(value);
  return parsed === 1000 || parsed === 5000 || parsed === 10000 ? parsed : 2500;
}
function defaultEpisode(value: string): FrontendSettings["default_episode"] {
  if (value === "first" || value === "all") return value;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 9999 ? parsed : "first";
}

export function SettingsStatusWorkbench({ baseUrl, projectId }: Props) {
  const desktop = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const timeline = useMemo(() => new TimelineClient(), []);
  const [status, setStatus] = useState<DesktopStatusPayload | null>(null);
  const [settings, setSettings] = useState<FrontendSettings | null>(null);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [hostProcess, setHostProcess] = useState<HostProcessStatus | null>(null);
  const [timelineStatus, setTimelineStatus] = useState<TimelineRuntimeStatus | null>(null);
  const [timelineNote, setTimelineNote] = useState("未读取");
  const [message, setMessage] = useState("正在读取 Desktop 诊断…");
  const [busy, setBusy] = useState(false);

  function patchSettings(patch: Partial<FrontendSettings>): void {
    setSettings((current) => current ? { ...current, ...patch } : current);
  }

  async function reload(): Promise<void> {
    setBusy(true);
    setMessage("正在读取 Desktop 诊断…");
    try {
      const [next, nextSettings] = await Promise.all([desktop.status(), desktop.frontendSettings()]);
      setStatus(next);
      setSettings(nextSettings);
      if (isTauri()) {
        const [nextPlatform, nextHost] = await Promise.all([platform.info(), host.managedStatus().catch(() => null)]);
        setPlatformInfo(nextPlatform);
        setHostProcess(nextHost);
        try {
          const nextTimeline = await timeline.persistenceStatus();
          if (nextTimeline.project_id === projectId) {
            setTimelineStatus(nextTimeline);
            setTimelineNote(`generation ${nextTimeline.persistence.generation || "-"} · checkpoint #${nextTimeline.persistence.checkpoint_sequence}`);
          } else {
            setTimelineStatus(null);
            setTimelineNote(`当前 Rust Timeline 属于 ${nextTimeline.project_id}`);
          }
        } catch {
          setTimelineStatus(null);
          setTimelineNote("当前项目尚未加载 Rust Timeline；打开“剪辑”后会建立/恢复持久化状态。");
        }
      }
      setMessage(`desktop_status.v1 · ${next.environment.platform} · Python ${next.environment.python.version}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally { setBusy(false); }
  }

  useEffect(() => { void reload(); }, [desktop, projectId]);

  async function saveSettings(): Promise<void> {
    if (!settings) return;
    setBusy(true);
    setMessage("正在保存 Python Core frontend settings…");
    try {
      const saved = await desktop.saveFrontendSettings(settings);
      setSettings(saved);
      setMessage("Frontend settings 已保存到当前 workspace；没有创建 Desktop 专用业务配置副本。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally { setBusy(false); }
  }

  const requiredModules = status?.environment.python_modules.filter((item) => item.required) ?? [];
  const optionalModules = status?.environment.python_modules.filter((item) => !item.required) ?? [];
  const parityGates = Object.entries(parity.gates);
  const nativeGateCount = Object.values(parity.release_gates).filter((value) => value === "required").length;

  return (
    <section className="phase3-workbench settings-status-workbench">
      <header className="production-heading">
        <div><p className="eyebrow">Phase 7 · Desktop Primary Readiness</p><h2>设置 / 状态</h2></div>
        <div className="assistant-heading-actions"><span className="production-state">{message}</span><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>重新诊断</button></div>
      </header>

      <div className="production-grid settings-status-grid">
        <div className="production-panel status-card frontend-settings-card">
          <div className="parse-heading"><div><p className="eyebrow">Existing Python Frontend Settings</p><h3>工作区界面偏好</h3></div><button type="button" disabled={busy || !settings} onClick={() => void saveSettings()}>保存</button></div>
          {settings ? (
            <div className="settings-form-grid">
              <label className="production-field"><span>主题</span><select value={settings.theme} onChange={(event) => patchSettings({ theme: event.target.value as FrontendSettings["theme"] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
              <label className="production-field"><span>密度</span><select value={settings.density} onChange={(event) => patchSettings({ density: event.target.value as FrontendSettings["density"] })}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label>
              <label className="production-field"><span>默认工作台</span><select value={settings.default_mode} onChange={(event) => patchSettings({ default_mode: event.target.value as FrontendSettings["default_mode"] })}><option value="script">剧本</option><option value="unassigned">待归集</option></select></label>
              <label className="production-field"><span>默认集数</span><input value={String(settings.default_episode)} onChange={(event) => patchSettings({ default_episode: defaultEpisode(event.target.value) })} placeholder="first / all / 1" /></label>
              <label className="production-field"><span>刷新间隔</span><select value={settings.poll_interval_ms} onChange={(event) => patchSettings({ poll_interval_ms: pollInterval(event.target.value) })}><option value={1000}>1 秒</option><option value={2500}>2.5 秒</option><option value={5000}>5 秒</option><option value={10000}>10 秒</option></select></label>
              <label className="settings-check"><input type="checkbox" checked={settings.update_sound} onChange={(event) => patchSettings({ update_sound: event.target.checked })} /><span>更新提示音</span></label>
              <label className="settings-check"><input type="checkbox" checked={settings.show_unknown_count} onChange={(event) => patchSettings({ show_unknown_count: event.target.checked })} /><span>显示 unknown 数量</span></label>
            </div>
          ) : <p className="empty-copy">尚未读取 workspace frontend settings。</p>}
          <p className="production-note">这里直接读写现有 `/api/v1/settings`；Desktop v2 不另建一套 theme/density/default-mode 业务配置。</p>
        </div>

        <LocalRuntimePanel baseUrl={baseUrl} />
        <CollaborationPanel baseUrl={baseUrl} />
        <TaskStatusPanel baseUrl={baseUrl} projectId={projectId} />

        <div className="production-panel status-card phase7-gate-card">
          <div className="parse-heading"><div><p className="eyebrow">desktop_phase7_parity.v1</p><h3>{parity.desktop_primary_candidate ? "Desktop primary candidate" : "Parity incomplete"}</h3></div><span>{nativeGateCount} release gates</span></div>
          <div className="phase7-gate-list">{parityGates.map(([name, gate]) => <div className="phase7-gate-row" key={name}><strong>{name.replaceAll("_", " ")}</strong><span className={gate.code_status.startsWith("implemented") ? "is-ready" : "is-missing"}>{gate.code_status}</span><small>{gate.native_smoke_required ? "native smoke required" : "code gate"}</small></div>)}</div>
          <p className="production-warning">SwiftUI physical retirement: {parity.swiftui_retirement_allowed ? "allowed" : "BLOCKED until native release gates pass"}</p>
        </div>

        <div className="production-panel status-card">
          <p className="eyebrow">Python Core / Workspace</p><h3>{status?.workspace.name || "Workspace"}</h3>
          <dl className="status-facts"><div><dt>workspace</dt><dd>{status?.workspace.path || "-"}</dd></div><div><dt>projects</dt><dd>{status?.workspace.projects ?? "-"}</dd></div><div><dt>Python</dt><dd>{status ? `${status.environment.python.version} · ${status.environment.python.executable}` : "-"}</dd></div><div><dt>Host</dt><dd>{status ? `${status.environment.host} · ${status.environment.platform}` : "-"}</dd></div><div><dt>writable</dt><dd>{yesNo(Boolean(status?.environment.workspaces[0]?.writable))}</dd></div></dl>
        </div>

        <div className="production-panel status-card">
          <p className="eyebrow">Media / Analysis Runtime</p>
          <div className="status-capabilities">{(status?.environment.commands ?? []).map((item) => <span className={item.available ? "is-ready" : "is-missing"} key={item.name}>{item.name} · {yesNo(item.available)}</span>)}<span className={status?.environment.media_directory_sync_ready ? "is-ready" : "is-missing"}>media sync · {yesNo(Boolean(status?.environment.media_directory_sync_ready))}</span><span className={status?.environment.identity_runtime.face ? "is-ready" : "is-missing"}>face · {yesNo(Boolean(status?.environment.identity_runtime.face))}</span><span className={status?.environment.identity_runtime.speaker ? "is-ready" : "is-missing"}>speaker · {yesNo(Boolean(status?.environment.identity_runtime.speaker))}</span></div>
          <p className="production-note">Required Python modules: {requiredModules.map((item) => `${item.name}:${yesNo(item.available)}`).join(" · ") || "-"}</p><p className="production-note">Optional: {optionalModules.map((item) => `${item.name}:${yesNo(item.available)}`).join(" · ") || "-"}</p>
        </div>

        <div className="production-panel status-card">
          <p className="eyebrow">Native Platform Adapter</p>
          {isTauri() && platformInfo ? <div className="status-capabilities"><span className="is-ready">{platformInfo.os}</span><span className={platformInfo.native_dialog ? "is-ready" : "is-missing"}>dialog</span><span className={platformInfo.reveal_path ? "is-ready" : "is-missing"}>reveal</span><span className={platformInfo.open_path ? "is-ready" : "is-missing"}>open</span><span className={platformInfo.open_url ? "is-ready" : "is-missing"}>URL</span><span className={platformInfo.fcp_adapter ? "is-ready" : "is-missing"}>FCP adapter</span><span className={platformInfo.security_scoped_media ? "is-ready" : "is-pending"}>security scope</span><span className={platformInfo.resolve_adapter ? "is-ready" : "is-pending"}>Resolve extension</span><span className={platformInfo.premiere_adapter ? "is-ready" : "is-pending"}>Premiere extension</span></div> : <p className="empty-copy">浏览器预览不加载 Tauri native adapter。</p>}
          <p className="production-note">Host process: {hostProcess ? `${hostProcess.running ? "running" : "stopped"} · pid ${hostProcess.pid ?? "-"}` : "unmanaged / browser preview"}</p>
        </div>

        <div className="production-panel status-card">
          <p className="eyebrow">Rust Timeline Persistence v2</p><h3>{timelineStatus ? `${timelineStatus.persistence.journal_operations} journal ops` : "当前未挂载"}</h3><p className="production-note">{timelineNote}</p>
          {timelineStatus ? <dl className="status-facts"><div><dt>checkpoint</dt><dd>{timelineStatus.persistence.checkpoint_path}</dd></div><div><dt>journal</dt><dd>{timelineStatus.persistence.journal_path}</dd></div><div><dt>recovered</dt><dd>{timelineStatus.recovered_operations}</dd></div><div><dt>backup</dt><dd>{timelineStatus.used_backup ? "used" : "primary"}</dd></div><div><dt>partial tail</dt><dd>{timelineStatus.ignored_partial_tail ? "ignored safely" : "none"}</dd></div></dl> : null}
        </div>

        <div className="production-panel status-card">
          <p className="eyebrow">Device-local State</p><dl className="status-facts"><div><dt>device</dt><dd>{status?.device_media.device_name || "-"}</dd></div><div><dt>media binding</dt><dd>{status?.device_media.state_path || "-"}</dd></div><div><dt>multicam engine</dt><dd>{String(status?.environment.multicam_engine.available ?? false)}</dd></div><div><dt>engine origin</dt><dd>{String(status?.environment.multicam_engine.origin ?? "-")}</dd></div></dl><p className="production-note">模型连接的密钥仍保存在 Python device secret store；此状态页不读取或回显密钥。</p>
        </div>
      </div>
    </section>
  );
}
