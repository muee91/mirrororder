import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { DeliveryClient, type DeliveryExportReport } from "../../api/delivery";
import { PlatformClient, type PlatformInfo } from "../../api/platform";

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
    .map(([key, value]) => [labels[key] || key.replaceAll("_", " "), String(value)]);
}

export function DeliveryWorkbench({ baseUrl, projectId }: Props) {
  const delivery = useMemo(() => new DeliveryClient(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const [report, setReport] = useState<DeliveryExportReport>({});
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState("正在读取上次交付结果…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void delivery.status(projectId).then((payload) => {
      if (cancelled) return;
      setReport(payload.report);
      setMessage(Object.keys(payload.report).length ? "已读取上次交付结果。" : "尚未生成交付文件。");
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(errorMessage(error));
    });
    if (isTauri()) {
      void platform.info().then((info) => { if (!cancelled) setPlatformInfo(info); }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [delivery, platform, projectId]);

  async function runExport(): Promise<void> {
    setBusy(true);
    setMessage("正在根据当前最终剪辑决定生成交付文件…");
    try {
      const payload = await delivery.export(projectId);
      setReport(payload.report);
      setMessage("交付文件已生成。打开或定位文件不会改变项目里的最终剪辑决定。");
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

  async function openFinalCut(): Promise<void> {
    if (!report.organized_fcpxml) return;
    try {
      await platform.openInFinalCut(report.organized_fcpxml);
      setMessage("已将现有 FCPXML 交给 Final Cut Pro 打开。");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  const rows = summaryRows(report.selection_summary);
  const generated = Boolean(report.organized_fcpxml_exists || report.selection_manifest_exists);

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
          <p className="eyebrow">Final Cut Pro</p>
          <h3>{fileName(report.organized_fcpxml)}</h3>
          <p className="production-note">根据当前最终 Best / Keep / Reject 重新生成选择清单和 FCPXML。自动分析、个人意见和场记状态不会被静默提升为最终交付决定。</p>

          {rows.length ? (
            <dl className="status-facts">
              {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
          ) : null}

          <div className="production-actions">
            <button type="button" disabled={busy} onClick={() => void runExport()}>{generated ? "刷新交付文件" : "生成交付文件"}</button>
            {report.warning ? <span className="production-warning">{report.warning}</span> : null}
          </div>
        </section>

        <aside className="production-panel">
          <p className="eyebrow">输出文件</p>
          <div className="production-actions">
            <button type="button" className="secondary" disabled={!isTauri() || !report.organized_fcpxml_exists} onClick={() => void reveal(report.organized_fcpxml)}>在 Finder 显示 FCPXML</button>
            {platformInfo?.fcp_adapter ? <button type="button" disabled={!report.organized_fcpxml_exists} onClick={() => void openFinalCut()}>在 Final Cut Pro 打开</button> : null}
          </div>
          {report.selection_manifest_exists ? <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void reveal(report.selection_manifest)}>显示选择清单</button> : null}

          <details className="advanced-connection-options delivery-technical-details">
            <summary>高级交付信息</summary>
            <dl className="status-facts">
              <div><dt>selection contract</dt><dd>{String(report.selection_contract || "-")}</dd></div>
              <div><dt>keywords</dt><dd>{report.keywords_written ? "written" : "-"}</dd></div>
              <div><dt>multicam structure</dt><dd>{report.multicam_structure_modified ? "modified" : "preserved"}</dd></div>
              <div><dt>platform</dt><dd>{platformInfo?.os || "browser preview"}</dd></div>
              <div><dt>FCP adapter</dt><dd>{platformInfo?.fcp_adapter ? "available" : "unavailable"}</dd></div>
            </dl>
            <p className="production-note">交付语义仍由现有 exporter 负责；Desktop 只提供明确的人工作业入口。平台打开动作不会重写 FCPXML。</p>
          </details>
        </aside>
      </div>
    </section>
  );
}
