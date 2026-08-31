import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { DesktopClient, type MediaBindingSummary } from "../../api/desktop";
import { HostConnectionError } from "../../api/host";
import { PlatformClient } from "../../api/platform";

interface Props {
  baseUrl: string;
  projectId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function splitRoots(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
}

export function MediaBindingWorkbench({ baseUrl, projectId }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const [summary, setSummary] = useState<MediaBindingSummary | null>(null);
  const [rootsText, setRootsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取本机素材绑定…");

  async function reload(): Promise<void> {
    try {
      const payload = await client.mediaBinding(projectId);
      setSummary(payload.summary);
      setRootsText(payload.summary.roots.join("\n"));
      setMessage(`${payload.summary.resolved}/${payload.summary.total} 个媒体身份已在本机解析`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    void reload();
    // client is stable for baseUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId]);

  async function chooseRoots(): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览无法打开系统目录选择器；可以在下方手动填写目录。");
      return;
    }
    try {
      const selected = await openDialog({ directory: true, multiple: true, title: "选择本机素材目录" });
      const values = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
      if (!values.length) return;
      const merged = [...new Set([...splitRoots(rootsText), ...values])];
      setRootsText(merged.join("\n"));
      setMessage(`已选择 ${values.length} 个本机素材目录；尚未写入绑定。`);
    } catch (error) {
      setMessage(`目录选择失败：${errorMessage(error)}`);
    }
  }

  async function scan(replace: boolean): Promise<void> {
    const roots = splitRoots(rootsText);
    if (!roots.length) {
      setMessage("至少填写或选择一个本机素材目录。");
      return;
    }
    setBusy(true);
    setMessage(replace ? "正在提交替换目录并重扫任务…" : "正在提交素材扫描任务…");
    try {
      const payload = await client.scanMediaBinding(projectId, roots, replace);
      if (payload.task.type && payload.task.type !== "media_inventory_scan") {
        setMessage(`素材扫描提交返回了未知任务类型：${payload.task.type}`);
        return;
      }
      setMessage("素材扫描已提交到状态中心；可以继续制作，扫描完成后这里会显示恢复结果。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(mediaId: string, candidatePath: string): Promise<void> {
    setBusy(true);
    setMessage("正在确认旧项目素材候选…");
    try {
      const payload = await client.confirmProvisionalMediaBinding(projectId, mediaId, candidatePath);
      setSummary(payload.summary);
      setMessage(`已确认 ${candidatePath}；该确认只保存在当前设备。`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reveal(path: string): Promise<void> {
    if (!isTauri()) return;
    try {
      await platform.reveal(path);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  const items = useMemo(
    () => [...(summary?.items ?? [])].sort((left, right) => Number(left.local_exists) - Number(right.local_exists) || left.name.localeCompare(right.name)),
    [summary],
  );
  const roots = splitRoots(rootsText);

  return (
    <section className="phase3-workbench media-binding-workbench">
      <header className="production-heading media-binding-heading">
        <div>
          <p className="eyebrow">当前设备</p>
          <h2>本机素材</h2>
          <span>为这个项目指定当前 Mac 上的素材位置。</span>
        </div>
      </header>

      <div className="media-binding-status" aria-live="polite">{message}</div>

      <div className="media-binding-content">
        <section className="media-binding-section media-binding-setup">
          <header className="media-binding-section-heading">
            <div><strong>素材位置</strong><span>{roots.length ? `${roots.length} 个目录` : "尚未设置目录"}</span></div>
            <div className="media-binding-summary" aria-label="本机素材恢复统计">
              <span><strong>{summary?.resolved ?? 0}</strong> 已解析</span>
              <span><strong>{summary?.missing ?? 0}</strong> 缺失</span>
              <span><strong>{summary?.total ?? 0}</strong> 媒体身份</span>
            </div>
          </header>

          <label className="production-field media-binding-roots-field">
            <span>本机素材目录 · 每行一个</span>
            <textarea
              className="media-roots-input"
              rows={4}
              value={rootsText}
              onChange={(event) => setRootsText(event.target.value)}
              spellCheck={false}
              placeholder="/Volumes/PROJECT/Media"
            />
          </label>

          <div className="media-binding-actions">
            <button type="button" className="secondary" disabled={busy || !isTauri()} onClick={() => void chooseRoots()}>选择目录…</button>
            <button type="button" disabled={busy || !roots.length} onClick={() => void scan(false)}>扫描新增目录</button>
            <button type="button" className="secondary" disabled={busy || !roots.length} onClick={() => void scan(true)}>替换目录并重扫</button>
          </div>

          <details className="media-binding-help">
            <summary>关于本机素材恢复</summary>
            <p>正式媒体身份会通过内容校验自动恢复。旧项目只有文件名线索时只会生成候选，不会静默绑定；需要逐项确认。所有绑定只保存在当前设备，不修改共享项目或人工审核结果。</p>
            {summary?.state_path ? (
              <button type="button" className="secondary media-state-path" disabled={!isTauri()} onClick={() => void reveal(summary.state_path)}>定位设备绑定文件</button>
            ) : null}
          </details>
        </section>

        <section className="media-binding-section media-binding-results">
          <header className="media-binding-section-heading">
            <div><strong>恢复结果</strong><span>{summary?.device_name || "当前设备"}</span></div>
            <span className="media-binding-result-state">{summary?.pending_analysis ? "等待首次分析建立媒体身份" : `${summary?.resolved ?? 0}/${summary?.total ?? 0} 已解析`}</span>
          </header>

          <div className="media-binding-list">
            {items.length ? items.slice(0, 300).map((item) => (
              <article className={`media-binding-row ${item.local_exists ? "is-resolved" : "is-missing"}`} key={item.media_id}>
                <div>
                  <strong>{item.name || item.media_id}</strong>
                  <span>{item.verified ? "内容身份已校验" : "旧项目临时身份"} · {item.clip_ids.length} clips</span>
                </div>
                <em>{item.local_exists ? "已解析" : item.needs_confirmation ? "待确认" : "缺失"}</em>
                <code>{item.resolved_path || item.candidate_path || item.source_media_path || item.media_id}</code>
                {item.local_exists && item.resolved_path ? (
                  <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void reveal(item.resolved_path)}>在 Finder 中显示</button>
                ) : null}
                {item.needs_confirmation && item.candidate_path ? (
                  <div className="production-actions">
                    <button type="button" className="secondary" disabled={busy || !isTauri()} onClick={() => void reveal(item.candidate_path!)}>查看候选</button>
                    <button type="button" disabled={busy} onClick={() => void confirm(item.media_id, item.candidate_path!)}>确认这是该素材</button>
                  </div>
                ) : null}
              </article>
            )) : (
              <div className="media-binding-empty">
                <strong>{summary?.pending_analysis ? "等待首次整理" : "还没有媒体身份"}</strong>
                <span>{summary?.pending_analysis ? "项目完成首次素材分析后，会在这里列出可恢复的媒体身份。" : "选择素材目录并扫描，恢复结果会显示在这里。"}</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
