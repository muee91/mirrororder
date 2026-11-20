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
  onWorkspacePathChange: (path: string) => void;
  onServiceAddressChange: (address: string) => void;
  onChooseWorkspace: (directory: boolean) => void;
  onOpenPath: () => void;
  onConnect: () => void;
  onClearRecovery: () => void;
}

export function WorkspaceLauncher({
  state, recovering, recoveryFailed, native, workspacePath, serviceAddress, message,
  onWorkspacePathChange, onServiceAddressChange, onChooseWorkspace, onOpenPath, onConnect, onClearRecovery,
}: Props) {
  const titleId = useId();
  const busy = state === "starting" || state === "connecting";
  const failed = state === "error";
  const title = recovering ? "恢复工作区" : recoveryFailed ? "重新定位工作区" : "打开工作区";
  const description = recovering
    ? "正在连接本机服务，准备恢复上次打开的项目。"
    : recoveryFailed
      ? "重新选择上次的工作区文件夹，也可以从工作区文件打开其他项目。"
      : "选择保存镜序项目、场记和同步任务的文件夹。";
  const hasFeedback = Boolean(message.trim());
  const showsPath = Boolean(workspacePath.trim()) && (recovering || recoveryFailed);

  return (
    <main className="startup-shell">
      <header className="startup-masthead">
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
              <button className="startup-choose" type="button" disabled={!native || busy}
                onClick={() => onChooseWorkspace(true)}>
                {recoveryFailed ? "重新选择文件夹…" : "选择工作区文件夹…"}
              </button>
            </div>

            <div className="startup-file">
              <h2>从工作区文件打开</h2>
              <p>如果已有 <code>workspace.toml</code>，可以直接选择此文件。</p>
              <button type="button" className="secondary" disabled={!native || busy}
                onClick={() => onChooseWorkspace(false)}>选择工作区文件…</button>
            </div>
          </div>

          {(hasFeedback || showsPath) && (
            <div className="startup-feedback" data-failed={failed || undefined} role={failed ? "alert" : "status"}>
              {hasFeedback && <p>{message}</p>}
              {showsPath && <p className="startup-location">
                <span>{recovering ? "正在恢复" : "上次位置"}</span>
                <code title={workspacePath}>{workspacePath}</code>
              </p>}
              {recoveryFailed && <button type="button" className="secondary" onClick={onClearRecovery}>清除恢复记录</button>}
            </div>
          )}

          <details className="startup-advanced">
            <summary>手动打开与连接</summary>
            <div className="startup-advanced-body">
              <form onSubmit={(event) => {
                event.preventDefault();
                if (native && !busy && workspacePath.trim()) onOpenPath();
              }}>
                <label>
                  <span>工作区路径</span>
                  <input value={workspacePath} onChange={(event) => onWorkspacePathChange(event.target.value)}
                    placeholder="文件夹或 workspace.toml" spellCheck={false} autoComplete="off" />
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
