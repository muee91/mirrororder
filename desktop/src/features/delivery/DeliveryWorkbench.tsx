import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DeliveryClient,
  type DeliveryExportReport,
  type TimelineDeliveryReport,
} from "../../api/delivery";
import { PlatformClient, type PlatformInfo } from "../../api/platform";
import {
  TimelineClient,
  type TimelineAuthority,
  type TimelineSnapshot,
} from "../../api/timeline";
import { buildTimelineDeliveryPreflight, sameTimelineAuthority } from "./deliveryPreflight";

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

function authorityValueLabel(authority: TimelineAuthority | null | undefined): string {
  if (!authority?.generation) return "尚未捕获 Timeline authority";
  return `${authority.generation.slice(0, 12)}… @ r${authority.revision}`;
}

function authorityLabel(report: TimelineDeliveryReport): string {
  return authorityValueLabel(report.timeline_authority);
}

export function DeliveryWorkbench({ baseUrl, projectId }: Props) {
  const delivery = useMemo(() => new DeliveryClient(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const timeline = useMemo(() => new TimelineClient(), []);
  const [legacyReport, setLegacyReport] = useState<DeliveryExportReport>({});
  const [timelineReport, setTimelineReport] = useState<TimelineDeliveryReport>({});
  const [timelineSnapshot, setTimelineSnapshot] = useState<TimelineSnapshot | null>(null);
  const [timelineSnapshotError, setTimelineSnapshotError] = useState("");
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState("正在读取上次交付结果…");
  const [busy, setBusy] = useState(false);
  const [preflightBusy, setPreflightBusy] = useState(false);

  const refreshTimelineSnapshot = useCallback(async (announce = false): Promise<TimelineSnapshot | null> => {
    if (!isTauri()) return null;
    setPreflightBusy(true);
    if (announce) setMessage("正在刷新当前 Timeline 交付前检查…");
    try {
      const snapshot = await timeline.openPersisted(projectId);
      setTimelineSnapshot(snapshot);
      setTimelineSnapshotError("");
      if (announce) setMessage(`交付前检查已刷新 · ${authorityValueLabel(snapshot.authority)}`);
      return snapshot;
    } catch (error) {
      const text = errorMessage(error);
      setTimelineSnapshot(null);
      setTimelineSnapshotError(text);
      if (announce) setMessage(`无法读取当前 Timeline：${text}`);
      return null;
    } finally {
      setPreflightBusy(false);
    }
  }, [projectId, timeline]);

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
      void refreshTimelineSnapshot(false);
    }
    return () => { cancelled = true; };
  }, [delivery, platform, projectId, refreshTimelineSnapshot]);

  const preflight = useMemo(
    () => timelineSnapshot ? buildTimelineDeliveryPreflight(timelineSnapshot) : null,
    [timelineSnapshot],
  );

  async function runTimelineExport(): Promise<void> {
    if (!isTauri()) {
      setMessage("最终 Timeline FCPXML 必须在 Desktop 中从 Rust Timeline authority 生成；浏览器预览保持只读。");
      return;
    }
    setBusy(true);
    setMessage("正在恢复该项目最新 Rust Timeline checkpoint + journal…");
    try {
      const snapshot = await timeline.openPersisted(projectId);
      setTimelineSnapshot(snapshot);
      setTimelineSnapshotError("");
      const nextPreflight = buildTimelineDeliveryPreflight(snapshot);
      if (nextPreflight.blockers.length) {
        setMessage(`交付前检查未通过 · ${nextPreflight.blockers.length} 个阻塞项；先回到 Timeline 处理。`);
        return;
      }
      setMessage(`已捕获 Timeline ${authorityValueLabel(snapshot.authority)}，正在执行最终 exporter 校验并生成 FCPXML…`);
      const payload = await delivery.exportTimeline(projectId, snapshot);
      setTimelineReport(payload.report);
      const authority = payload.report.timeline_authority;
      setMessage(
        authority
          ? `最终 Timeline FCPXML 已生成 · authority ${authorityValueLabel(authority)}`
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
  const artifactCurrent = Boolean(
    timelineGenerated
      && timelineSnapshot
      && sameTimelineAuthority(timelineSnapshot.authority, timelineReport.timeline_authority),
  );
  const artifactStale = Boolean(timelineGenerated && timelineSnapshot && !artifactCurrent);
  const exportBlocked = !timelineSnapshot || Boolean(preflight?.blockers.length);
  const readinessLabel = !isTauri()
    ? "Desktop 中检查"
    : preflightBusy
      ? "正在检查"
      : timelineSnapshotError
        ? "无法读取 Timeline"
        : preflight?.blockers.length
          ? `${preflight.blockers.length} 个阻塞项`
          : timelineSnapshot
            ? "可进入最终 exporter 校验"
            : "尚未检查";
  const artifactLabel = !timelineGenerated
    ? "尚未生成"
    : artifactCurrent
      ? "与当前 Timeline 一致"
      : artifactStale
        ? "Timeline 已更新 · 需要刷新交付"
        : "无法确认是否为当前版本";

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
            最终交付从 Rust Timeline 的 persisted checkpoint + journal 捕获不可变 snapshot，保留当前 split / trim / move / Video Insert / Overwrite 与已明确选择的多机位角度。不会从 Review Best 重新推导一条“看起来相似”的时间线。
          </p>

          <div className="production-panel delivery-preflight">
            <div className="parse-heading">
              <div>
                <p className="eyebrow">交付前检查</p>
                <strong>{readinessLabel}</strong>
              </div>
              <button type="button" className="secondary" disabled={!isTauri() || busy || preflightBusy} onClick={() => void refreshTimelineSnapshot(true)}>刷新检查</button>
            </div>

            <dl className="status-facts">
              <div><dt>当前 Timeline</dt><dd>{authorityValueLabel(timelineSnapshot?.authority)}</dd></div>
              <div><dt>已生成文件</dt><dd>{artifactLabel}</dd></div>
              <div><dt>启用视频</dt><dd>{preflight ? String(preflight.enabledVideoClipCount) : "-"}</dd></div>
              <div><dt>机位待选</dt><dd>{preflight ? String(preflight.pendingMulticamCount) : "-"}</dd></div>
              <div><dt>独立 A-track</dt><dd>{preflight ? String(preflight.independentAudioClipCount) : "-"}</dd></div>
              <div><dt>transition / marker</dt><dd>{preflight ? `${preflight.transitionCount} / ${preflight.markerCount}` : "-"}</dd></div>
            </dl>

            {timelineSnapshotError ? <p className="production-warning">无法读取当前 persisted Timeline：{timelineSnapshotError}</p> : null}
            {preflight?.blockers.map((blocker) => (
              <p className="production-warning" key={`${blocker.code}-${blocker.message}`}>阻塞 · {blocker.message}</p>
            ))}
            {preflight?.warnings.map((warning) => (
              <p className="production-note" key={`${warning.code}-${warning.message}`}>注意 · {warning.message}</p>
            ))}
            {timelineSnapshot && !preflight?.blockers.length ? (
              <p className="production-note">当前 Timeline snapshot 没有发现 v1 可直接证明的阻塞项。素材映射、源 FCPXML format 与 source range 仍由 Python exporter 在真正写文件前做最终 fail-closed 校验。</p>
            ) : null}
            {preflight?.blockers.length ? <p className="production-note">先切到“时间线”处理上述编辑决定；交付按钮会保持禁用，不会用 fallback 方式静默改写 Timeline。</p> : null}
          </div>

          <dl className="status-facts">
            <div><dt>上次交付 authority</dt><dd>{authorityLabel(timelineReport)}</dd></div>
            <div><dt>sequence</dt><dd>{String(timelineReport.sequence_id || "-")}</dd></div>
            <div><dt>video clips</dt><dd>{String(timelineReport.video_clip_count ?? "-")}</dd></div>
            <div><dt>audio</dt><dd>linked asset audio only · v1</dd></div>
            <div><dt>frame rate</dt><dd>{timelineReport.frame_rate ? `${timelineReport.frame_rate.numerator}/${timelineReport.frame_rate.denominator}` : "-"}</dd></div>
          </dl>

          <div className="production-actions">
            <button type="button" disabled={busy || preflightBusy || !isTauri() || exportBlocked} onClick={() => void runTimelineExport()}>
              {timelineGenerated ? "刷新最终 Timeline FCPXML" : "生成最终 Timeline FCPXML"}
            </button>
            <button type="button" className="secondary" disabled={!isTauri() || !timelineGenerated} onClick={() => void reveal(timelineReport.organized_fcpxml)}>
              在 Finder 显示
            </button>
            {platformInfo?.fcp_adapter ? (
              <button type="button" disabled={!artifactCurrent} title={artifactCurrent ? "打开与当前 Timeline authority 一致的最终 FCPXML" : "先刷新最终 Timeline FCPXML，再交给 Final Cut Pro"} onClick={() => void openFinalCut(timelineReport.organized_fcpxml, "最终 Timeline FCPXML")}>
                在 Final Cut Pro 打开
              </button>
            ) : null}
          </div>

          {artifactStale ? <p className="production-warning">当前 Timeline authority 与上次生成 FCPXML 的 authority 已不一致；旧文件仍可在 Finder 查看，但不应作为当前剪辑版本交付。</p> : null}
          {flattened > 0 ? <p className="production-warning">{flattened} 个多机位片段按当前选中角度 flatten 为普通 asset-clip；不会伪装成保留了 multicam container。</p> : null}
          {omittedMarkers > 0 ? <p className="production-warning">{omittedMarkers} 个 Timeline marker 当前不属于交付 authority，v1 明确不导出。</p> : null}
          <p className="production-note">v1 目前只安全保留视频 asset 自带的 linked audio。非空独立 A-track、transition、多条非空视频轨、未知素材映射、视频重叠或未选择机位的 multicam 都会 fail closed；不会静默丢失或猜测编辑语义。</p>
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
              <div><dt>independent audio</dt><dd>{timelineReport.semantics?.independent_audio_tracks_supported ? "supported" : "unsupported in v1"}</dd></div>
              <div><dt>legacy selection contract</dt><dd>{String(legacyReport.selection_contract || "-")}</dd></div>
              <div><dt>legacy keywords</dt><dd>{legacyReport.keywords_written ? "written" : "-"}</dd></div>
              <div><dt>platform</dt><dd>{platformInfo?.os || "browser preview"}</dd></div>
              <div><dt>FCP adapter</dt><dd>{platformInfo?.fcp_adapter ? "available" : "unavailable"}</dd></div>
            </dl>
            <p className="production-note">两种 exporter 的 authority 不同，因此保持两个明确入口；Desktop 只负责捕获 Rust snapshot、显示可证明的 preflight、发送 DTO 与平台打开动作，最终可交付性仍由 Python exporter 判定。</p>
          </details>
        </aside>
      </div>
    </section>
  );
}
