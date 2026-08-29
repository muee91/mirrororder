import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import {
  DeliveryClient,
  type DeliveryExportReport,
  type TimelineDeliveryReport,
} from "../../api/delivery";
import { PlatformClient, type PlatformInfo } from "../../api/platform";
import { TimelineClient } from "../../api/timeline";

interface Props {
  baseUrl: string;
  projectId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileName(path: string | undefined): string {
  if (!path) return "尚未生成";
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function summaryRows(summary: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!summary) return [];
  const labels: Record<string, string> = {
    best: "最佳",
    keep: "保留",
    reject: "隐藏",
    unreviewed: "未决定",
    decisions: "最终决定",
    groups: "Take",
    assignments: "剧本段决定",
  };
  return Object.entries(summary)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 8)
    .map(([key, value]) => [labels[key] || key.replaceAll("_", " "), String(value)] as [string, string]);
}

function authorityLabel(report: TimelineDeliveryReport): string {
  const authority = report.timeline_authority;
  if (!authority?.generation) return "尚未捕获 Timeline authority";
  return `${authority.generation.slice(0, 12)}… @ r${authority.revision}`;
}

export function DeliveryWorkbench({ baseUrl, projectId }: Props) {
  const delivery = useMemo(() => new DeliveryClient(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const timeline = useMemo(() => new TimelineClient(), []);
  const [legacyReport, setLegacyReport] = useState<DeliveryExportReport>({});
  const [timelineReport, setTimelineReport] = useState<TimelineDeliveryReport>({});
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState("正在读取上次交付结果…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      delivery.timelineStatus(projectId),
      delivery.status(projectId),
    ]).then(([timelineState, legacyState]) => {
      if (cancelled) return;
      if (timelineState.status === "fulfilled") setTimelineReport(timelineState.value.report);
      if (legacyState.status === "fulfilled") setLegacyReport(legacyState.value.report);
      const hasTimeline = timelineState.status === "fulfilled" && Object.keys(timelineState.value.report).length > 0;
      const hasLegacy = legacyState.status === "fulfilled" && Object.keys(legacyState.value.report).length > 0;
      if (hasTimeline) setMessage("已读取上次 authoritative Timeline 交付结果。");
      else if (hasLegacy) setMessage("只有旧的 Review/Editorial 标注交付；尚未生成最终 Timeline FCPXML。");
      else setMessage("尚未生成交付文件。");
    });
    if (isTauri()) {
      void platform.info().then((info) => { if (!cancelled) setPlatformInfo(info); }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [delivery, platform, projectId]);

  async function runTimelineExport(): Promise<void> {
    if (!isTauri()) {
      setMessage("最终 Timeline FCPXML 必须在 Desktop 中从 Rust Timeline authority 生成；浏览器预览保持只读。");
      return;
    }
    setBusy(true);
    setMessage("正在恢复该项目最新 Rust Timeline checkpoint + journal…");
    try {
      const snapshot = await timeline.openPersisted(projectId);
      setMessage(`已捕获 Timeline ${snapshot.authority.generation.slice(0, 12)}… @ r${snapshot.authority.revision}，正在生成 FCPXML…`);
      const payload = await delivery.exportTimeline(projectId, snapshot);
      setTimelineReport(payload.report);
      const authority = payload.report.timeline_authority;
      setMessage(
        authority
          ? `最终 Timeline FCPXML 已生成 · authority ${authority.generation.slice(0, 12)}… @ r${authority.revision}`
          : "最终 Timeline FCPXML 已生成。",
      );
    } catch (error) {
      setMessage(`最终 Timeline 交付失败：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runLegacyExport(): Promise<void> {
    setBusy(true);
    setMessage("正在生成 Review/Editorial Best / Keep / Reject 标注交付…");
    try {
      const payload = await delivery.export(projectId);
      setLegacyReport(payload.report);
      setMessage("Review/Editorial 标注 FCPXML 已生成；它不会替代 authoritative Timeline FCPXML。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reveal(path: string | undefined): Promise<void> {
    if (!path) return;
    try {
      await platform.reveal(path);
      setMessage("已在 Finder / 文件管理器中定位交付文件。");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function openFinalCut(path: string | undefined, label: string): Promise<void> {
    if (!path) return;
    try {
      await platform.openInFinalCut(path);
      setMessage(`已将${label}交给 Final Cut Pro 打开。`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  const legacyRows = summaryRows(legacyReport.selection_summary);
  const timelineGenerated = Boolean(timelineReport.organized_fcpxml_exists);
  const legacyGenerated = Boolean(legacyReport.organized_fcpxml_exists || legacyReport.selection_manifest_exists);
  const flattened = Number(timelineReport.multicam_flattened_count || 0);
  const omittedMarkers = Number(timelineReport.markers_not_exported || 0);
  const audioTracks = Number(timelineReport.audio_track_count || 0);
  const audioClips = Number(timelineReport.audio_clip_count || 0);

  return (
    <section className="phase3-workbench delivery-workbench">
      <header className="production-heading">
        <div>
          <p className="eyebrow">剪辑 / Delivery</p>
          <h2>交付</h2>
        </div>
        <span className="production-state">{message}</span>
      </header>

      <div className="production-grid">
        <section className="production-panel">
          <p className="eyebrow">Authoritative Timeline → Final Cut Pro</p>
          <h3>{fileName(timelineReport.organized_fcpxml)}</h3>
          <p className="production-note">
            最终交付从 Rust Timeline 的 persisted checkpoint + journal 捕获不可变 snapshot，保留当前 split / trim / move / Insert / Overwrite、独立 A-track 与选中机位结果。不会从 Review Best 重新推导一条“看起来相似”的时间线。
          </p>

          <dl className="status-facts">
            <div><dt>Timeline authority</dt><dd>{authorityLabel(timelineReport)}</dd></div>
            <div><dt>sequence</dt><dd>{String(timelineReport.sequence_id || "-")}</dd></div>
            <div><dt>video clips</dt><dd>{String(timelineReport.video_clip_count ?? "-")}</dd></div>
            <div><dt>audio</dt><dd>{audioTracks ? `${audioTracks} tracks · ${audioClips} clips` : "linked asset audio only"}</dd></div>
            <div><dt>frame rate</dt><dd>{timelineReport.frame_rate ? `${timelineReport.frame_rate.numerator}/${timelineReport.frame_rate.denominator}` : "-"}</dd></div>
          </dl>

          <div className="production-actions">
            <button type="button" disabled={busy || !isTauri()} onClick={() => void runTimelineExport()}>
              {timelineGenerated ? "刷新最终 Timeline FCPXML" : "生成最终 Timeline FCPXML"}
            </button>
            <button type="button" className="secondary" disabled={!isTauri() || !timelineGenerated} onClick={() => void reveal(timelineReport.organized_fcpxml)}>
              在 Finder 显示
            </button>
            {platformInfo?.fcp_adapter ? (
              <button type="button" disabled={!timelineGenerated} onClick={() => void openFinalCut(timelineReport.organized_fcpxml, "最终 Timeline FCPXML")}>
                在 Final Cut Pro 打开
              </button>
            ) : null}
          </div>

          {flattened > 0 ? <p className="production-warning">{flattened} 个多机位片段按当前选中角度 flatten 为普通 asset-clip；不会伪装成保留了 multicam container。</p> : null}
          {omittedMarkers > 0 ? <p className="production-warning">{omittedMarkers} 个 Timeline marker 当前不属于交付 authority，v1 明确不导出。</p> : null}
          {audioClips > 0 ? <p className="production-note">{audioClips} 个独立音频片段会按 Timeline A-track 的位置与源范围导出为 connected audio-only asset-clip；视频 asset 自带音频继续 linked 保留。</p> : null}
          <p className="production-note">v1 对 transition、多条非空视频轨、未知素材映射、同一音轨重叠或无音频组件的独立 A-track 素材继续 fail closed；不会静默丢失编辑语义。</p>
        </section>

        <aside className="production-panel">
          <p className="eyebrow">Review / Editorial 标注导出</p>
          <h3>{fileName(legacyReport.organized_fcpxml)}</h3>
          <p className="production-note">
            兼容入口：根据当前 Best / Keep / Reject 在原始 FCPXML 上生成选择清单和关键词范围。它用于审核/交接元数据，不代表 Rust Timeline 的最终剪辑结构。
          </p>

          {legacyRows.length ? (
            <dl className="status-facts">
              {legacyRows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
          ) : null}

          <div className="production-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void runLegacyExport()}>
              {legacyGenerated ? "刷新 Review 标注导出" : "生成 Review 标注导出"}
            </button>
            <button type="button" className="secondary" disabled={!isTauri() || !legacyReport.organized_fcpxml_exists} onClick={() => void reveal(legacyReport.organized_fcpxml)}>
              显示标注 FCPXML
            </button>
          </div>
          {legacyReport.selection_manifest_exists ? (
            <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void reveal(legacyReport.selection_manifest)}>显示选择清单</button>
          ) : null}

          <details className="advanced-connection-options delivery-technical-details">
            <summary>高级交付信息</summary>
            <dl className="status-facts">
              <div><dt>Timeline report</dt><dd>{String(timelineReport.contract || "-")}</dd></div>
              <div><dt>Timeline path-safe</dt><dd>{timelineReport.persisted_report_path_safe ? "yes" : "-"}</dd></div>
              <div><dt>independent audio</dt><dd>{timelineReport.semantics?.independent_audio_tracks_supported ? "connected audio" : "not present / unsupported"}</dd></div>
              <div><dt>legacy selection contract</dt><dd>{String(legacyReport.selection_contract || "-")}</dd></div>
              <div><dt>legacy keywords</dt><dd>{legacyReport.keywords_written ? "written" : "-"}</dd></div>
              <div><dt>platform</dt><dd>{platformInfo?.os || "browser preview"}</dd></div>
              <div><dt>FCP adapter</dt><dd>{platformInfo?.fcp_adapter ? "available" : "unavailable"}</dd></div>
            </dl>
            <p className="production-note">两种 exporter 的 authority 不同，因此保持两个明确入口；Desktop 只负责捕获 Rust snapshot、发送 DTO 与平台打开动作。</p>
          </details>
        </aside>
      </div>
    </section>
  );
}
