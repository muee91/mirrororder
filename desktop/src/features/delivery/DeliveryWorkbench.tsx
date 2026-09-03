import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DeliveryClient,
  type DeliveryExportReport,
  type PremiereDeliveryReport,
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

function authorityLabel(report: TimelineDeliveryReport | PremiereDeliveryReport): string {
  return authorityValueLabel(report.timeline_authority);
}

export function DeliveryWorkbench({ baseUrl, projectId }: Props) {
  const delivery = useMemo(() => new DeliveryClient(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const timeline = useMemo(() => new TimelineClient(), []);
  const [legacyReport, setLegacyReport] = useState<DeliveryExportReport>({});
  const [timelineReport, setTimelineReport] = useState<TimelineDeliveryReport>({});
  const [premiereReport, setPremiereReport] = useState<PremiereDeliveryReport>({});
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
      delivery.premiereStatus(projectId),
      delivery.status(projectId),
    ]).then(([timelineState, premiereState, legacyState]) => {
      if (cancelled) return;
      if (timelineState.status === "fulfilled") setTimelineReport(timelineState.value.report);
      if (premiereState.status === "fulfilled") setPremiereReport(premiereState.value.report);
      if (legacyState.status === "fulfilled") setLegacyReport(legacyState.value.report);
      const hasTimeline = timelineState.status === "fulfilled" && Object.keys(timelineState.value.report).length > 0;
      const hasPremiere = premiereState.status === "fulfilled" && Object.keys(premiereState.value.report).length > 0;
      const hasLegacy = legacyState.status === "fulfilled" && Object.keys(legacyState.value.report).length > 0;
      if (hasTimeline || hasPremiere) setMessage("已读取上次 authoritative Timeline 交付结果。");
      else if (hasLegacy) setMessage("只有旧的 Review/Editorial 标注交付；尚未生成 Timeline NLE 交付文件。");
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

  async function captureExportSnapshot(): Promise<TimelineSnapshot | null> {
    const snapshot = await timeline.openPersisted(projectId);
    setTimelineSnapshot(snapshot);
    setTimelineSnapshotError("");
    const nextPreflight = buildTimelineDeliveryPreflight(snapshot);
    if (nextPreflight.blockers.length) {
      setMessage(`交付前检查未通过 · ${nextPreflight.blockers.length} 个阻塞项；先回到 Timeline 处理。`);
      return null;
    }
    return snapshot;
  }

  async function runTimelineExport(): Promise<void> {
    if (!isTauri()) {
      setMessage("最终 Timeline FCPXML 必须在 Desktop 中从 Rust Timeline authority 生成；浏览器预览保持只读。");
      return;
    }
    setBusy(true);
    setMessage("正在恢复该项目最新 Rust Timeline checkpoint + journal…");
    try {
      const snapshot = await captureExportSnapshot();
      if (!snapshot) return;
      setMessage(`已捕获 Timeline ${authorityValueLabel(snapshot.authority)}，正在生成保留 Multicam / Audio / Marker 的 FCPXML…`);
      const payload = await delivery.exportTimeline(projectId, snapshot);
      setTimelineReport(payload.report);
      const authority = payload.report.timeline_authority;
      setMessage(
        authority
          ? `Final Cut FCPXML 已生成 · authority ${authorityValueLabel(authority)}`
          : "Final Cut FCPXML 已生成。",
      );
    } catch (error) {
      setMessage(`Final Cut 交付失败：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runPremiereExport(): Promise<void> {
    if (!isTauri()) {
      setMessage("Premiere XML 必须在 Desktop 中从 Rust Timeline authority 生成；浏览器预览保持只读。");
      return;
    }
    setBusy(true);
    setMessage("正在恢复该项目最新 Rust Timeline checkpoint + journal…");
    try {
      const snapshot = await captureExportSnapshot();
      if (!snapshot) return;
      setMessage(`已捕获 Timeline ${authorityValueLabel(snapshot.authority)}，正在生成 Premiere Pro XMEML…`);
      const payload = await delivery.exportPremiere(projectId, snapshot);
      setPremiereReport(payload.report);
      const authority = payload.report.timeline_authority;
      setMessage(
        authority
          ? `Premiere Pro XML 已生成 · authority ${authorityValueLabel(authority)}`
          : "Premiere Pro XML 已生成。",
      );
    } catch (error) {
      setMessage(`Premiere Pro 交付失败：${errorMessage(error)}`);
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
      setMessage("Review/Editorial 标注 FCPXML 已生成；它不会替代 authoritative Timeline NLE 交付。");
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

  async function openArtifact(path: string | undefined, label: string): Promise<void> {
    if (!path) return;
    try {
      await platform.open(path);
      setMessage(`已用系统默认应用打开${label}。`);
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
  const premiereGenerated = Boolean(premiereReport.premiere_xmeml_exists);
  const legacyGenerated = Boolean(legacyReport.organized_fcpxml_exists || legacyReport.selection_manifest_exists);
  const artifactCurrent = Boolean(
    timelineGenerated
      && timelineSnapshot
      && sameTimelineAuthority(timelineSnapshot.authority, timelineReport.timeline_authority),
  );
  const artifactStale = Boolean(timelineGenerated && timelineSnapshot && !artifactCurrent);
  const premiereArtifactCurrent = Boolean(
    premiereGenerated
      && timelineSnapshot
      && sameTimelineAuthority(timelineSnapshot.authority, premiereReport.timeline_authority),
  );
  const premiereArtifactStale = Boolean(premiereGenerated && timelineSnapshot && !premiereArtifactCurrent);
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
            ? "可进入 NLE exporter 校验"
            : "尚未检查";
  const artifactLabel = !timelineGenerated
    ? "尚未生成"
    : artifactCurrent
      ? "与当前 Timeline 一致"
      : artifactStale
        ? "Timeline 已更新 · 需要刷新交付"
        : "无法确认是否为当前版本";
  const premiereArtifactLabel = !premiereGenerated
    ? "尚未生成"
    : premiereArtifactCurrent
      ? "与当前 Timeline 一致"
      : premiereArtifactStale
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
          <p className="eyebrow">Authoritative Timeline → NLE</p>
          <h3>Final Cut Pro / Adobe Premiere Pro</h3>
          <p className="production-note">
            两种 NLE 输出都从同一份 Rust Timeline persisted checkpoint + journal 捕获不可变 snapshot，再经过 NLE Sequence IR。不会从 Review Best 重新推导第二条时间线，也不会让各 NLE adapter 重新解释 Editorial 决定。
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
              <div><dt>Final Cut</dt><dd>{artifactLabel}</dd></div>
              <div><dt>Premiere</dt><dd>{premiereArtifactLabel}</dd></div>
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
              <p className="production-note">当前 Timeline snapshot 没有发现公共 NLE contract 阻塞项。素材映射、源 FCPXML format、typed sync 与 source range 仍由 Python adapter 在真正写文件前做最终 fail-closed 校验。</p>
            ) : null}
            {preflight?.blockers.length ? <p className="production-note">先切到“时间线”处理上述编辑决定；交付按钮会保持禁用，不会用 fallback 方式静默改写 Timeline。</p> : null}
          </div>

          <div className="production-panel">
            <p className="eyebrow">Final Cut Pro · FCPXML</p>
            <h3>{fileName(timelineReport.organized_fcpxml)}</h3>
            <dl className="status-facts">
              <div><dt>上次 authority</dt><dd>{authorityLabel(timelineReport)}</dd></div>
              <div><dt>sequence</dt><dd>{String(timelineReport.sequence_id || "-")}</dd></div>
              <div><dt>video clips</dt><dd>{String(timelineReport.video_clip_count ?? "-")}</dd></div>
              <div><dt>multicam</dt><dd>{String(timelineReport.multicam_clip_count ?? 0)}</dd></div>
              <div><dt>独立 A-track</dt><dd>{String(timelineReport.audio_clip_count ?? 0)}</dd></div>
              <div><dt>Timeline marker</dt><dd>{String(timelineReport.marker_count ?? 0)}</dd></div>
            </dl>

            <div className="production-actions">
              <button type="button" disabled={busy || preflightBusy || !isTauri() || exportBlocked} onClick={() => void runTimelineExport()}>
                {timelineGenerated ? "刷新 Final Cut FCPXML" : "生成 Final Cut FCPXML"}
              </button>
              <button type="button" className="secondary" disabled={!isTauri() || !timelineGenerated} onClick={() => void reveal(timelineReport.organized_fcpxml)}>
                在 Finder 显示
              </button>
              {platformInfo?.fcp_adapter ? (
                <button type="button" disabled={!artifactCurrent} title={artifactCurrent ? "打开与当前 Timeline authority 一致的最终 FCPXML" : "先刷新 Final Cut FCPXML"} onClick={() => void openFinalCut(timelineReport.organized_fcpxml, "最终 Timeline FCPXML")}>
                  在 Final Cut Pro 打开
                </button>
              ) : null}
            </div>

            {artifactStale ? <p className="production-warning">当前 Timeline authority 与上次 Final Cut FCPXML 已不一致；旧文件仍可查看，但不应作为当前剪辑版本交付。</p> : null}
            <p className="production-note">Final Cut adapter 保留 multicam container、已选机位、独立 A-track、linked audio、disabled clip 与 Timeline marker。Transition、多条非空视频轨、未知素材映射或无效 source range 继续 fail closed。</p>
          </div>

          <div className="production-panel">
            <p className="eyebrow">Adobe Premiere Pro · FCP7 XMEML v4</p>
            <h3>{fileName(premiereReport.premiere_xmeml)}</h3>
            <dl className="status-facts">
              <div><dt>上次 authority</dt><dd>{authorityLabel(premiereReport)}</dd></div>
              <div><dt>sequence</dt><dd>{String(premiereReport.sequence_id || "-")}</dd></div>
              <div><dt>edit video</dt><dd>{String(premiereReport.video_clip_count ?? "-")}</dd></div>
              <div><dt>audio tracks</dt><dd>{String(premiereReport.audio_track_count ?? 0)}</dd></div>
              <div><dt>multicam source clips</dt><dd>{String(premiereReport.multicam_source_clip_count ?? 0)}</dd></div>
              <div><dt>marker 未导出</dt><dd>{String(premiereReport.markers_not_exported ?? 0)}</dd></div>
            </dl>

            <div className="production-actions">
              <button type="button" disabled={busy || preflightBusy || !isTauri() || exportBlocked} onClick={() => void runPremiereExport()}>
                {premiereGenerated ? "刷新 Premiere XML" : "生成 Premiere XML"}
              </button>
              <button type="button" className="secondary" disabled={!isTauri() || !premiereGenerated} onClick={() => void reveal(premiereReport.premiere_xmeml)}>
                在 Finder 显示
              </button>
              <button type="button" className="secondary" disabled={!isTauri() || !premiereArtifactCurrent} onClick={() => void openArtifact(premiereReport.premiere_xmeml, "Premiere XML")}>
                系统打开 XML
              </button>
            </div>

            {premiereArtifactStale ? <p className="production-warning">当前 Timeline authority 与上次 Premiere XML 已不一致；先刷新后再导入 Premiere Pro。</p> : null}
            {Number(premiereReport.markers_not_exported || 0) > 0 ? <p className="production-warning">Premiere XMEML 本轮不携带 Timeline marker；Final Cut FCPXML 会保留这些 marker。</p> : null}
            <p className="production-note">XML 同时包含当前 edit sequence 和按 typed sync 对齐的 multicam source sequence。导入 Premiere Pro 后，可对 multicam source sequence 使用“创建多机位源序列”；设备绝对素材路径只在本机导出瞬间写入 interchange XML，不写回共享项目或 report。</p>
          </div>
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
              <div><dt>Final Cut report</dt><dd>{String(timelineReport.contract || "-")}</dd></div>
              <div><dt>Final Cut path-safe</dt><dd>{timelineReport.persisted_report_path_safe ? "yes" : "-"}</dd></div>
              <div><dt>Premiere report</dt><dd>{String(premiereReport.contract || "-")}</dd></div>
              <div><dt>Premiere report path-safe</dt><dd>{premiereReport.persisted_report_path_safe ? "yes" : "-"}</dd></div>
              <div><dt>Premiere interchange local paths</dt><dd>{premiereReport.interchange_contains_device_media_paths ? "export-only" : "-"}</dd></div>
              <div><dt>legacy selection contract</dt><dd>{String(legacyReport.selection_contract || "-")}</dd></div>
              <div><dt>platform</dt><dd>{platformInfo?.os || "browser preview"}</dd></div>
              <div><dt>FCP adapter</dt><dd>{platformInfo?.fcp_adapter ? "available" : "unavailable"}</dd></div>
            </dl>
            <p className="production-note">Final Cut 与 Premiere 消费同一个 Timeline/NLE authority，但保持格式 adapter 与失败隔离；Review/Editorial 标注导出仍是另一种 authority，因此继续作为明确的兼容入口。</p>
          </details>
        </aside>
      </div>
    </section>
  );
}
