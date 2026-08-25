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

export function DeliveryWorkbench({ baseUrl, projectId }: Props) {
  const delivery = useMemo(() => new DeliveryClient(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const [report, setReport] = useState<DeliveryExportReport>({});
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [message, setMessage] = useState("正在读取 delivery export 状态…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void delivery.status(projectId).then((payload) => {
      if (cancelled) return;
      setReport(payload.report);
      setMessage(Object.keys(payload.report).length ? "已读取上次 delivery export。" : "尚未生成 delivery export。");
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
    setMessage("正在调用 Python Core delivery exporter…");
    try {
      const payload = await delivery.export(projectId);
      setReport(payload.report);
      setMessage("delivery.v1 已生成；平台打开动作不会修改导出语义。");
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
      setMessage("已在系统文件管理器定位导出文件。");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function openFinalCut(): Promise<void> {
    if (!report.organized_fcpxml) return;
    try {
      await platform.openInFinalCut(report.organized_fcpxml);
      setMessage("已把现有 FCPXML 交给 Final Cut Pro；Tauri 未重写 FCPXML。 ");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  return (
    <section className="phase3-workbench delivery-workbench">
      <header className="production-heading">
        <div>
          <p className="eyebrow">Delivery / Platform Adapter</p>
          <h2>交付 / NLE</h2>
        </div>
        <span className="production-state">{message}</span>
      </header>

      <div className="production-grid">
        <section className="production-panel">
          <p className="eyebrow">Python delivery.v1</p>
          <h3>{String(report.selection_contract || "尚未导出")}</h3>
          <p className="production-note">导出仍由现有 Python `fcpxml_exporter` 生成；Desktop 这里只提供明确的人工作业入口。</p>
          <button type="button" disabled={busy} onClick={() => void runExport()}>生成 / 刷新交付文件</button>
          {report.warning ? <p className="production-warning">{report.warning}</p> : null}
        </section>

        <aside className="production-panel">
          <p className="eyebrow">Native platform adapter</p>
          <div className="fact-chips">
            <span>{platformInfo?.os || "browser preview"}</span>
            <span>Finder/Explorer {platformInfo?.reveal_path ? "✓" : "—"}</span>
            <span>FCP {platformInfo?.fcp_adapter ? "✓" : "—"}</span>
            <span>Resolve/Premiere extension-only</span>
          </div>
          <div className="production-actions">
            <button type="button" className="secondary" disabled={!isTauri() || !report.selection_manifest_exists} onClick={() => void reveal(report.selection_manifest)}>显示 selection manifest</button>
            <button type="button" className="secondary" disabled={!isTauri() || !report.organized_fcpxml_exists} onClick={() => void reveal(report.organized_fcpxml)}>显示 FCPXML</button>
            {platformInfo?.fcp_adapter ? <button type="button" disabled={!report.organized_fcpxml_exists} onClick={() => void openFinalCut()}>在 Final Cut Pro 打开</button> : null}
          </div>
          <p className="production-note">当前未启用 macOS App Sandbox，因此不宣称 security-scoped bookmark；若后续发行策略启用 sandbox，再进入该 native gate。</p>
        </aside>
      </div>
    </section>
  );
}
