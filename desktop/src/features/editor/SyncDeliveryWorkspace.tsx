import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import {
  SyncTimelineClient,
  syncDeliveryFileLabel,
  type MulticamSyncTimeline,
  type SyncDeliveryArtifacts,
  type SyncEnrichedDeliveryManifest,
} from "../../api/syncTimeline";
import { PlatformClient } from "../../api/platform";
import "./sync-delivery-workspace.css";

interface Props {
  baseUrl: string;
  syncTimeline: MulticamSyncTimeline;
  onInspect?: () => void;
  onSyncTask: () => void;
  onRepair?: () => void;
  onOpenAssembly?: () => void;
  canGenerate?: boolean;
}

const TARGET_HELP: Record<string, string> = {
  davinci: "在 Resolve 媒体池中将视频时间线转换为多机位片段，再检查机位、源片与录音。",
  premiere: "导入 FCP7 XML 后核对原生多机位源序列",
  "final-cut": "FCPXML，须在目标 Final Cut Pro 版本检查机位切换",
  jianying: "国内剪映专业版 FCPXML 兼容路径，Windows/macOS 均需验收",
};

export function SyncDeliveryWorkspace({ baseUrl, syncTimeline, onSyncTask, onRepair, onOpenAssembly, canGenerate = true }: Props) {
  const [manifest, setManifest] = useState<SyncDeliveryArtifacts | null>(null);
  const [error, setError] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("davinci");
  const [busyTarget, setBusyTarget] = useState("");
  const [lastRequest, setLastRequest] = useState(0);
  const [includeMarkers, setIncludeMarkers] = useState(true);
  const [splitByScene, setSplitByScene] = useState(true);
  const [exportSrt, setExportSrt] = useState(true);
  const [enrichedBusy, setEnrichedBusy] = useState(false);
  const [enrichedError, setEnrichedError] = useState("");
  const [enrichedManifest, setEnrichedManifest] = useState<SyncEnrichedDeliveryManifest | null>(null);
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

  async function createEnrichedPack() {
    if (!canGenerate || enrichedBusy) return;
    setEnrichedBusy(true);
    setEnrichedError("");
    try {
      const result = await client.createEnrichedDelivery(syncTimeline.project_id, {
        include_markers: includeMarkers,
        split_by_scene: splitByScene,
        export_srt: exportSrt,
      });
      setEnrichedManifest(result);
    } catch (reason) {
      setEnrichedError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setEnrichedBusy(false);
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

  const item = manifest?.artifacts.find(artifact => artifact.target === selectedTarget) ?? manifest?.artifacts[0];
  const running = item?.task?.status === "queued" || item?.task?.status === "running";
  const syncVersion = manifest?.sync_version || syncTimeline.task?.task_id;
  const { timebase } = syncTimeline;
  const frameRate = timebase?.status === "confirmed" && timebase.numerator && timebase.denominator
    ? timebase.denominator === 1 ? `${timebase.numerator} fps` : `${timebase.numerator}/${timebase.denominator} fps`
    : "待确认";

  return (
    <section className="sync-delivery-workspace" aria-label="同步工程交付">
      <div className="sync-delivery-content">
        <p className="sync-delivery-intro">选择你要导入的剪辑软件，获取同步好的多机位工程文件；可直接进软件开始精剪。</p>

        <dl className="sync-delivery-summary">
          <div><dt>母版版本</dt><dd>{syncVersion ? <code title={syncVersion}>{syncVersion.slice(0, 12)}</code> : "待确认"}</dd></div>
          <div><dt>机位</dt><dd>{syncTimeline.cameras.join(" / ") || "待确认"}</dd></div>
          <div><dt>视频片段</dt><dd>{syncTimeline.clip_count.toLocaleString()}</dd></div>
          <div><dt>时间基</dt><dd>{frameRate}</dd></div>
        </dl>

        {error && <div className="sync-delivery-error" role="alert"><span>{error}</span>
          <button type="button" className="secondary" onClick={() => setLastRequest(value => value + 1)}>重新读取</button>
        </div>}
        {manifest && item ? <div className="sync-delivery-body">
          <div className="sync-delivery-choices">
            <h3>目标软件</h3>
            <ul className="sync-delivery-targets" aria-label="工程文件">
              {manifest.artifacts.map(artifact => {
                const active = artifact.task?.status === "queued" || artifact.task?.status === "running";
                return <li key={artifact.target}>
                  <button type="button" className="sync-delivery-target" aria-pressed={item.target === artifact.target}
                    onClick={() => setSelectedTarget(artifact.target)}>
                    <strong>{artifact.label}</strong>
                    <span className="sync-delivery-file-state" data-ready={artifact.available || undefined}>
                      {active ? "正在生成" : syncDeliveryFileLabel(artifact)}
                    </span>
                  </button>
                </li>;
              })}
            </ul>
          </div>

          <section className="sync-delivery-detail" aria-label={`${item.label} 工程详情`}>
            <header>
              <div><h3>{item.label}</h3><p>{item.format}</p></div>
              <span className="sync-delivery-file-state" role="status" data-ready={item.available || undefined}>
                {running ? item.task?.message || "正在生成" : syncDeliveryFileLabel(item)}
              </span>
            </header>
            <dl className="sync-delivery-file">
              {item.filename && <div><dt>文件名</dt><dd title={item.filename}>{item.filename}</dd></div>}
              {item.details?.audio_segments !== undefined && <div><dt>独立同期声</dt><dd>{item.details.audio_segments ? `${item.details.audio_segments} 段` : "尚未确认上轨"}</dd></div>}
              {item.details?.camera_audio_tracks !== undefined && <div><dt>机内音轨</dt><dd>{item.details.camera_audio_tracks} 条</dd></div>}
            </dl>

            <div className="sync-delivery-preflight">
              <h4>导入后核对</h4>
              <p>{item.details?.conversion_instruction || TARGET_HELP[item.target] || "在目标软件中核对机位和音轨。"}</p>
              {item.details?.relocation_instruction && <p>{item.details.relocation_instruction}</p>}
              {item.details?.diagnostics?.map(diagnostic => <p key={diagnostic.code} role="status">{diagnostic.message}</p>)}
              {item.task?.error && !item.available && <p className="sync-delivery-error" role="alert">{item.task.error}</p>}
            </div>

            <div className="sync-delivery-actions">
              {item.available ? <button type="button"
                disabled={!isTauri() || Boolean(busyTarget)}
                aria-label={`显示 ${item.label} 工程文件`}
                onClick={() => void revealArtifact(item.local_path, item.target)}>
                {busyTarget === item.target ? "打开中…" : "显示工程文件"}
              </button> : item.target === "davinci" && <button type="button"
                disabled={!canGenerate || !manifest.ready || !isTauri() || running || Boolean(busyTarget)}
                onClick={() => void createResolveDelivery()}>
                {running || busyTarget === item.target ? "生成中…" : item.task?.error ? "重试 Resolve 交付" : "在 Resolve 生成"}
              </button>}
              {item.unavailable_reason === "media_roots_unbound" && onRepair && <button type="button" className="secondary" onClick={onRepair}>检查本机目录</button>}
              {item.unavailable_reason === "file_missing" && <button type="button" className="secondary" onClick={onSyncTask}>检查同步任务</button>}
            </div>
          </section>
        </div> : !error && <p className="sync-delivery-loading" role="status">{manifest ? "当前版本暂无可列出的文件。" : "正在查找工程文件…"}</p>}

        <details className="sync-enriched-pack-details">
          <summary>
            <span className="sync-enriched-pack-summary-title">进阶：增强交付包</span>
            <span className="sync-enriched-pack-summary-subtitle">附带场记彩色 Marker、分场子序列与实际台词 SRT · 按需展开</span>
          </summary>
          <section className="sync-enriched-pack" aria-label="剪辑增强交付包">
            <header>
              <div>
                <h3>增强交付包（场记彩色 Marker · 分场子序列 · 实际台词 SRT）</h3>
                <p>
                  {(syncTimeline.offset_revision ?? 0) > 0
                    ? `写入独立版本号目录，不覆盖既有同步母版；已包含人工同步微调（第 ${syncTimeline.offset_revision} 版）。`
                    : "写入独立版本号目录，不覆盖既有同步母版。"}
                </p>
              </div>
              <button type="button" disabled={!canGenerate || enrichedBusy} onClick={() => void createEnrichedPack()}>
                {enrichedBusy ? "生成中…" : "生成增强交付包"}
              </button>
            </header>
            <div className="sync-enriched-options">
              <label><input type="checkbox" checked={includeMarkers} onChange={(e) => setIncludeMarkers(e.target.checked)} />写入场记状态 / 保条 ★ / 偏移 Marker</label>
              <label><input type="checkbox" checked={splitByScene} onChange={(e) => setSplitByScene(e.target.checked)} />按场次自动拆分子序列（FCPXML）</label>
              <label><input type="checkbox" checked={exportSrt} onChange={(e) => setExportSrt(e.target.checked)} />附带帧精确实际台词 .srt 字幕轨</label>
            </div>
            {enrichedError ? <p className="sync-delivery-error" role="alert">{enrichedError}</p> : null}
            {enrichedManifest ? (
              <div className="sync-enriched-result" role="status">
                <div className="sync-enriched-metrics">
                  <span><strong>{enrichedManifest.marker_count}</strong> 条 Marker</span>
                  <span><strong>{enrichedManifest.scene_sequences.length}</strong> 条分场序列</span>
                  <span><strong>{enrichedManifest.srt_cue_count}</strong> 条实际对白字幕</span>
                  <span>偏移版本 <code>r{enrichedManifest.offset_revision}</code></span>
                </div>
                <div className="sync-delivery-actions">
                  <button type="button" disabled={!isTauri() || Boolean(busyTarget)} onClick={() => void revealArtifact(enrichedManifest.master_fcpxml, "enriched-master")}>
                    显示带 Marker 母版 FCPXML
                  </button>
                  <button type="button" className="secondary" disabled={!isTauri() || Boolean(busyTarget)} onClick={() => void revealArtifact(enrichedManifest.bundle_dir, "enriched-dir")}>
                    打开完整增强包目录
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </details>

        {onOpenAssembly ? (
          <div className="sync-delivery-assembly-bridge">
            <span>以上用于导出原始多机位同步工程；若已在镜序完成选片并需要按剧本生成粗剪顺片，可前往「粗剪组接」。</span>
            <button type="button" className="secondary" onClick={onOpenAssembly}>前往粗剪组接</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
