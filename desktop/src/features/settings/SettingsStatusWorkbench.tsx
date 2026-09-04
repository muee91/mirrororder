import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { DesktopClient, type DesktopStatusPayload, type FrontendSettings } from "../../api/desktop";
import { HostConnection, HostConnectionError, type HostProcessStatus } from "../../api/host";
import { PlatformClient, type PlatformInfo } from "../../api/platform";
import { AssistantModelsPanel } from "../assistant/AssistantModelsPanel";
import { CollaborationPanel } from "./CollaborationPanel";
import { DesktopAppearanceControl } from "./DesktopAppearanceControl";
import { LocalRuntimePanel } from "./LocalRuntimePanel";
import "./settings-preferences.css";

interface Props { baseUrl: string }
type EpisodeMode = "first" | "all" | "number";

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
function availabilityLabel(value: boolean): string { return value ? "可用" : "缺失"; }
function pollInterval(value: string): FrontendSettings["poll_interval_ms"] {
  const parsed = Number(value);
  return parsed === 1000 || parsed === 5000 || parsed === 10000 ? parsed : 2500;
}
function sameSettings(left: FrontendSettings | null, right: FrontendSettings | null): boolean {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}
function episodeMode(value: FrontendSettings["default_episode"]): EpisodeMode {
  return typeof value === "number" ? "number" : value;
}
function validEpisodeNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 9999 ? parsed : null;
}

export function SettingsStatusWorkbench({ baseUrl }: Props) {
  const desktop = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const [status, setStatus] = useState<DesktopStatusPayload | null>(null);
  const [settings, setSettings] = useState<FrontendSettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<FrontendSettings | null>(null);
  const [episodeInput, setEpisodeInput] = useState("1");
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [hostProcess, setHostProcess] = useState<HostProcessStatus | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  function patchSettings(patch: Partial<FrontendSettings>): void {
    if (saving) return;
    setSettings((current) => current ? { ...current, ...patch } : current);
  }

  function syncEpisodeInput(next: FrontendSettings): void {
    if (typeof next.default_episode === "number") setEpisodeInput(String(next.default_episode));
  }

  function changeEpisodeMode(mode: EpisodeMode): void {
    if (!settings || saving) return;
    if (mode === "number") {
      const nextEpisode = validEpisodeNumber(episodeInput) ?? (typeof settings.default_episode === "number" ? settings.default_episode : 1);
      setEpisodeInput(String(nextEpisode));
      patchSettings({ default_episode: nextEpisode });
      return;
    }
    patchSettings({ default_episode: mode });
  }

  function changeEpisodeNumber(value: string): void {
    setEpisodeInput(value);
    const nextEpisode = validEpisodeNumber(value);
    if (nextEpisode !== null) patchSettings({ default_episode: nextEpisode });
  }

  function restoreEpisodeNumber(): void {
    if (settings && typeof settings.default_episode === "number" && validEpisodeNumber(episodeInput) === null) {
      setEpisodeInput(String(settings.default_episode));
    }
  }

  async function readDeviceStatus(): Promise<void> {
    const next = await desktop.status();
    setStatus(next);
    if (isTauri()) {
      const [nextPlatform, nextHost] = await Promise.all([platform.info(), host.managedStatus().catch(() => null)]);
      setPlatformInfo(nextPlatform);
      setHostProcess(nextHost);
    }
  }

  async function loadInitial(): Promise<void> {
    setRefreshing(true);
    setError("");
    try {
      const [, nextSettings] = await Promise.all([readDeviceStatus(), desktop.frontendSettings()]);
      setSettings(nextSettings);
      setSavedSettings(nextSettings);
      syncEpisodeInput(nextSettings);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshStatus(): Promise<void> {
    if (refreshing || saving) return;
    setRefreshing(true);
    setError("");
    try {
      await readDeviceStatus();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => { void loadInitial(); }, [desktop, host, platform]);

  async function saveSettings(): Promise<void> {
    if (!settings || saving || sameSettings(settings, savedSettings)) return;
    setSaving(true);
    setError("");
    try {
      const saved = await desktop.saveFrontendSettings(settings);
      setSettings(saved);
      setSavedSettings(saved);
      syncEpisodeInput(saved);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }

  const settingsDirty = Boolean(settings && savedSettings && !sameSettings(settings, savedSettings));
  const requiredModules = status?.environment.python_modules.filter((item) => item.required) ?? [];
  const optionalModules = status?.environment.python_modules.filter((item) => !item.required) ?? [];

  return (
    <section className="phase3-workbench settings-status-workbench">
      <header className="production-heading settings-heading">
        <div><p className="eyebrow">MirrorOrder Desktop</p><h2>设置</h2></div>
        <div className="assistant-heading-actions">
          {error ? <span className="production-state is-error" role="alert">{error}</span> : null}
          <button
            type="button"
            className={`secondary settings-refresh-button ${refreshing ? "is-refreshing" : ""}`}
            disabled={refreshing || saving}
            aria-busy={refreshing}
            onClick={() => void refreshStatus()}
          >
            <span className="settings-refresh-icon" aria-hidden="true">↻</span>
            <span>刷新状态</span>
          </button>
        </div>
      </header>

      <p className="production-note settings-intro">这里管理当前设备的外观、本地 AI、小镜实际运行方式和团队审阅偏好。后台任务、下载进度与失败恢复统一在“状态中心”查看。</p>

      <div className="settings-preference-stack">
        <section className="settings-preference-section" aria-labelledby="settings-general-title">
          <header className="settings-section-heading">
            <div><p className="eyebrow">通用</p><h3 id="settings-general-title">Desktop</h3></div>
            <span>仅当前设备</span>
          </header>
          <div className="settings-preference-surface settings-general-card">
            <DesktopAppearanceControl />
          </div>
        </section>

        <section className="settings-preference-section" aria-labelledby="settings-local-title">
          <header className="settings-section-heading">
            <div><p className="eyebrow">本机智能</p><h3 id="settings-local-title">本地 AI 与身份识别</h3></div>
            <span>启用一次 · 当前设备自动恢复</span>
          </header>
          <LocalRuntimePanel baseUrl={baseUrl} />
        </section>

        <section className="settings-preference-section" aria-labelledby="settings-assistant-title">
          <header className="settings-section-heading">
            <div><p className="eyebrow">小镜</p><h3 id="settings-assistant-title">AI 能力</h3></div>
            <span>当前设备 · 与项目无关 · 显示实际路由 · 高级设置可覆盖</span>
          </header>
          <AssistantModelsPanel baseUrl={baseUrl} />
        </section>

        <section className="settings-preference-section" aria-labelledby="settings-team-title">
          <header className="settings-section-heading">
            <div><p className="eyebrow">团队审阅</p><h3 id="settings-team-title">Team Web</h3></div>
            <span>浏览器审阅界面与访问权限</span>
          </header>
          <div className="settings-team-grid">
            <div className="production-panel status-card frontend-settings-card">
              <div className="parse-heading"><div><h3>审阅界面</h3><p className="production-note">这些选项只控制 Team Web，不改变 Desktop 场记画布。</p></div><button type="button" disabled={saving || !settings || !settingsDirty} onClick={() => void saveSettings()}>{saving ? "保存中…" : "保存"}</button></div>
              {settings ? (
                <>
                  <div className="settings-form-grid">
                    <label className="production-field"><span>Web 外观</span><select value={settings.theme} disabled={saving} onChange={(event) => patchSettings({ theme: event.target.value as FrontendSettings["theme"] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
                    <label className="production-field"><span>界面密度</span><select value={settings.density} disabled={saving} onChange={(event) => patchSettings({ density: event.target.value as FrontendSettings["density"] })}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label>
                    <label className="production-field"><span>默认视图</span><select value={settings.default_mode} disabled={saving} onChange={(event) => patchSettings({ default_mode: event.target.value as FrontendSettings["default_mode"] })}><option value="script">剧本</option><option value="unassigned">待归集</option></select></label>
                    <label className="production-field"><span>默认集数</span><select value={episodeMode(settings.default_episode)} disabled={saving} onChange={(event) => changeEpisodeMode(event.target.value as EpisodeMode)}><option value="first">首集</option><option value="all">全部</option><option value="number">指定集数</option></select></label>
                    {typeof settings.default_episode === "number" ? <label className="production-field"><span>指定集数</span><input type="number" min={1} max={9999} inputMode="numeric" value={episodeInput} disabled={saving} onChange={(event) => changeEpisodeNumber(event.target.value)} onBlur={restoreEpisodeNumber} /></label> : null}
                    <label className="settings-check"><input type="checkbox" checked={settings.update_sound} disabled={saving} onChange={(event) => patchSettings({ update_sound: event.target.checked })} /><span>更新提示音</span></label>
                    <label className="settings-check"><input type="checkbox" checked={settings.show_unknown_count} disabled={saving} onChange={(event) => patchSettings({ show_unknown_count: event.target.checked })} /><span>显示未归类数量</span></label>
                  </div>
                  <details className="team-web-advanced">
                    <summary>高级</summary>
                    <label className="production-field"><span>自动刷新频率</span><select value={settings.poll_interval_ms} disabled={saving} onChange={(event) => patchSettings({ poll_interval_ms: pollInterval(event.target.value) })}><option value={1000}>1 秒</option><option value={2500}>2.5 秒</option><option value={5000}>5 秒</option><option value={10000}>10 秒</option></select></label>
                  </details>
                </>
              ) : <p className="empty-copy">尚未读取团队审阅偏好。</p>}
            </div>
            <CollaborationPanel baseUrl={baseUrl} />
          </div>
        </section>

        <details className="settings-advanced-diagnostics">
          <summary>
            <div><strong>高级诊断</strong><span>工作区、运行环境、平台适配与当前设备</span></div>
            <small>{status ? `${status.environment.platform} · Python ${status.environment.python.version}` : "尚未读取"}</small>
          </summary>
          <p className="production-note settings-diagnostics-note">这里用于排查安装和设备环境问题；任务进度与失败恢复仍以状态中心为准。</p>
          <div className="settings-diagnostics-grid">
            <div className="production-panel status-card">
              <p className="eyebrow">工作区 / Python</p><h3>{status?.workspace.name || "工作区"}</h3>
              <dl className="status-facts"><div><dt>路径</dt><dd>{status?.workspace.path || "-"}</dd></div><div><dt>项目</dt><dd>{status?.workspace.projects ?? "-"}</dd></div><div><dt>Python</dt><dd>{status ? `${status.environment.python.version} · ${status.environment.python.executable}` : "-"}</dd></div><div><dt>Host</dt><dd>{status ? `${status.environment.host} · ${status.environment.platform}` : "-"}</dd></div><div><dt>可写</dt><dd>{availabilityLabel(Boolean(status?.environment.workspaces[0]?.writable))}</dd></div></dl>
            </div>

            <div className="production-panel status-card">
              <p className="eyebrow">媒体 / 分析环境</p>
              <div className="status-capabilities">{(status?.environment.commands ?? []).map((item) => <span className={item.available ? "is-ready" : "is-missing"} key={item.name}>{item.name} · {availabilityLabel(item.available)}</span>)}<span className={status?.environment.media_directory_sync_ready ? "is-ready" : "is-missing"}>媒体同步 · {availabilityLabel(Boolean(status?.environment.media_directory_sync_ready))}</span><span className={status?.environment.identity_runtime.face ? "is-ready" : "is-missing"}>人脸 · {availabilityLabel(Boolean(status?.environment.identity_runtime.face))}</span><span className={status?.environment.identity_runtime.speaker ? "is-ready" : "is-missing"}>声纹 · {availabilityLabel(Boolean(status?.environment.identity_runtime.speaker))}</span></div>
              <p className="production-note">必需 Python 模块：{requiredModules.map((item) => `${item.name}:${availabilityLabel(item.available)}`).join(" · ") || "-"}</p><p className="production-note">可选模块：{optionalModules.map((item) => `${item.name}:${availabilityLabel(item.available)}`).join(" · ") || "-"}</p>
            </div>

            <div className="production-panel status-card">
              <p className="eyebrow">平台适配</p>
              {isTauri() && platformInfo ? <div className="status-capabilities"><span className="is-ready">{platformInfo.os}</span><span className={platformInfo.native_dialog ? "is-ready" : "is-missing"}>文件选择</span><span className={platformInfo.reveal_path ? "is-ready" : "is-missing"}>文件定位</span><span className={platformInfo.open_path ? "is-ready" : "is-missing"}>打开路径</span><span className={platformInfo.open_url ? "is-ready" : "is-missing"}>打开链接</span><span className={platformInfo.fcp_adapter ? "is-ready" : "is-missing"}>Final Cut</span><span className={platformInfo.security_scoped_media ? "is-ready" : "is-pending"}>安全媒体访问</span><span className={platformInfo.resolve_adapter ? "is-ready" : "is-pending"}>Resolve</span><span className={platformInfo.premiere_adapter ? "is-ready" : "is-pending"}>Premiere</span></div> : <p className="empty-copy">浏览器预览不加载原生平台适配。</p>}
              <p className="production-note">本机 Host：{hostProcess ? `${hostProcess.running ? "运行中" : "已停止"} · pid ${hostProcess.pid ?? "-"}` : "浏览器预览 / 未托管"}</p>
            </div>

            <div className="production-panel status-card">
              <p className="eyebrow">当前设备</p><dl className="status-facts"><div><dt>设备</dt><dd>{status?.device_media.device_name || "-"}</dd></div><div><dt>媒体绑定</dt><dd>{status?.device_media.state_path || "-"}</dd></div><div><dt>多机位引擎</dt><dd>{availabilityLabel(Boolean(status?.environment.multicam_engine.available))}</dd></div><div><dt>引擎来源</dt><dd>{String(status?.environment.multicam_engine.origin ?? "-")}</dd></div></dl><p className="production-note">模型连接密钥保存在设备 secret store；此页面不读取或回显密钥。</p>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
