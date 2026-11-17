import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { SyncTimelineClient, type MulticamSyncTimeline, type SyncDeliveryArtifacts } from "../../api/syncTimeline";
import { PlatformClient } from "../../api/platform";
import "./sync-delivery-workspace.css";

interface Props {
  baseUrl: string;
  syncTimeline: MulticamSyncTimeline;
  onInspect: () => void;
  onSyncTask: () => void;
}

const TARGET_HELP: Record<string, string> = {
  davinci: "可导入的工程文件；原生多机位结构仍需在 Resolve 内验证",
  premiere: "FCP7 XML，多轨可导入不代表已生成原生多机位源序列",
  "final-cut": "FCPXML，须在目标 Final Cut Pro 版本检查机位切换",
  jianying: "国内剪映专业版 FCPXML 兼容路径，Windows/macOS 均需验收",
};

export function SyncDeliveryWorkspace({ baseUrl, syncTimeline, onInspect, onSyncTask }: Props) {
  const [manifest, setManifest] = useState<SyncDeliveryArtifacts | null>(null);
  const [error, setError] = useState("");
  const [busyTarget, setBusyTarget] = useState("");
  const platform = useMemo(() => new PlatformClient(), []);

  useEffect(() => {
    if (!syncTimeline.ready) {
      setManifest(null);
      return;
    }
    let cancelled = false;
    setError("");
    setManifest(null);
    void new SyncTimelineClient(baseUrl).readArtifacts(syncTimeline.project_id).then((result) => {
      if (!cancelled) setManifest(result);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [baseUrl, syncTimeline.project_id, syncTimeline.ready]);

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
      <header><p>03 / 工程交付</p><h2>先完成同步，再交付工程</h2></header>
      <div className="sync-delivery-empty">
        <strong>尚无可信同步母版</strong>
        <p>生成的工程必须来自已完成的同步结果，不能把上次留下的 XML 当成这次的交付。</p>
        <button type="button" onClick={onSyncTask}>查看同步任务</button>
      </div>
    </section>;
  }

  const readyCount = manifest?.artifacts.filter((item) => item.available).length ?? 0;
  return (
    <section className="sync-delivery-workspace" aria-label="同步工程交付">
      <header className="sync-delivery-heading">
        <div><p>03 / 工程交付</p><h2>把同步母版交给剪辑师</h2>
          <span>读取同步引擎已生成的文件，不要求先完成场记、剧本或 AI 分析。</span></div>
        <button className="secondary" type="button" onClick={onInspect}>返回同步核对</button>
      </header>
      <div className="sync-delivery-summary">
        <div><span>同步轨道</span><strong>{syncTimeline.cameras.length} 个机位</strong></div>
        <div><span>视频片段</span><strong>{syncTimeline.clip_count} 条</strong></div>
        <div><span>文件状态</span><strong>{manifest ? `${readyCount} / ${manifest.artifacts.length} 可读取` : "检查中"}</strong></div>
      </div>
      <div className="sync-delivery-explainer">
        <strong>两种交付目标，分别验收</strong>
        <p><b>多轨同步母版</b>用于检查和修正原始素材；<b>原生多机位片段</b>用于剪辑师直接切机位。当前已生成文件不能自动证明目标软件保留了原生多机位结构，也不能证明独立 WAV 已完成对轨。</p>
      </div>
      {error ? <p className="sync-delivery-error" role="alert">读取工程文件失败：{error}</p> : null}
      <div className="sync-delivery-target-grid">
        {manifest ? manifest.artifacts.map((item) => (
          <div className="sync-delivery-target" key={item.target}>
            <div className="sync-delivery-target-top"><strong>{item.label}</strong>
              <span className={item.available ? "is-generated" : "is-missing"}>{item.available ? "已生成文件" : "文件不可用"}</span></div>
            <p>{TARGET_HELP[item.target] || "仍需实机验证工程导入行为"}</p>
            <div className="sync-delivery-target-detail"><span>{item.format}</span><span title={item.filename}>{item.filename}</span></div>
            <button type="button" className="secondary"
              disabled={!item.available || !isTauri() || Boolean(busyTarget)}
              onClick={() => void revealArtifact(item.local_path, item.target)}>
              {busyTarget === item.target ? "打开中…" : item.available ? "在本机显示工程文件" : "请检查生成任务"}
            </button>
          </div>
        )) : !error ? <div className="sync-delivery-loading" role="status">正在从本机 Host 检查已有工程文件…</div> : null}
      </div>
      <div className="sync-delivery-acceptance">
        <strong>交付前的人工确认</strong>
        <p>先在「同步核对」听看音画，再到目标 NLE 导入，确认每个视频机位、独立录音、重连路径和原生多机位切换。尚未验证的能力不会显示为“交付成功”。</p>
        {!isTauri() ? <p>当前为浏览器预览：本机显示文件按钮需要桌面 App。</p> : null}
      </div>
    </section>
  );
}
