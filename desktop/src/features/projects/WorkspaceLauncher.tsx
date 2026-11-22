import { useId } from "react";
import type { HostConnectionState } from "../../api/host";
import logo from "../../assets/mirrororder-logo.svg";
import "./workspace-launcher.css";

interface Props {
  state: HostConnectionState;
  recovering: boolean;
  recoveryFailed: boolean;
  native: boolean;
  workspacePath: string;
  serviceAddress: string;
  message: string;
  recentWorkspaces?: readonly string[];
  onOpenRecent?: (path: string) => void;
  onWorkspacePathChange: (path: string) => void;
  onServiceAddressChange: (address: string) => void;
  onChooseWorkspace: (directory: boolean) => void;
  onOpenDefaultLibrary?: () => void;
  onOpenPath: () => void;
  onConnect: () => void;
  onClearRecovery: () => void;
}

export function WorkspaceLauncher({
  state, recovering, recoveryFailed, native, workspacePath, serviceAddress, message,
  recentWorkspaces = [], onOpenRecent,
  onWorkspacePathChange, onServiceAddressChange, onChooseWorkspace, onOpenDefaultLibrary, onOpenPath, onConnect, onClearRecovery,
}: Props) {
  const titleId = useId();
  const busy = state === "starting" || state === "connecting";
  const failed = state === "error";
  const title = recovering ? "恢复项目库" : recoveryFailed ? "重新定位项目库" : "镜序项目库";
  const description = recovering
    ? "正在恢复上次打开的项目库…"
    : recoveryFailed
      ? "未找到原项目库文件夹，可重新定位或直接进入本机项目库。"
      : "使用本机项目库管理全部短剧工程，或打开硬盘上已有的项目库文件夹。";
  const hasFeedback = Boolean(message.trim());
  const showsPath = Boolean(workspacePath.trim()) && (recovering || recoveryFailed);
  const displayWorkspacePath = workspacePath.replace(/[\\/]workspace\.toml$/i, "") || workspacePath;

  return (
    <main className="startup-shell">
      <header className="startup-masthead" data-tauri-drag-region="deep">
        <div className="startup-brand">
          <img className="startup-logo" src={logo} alt="" />
          <strong>镜序</strong>
        </div>
      </header>

      <div className="startup-scroll">
        <section className="startup-home" aria-labelledby={titleId}>
          <div className="startup-entry">
            <div className="startup-primary">
              <h1 id={titleId}>{title}</h1>
              <p>{description}</p>
              <div className="startup-primary-actions">
                {recoveryFailed ? (
                  <>
                    <button className="startup-choose" type="button" disabled={!native || busy}
                      onClick={() => onChooseWorkspace(true)}>
                      重新定位项目库…
                    </button>
                    {onOpenDefaultLibrary ? (
                      <button type="button" className="secondary" disabled={!native || busy} onClick={onOpenDefaultLibrary}>进入本机项目库</button>
                    ) : null}
                  </>
                ) : onOpenDefaultLibrary ? (
                  <>
                    <button className="startup-choose" type="button" disabled={!native || busy} onClick={onOpenDefaultLibrary}>进入本机项目库</button>
                    <button type="button" className="secondary" disabled={!native || busy} onClick={() => onChooseWorkspace(true)}>打开其他项目库…</button>
                  </>
                ) : (
                  <button className="startup-choose" type="button" disabled={!native || busy}
                    onClick={() => onChooseWorkspace(true)}>
                    打开项目库文件夹…
                  </button>
                )}
              </div>
            </div>

          </div>

          {onOpenRecent && recentWorkspaces.length > 0 && (
            <section className="startup-recent" aria-label="最近打开的项目库">
              <h2>最近打开</h2>
              <ul>
                {recentWorkspaces.slice(0, 4).map(path => {
                  const pieces = path.split(/[\\/]/).filter(Boolean);
                  const label = pieces.at(-1)?.toLowerCase() === "workspace.toml" ? pieces.at(-2) : pieces.at(-1);
                  const unavailable = recoveryFailed && path === workspacePath;
                  return <li key={path}>
                    <button type="button" className="secondary" disabled={!native || busy} title={path}
                      onClick={() => onOpenRecent(path)}>{label || path}{unavailable ? "（暂不可用）" : ""}</button>
                  </li>;
                })}
              </ul>
            </section>
          )}

          {(hasFeedback || showsPath) && (
            <div className="startup-feedback" data-failed={failed || undefined} role={failed ? "alert" : "status"}>
              {hasFeedback && <p>{message}</p>}
              {showsPath && <p className="startup-location">
                <span>{recovering ? "正在恢复" : "上次位置"}</span>
                <code title={workspacePath}>{displayWorkspacePath}</code>
              </p>}
              {recoveryFailed && <button type="button" className="secondary" onClick={onClearRecovery}>清除恢复记录</button>}
            </div>
          )}

          <details className="startup-advanced">
            <summary>手动打开与连接</summary>
            <div className="startup-advanced-body">
              <div className="startup-file">
                <button type="button" className="secondary" disabled={!native || busy}
                  onClick={() => onChooseWorkspace(false)}>选择项目库配置文件…</button>
              </div>
              <form onSubmit={(event) => {
                event.preventDefault();
                if (native && !busy && workspacePath.trim()) onOpenPath();
              }}>
                <label>
                  <span>项目库路径</span>
                  <input value={workspacePath} onChange={(event) => onWorkspacePathChange(event.target.value)}
                    placeholder="输入项目库文件夹路径" spellCheck={false} autoComplete="off" />
                </label>
                <button type="submit" className="secondary" disabled={!native || busy || !workspacePath.trim()}>打开路径</button>
              </form>
              <form onSubmit={(event) => {
                event.preventDefault();
                if (!busy && serviceAddress.trim()) onConnect();
              }}>
                <label>
                  <span>本机服务地址</span>
                  <input value={serviceAddress} onChange={(event) => onServiceAddressChange(event.target.value)}
                    inputMode="url" spellCheck={false} autoComplete="off" />
                </label>
                <button type="submit" className="secondary" disabled={busy || !serviceAddress.trim()}>连接已运行服务</button>
              </form>
            </div>
          </details>
        </section>
      </div>
    </main>
  );
}
