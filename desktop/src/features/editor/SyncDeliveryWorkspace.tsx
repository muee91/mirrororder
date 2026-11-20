import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { SyncTimelineClient, syncDeliveryFileLabel, type MulticamSyncTimeline, type SyncDeliveryArtifacts } from "../../api/syncTimeline";
import { PlatformClient } from "../../api/platform";
import "./sync-delivery-workspace.css";

interface Props {
  baseUrl: string;
  syncTimeline: MulticamSyncTimeline;
  onInspect: () => void;
  onSyncTask: () => void;
  onRepair?: () => void;
  canGenerate?: boolean;
}

const TARGET_HELP: Record<string, string> = {
  davinci: "生成原片直连同步母版与待转换视频时间线；媒体池右键 Convert Timeline to Multicam Clip 后仍须核对原片层级与音轨。不会自动生成已验收的多机位剪辑工程",
  premiere: "导入 FCP7 XML 后核对原生多机位源序列",
  "final-cut": "FCPXML，须在目标 Final Cut Pro 版本检查机位切换",
  jianying: "国内剪映专业版 FCPXML 兼容路径，Windows/macOS 均需验收",
};

export function SyncDeliveryWorkspace({ baseUrl, syncTimeline, onInspect, onSyncTask, onRepair, canGenerate = true }: Props) {
  const [manifest, setManifest] = useState<SyncDeliveryArtifacts | null>(null);
  const [error, setError] = useState("");
  const [busyTarget, setBusyTarget] = useState("");
  const [lastRequest, setLastRequest] = useState(0);
  const platform = useMemo(() => new PlatformClient(), []);
  const client = useMemo(() => new SyncTimelineClient(baseUrl), [baseUrl]);

  useEffect(() => {
    if (!syncTimeline.ready) {
      setManifest(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = lastRequest > 0;
    let consecutiveErrors = 0;
    setError("");
    async function load() {
      try {
        const result = await client.readArtifacts(syncTimeline.project_id);
        if (cancelled) return;
        consecutiveErrors = 0;
        setError("");
        setManifest(result);
        polling = result.artifacts.some(item => item.task?.status === "queued" || item.task?.status === "running");
        if (polling) timer = setTimeout(() => void load(), 1200);
      } catch (reason) {
        if (cancelled) return;
        if (polling && ++consecutiveErrors <= 2) timer = setTimeout(() => void load(), 1200);
        else setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, syncTimeline.project_id, syncTimeline.ready, syncTimeline.task?.task_id, lastRequest]);

  async function createResolveDelivery() {
    if (!canGenerate) return;
    setBusyTarget("davinci");
    setError("");
    try {
      await client.createResolveDelivery(syncTimeline.project_id);
      setLastRequest(value => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyTarget("");
    }
  }

  async function revealArtifact(path: string, target: string) {
    if (!isTauri() || !path.trim()) return;
    setBusyTarget(target);
    setError("");
    try {
      await platform.reveal(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyTarget("");
    }
  }

  if (!syncTimeline.ready) {
    return <section className="sync-delivery-workspace" aria-label="同步工程交付">
      <div className="sync-delivery-empty">
        <h2>先完成同步</h2>
        <p>同步完成后会在这里列出本次生成的工程文件。</p>
        <button type="button" onClick={onSyncTask}>查看同步任务</button>
      </div>
    </section>;
  }

  const readyCount = manifest?.artifacts.filter((item) => item.available).length ?? 0;
  return (
    <section className="sync-delivery-workspace" aria-label="同步工程交付">
      <header className="sync-delivery-heading">
        <div><h2>同步工程交付</h2>
          <span>{syncTimeline.cameras.length} 个机位 · {syncTimeline.clip_count.toLocaleString()} 个视频片段
            {manifest ? ` · ${readyCount} / ${manifest.artifacts.length} 个文件可读取` : ""}</span></div>
        <button className="secondary" type="button" onClick={onInspect}>返回同步核对</button>
      </header>
      {syncTimeline.task?.task_id && <p className="sync-delivery-version">同步版本 <code>{manifest?.sync_version || syncTimeline.task.task_id}</code>
        {syncTimeline.timebase?.status === "confirmed" && ` · ${syncTimeline.timebase.numerator}/${syncTimeline.timebase.denominator} fps`}</p>}
      {error && <div className="sync-delivery-error" role="alert"><span>{error}</span>
        <button type="button" className="secondary" onClick={() => setLastRequest(value => value + 1)}>重新读取</button></div>}
      {manifest ? <ul className="sync-delivery-targets" aria-label="工程文件">
        {manifest.artifacts.map(item => {
          const running = item.task?.status === "queued" || item.task?.status === "running";
          return (
          <li className="sync-delivery-target" key={item.target}>
            <div className="sync-delivery-target-info">
              <strong>{item.label}</strong>
              <div><span>{item.format}</span><span title={item.filename}>{item.filename}</span></div>
              {item.details && <div><span>{item.details.audio_segments ? `${item.details.audio_segments} 段独立同期声` : "独立同期声待对齐"}</span></div>}
              {item.target === "davinci" && <p>{item.details?.conversion_instruction || TARGET_HELP.davinci}</p>}
              {item.details?.relocation_instruction && <p>{item.details.relocation_instruction}</p>}
              {item.details?.diagnostics?.map(diagnostic => <p key={diagnostic.code} role="status">{diagnostic.message}</p>)}
              {item.task?.error && !item.available && <p className="sync-delivery-error" role="alert">{item.task.error}</p>}
            </div>
            <span className="sync-delivery-file-state" data-missing={!item.available || undefined} aria-live="polite">
              {running ? item.task?.message : syncDeliveryFileLabel(item)}
            </span>
            {item.available ? <button type="button" className="secondary"
              disabled={!isTauri() || Boolean(busyTarget)}
              aria-label={`显示 ${item.label} 工程文件`}
              onClick={() => void revealArtifact(item.local_path, item.target)}>
              {busyTarget === item.target ? "打开中…" : "显示文件"}
            </button> : item.target === "davinci" && <button type="button" className="secondary"
              disabled={!canGenerate || !manifest.ready || !isTauri() || running || Boolean(busyTarget)} onClick={() => void createResolveDelivery()}>
              {running || busyTarget === item.target ? "生成中…" : item.task?.error ? "重试 Resolve 交付" : "在 Resolve 生成"}
            </button>}
            {item.unavailable_reason === "media_roots_unbound" && onRepair && <button type="button" className="secondary" onClick={onRepair}>检查本机目录</button>}
          </li>
          );
        })}
      </ul> : !error ? <p className="sync-delivery-loading" role="status">正在查找工程文件…</p> : null}
      <details className="sync-delivery-acceptance">
        <summary>交付核对事项</summary>
        <p>在剪辑软件导入后，检查画面机位、独立录音、重连路径和原生多机位切换。</p>
        {manifest && <ul>{manifest.artifacts.map(item => <li key={item.target}>
          <strong>{item.label}</strong> {TARGET_HELP[item.target] || "核对目标软件的导入结果"}
        </li>)}</ul>}
        {!isTauri() && <p>在桌面 App 中可显示本机文件。</p>}
      </details>
    </section>
  );
}
